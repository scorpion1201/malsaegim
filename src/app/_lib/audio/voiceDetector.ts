/**
 * 말소리 판정 — 음량이 아니라 목소리의 주기성으로 말의 시작을 찾는다. 마이크마다 입력 크기가 수십 dB 씩 달라서
 * (아이패드 내장 마이크의 먼 말소리는 -70 dBFS 까지 내려간다) 크기로는 먼 말소리와 빈 방 잡음을 가를 수 없다.
 * 입력은 16 kHz 다.
 */
/** 말소리로 치는 주기성 — 정규화 자기상관 봉우리. 말소리를 놓치는 쪽이 더 나빠 낮게 잡는다. 잡음의 드문 한 프레임은 조각 판정(MIN_VOICED_FRAMES)이 거른다 */
const VOICING_THRESHOLD = 0.4;
/** 말의 시작은 잡음 바닥보다 이만큼 커야 한다 — 전원 험처럼 일정한 주기음은 바닥 자체라 걸러진다 */
const VOICED_MARGIN_DB = 3;
/** 말하는 중에는 잡음 바닥보다 이만큼 크면 이어진다 — 주기가 없는 자음과 작게 끝나는 어미("~습니다")를 자르지 않는다 */
const HOLD_MARGIN_DB = 6;
/** 주기성이 이만큼 이어져야 말이 시작된다 — 먼 말소리는 모음 한 프레임씩 끊겨 보인다. 잘못 잡힌 한 프레임은 조각 판정(MIN_VOICED_FRAMES)이 거른다 */
const SPEECH_ONSET_MS = 100;
/** 이 길이 안에 CONFIRM_VOICED_MS 만큼 주기가 보이면 잘못 본 잡음이 아니라 말소리로 확정한다 */
const CONFIRM_WINDOW_MS = 1000;
/** 먼 말소리도 1초 안에 넘는 값이다. 빈 방의 오판은 3000 프레임에 몇 개뿐이고 흩어져 있다 */
const CONFIRM_VOICED_MS = 300;
/** 소리가 문턱 아래로 내려가도 이만큼은 말소리로 친다 (hangover) */
const SPEECH_HANGOVER_MS = 200;
/** 잡음 바닥은 최근 이 길이의 프레임에서 잰다 */
const FLOOR_WINDOW_MS = 10_000;
/** 잡음 바닥으로 쓰는 분위수 — 최솟값은 잡음 억제가 만든 순간적인 골에 끌려 내려간다 */
const FLOOR_QUANTILE = 0.2;
const SAMPLES_PER_MS = 16;
/** 자기상관 앞에 4 kHz 로 내린다 — 프레임당 연산을 줄이고 기본 주파수 대역만 남긴다 */
const DECIMATION = 4;
const SMOOTHING = 8;
/** 4 kHz 기준 지연 — 400~80 Hz */
const MIN_LAG = 10;
const MAX_LAG = 50;

export type VoiceDetector = {
  /** 프레임이 말소리인지 판정한다. 프레임 순서대로 불러야 한다 */
  classify: (samples: Float32Array) => boolean;
  /** 방금 판정한 프레임 근처에 주기가 충분했는지 — hangover 와 유지 프레임은 세지 않는다 */
  confirmed: () => boolean;
};

export const frameDb = (samples: Float32Array): number => {
  let energy = 0;
  for (let i = 0; i < samples.length; i += 1) energy += samples[i] * samples[i];
  return 20 * Math.log10(Math.sqrt(energy / Math.max(1, samples.length)) + 1e-9);
};

const decimate = (samples: Float32Array): Float32Array => {
  const out = new Float32Array(Math.max(0, Math.floor((samples.length - SMOOTHING) / DECIMATION)));
  let mean = 0;
  for (let i = 0; i < out.length; i += 1) {
    let sum = 0;
    for (let k = 0; k < SMOOTHING; k += 1) sum += samples[i * DECIMATION + k];
    out[i] = sum;
    mean += sum / out.length;
  }
  for (let i = 0; i < out.length; i += 1) out[i] -= mean;
  return out;
};

const correlation = (signal: Float32Array, lag: number): number => {
  let cross = 0;
  let left = 0;
  let right = 0;
  for (let i = lag; i < signal.length; i += 1) {
    cross += signal[i - lag] * signal[i];
    left += signal[i - lag] * signal[i - lag];
    right += signal[i] * signal[i];
  }
  const norm = Math.sqrt(left * right);
  return norm > 0 ? cross / norm : 0;
};

/**
 * 기본 주파수 대역의 정규화 자기상관 봉우리 (0~1). 봉우리만 본다 — 저음 잡음과 전원 험은 지연이 짧을수록 상관이 높아
 * 그냥 최대값을 고르면 대역 끝(400 Hz)에서 주기음처럼 보인다
 */
const periodicity = (samples: Float32Array): number => {
  const signal = decimate(samples);
  let best = 0;
  let previous = correlation(signal, MIN_LAG - 1);
  let current = correlation(signal, MIN_LAG);
  for (let lag = MIN_LAG; lag <= MAX_LAG && lag + 1 < signal.length; lag += 1) {
    const next = correlation(signal, lag + 1);
    if (current > previous && current >= next) best = Math.max(best, current);
    previous = current;
    current = next;
  }
  return best;
};

export const createVoiceDetector = (): VoiceDetector => {
  const history: number[] = [];
  const recentVoiced: number[] = [];
  let voicedMs = 0;
  let speaking = false;
  let onsetMs = 0;
  let hangoverMs = 0;
  return {
    classify: (samples) => {
      const frameMs = samples.length / SAMPLES_PER_MS;
      const db = frameDb(samples);
      history.push(db);
      if (history.length * frameMs > FLOOR_WINDOW_MS) history.shift();
      const noiseFloorDb = [...history].sort((a, b) => a - b)[Math.floor((history.length - 1) * FLOOR_QUANTILE)];
      const voiced = db >= noiseFloorDb + VOICED_MARGIN_DB && periodicity(samples) >= VOICING_THRESHOLD;
      if (voiced) onsetMs += frameMs;
      else onsetMs = 0;
      recentVoiced.push(voiced ? frameMs : 0);
      voicedMs += recentVoiced[recentVoiced.length - 1];
      if (recentVoiced.length * frameMs > CONFIRM_WINDOW_MS) voicedMs -= recentVoiced.shift() ?? 0;
      if (onsetMs >= SPEECH_ONSET_MS || (speaking && (voiced || db >= noiseFloorDb + HOLD_MARGIN_DB))) {
        speaking = true;
        hangoverMs = SPEECH_HANGOVER_MS;
        return true;
      }
      if (speaking && hangoverMs > 0) {
        hangoverMs -= frameMs;
        return true;
      }
      speaking = false;
      return false;
    },
    confirmed: () => voicedMs >= CONFIRM_VOICED_MS,
  };
};