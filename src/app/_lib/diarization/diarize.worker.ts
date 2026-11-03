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

const diarize = async ({ pcm, runtime, threads }: DiarizeRequest) => {
  const ort = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ new URL(runtime.ortUrl, location.origin).href)) as OrtModule;
  ort.env.wasm.wasmPaths = new URL(runtime.wasmBaseUrl, location.origin).href;
  ort.env.wasm.numThreads = threads;
  const response = await fetch(runtime.modelUrl);
  if (!response.ok) throw new Error(`화자 모델을 받지 못했습니다 (${response.status})`);
  const session = await ort.InferenceSession.create(new Uint8Array(await response.arrayBuffer()));
  const { turns } = await runDiarization(
    pcm,
    {
      embed: async (features) => (await session.run({ x: new ort.Tensor('float32', features, [1, WINDOW_FRAMES, MEL_BINS]) })).embedding.data,
      classify: null,
    },
    (ratio) => post({ type: 'progress', ratio }),
  );
  post({ type: 'done', turns });
};

self.onmessage = (event: MessageEvent<DiarizeRequest>) => {
  diarize(event.data).catch((error: unknown) => post({ type: 'error', message: error instanceof Error ? error.message : String(error) }));
};