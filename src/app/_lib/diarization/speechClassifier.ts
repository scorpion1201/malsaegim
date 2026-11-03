/**
 * 말소리/겹침 분류 모델 실행 — 녹음을 10초 조각으로 나눠 앞뒤 1초 문맥을 붙여 넣고 가운데만 쓴다.
 * 조각마다 log-mel 을 새로 계산해 확률만 남기므로 메모리가 녹음 길이만큼 늘지 않는다.
 * 후처리 규칙은 학습 도구(scripts/diarization/tune-vad.py)와 같아야 한다.
 */
import { HOP_SAMPLES, MEL_BINS, createLogMel } from './fbank';

const FRAME_SAMPLES = 400;
const CHUNK_FRAMES = 1000;
const CONTEXT_FRAMES = 100;

export type SpeechThresholds = { on: number; off: number; minSpeechMs: number; minSilenceMs: number };

/** 학습 도구(tune-vad.py)가 검증셋에서 고른 값 */
export const SPEECH_THRESHOLDS: SpeechThresholds = { on: 0.9, off: 0.7, minSpeechMs: 200, minSilenceMs: 300 };

export const logMelFrames = (samples: number): number => Math.max(0, Math.floor((samples - FRAME_SAMPLES) / HOP_SAMPLES) + 1);

/** 프레임 index 를 [0, frames) 안으로 반사한다 — 마지막 조각 채우기 */
const reflect = (index: number, frames: number): number => {
  if (frames === 1) return 0;
  const period = 2 * (frames - 1);
  const folded = ((index % period) + period) % period;
  return folded < frames ? folded : period - folded;
};

/** 녹음 전체의 프레임별 [말소리, 겹침] 확률 */
export const classifyChunks = async (
  pcm: Int16Array,
  run: (logMel: Float32Array, frames: number) => Promise<Float32Array>,
): Promise<{ speech: Float32Array; overlap: Float32Array }> => {
  const frames = logMelFrames(pcm.length);
  const speech = new Float32Array(frames);
  const overlap = new Float32Array(frames);
  const logMel = createLogMel();
  for (let start = 0; start < frames; start += CHUNK_FRAMES) {
    const end = Math.min(frames, start + CHUNK_FRAMES);
    const left = Math.max(0, start - CONTEXT_FRAMES);
    const right = Math.min(frames, end + CONTEXT_FRAMES);
    const real = logMel(pcm, left * HOP_SAMPLES, right - left);
    const length = end - start + 2 * CONTEXT_FRAMES;
    const input = new Float32Array(length * MEL_BINS);
    const available = right - left;
    for (let t = 0; t < length; t += 1) {
      const source = t < available ? t : reflect(t, available);
      input.set(real.subarray(source * MEL_BINS, (source + 1) * MEL_BINS), t * MEL_BINS);
    }
    const probs = await run(input, length);
    for (let t = start; t < end; t += 1) {
      speech[t] = probs[(t - left) * 2];
      overlap[t] = probs[(t - left) * 2 + 1];
    }
  }
  return { speech, overlap };
};

/** 확률 → 말소리 프레임: 히스테리시스, 짧은 쉼 메우기, 짧은 말 지우기 순서 */
export const speechMask = (probs: Float32Array, thresholds: SpeechThresholds): Uint8Array => {
  const active = new Uint8Array(probs.length);
  let state = false;
  for (let t = 0; t < probs.length; t += 1) {
    state = state ? probs[t] >= thresholds.off : probs[t] >= thresholds.on;
    active[t] = state ? 1 : 0;
  }
  const minSilence = thresholds.minSilenceMs / 10;
  let lastOn = -1;
  for (let t = 0; t < active.length; t += 1) {
    if (!active[t]) continue;
    if (lastOn >= 0 && t - lastOn - 1 > 0 && t - lastOn - 1 < minSilence) active.fill(1, lastOn + 1, t);
    lastOn = t;
  }
  const minSpeech = thresholds.minSpeechMs / 10;
  for (let t = 0; t < active.length; ) {
    if (!active[t]) {
      t += 1;
      continue;
    }
    let end = t;
    while (end < active.length && active[end]) end += 1;
    if (end - t < minSpeech) active.fill(0, t, end);
    t = end;
  }
  return active;
};