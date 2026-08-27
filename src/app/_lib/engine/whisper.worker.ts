import { readCachedFile, type ModelManifest } from './modelStore';
import type { WhisperRequest, WhisperResponse } from './whisperProtocol';

/** malsaegim-engine(wasm)에서 워커가 쓰는 부분만. init/transcribe/정리는 Rust 안에서 하고, 여기서는 ccall 로 부른다 */
type WhisperModule = {
  FS: { writeFile: (path: string, data: Uint8Array) => void; unlink: (path: string) => void };
  ccall: (name: string, ret: string | null, argTypes: string[], args: unknown[]) => number;
  _malloc: (bytes: number) => number;
  _free: (ptr: number) => void;
  HEAPF32: Float32Array;
  UTF8ToString: (ptr: number) => string;
};
type ModuleFactory = (options: { print: (line: string) => void; printErr: (line: string) => void }) => Promise<WhisperModule>;

type WorkerScope = { postMessage: (message: unknown) => void; location: Location };
const scope = self as unknown as WorkerScope;
const post = (message: WhisperResponse) => scope.postMessage(message);

class LoadError extends Error {
  constructor(
    message: string,
    readonly fileId: string | null,
  ) {
    super(message);
  }
}

let whisper: WhisperModule | null = null;
/** 엔진이 stdout 으로 내보내는 줄을 받는 현재 핸들러 (transcribe 중 진행률 PROG 만 온다) */
let onLine: (line: string) => void = () => {};

const load = async (manifest: ModelManifest): Promise<void> => {
  const js = manifest.files.find((file) => file.id === 'whisper-js');
  const model = manifest.files.find((file) => file.id === 'whisper-model');
  if (!js || !model) throw new LoadError('manifest 에 whisper 파일이 없습니다', null);
  const bytes = await readCachedFile(model.url);
  if (!bytes) throw new LoadError('모델 파일이 캐시에 없습니다', model.id);
  // 런타임(JS/wasm)은 HTTP 캐시(immutable)에서 — 번들러는 이 import 를 건드리지 않는다
  const url = new URL(js.url, scope.location.origin).href;
  const loaded = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url)) as { default: ModuleFactory };
  const instance = await loaded.default({
    print: (line) => onLine(line),
    printErr: (line) => console.warn('[whisper]', line),
  });
  instance.FS.writeFile('/model.bin', new Uint8Array(bytes));
  const ok = instance.ccall('msg_init', 'number', ['string'], ['/model.bin']);
  instance.FS.unlink('/model.bin');
  if (ok !== 0) throw new LoadError('모델을 읽을 수 없습니다', model.id);
  whisper = instance;
};

const transcribe = (id: number, pcm: Float32Array, language: string, threads: number): void => {
  if (!whisper) {
    post({ type: 'error', id, message: '모델이 로드되지 않았습니다' });
    return;
  }
  onLine = (line) => {
    const [tag, value] = line.split('\t');
    if (tag === 'PROG') post({ type: 'progress', id, ratio: Math.max(0, Math.min(1, Number(value) / 100)) });
  };
  try {
    const ptr = whisper._malloc(pcm.length * 4);
    whisper.HEAPF32.set(pcm, ptr >> 2);
    // Rust 가 세그먼트를 모아 할루시네이션까지 정리한 텍스트를 돌려준다 (실패 시 널 포인터)
    const outPtr = whisper.ccall('msg_transcribe', 'number', ['number', 'number', 'string', 'number'], [ptr, pcm.length, language, threads]);
    const text = outPtr ? whisper.UTF8ToString(outPtr) : '';
    if (outPtr) whisper.ccall('msg_free_cstr', null, ['number'], [outPtr]);
    whisper._free(ptr);
    onLine = () => {};
    if (!outPtr) post({ type: 'error', id, message: 'whisper_full 실패' });
    else post({ type: 'done', id, text });
  } catch (error) {
    onLine = () => {};
    post({ type: 'error', id, message: error instanceof Error ? error.message : String(error) });
  }
};

self.onmessage = (event: MessageEvent<WhisperRequest>) => {
  const request = event.data;
  if (request.type === 'load') {
    load(request.manifest)
      .then(() => post({ type: 'loaded' }))
      .catch((error: unknown) =>
        post({
          type: 'load-error',
          message: error instanceof Error ? error.message : String(error),
          fileId: error instanceof LoadError ? error.fileId : null,
        }),
      );
    return;
  }
  transcribe(request.id, request.pcm, request.language, request.threads);
};