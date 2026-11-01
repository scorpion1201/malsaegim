/** whisper 워커 메시지. 워커 하나가 모델 하나를 올려 두고 파일 전사(transcribe)와 실시간 창 인식(live)을 모두 받는다 */
export type WhisperLoad = {
  /** 엔진 런타임(js) URL — wasm 은 같은 디렉터리에서 emscripten 이 찾는다 */
  runtimeUrl: string;
  /** WebGPU 런타임이면 GPU 어댑터를 얻어 GPU 로 돌린다. 어댑터가 없으면 load-error(gpu) — 호스트가 CPU 런타임으로 다시 띄운다 */
  gpu: boolean;
  /** 캐시에 든 모델 파일 */
  model: { id: string; fileId: string; url: string };
};

/** 실제로 인식을 돌리는 백엔드 */
export type WhisperBackend = 'webgpu' | 'cpu';

/** 실시간 창 인식 결과의 어절 하나 — 시각은 창 시작 기준 ms */
export type LiveWord = { t0: number; t1: number; text: string };

export type WhisperRequest =
  | ({ type: 'load' } & WhisperLoad)
  | { type: 'transcribe'; id: number; pcm: Float32Array; language: string; threads: number }
  /** audioCtx: 인코더 길이(20 ms 단위, 0 = 30초 전체) — 짧은 창을 빠르게 */
  | { type: 'live'; id: number; pcm: Float32Array; language: string; threads: number; audioCtx: number };

/** 로드 실패 종류 — missing: 캐시 파일이 없음/깨짐(다시 받기), memory: 메모리 부족(작은 모델 권장), gpu: WebGPU 를 쓸 수 없음(CPU 로), other */
export type LoadFailure = 'missing' | 'memory' | 'gpu' | 'other';

export type WhisperResponse =
  | { type: 'loaded'; backend: WhisperBackend; gpuName: string; initMs: number; heapMB: number }
  /** fileId 가 있으면 그 캐시 파일이 없거나 깨진 것 — 엔진이 지우고 다시 받게 한다 */
  | { type: 'load-error'; message: string; fileId: string | null; failure: LoadFailure }
  | { type: 'progress'; id: number; ratio: number }
  | { type: 'done'; id: number; text: string }
  | { type: 'live-done'; id: number; words: LiveWord[]; inferMs: number }
  | { type: 'error'; id: number; message: string };