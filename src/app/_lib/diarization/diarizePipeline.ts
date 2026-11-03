/**
 * 화자 구분 파이프라인 — 워커와 평가 도구(node)가 같은 코드를 쓴다. 모델 실행은 deps 로 받는다.
 * 말소리 창 고르기 → 화자 임베딩 → 묶기 → 말 차례
 */
import { createVoiceDetector } from '@/app/_lib/audio/voiceDetector';
import { clusterSpeakers } from './clusterSpeakers';
import { HOP_SAMPLES, createFbank } from './fbank';
import type { DiarizeResult } from './diarizeProtocol';
import { buildSpeakerTurns } from './speakerTurns';

export type PipelineDeps = {
  /** 창 특징(WINDOW_FRAMES × MEL_BINS) → 화자 임베딩(EMBEDDING_DIM, 정규화 전) */
  embed: (features: Float32Array) => Promise<Float32Array>;
  /** 조각 log-mel(frames × MEL_BINS) → 프레임별 [말소리, 겹침] 확률(frames × 2). 없으면 voiceDetector 로 고른다 */
  classify: ((logMel: Float32Array, frames: number) => Promise<Float32Array>) | null;
};

export const SAMPLE_RATE = 16000;
/** 임베딩 창 — 1.5초를 0.75초 간격으로 민다. 창이 짧을수록 경계가 정확하고 길수록 임베딩이 안정적이다 */
export const WINDOW_FRAMES = 150;
const STEP_FRAMES = 75;
const FRAME_SAMPLES = 400;
const WINDOW_SAMPLES = FRAME_SAMPLES + (WINDOW_FRAMES - 1) * HOP_SAMPLES;
const WINDOW_MS = (WINDOW_SAMPLES / SAMPLE_RATE) * 1000;
export const EMBEDDING_DIM = 192;
/** 말소리 판정 프레임 */
const VAD_FRAME_SAMPLES = 1600;
/** 창 안에서 말소리 프레임이 이 비율보다 적으면 임베딩을 뽑지 않는다 */
const MIN_VOICED_RATIO = 0.6;
const PROGRESS_INTERVAL_MS = 250;

/** 100 ms 프레임별 말소리 여부 */
const voiceActivity = (pcm: Int16Array): Uint8Array => {
  const detector = createVoiceDetector();
  const count = Math.floor(pcm.length / VAD_FRAME_SAMPLES);
  const frame = new Float32Array(VAD_FRAME_SAMPLES);
  const voiced = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) {
    for (let i = 0; i < VAD_FRAME_SAMPLES; i += 1) frame[i] = pcm[index * VAD_FRAME_SAMPLES + i] / 0x8000;
    voiced[index] = detector.classify(frame) ? 1 : 0;
  }
  return voiced;
};

/** 말소리가 충분한 창의 시작 샘플들 */
const speechWindows = (pcm: Int16Array, voiced: Uint8Array): number[] => {
  const starts: number[] = [];
  for (let start = 0; start + WINDOW_SAMPLES <= pcm.length; start += STEP_FRAMES * HOP_SAMPLES) {
    const first = Math.floor(start / VAD_FRAME_SAMPLES);
    const last = Math.min(voiced.length, Math.ceil((start + WINDOW_SAMPLES) / VAD_FRAME_SAMPLES));
    let count = 0;
    for (let i = first; i < last; i += 1) count += voiced[i];
    if (count >= (last - first) * MIN_VOICED_RATIO) starts.push(start);
  }
  return starts;
};

/** 100 ms 판정을 log-mel 프레임(10 ms) 단위로 펼친다 — 평가 도구가 말소리 오탐·놓침을 잰다 */
const toLogMelFrames = (voiced: Uint8Array, samples: number): Uint8Array => {
  const frames = Math.max(0, Math.floor((samples - FRAME_SAMPLES) / HOP_SAMPLES) + 1);
  return Uint8Array.from({ length: frames }, (_, t) => voiced[Math.min(voiced.length - 1, Math.floor((t * HOP_SAMPLES + FRAME_SAMPLES / 2) / VAD_FRAME_SAMPLES))] ?? 0);
};

export const runDiarization = async (pcm: Int16Array, deps: PipelineDeps, onProgress: (ratio: number) => void): Promise<DiarizeResult> => {
  const voiced = voiceActivity(pcm);
  const starts = speechWindows(pcm, voiced);
  const embeddings = new Float32Array(starts.length * EMBEDDING_DIM);
  const fbank = createFbank(WINDOW_FRAMES);
  let lastReport = 0;
  for (let index = 0; index < starts.length; index += 1) {
    const embedding = await deps.embed(fbank(pcm, starts[index]));
    let norm = 0;
    for (let k = 0; k < EMBEDDING_DIM; k += 1) norm += embedding[k] * embedding[k];
    norm = Math.sqrt(norm) || 1;
    for (let k = 0; k < EMBEDDING_DIM; k += 1) embeddings[index * EMBEDDING_DIM + k] = embedding[k] / norm;
    const now = performance.now();
    if (now - lastReport > PROGRESS_INTERVAL_MS) {
      lastReport = now;
      onProgress(index / starts.length);
    }
  }
  const totalMs = (pcm.length / SAMPLE_RATE) * 1000;
  const turns = buildSpeakerTurns(
    starts.map((start) => (start / SAMPLE_RATE) * 1000),
    clusterSpeakers(embeddings, EMBEDDING_DIM),
    WINDOW_MS,
    totalMs,
  );
  return { turns, speakers: [], speechFrames: toLogMelFrames(voiced, pcm.length) };
};