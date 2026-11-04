import { MEL_BINS } from './fbank';
import type { DiarizeRequest, DiarizeResponse } from './diarizeProtocol';
import { WINDOW_FRAMES, runDiarization } from './diarizePipeline';

/** onnxruntime-web 에서 워커가 쓰는 부분만 — 런타임은 /models 에서 그대로 읽어 번들에 넣지 않는다 */
type Tensor = { data: Float32Array };
type OrtModule = {
  env: { wasm: { wasmPaths: string; numThreads: number } };
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => Tensor;
  InferenceSession: {
    create: (model: Uint8Array) => Promise<{ run: (feeds: Record<string, Tensor>) => Promise<Record<string, Tensor>> }>;
  };
};

const post = (message: DiarizeResponse) => (self as unknown as { postMessage: (message: DiarizeResponse) => void }).postMessage(message);

type Session = Awaited<ReturnType<OrtModule['InferenceSession']['create']>>;

const sha256 = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');

/** 말소리 분류 모델 — 받지 못하거나 열지 못하면 null 로 지금의 voiceDetector 경로를 쓴다 */
const loadSpeechModel = async (ort: OrtModule, url: string | undefined): Promise<{ session: Session; id: string } | null> => {
  if (!url) return null;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { session: await ort.InferenceSession.create(bytes), id: await sha256(bytes) };
  } catch (error) {
    console.debug(`[diarize] speech model unavailable, using voice detector (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
};

const diarize = async ({ pcm, runtime, threads }: DiarizeRequest) => {
  const ort = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ new URL(runtime.ortUrl, location.origin).href)) as OrtModule;
  ort.env.wasm.wasmPaths = new URL(runtime.wasmBaseUrl, location.origin).href;
  ort.env.wasm.numThreads = threads;
  const response = await fetch(runtime.modelUrl);
  if (!response.ok) throw new Error(`화자 모델을 받지 못했습니다 (${response.status})`);
  const speakerBytes = new Uint8Array(await response.arrayBuffer());
  const session = await ort.InferenceSession.create(speakerBytes);
  const speech = await loadSpeechModel(ort, runtime.speechModelUrl);
  if (speech) console.debug('[diarize] speech model loaded');
  const { turns, speakers } = await runDiarization(
    pcm,
    {
      embed: async (features) => (await session.run({ x: new ort.Tensor('float32', features, [1, WINDOW_FRAMES, MEL_BINS]) })).embedding.data,
      classify: speech && (async (logMel, frames) => (await speech.session.run({ logmel: new ort.Tensor('float32', logMel, [1, frames, MEL_BINS]) })).probs.data),
      modelIds: { speaker: await sha256(speakerBytes), speech: speech?.id ?? null },
    },
    (ratio) => post({ type: 'progress', ratio }),
  );
  const cleanMs = speakers.map((speaker) => speaker.cleanSpans.reduce((sum, span) => sum + span.endMs - span.startMs, 0));
  console.debug(`[diarize] ${speakers.length} speakers, clean ms ${cleanMs.join(' ')}`);
  post({ type: 'done', turns, speakers });
};

self.onmessage = (event: MessageEvent<DiarizeRequest>) => {
  diarize(event.data).catch((error: unknown) => post({ type: 'error', message: error instanceof Error ? error.message : String(error) }));
};