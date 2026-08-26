import { floatToPcm16 } from './wav';

export type LiveChunkerOptions = {
  sampleRate: number;
  frameMs: number;
  /** 이 길이를 넘기면 짧은 무음(minSilenceFrames)에서도 자른다 */
  targetMs: number;
  /** 이 길이를 넘기면 무음이 없어도 자른다 */
  maxMs: number;
  /** 이 길이를 넘긴 뒤 문장 쉼(pauseFrames)이 오면 자른다 — 실시간성의 핵심 */
  minMs: number;
  /** 무음 판정 (dBFS, 100ms RMS) */
  silenceDb: number;
  /** 조각에 말소리가 있었는지 판정하는 문턱 — silenceDb 보다 낮게 잡아 조용한 마이크도 보낸다 */
  voiceDb: number;
  minSilenceFrames: number;
  pauseFrames: number;
  /** 첫 말소리 앞에 남겨 두는 무음 프레임 수 — 그 앞의 무음은 버려서 녹음이 말소리 직전에서 시작한다 */
  preRollFrames: number;
};

export const DEFAULT_LIVE_CHUNKER_OPTIONS: LiveChunkerOptions = {
  sampleRate: 16000,
  frameMs: 100,
  targetMs: 10_000,
  maxMs: 15_000,
  minMs: 4_000,
  silenceDb: -40,
  voiceDb: -55,
  minSilenceFrames: 3,
  pauseFrames: 6,
  preRollFrames: 3,
};

export type LiveChunk = {
  index: number;
  startMs: number;
  endMs: number;
  pcm: Int16Array;
  /** voiceDb 를 넘은 프레임이 하나라도 있었는지 — 없으면 인식 API 에 보낼 이유가 없다 */
  voiced: boolean;
};

/**
 * 마이크 샘플을 100ms 프레임으로 모으고 세 규칙으로 자른다:
 * min(4초) 을 넘긴 뒤 문장 쉼(600ms 무음) / target(10초) 을 넘긴 뒤 짧은 무음(300ms) / max(15초).
 * 시간축은 녹음된 샘플 수만 센다 (일시정지 구간은 없다).
 * 첫 말소리(voiceDb) 가 들리기 전의 무음은 프리롤 몇 프레임만 남기고 버린다 — 저장 파일과 타임스탬프가 말소리 직전에서 0초가 된다.
 */
export class LiveChunker {
  private readonly frameSamples: number;
  private readonly frame: Float32Array;
  private frameFill = 0;
  private readonly buffer: Int16Array;
  private length = 0;
  private silentRun = 0;
  private voicedFrames = 0;
  private index = 0;
  private emitted = 0;
  /** 첫 말소리를 들었는지 — 그 전 프레임은 preRoll 링에만 잠시 둔다 */
  private started = false;
  private preRoll: Float32Array[] = [];

  constructor(
    private readonly options: LiveChunkerOptions,
    private readonly onChunk: (chunk: LiveChunk) => void,
    private readonly onLevel?: (rms: number) => void,
  ) {
    this.frameSamples = Math.round((options.sampleRate * options.frameMs) / 1000);
    this.frame = new Float32Array(this.frameSamples);
    this.buffer = new Int16Array(Math.ceil((options.sampleRate * options.maxMs) / 1000) + this.frameSamples);
  }

  /** 지금까지 녹음된 길이 (아직 자르지 않은 부분 포함) */
  get recordedMs(): number {
    return this.emitted + this.lengthMs() + (this.frameFill / this.options.sampleRate) * 1000;
  }

  /** 조각으로 내보낸 길이 = 다음 조각의 시작 시각 */
  get emittedMs(): number {
    return this.emitted;
  }

  get chunkCount(): number {
    return this.index;
  }

  push(samples: Float32Array): void {
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(samples.length - offset, this.frameSamples - this.frameFill);
      this.frame.set(samples.subarray(offset, offset + take), this.frameFill);
      this.frameFill += take;
      offset += take;
      if (this.frameFill === this.frameSamples) this.consumeFrame(this.frame, false);
    }
  }

  /** 남은 샘플을 조각으로 내보낸다 (일시정지·중지 시) */
  flush(): void {
    if (this.frameFill > 0) this.consumeFrame(this.frame.subarray(0, this.frameFill), true);
    if (this.length > 0) this.cut();
  }

  private lengthMs(): number {
    return (this.length / this.options.sampleRate) * 1000;
  }

  private consumeFrame(frame: Float32Array, partial: boolean): void {
    let energy = 0;
    for (let i = 0; i < frame.length; i += 1) energy += frame[i] * frame[i];
    const rms = Math.sqrt(energy / Math.max(1, frame.length));
    this.onLevel?.(rms);
    const db = 20 * Math.log10(rms + 1e-9);
    const silent = db < this.options.silenceDb;
    const voiced = db >= this.options.voiceDb;
    this.frameFill = 0;
    if (!this.started) {
      if (!voiced) {
        // 아직 말소리 전: 프리롤 링에만 두고 시간축에는 넣지 않는다
        this.preRoll.push(frame.slice());
        if (this.preRoll.length > this.options.preRollFrames) this.preRoll.shift();
        return;
      }
      this.started = true;
      for (const kept of this.preRoll) {
        this.buffer.set(floatToPcm16(kept), this.length);
        this.length += kept.length;
      }
      this.preRoll = [];
    }
    this.silentRun = silent ? this.silentRun + 1 : 0;
    if (voiced) this.voicedFrames += 1;
    this.buffer.set(floatToPcm16(frame), this.length);
    this.length += frame.length;
    if (partial) return;
    const { maxMs, targetMs, minMs, minSilenceFrames, pauseFrames } = this.options;
    const ms = this.lengthMs();
    const atPause = this.voicedFrames > 0 && this.silentRun >= pauseFrames;
    if (ms >= maxMs || (ms >= targetMs && this.silentRun >= minSilenceFrames) || (ms >= minMs && atPause)) {
      this.cut();
    }
  }

  private cut(): void {
    const ms = this.lengthMs();
    const pcm = this.buffer.slice(0, this.length);
    const startMs = Math.round(this.emitted);
    this.emitted += ms;
    this.onChunk({ index: this.index, startMs, endMs: Math.round(this.emitted), pcm, voiced: this.voicedFrames > 0 });
    this.index += 1;
    this.length = 0;
    this.silentRun = 0;
    this.voicedFrames = 0;
  }
}