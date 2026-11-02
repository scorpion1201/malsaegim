import { createVoiceDetector, frameDb } from './voiceDetector';

/** 말소리 큰 쪽(프레임 RMS)을 이 크기에 맞춘다 */
const TARGET_DB = -20;
/** 키울 수 있는 상한 — 아이패드 내장 마이크의 먼 말소리(-70 dBFS)까지 들리게 키운다. 말소리 없는 구간은 판정이 막아 키우지 않는다 */
const MAX_GAIN_DB = 40;
/** 샘플 최대값 상한 — 갑자기 큰 소리가 나도 PCM16 에서 잘리지 않게 그 프레임의 게인을 바로 줄인다 */
const PEAK_LIMIT = 0.95;
/** 말소리 크기 추정이 올라가는 비율 (프레임당, 큰 소리는 빠르게 따라간다) */
const LEVEL_ATTACK = 0.5;
/** 말소리 크기 추정이 내려가는 속도 (말소리 초당 dB) — 작은 소리의 화자가 이어져도 그 화자에 맞춰 내려온다 */
const LEVEL_RELEASE_DB_PER_SEC = 1.5;
/** 게인을 올리는 속도 (초당 dB) — 쉼 동안 잡음이 숨 쉬듯 커지지 않게 천천히 올린다 */
const GAIN_RISE_DB_PER_SEC = 6;
/** 말소리가 이만큼 없으면 크기 추정을 버리고 게인을 내린다 — 말소리 아닌 큰 소리 하나가 남긴 게인으로 빈 방을 키우지 않는다 */
const GAIN_HOLD_MS = 10_000;
/** 게인을 내리는 속도 (초당 dB) */
const GAIN_FALL_DB_PER_SEC = 3;
/** 게인이 바뀔 때 프레임 앞에서 이어 붙이는 길이 (샘플) — 계단 잡음 방지 */
const RAMP_SAMPLES = 160;

/**
 * 소프트웨어 자동 음량 보정 — 브라우저의 autoGainControl 에 기대지 않는다. 이 제약을 켠 채 녹음해도
 * 아이패드 내장 마이크의 말소리가 -55 dBFS 근처로 저장됐다. PCM16 으로 바꾸기 전(float)에 키워야 해상도를 잃지 않는다.
 * 저장 WAV 와 인식기가 같은 샘플을 받으므로 타임스탬프와 들리는 소리가 어긋나지 않는다.
 */
export const createLevelNormalizer = (sampleRate: number): ((frame: Float32Array) => Float32Array) => {
  const detector = createVoiceDetector();
  /** 말소리 크기 추정 (dBFS). 말소리를 듣기 전에는 null */
  let levelDb: number | null = null;
  let gainDb = 0;
  let gain = 1;
  let idleMs = 0;
  return (frame) => {
    const frameMs = (frame.length / sampleRate) * 1000;
    const db = frameDb(frame);
    // 확정된 말소리만 게인을 움직인다 — 잡음을 잘못 본 프레임 하나로 빈 방을 30 dB 키우지 않는다
    if (detector.classify(frame) && detector.confirmed()) {
      idleMs = 0;
      if (levelDb === null) {
        levelDb = db;
        gainDb = Math.min(MAX_GAIN_DB, Math.max(0, TARGET_DB - db));
      }
      levelDb = db > levelDb ? levelDb + (db - levelDb) * LEVEL_ATTACK : levelDb - (LEVEL_RELEASE_DB_PER_SEC * frameMs) / 1000;
    } else {
      idleMs += frameMs;
    }
    if (idleMs >= GAIN_HOLD_MS) {
      levelDb = null;
      gainDb = Math.max(0, gainDb - (GAIN_FALL_DB_PER_SEC * frameMs) / 1000);
    } else if (levelDb !== null) {
      const desired = Math.min(MAX_GAIN_DB, Math.max(0, TARGET_DB - levelDb));
      gainDb = desired < gainDb ? desired : Math.min(desired, gainDb + (GAIN_RISE_DB_PER_SEC * frameMs) / 1000);
    }
    let peak = 0;
    for (let i = 0; i < frame.length; i += 1) peak = Math.max(peak, Math.abs(frame[i]));
    const limit = peak > 0 ? PEAK_LIMIT / peak : Infinity;
    const next = Math.min(10 ** (gainDb / 20), limit);
    // 이어 붙이는 구간도 한도를 넘지 않는다 — 앞 프레임의 큰 게인이 갑자기 커진 소리에 곱해지면 잘린다
    const from = Math.min(gain, limit);
    const out = new Float32Array(frame.length);
    const ramp = Math.min(RAMP_SAMPLES, frame.length);
    for (let i = 0; i < frame.length; i += 1) {
      out[i] = frame[i] * (i < ramp ? from + ((next - from) * (i + 1)) / ramp : next);
    }
    gain = next;
    return out;
  };
};