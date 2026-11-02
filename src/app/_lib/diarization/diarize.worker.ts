import { createVoiceDetector, frameDb } from '@/app/_lib/audio/voiceDetector';
import { clusterSpeakers } from './clusterSpeakers';
import { HOP_SAMPLES, MEL_BINS, createFbank } from './fbank';
import type { DiarizeRequest, DiarizeResponse } from './diarizeProtocol';
import { buildSpeakerTurns } from './speakerTurns';

/** onnxruntime-web 에서 워커가 쓰는 부분만 — 런타임은 /models 에서 그대로 읽어 번들에 넣지 않는다 */
type Tensor = { data: Float32Array };
type OrtModule = {
  env: { wasm: { wasmPaths: string; numThreads: number } };
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => Tensor;
  InferenceSession: {
    create: (model: Uint8Array) => Promise<{ run: (feeds: Record<string, Tensor>) => Promise<Record<string, Tensor>> }>;
  };
};

const SAMPLE_RATE = 16000;
/** 임베딩 창 — 1.5초를 0.75초 간격으로 민다. 창이 짧을수록 경계가 정확하고 길수록 임베딩이 안정적이다 */
const WINDOW_FRAMES = 150;
const STEP_FRAMES = 75;
const WINDOW_SAMPLES = 400 + (WINDOW_FRAMES - 1) * HOP_SAMPLES;
const WINDOW_MS = (WINDOW_SAMPLES / SAMPLE_RATE) * 1000;
const EMBEDDING_DIM = 192;
/** 말소리 판정 프레임 */
const VAD_FRAME_SAMPLES = 1600;
/** 창 안에서 말소리 프레임이 이 비율보다 적으면 임베딩을 뽑지 않는다 */
const MIN_VOICED_RATIO = 0.6;

const post = (message: DiarizeResponse) => (self as unknown as { postMessage: (message: DiarizeResponse) => void }).postMessage(message);

/** 100 ms 프레임별 말소리 여부 */
const voiceActivity = (pcm: Int16Array): Uint8Array => {
  const detector = createVoiceDetector();
  const count = Math.floor(pcm.length / VAD_FRAME_SAMPLES);
  const frame = new Float32Array(VAD_FRAME_SAMPLES);
  const voiced = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) {
    for (let i = 0; i < VAD_FRAME_SAMPLES; i += 1) frame[i] = pcm[index * VAD_FRAME_SAMPLES + i] / 0x8000;
    voiced[index] = detector.classify(frameDb(frame), 100) ? 1 : 0;
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

const diarize = async ({ pcm, runtime, threads }: DiarizeRequest) => {
  const ort = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ new URL(runtime.ortUrl, location.origin).href)) as OrtModule;
  ort.env.wasm.wasmPaths = new URL(runtime.wasmBaseUrl, location.origin).href;
  ort.env.wasm.numThreads = threads;
  const response = await fetch(runtime.modelUrl);
  if (!response.ok) throw new Error(`화자 모델을 받지 못했습니다 (${response.status})`);
  const session = await ort.InferenceSession.create(new Uint8Array(await response.arrayBuffer()));

  const starts = speechWindows(pcm, voiceActivity(pcm));
  const embeddings = new Float32Array(starts.length * EMBEDDING_DIM);
  const fbank = createFbank(WINDOW_FRAMES);
  let lastReport = 0;
  for (let index = 0; index < starts.length; index += 1) {
    const features = new ort.Tensor('float32', fbank(pcm, starts[index]), [1, WINDOW_FRAMES, MEL_BINS]);
    const { embedding } = await session.run({ x: features });
    let norm = 0;
    for (let k = 0; k < EMBEDDING_DIM; k += 1) norm += embedding.data[k] * embedding.data[k];
    norm = Math.sqrt(norm) || 1;
    for (let k = 0; k < EMBEDDING_DIM; k += 1) embeddings[index * EMBEDDING_DIM + k] = embedding.data[k] / norm;
    const now = performance.now();
    if (now - lastReport > 250) {
      lastReport = now;
      post({ type: 'progress', ratio: index / starts.length });
    }
  }
  const totalMs = (pcm.length / SAMPLE_RATE) * 1000;
  const turns = buildSpeakerTurns(
    starts.map((start) => (start / SAMPLE_RATE) * 1000),
    clusterSpeakers(embeddings, EMBEDDING_DIM),
    WINDOW_MS,
    totalMs,
  );
  post({ type: 'done', turns });
};

self.onmessage = (event: MessageEvent<DiarizeRequest>) => {
  diarize(event.data).catch((error: unknown) => post({ type: 'error', message: error instanceof Error ? error.message : String(error) }));
};