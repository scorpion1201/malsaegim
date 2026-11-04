/**
 * 화자 구분 파이프라인 — 워커와 평가 도구(node)가 같은 코드를 쓴다. 모델 실행은 deps 로 받는다.
 * 말소리 창 고르기 → 화자 임베딩 → 묶기 → 말 차례
 */
import { createVoiceDetector } from '@/app/_lib/audio/voiceDetector';
import { CLUSTER_PARAMS, type ClusterParams, clusterWith } from './clusterSpeakers';
import { HOP_SAMPLES, createFbank } from './fbank';
import type { DiarizeResult, SpeakerPrint } from './diarizeProtocol';
import { SPEECH_THRESHOLDS, classifyChunks, speechMask } from './speechClassifier';
import { buildSpeakerTurns } from './speakerTurns';

export type PipelineDeps = {
  /** 창 특징(WINDOW_FRAMES × MEL_BINS) → 화자 임베딩(EMBEDDING_DIM, 정규화 전) */
  embed: (features: Float32Array) => Promise<Float32Array>;
  /** 조각 log-mel(frames × MEL_BINS) → 프레임별 [말소리, 겹침] 확률(frames × 2). 없으면 voiceDetector 로 고른다 */
  classify: ((logMel: Float32Array, frames: number) => Promise<Float32Array>) | null;
  /** 지문이 어느 모델로 만들어졌는지 — 모델이 바뀌면 등록된 지문을 다시 만들어야 한다 */
  modelIds?: { speaker: string; speech: string | null };
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
/** 창 안에서 겹친 프레임이 이 비율 이상이면 묶기에 넣지 않는다 — 두 목소리가 섞인 임베딩은 엉뚱한 묶음을 만든다 */
const MAX_OVERLAP_RATIO = 0.1;
/** 겹침 확률이 이 값 이상인 프레임을 겹침으로 본다 */
const OVERLAP_THRESHOLD = 0.5;
/** 겹침이 이 프레임 수(10 ms) 이상 이어져야 겹침 시작으로 친다 — 한두 프레임 튐은 말 차례 경계를 엉뚱하게 옮긴다 */
const OVERLAP_ONSET_FRAMES = 5;
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

/** 분류 모델 판정(10 ms)으로 창을 고른다 — 말소리 60% 이상, 겹침 10% 미만 */
const classifiedWindows = (samples: number, speech: Uint8Array, overlap: Uint8Array): number[] => {
  const starts: number[] = [];
  for (let start = 0; start + WINDOW_SAMPLES <= samples; start += STEP_FRAMES * HOP_SAMPLES) {
    const first = start / HOP_SAMPLES;
    let voiced = 0;
    let overlapped = 0;
    for (let t = first; t < first + WINDOW_FRAMES && t < speech.length; t += 1) {
      voiced += speech[t];
      overlapped += overlap[t];
    }
    if (voiced >= WINDOW_FRAMES * MIN_VOICED_RATIO && overlapped < WINDOW_FRAMES * MAX_OVERLAP_RATIO) starts.push(start);
  }
  return starts;
};

/** 100 ms 판정을 log-mel 프레임(10 ms) 단위로 펼친다 — 평가 도구가 말소리 오탐·놓침을 잰다 */
const toLogMelFrames = (voiced: Uint8Array, samples: number): Uint8Array => {
  const frames = Math.max(0, Math.floor((samples - FRAME_SAMPLES) / HOP_SAMPLES) + 1);
  return Uint8Array.from({ length: frames }, (_, t) => voiced[Math.min(voiced.length - 1, Math.floor((t * HOP_SAMPLES + FRAME_SAMPLES / 2) / VAD_FRAME_SAMPLES))] ?? 0);
};

/** 묶기 전 단계 결과 — 평가 도구는 이것을 한 번 만들어 두고 묶기 값만 바꿔 본다 */
export type EmbeddedWindows = {
  /** 창 시작 샘플 */
  starts: number[];
  /** 창별 화자 임베딩 (L2 정규화) */
  embeddings: Float32Array;
  /** log-mel 프레임(10 ms)별 말소리 판정 */
  speechFrames: Uint8Array;
  /** 프레임별 깨끗한 말소리 — 분류 모델이 말소리로 보고 겹침이 없는 프레임. 모델이 없으면 말소리 판정과 같다 */
  cleanFrames: Uint8Array;
  /** 겹침이 시작되는 시각(ms) — 모델이 없으면 빈 배열 */
  overlapStartsMs: number[];
  totalMs: number;
  modelIds: { speaker: string; speech: string | null };
};

export const embedWindows = async (pcm: Int16Array, deps: PipelineDeps, onProgress: (ratio: number) => void): Promise<EmbeddedWindows> => {
  let starts: number[];
  let speechFrames: Uint8Array;
  let cleanFrames: Uint8Array;
  const overlapStartsMs: number[] = [];
  if (deps.classify) {
    const probs = await classifyChunks(pcm, deps.classify);
    speechFrames = speechMask(probs.speech, SPEECH_THRESHOLDS);
    const overlap = Uint8Array.from(probs.overlap, (p) => (p >= OVERLAP_THRESHOLD ? 1 : 0));
    starts = classifiedWindows(pcm.length, speechFrames, overlap);
    cleanFrames = speechFrames.map((value, t) => value & (overlap[t] ^ 1));
    let run = 0;
    for (let t = 0; t < overlap.length; t += 1) {
      run = overlap[t] ? run + 1 : 0;
      if (run === OVERLAP_ONSET_FRAMES) overlapStartsMs.push((t - OVERLAP_ONSET_FRAMES + 1) * 10);
    }
  } else {
    const voiced = voiceActivity(pcm);
    starts = speechWindows(pcm, voiced);
    speechFrames = toLogMelFrames(voiced, pcm.length);
    cleanFrames = speechFrames;
  }
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
  return {
    starts,
    embeddings,
    speechFrames,
    cleanFrames,
    overlapStartsMs,
    totalMs: (pcm.length / SAMPLE_RATE) * 1000,
    modelIds: deps.modelIds ?? { speaker: '', speech: null },
  };
};

/** 화자별 지문 재료 — 임베딩 평균과, 창 전체가 깨끗한 말소리인 구간 */
const speakerPrints = (windows: EmbeddedWindows, labels: Int32Array): SpeakerPrint[] => {
  const prints = new Map<number, { sum: Float64Array; spans: { startMs: number; endMs: number }[] }>();
  labels.forEach((speaker, index) => {
    const entry = prints.get(speaker) ?? { sum: new Float64Array(EMBEDDING_DIM), spans: [] };
    for (let k = 0; k < EMBEDDING_DIM; k += 1) entry.sum[k] += windows.embeddings[index * EMBEDDING_DIM + k];
    const first = windows.starts[index] / HOP_SAMPLES;
    let clean = true;
    for (let t = first; t < first + WINDOW_FRAMES && clean; t += 1) clean = windows.cleanFrames[t] === 1;
    if (clean) {
      const startMs = (windows.starts[index] / SAMPLE_RATE) * 1000;
      const last = entry.spans.at(-1);
      if (last && last.endMs >= startMs) last.endMs = startMs + WINDOW_MS;
      else entry.spans.push({ startMs, endMs: startMs + WINDOW_MS });
    }
    prints.set(speaker, entry);
  });
  return [...prints.entries()]
    .sort(([a], [b]) => a - b)
    .map(([speaker, { sum, spans }]) => {
      const norm = Math.sqrt(sum.reduce((total, value) => total + value * value, 0)) || 1;
      return {
        speaker,
        centroid: Array.from(sum, (value) => value / norm),
        cleanSpans: spans.map((span) => ({ startMs: Math.round(span.startMs), endMs: Math.round(span.endMs) })),
        speakerModelSha256: windows.modelIds.speaker,
        speechModelSha256: windows.modelIds.speech,
      };
    });
};

/** 창 임베딩 → 말 차례 */
export const labelWindows = (windows: EmbeddedWindows, params: ClusterParams = CLUSTER_PARAMS): DiarizeResult => {
  const { starts, embeddings, speechFrames, totalMs, overlapStartsMs } = windows;
  const speechMs = speechFrames.reduce((sum, value) => sum + value, 0) * 10;
  const labels = clusterWith(embeddings, EMBEDDING_DIM, speechMs, params);
  const turns = buildSpeakerTurns(
    starts.map((start) => (start / SAMPLE_RATE) * 1000),
    labels,
    WINDOW_MS,
    totalMs,
    overlapStartsMs,
  );
  return { turns, speakers: speakerPrints(windows, labels), speechFrames };
};

export const runDiarization = async (pcm: Int16Array, deps: PipelineDeps, onProgress: (ratio: number) => void): Promise<DiarizeResult> =>
  labelWindows(await embedWindows(pcm, deps, onProgress));