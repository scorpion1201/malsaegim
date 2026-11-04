import { createLevelNormalizer } from './levelNormalizer';

export type MicCapture = {
  /** 실제 AudioContext 샘플레이트 — 16000 이 아니면 호출자가 리샘플한다 */
  sampleRate: number;
  pause: () => void;
  /** 다시 받는다. 시스템이 오디오를 끊었으면(iPad·iPhone 에서 화면을 벗어남 등) 컨텍스트를 깨우고, 마이크 트랙이 끝났으면 다시 연다 */
  resume: () => Promise<void>;
  stop: () => Promise<void>;
};

/** 워크릿 프로세서: 입력 채널 0 을 1600 샘플(16kHz 기준 100ms)씩 모아 메인 스레드로 보낸다 */
const WORKLET_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(1600);
    this.fill = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(channel.length - offset, this.buffer.length - this.fill);
      this.buffer.set(channel.subarray(offset, offset + take), this.fill);
      this.fill += take;
      offset += take;
      if (this.fill === this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(1600);
        this.fill = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
`;

/** 선형 보간 리샘플 (한 번짜리) — 16kHz 컨텍스트를 못 만드는 브라우저용 대비책 */
export const resampleLinear = (input: Float32Array, fromRate: number, toRate: number): Float32Array => {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const next = Math.min(index + 1, input.length - 1);
    const t = position - index;
    out[i] = input[index] * (1 - t) + input[next] * t;
  }
  return out;
};

/** 저역 통과 필터의 한쪽 길이(탭) — 48kHz 에서 약 1.3ms */
const FILTER_HALF_TAPS = 31;

/** 해닝 창을 씌운 싱크 저역 통과 필터. cutoff 는 입력 나이퀴스트 대비 비율 */
const lowPassKernel = (cutoff: number): Float32Array => {
  const kernel = new Float32Array(FILTER_HALF_TAPS * 2 + 1);
  let sum = 0;
  for (let n = -FILTER_HALF_TAPS; n <= FILTER_HALF_TAPS; n += 1) {
    const x = Math.PI * cutoff * n;
    const sinc = n === 0 ? 1 : Math.sin(x) / x;
    const window = 0.5 + 0.5 * Math.cos((Math.PI * n) / (FILTER_HALF_TAPS + 1));
    kernel[n + FILTER_HALF_TAPS] = sinc * window;
    sum += sinc * window;
  }
  return kernel.map((value) => value / sum);
};

/** 블록을 이어 가며 거르는 FIR 필터 — 앞 블록 끝의 샘플을 들고 있어 경계가 끊기지 않는다 */
const createLowPass = (cutoff: number): ((input: Float32Array) => Float32Array) => {
  const kernel = lowPassKernel(cutoff);
  let history = new Float32Array(kernel.length - 1);
  return (input) => {
    const joined = new Float32Array(history.length + input.length);
    joined.set(history);
    joined.set(input, history.length);
    const out = new Float32Array(input.length);
    for (let i = 0; i < out.length; i += 1) {
      let sum = 0;
      for (let k = 0; k < kernel.length; k += 1) sum += joined[i + k] * kernel[k];
      out[i] = sum;
    }
    history = joined.slice(input.length);
    return out;
  };
};

/**
 * 연속(상태 유지) 선형 리샘플러. 블록마다 소수 위치와 직전 샘플을 이어받아 경계에서 샘플이 빠지거나
 * 위상이 튀지 않는다 — 실시간 마이크 스트림을 끊김 없이 16kHz 로 내리는 데 쓴다.
 * 내릴 때는 먼저 저역 통과로 거른다 — 안 거르면 새 나이퀴스트 위의 잡음이 말소리 대역으로 접혀 들어온다(앨리어싱).
 */
export const createResampler = (fromRate: number, toRate: number): ((input: Float32Array) => Float32Array) => {
  if (fromRate === toRate) return (input) => input;
  const ratio = fromRate / toRate;
  const filter = ratio > 1 ? createLowPass(0.9 / ratio) : (input: Float32Array) => input;
  let pos = 0; // 가상 배열 [prev, ...input] 기준 읽기 위치
  let prev = 0; // 직전 블록의 마지막 샘플 (가상 인덱스 0)
  return (raw: Float32Array): Float32Array => {
    if (raw.length === 0) return raw;
    const input = filter(raw);
    const out: number[] = [];
    const at = (idx: number): number => (idx === 0 ? prev : input[idx - 1]);
    const vlen = input.length + 1;
    while (pos + 1 < vlen) {
      const i = Math.floor(pos);
      const t = pos - i;
      out.push(at(i) * (1 - t) + at(i + 1) * t);
      pos += ratio;
    }
    pos -= input.length; // 다음 블록의 가상 인덱스 0 = 이번 블록 마지막 샘플
    prev = input[input.length - 1];
    return Float32Array.from(out);
  };
};

// 강제 16kHz 컨텍스트 + 하드웨어 48kHz 마이크를 물리면 브라우저 내부 리샘플에서 주기적 언더런(씹힘)이 난다.
// 하드웨어(네이티브) 레이트로 그대로 받고, 16kHz 로는 JS 에서 연속 리샘플로 내린다.
const createContext = (): AudioContext => new AudioContext();

const OUTPUT_SAMPLE_RATE = 16000;
/** 워커로 넘길 프레임 크기 — 100ms(16kHz). 잘게 넘기면 malloc/ccall/디코드 호출 오버헤드가 커져 실시간을 못 따라간다 */
const OUTPUT_FRAME = 1600;

// 에코 제거는 끈다: 이 앱은 녹음 중 소리를 내지 않는데, OS 의 에코 제거가 스피커로 나오는
// 다른 사람 목소리(회의 스피커폰 등)를 "에코"로 보고 몇 초 뒤부터 지워 버린다.
// 잡음 억제도 끈다: 가까운 말소리에 맞춰져 있어 멀리 있는 회의 참석자의 말을 잡음으로 지운다. 잡음은 인식 모델이 견딘다.
export const MIC_AUDIO_CONSTRAINTS = { echoCancellation: false, noiseSuppression: false, autoGainControl: true };

/** 마이크 → Float32 샘플 콜백. AudioWorklet 을 못 쓰는 브라우저는 ScriptProcessor 로 대체한다 */
export const startMicCapture = async (onSamples: (samples: Float32Array) => void, sharedTrack?: MediaStreamTrack): Promise<MicCapture> => {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('이 브라우저나 주소에서는 마이크를 쓸 수 없습니다 (HTTPS 또는 localhost 필요)');
  }
  // 번역 세션은 이미 연 트랙을 복제해 쓴다. 복제본은 일시정지와 정지가 원본과 따로 논다
  let stream = sharedTrack
    ? new MediaStream([sharedTrack.clone()])
    : await navigator.mediaDevices.getUserMedia({ audio: MIC_AUDIO_CONSTRAINTS });
  const context = createContext();
  await context.resume();
  let source = context.createMediaStreamSource(stream);
  // 출력은 내지 않지만 그래프가 돌게 하려고 0 게인으로 destination 에 잇는다
  const sink = context.createGain();
  sink.gain.value = 0;
  let paused = false;
  // 네이티브 레이트 → 16kHz 연속 리샘플 (호출자는 항상 16kHz 를 받는다)
  const resample = createResampler(context.sampleRate, OUTPUT_SAMPLE_RATE);
  // 입력 크기를 고르게 맞춘다 — 저장 WAV 와 인식기가 같은 샘플을 받는다
  const normalize = createLevelNormalizer(OUTPUT_SAMPLE_RATE);
  // 리샘플 출력을 100ms 프레임으로 모아서 넘긴다 (워커 호출 빈도를 낮춰 실시간 유지)
  let acc = new Float32Array(0);
  const deliver = (samples: Float32Array) => {
    if (paused) return;
    const out = resample(samples);
    if (out.length === 0) return;
    const merged = new Float32Array(acc.length + out.length);
    merged.set(acc);
    merged.set(out, acc.length);
    let off = 0;
    while (merged.length - off >= OUTPUT_FRAME) {
      onSamples(normalize(merged.subarray(off, off + OUTPUT_FRAME)));
      off += OUTPUT_FRAME;
    }
    acc = merged.slice(off);
  };

  let node: AudioNode;
  if (context.audioWorklet) {
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const worklet = new AudioWorkletNode(context, 'pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
    });
    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => deliver(event.data);
    node = worklet;
  } else {
    const processor = context.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => deliver(new Float32Array(event.inputBuffer.getChannelData(0)));
    node = processor;
  }
  source.connect(node);
  node.connect(sink);
  sink.connect(context.destination);

  return {
    // 호출자가 받는 샘플은 이미 16kHz (내부에서 네이티브→16kHz 리샘플했다)
    sampleRate: OUTPUT_SAMPLE_RATE,
    pause: () => {
      paused = true;
      stream.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
    },
    resume: async () => {
      stream.getAudioTracks().forEach((track) => {
        track.enabled = true;
      });
      // Safari 는 앱 전환·화면 잠금 때 컨텍스트를 interrupted 로 두고, 트랙을 끝내기도 한다
      if (context.state !== 'running') await context.resume();
      const ended = stream.getAudioTracks().every((track) => track.readyState === 'ended');
      if (ended && !sharedTrack) {
        const next = await navigator.mediaDevices.getUserMedia({ audio: MIC_AUDIO_CONSTRAINTS });
        source.disconnect();
        stream = next;
        source = context.createMediaStreamSource(stream);
        source.connect(node);
      }
      paused = false;
    },
    stop: async () => {
      paused = true;
      source.disconnect();
      node.disconnect();
      sink.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      await context.close();
    },
  };
};