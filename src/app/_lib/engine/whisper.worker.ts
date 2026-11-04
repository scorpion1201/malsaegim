import { readCachedBlob } from './modelStore';
import type { LiveWord, LoadFailure, WhisperBackend, WhisperLoad, WhisperRequest, WhisperResponse } from './whisperProtocol';

/** malsaegim-engine(wasm)에서 워커가 쓰는 부분만. init/transcribe/정리는 Rust 안에서 하고, 여기서는 ccall 로 부른다 */
type FileSystem = {
  mkdir: (path: string) => void;
  mount: (type: unknown, options: { blobs: Array<{ name: string; data: Blob }> }, path: string) => void;
  unmount: (path: string) => void;
  writeFile: (path: string, data: Uint8Array) => void;
  unlink: (path: string) => void;
};
type WhisperModule = {
  FS: FileSystem;
  WORKERFS?: unknown;
  /** WebGPU 런타임(ASYNCIFY)은 { async: true } 로 불러야 하고 Promise 를 돌려준다 */
  ccall: (name: string, ret: string | null, argTypes: string[], args: unknown[], opts?: { async?: boolean }) => number | Promise<number>;
  _malloc: (bytes: number) => number;
  _free: (ptr: number) => void;
  HEAPF32: Float32Array;
  HEAPU8: Uint8Array;
  UTF8ToString: (ptr: number) => string;
};
type ModuleFactory = (options: { print: (line: string) => void; printErr: (line: string) => void }) => Promise<WhisperModule>;
type GpuNavigator = { gpu?: { requestAdapter: () => Promise<{ features: { has: (name: string) => boolean } } | null> } };

type WorkerScope = { postMessage: (message: unknown) => void; location: Location; navigator: GpuNavigator };
const scope = self as unknown as WorkerScope;
const post = (message: WhisperResponse) => scope.postMessage(message);

const MOUNT = '/model';

class LoadError extends Error {
  constructor(
    message: string,
    readonly fileId: string | null,
    readonly failure: LoadFailure,
  ) {
    super(message);
  }
}

/**
 * wasm 메모리를 늘리지 못한 경우 — emscripten 은 abort 메시지나 RangeError 로 알린다.
 * 콜 스택 초과도 RangeError 지만 메모리 문제가 아니다 — 메모리 부족 안내(small 로 바꾸라는)를 띄우지 않는다
 */
const isMemoryError = (error: unknown): boolean =>
  !/call stack/i.test(String(error)) &&
  (error instanceof RangeError || /out of memory|OOM|Cannot enlarge memory|could not allocate memory|Array buffer allocation/i.test(String(error)));

let whisper: WhisperModule | null = null;
let backend: WhisperBackend = 'cpu';
/** 엔진이 stdout 으로 내보내는 줄을 받는 현재 핸들러 (transcribe 중 진행률 PROG 만 온다) */
let onLine: (line: string) => void = () => {};
/** whisper 가 stderr 로 찍는 최근 로그 — 로드 실패 원인 판정에 쓴다 */
let lastErrLines: string[] = [];

const call = async (name: string, ret: string | null, argTypes: string[], args: unknown[]): Promise<number> => {
  if (!whisper) throw new Error('모델이 로드되지 않았습니다');
  return whisper.ccall(name, ret, argTypes, args, { async: backend === 'webgpu' });
};

const load = async ({ runtimeUrl, gpu, model }: WhisperLoad) => {
  if (gpu) {
    // ggml-webgpu 는 shader-f16 이 있는 어댑터만 쓴다 — 없으면 런타임을 띄우기 전에 CPU 로 돌린다
    const adapter = await scope.navigator.gpu?.requestAdapter().catch(() => null);
    if (!adapter) throw new LoadError('WebGPU 어댑터를 얻지 못했습니다', null, 'gpu');
    if (!adapter.features.has('shader-f16')) throw new LoadError('WebGPU 어댑터가 shader-f16 을 지원하지 않습니다', null, 'gpu');
  }
  // 모델은 Blob 그대로 — 메모리에 올리지 않고 whisper 가 읽는 만큼만 WORKERFS(FileReaderSync)로 가져온다
  const blob = await readCachedBlob(model.url);
  if (!blob) throw new LoadError('모델 파일이 캐시에 없습니다', model.fileId, 'missing');
  // 런타임(JS/wasm)은 HTTP 캐시(immutable)에서 — 번들러는 이 import 를 건드리지 않는다
  const url = new URL(runtimeUrl, scope.location.origin).href;
  const loaded = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url)) as { default: ModuleFactory };
  const instance = await loaded.default({
    print: (line) => onLine(line),
    printErr: (line) => {
      if (!line.trim()) return;
      lastErrLines = [...lastErrLines.slice(-20), line];
      console.debug('[whisper]', line);
    },
  });
  whisper = instance;
  backend = gpu ? 'webgpu' : 'cpu';
  const startedAt = performance.now();
  let ok: number;
  try {
    if (instance.WORKERFS) {
      instance.FS.mkdir(MOUNT);
      instance.FS.mount(instance.WORKERFS, { blobs: [{ name: 'model.bin', data: blob }] }, MOUNT);
      try {
        ok = await call('msg_init', 'number', ['string', 'number'], [`${MOUNT}/model.bin`, gpu ? 1 : 0]);
      } finally {
        instance.FS.unmount(MOUNT);
      }
    } else {
      // WORKERFS 없이 빌드된 런타임 — 파일을 메모리로 읽어 MEMFS 에 쓴다 (모델 크기의 두 배 메모리가 잠깐 든다)
      instance.FS.writeFile('/model.bin', new Uint8Array(await blob.arrayBuffer()));
      ok = await call('msg_init', 'number', ['string', 'number'], ['/model.bin', gpu ? 1 : 0]);
      instance.FS.unlink('/model.bin');
    }
  } catch (error) {
    whisper = null;
    if (isMemoryError(error)) throw new LoadError('메모리가 부족해 모델을 올리지 못했습니다', null, 'memory');
    if (gpu) throw new LoadError(`WebGPU 로 모델을 올리지 못했습니다: ${String(error)}`, null, 'gpu');
    throw error;
  }
  if (ok !== 0) {
    whisper = null;
    if (gpu) throw new LoadError('WebGPU 로 모델을 올리지 못했습니다', null, 'gpu');
    const memory = lastErrLines.some((line) => /failed to allocate|out of memory/i.test(line));
    if (memory) throw new LoadError('메모리가 부족해 모델을 올리지 못했습니다', null, 'memory');
    throw new LoadError('모델을 읽을 수 없습니다', model.fileId, 'missing');
  }
  const namePtr = gpu ? await call('msg_gpu_name', 'number', [], []) : 0;
  const gpuName = namePtr ? instance.UTF8ToString(namePtr) : '';
  if (gpu && !gpuName) {
    whisper = null;
    throw new LoadError('WebGPU 장치가 등록되지 않았습니다', null, 'gpu');
  }
  return { backend, gpuName, initMs: Math.round(performance.now() - startedAt), heapMB: Math.round(instance.HEAPU8.length / 1048576) };
};

