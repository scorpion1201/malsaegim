/**
 * 말소리 판정 — 절대 음량이 아니라 잡음 바닥과의 차이로 본다. 마이크마다 입력 크기가 수십 dB 씩 달라서
 * (아이패드 내장 마이크는 말소리가 -55 dBFS 근처다) 고정 문턱으로는 말소리와 쉼을 가를 수 없다.
 */
/** 이보다 작으면 잡음 바닥과 무관하게 무음 — 디지털 무음 뒤 아주 작은 잡음을 말소리로 보지 않는다 */
const SPEECH_MIN_DB = -75;
/** 잡음 바닥보다 이만큼 크면 말이 시작된다 */
const SPEECH_MARGIN_DB = 12;
/** 말하는 중에는 문턱을 낮춰 작게 끝나는 어미("~습니다")를 무음으로 자르지 않는다 (히스테리시스) */
const SPEECH_HOLD_MARGIN_DB = 6;
/** 소리가 문턱 아래로 내려가도 이만큼은 말소리로 친다 (hangover) */
const SPEECH_HANGOVER_MS = 200;
/** 잡음 바닥이 올라가는 속도 (프레임당 dB) — 내려가는 것은 즉시 */
const FLOOR_RISE_DB = 0.05;

export type VoiceDetector = {
  /** 프레임 하나의 크기(dBFS)로 말소리인지 판정한다. 프레임 순서대로 불러야 한다 */
  classify: (db: number, frameMs: number) => boolean;
};

export const frameDb = (samples: Float32Array): number => {
  let energy = 0;
  for (let i = 0; i < samples.length; i += 1) energy += samples[i] * samples[i];
  return 20 * Math.log10(Math.sqrt(energy / Math.max(1, samples.length)) + 1e-9);
};

export const createVoiceDetector = (): VoiceDetector => {
  let noiseFloorDb: number | null = null;
  let speaking = false;
  let hangoverMs = 0;
  return {
    classify: (db, frameMs) => {
      noiseFloorDb = noiseFloorDb === null || db < noiseFloorDb ? db : noiseFloorDb + FLOOR_RISE_DB;
      const margin = speaking ? SPEECH_HOLD_MARGIN_DB : SPEECH_MARGIN_DB;
      if (db >= Math.max(SPEECH_MIN_DB, noiseFloorDb + margin)) {
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
  };
};