/** PCM 을 wasm 힙에 복사해 fn 을 부르고 결과 문자열을 돌려준다 (실패하면 null) */
const withPcm = async (pcm: Float32Array, run: (ptr: number) => Promise<number>): Promise<string | null> => {
  const engine = whisper;
  if (!engine) throw new Error('모델이 로드되지 않았습니다');
  const ptr = engine._malloc(pcm.length * 4);
  try {
    engine.HEAPF32.set(pcm, ptr >> 2);
    // Rust 가 세그먼트를 모아 할루시네이션까지 정리한 텍스트를 돌려준다 (실패 시 널 포인터)
    const outPtr = await run(ptr);
    if (!outPtr) return null;
    const text = engine.UTF8ToString(outPtr);
    await call('msg_free_cstr', null, ['number'], [outPtr]);
    return text;
  } finally {
    engine._free(ptr);
  }
};

const transcribe = async (id: number, pcm: Float32Array, language: string, threads: number): Promise<void> => {
  onLine = (line) => {
    const [tag, value] = line.split('\t');
    if (tag === 'PROG') post({ type: 'progress', id, ratio: Math.max(0, Math.min(1, Number(value) / 100)) });
  };
  try {
    const text = await withPcm(pcm, (ptr) =>
      call('msg_transcribe', 'number', ['number', 'number', 'string', 'number'], [ptr, pcm.length, language, threads]),
    );
    if (text === null) post({ type: 'error', id, message: 'whisper_full 실패' });
    else post({ type: 'done', id, text });
  } finally {
    onLine = () => {};
  }
};

/** 실시간 창 인식 — "t0\tt1\t어절" 줄을 어절 목록으로 */
const live = async (id: number, pcm: Float32Array, language: string, threads: number, audioCtx: number): Promise<void> => {
  const startedAt = performance.now();
  const raw = await withPcm(pcm, (ptr) =>
    call('msg_transcribe_live', 'number', ['number', 'number', 'string', 'number', 'number'], [ptr, pcm.length, language, threads, audioCtx]),
  );
  if (raw === null) {
    post({ type: 'error', id, message: 'whisper_full 실패' });
    return;
  }
  const words: LiveWord[] = [];
  for (const line of raw.split('\n')) {
    const [t0, t1, text] = line.split('\t');
    if (text) words.push({ t0: Number(t0), t1: Number(t1), text });
  }
  post({ type: 'live-done', id, words, inferMs: Math.round(performance.now() - startedAt) });
};

const handle = async (request: WhisperRequest): Promise<void> => {
  if (request.type === 'load') {
    try {
      post({ type: 'loaded', ...(await load(request)) });
    } catch (error) {
      post({
        type: 'load-error',
        message: error instanceof Error ? error.message : String(error),
        fileId: error instanceof LoadError ? error.fileId : null,
        failure: error instanceof LoadError ? error.failure : isMemoryError(error) ? 'memory' : 'other',
      });
    }
    return;
  }
  try {
    if (request.type === 'transcribe') await transcribe(request.id, request.pcm, request.language, request.threads);
    else await live(request.id, request.pcm, request.language, request.threads, request.audioCtx);
  } catch (error) {
    post({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) });
  }
};

// WebGPU 런타임은 호출마다 await 가 끼어 다음 메시지가 먼저 들어올 수 있다 — 한 번에 하나씩 처리한다
let queue: Promise<void> = Promise.resolve();
self.onmessage = (event: MessageEvent<WhisperRequest>) => {
  const request = event.data;
  queue = queue.then(() => handle(request));
};