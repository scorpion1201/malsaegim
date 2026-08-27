import { readCachedFile, type ModelFile, type ModelManifest } from './modelStore';
import type { SherpaRequest, SherpaResponse } from './sherpaProtocol';

/** malsaegim-engine-stream(wasm)에서 워커가 쓰는 부분만. 인식기 설정·디토크나이즈는 Rust 안에서 하고, 여기서는 ccall 로 부른다 */
type StreamModule = {
  FS: { writeFile: (path: string, data: Uint8Array) => void };
  ccall: (name: string, ret: string | null, argTypes: string[], args: unknown[]) => number;
  _malloc: (bytes: number) => number;
  _free: (ptr: number) => void;
  HEAPF32: Float32Array;
  UTF8ToString: (ptr: number) => string;
};
type ModuleFactory = (options: { print: (line: string) => void; printErr: (line: string) => void }) => Promise<StreamModule>;

type WorkerScope = { postMessage: (message: unknown) => void; location: Location };
const scope = self as unknown as WorkerScope;
const post = (message: SherpaResponse) => scope.postMessage(message);

const SAMPLE_RATE = 16000;
/** 부분 텍스트는 바뀔 때마다, 안 바뀌어도 이 간격마다(지연 계산용) 보낸다 */
const PARTIAL_HEARTBEAT_MS = 500;
/** 부분결과를 이 간격보다 자주 GetResult 하지 않는다 — 매 프레임 폴링은 alloc/detok 비용이 커 실시간을 깎아먹는다 */
const PARTIAL_POLL_MS = 150;

class LoadError extends Error {
  constructor(
    message: string,
    readonly fileId: string | null,
  ) {
    super(message);
  }
}

let engine: StreamModule | null = null;
let baseMs = 0;
let totalSamples = 0;
let segmentStartMs = 0;
let lastPartial = '';
let lastPartialAt = 0;
let frameCount = 0;
let loggedSamples = 0;
let lastPollAt = 0;

const nowMs = (): number => baseMs + (totalSamples / SAMPLE_RATE) * 1000;

const MODEL_PATHS: Array<[id: string, path: string]> = [
  ['sherpa-encoder', '/encoder.onnx'],
  ['sherpa-decoder', '/decoder.onnx'],
  ['sherpa-joiner', '/joiner.onnx'],
  ['sherpa-tokens', '/tokens.txt'],
];

const fileById = (manifest: ModelManifest, id: string): ModelFile => {
  const file = manifest.files.find((entry) => entry.id === id);
  if (!file) throw new LoadError(`manifest 에 ${id} 가 없습니다`, null);
  return file;
};

/** 현재 인식 텍스트 (Rust 가 이미 정리·공백 처리한 것) */
const resultText = (): string => {
  if (!engine) return '';
  const ptr = engine.ccall('mss_result', 'number', [], []);
  if (!ptr) return '';
  const text = engine.UTF8ToString(ptr);
  engine.ccall('mss_free_cstr', null, ['number'], [ptr]);
  return text;
};

const load = async (manifest: ModelManifest, base: number): Promise<void> => {
  const url = new URL(fileById(manifest, 'sherpa-js').url, scope.location.origin).href;
  const runtime = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url)) as { default: ModuleFactory };
  const instance = await runtime.default({
    print: (line) => console.debug('[stream]', line),
    printErr: (line) => console.warn('[stream]', line),
  });
  for (const [id, path] of MODEL_PATHS) {
    const file = fileById(manifest, id);
    const bytes = await readCachedFile(file.url);
    if (!bytes) throw new LoadError('모델 파일이 캐시에 없습니다', file.id);
    instance.FS.writeFile(path, new Uint8Array(bytes));
  }
  const rc = instance.ccall(
    'mss_create',
    'number',
    ['string', 'string', 'string', 'string'],
    ['/encoder.onnx', '/decoder.onnx', '/joiner.onnx', '/tokens.txt'],
  );
  if (rc !== 0) throw new LoadError('인식기를 만들 수 없습니다', null);
  engine = instance;
  baseMs = base;
  totalSamples = 0;
  segmentStartMs = base;
  lastPartial = '';
  lastPartialAt = 0;
};

/** 확정 세그먼트를 내보내고 스트림을 리셋한다. 시작 시각은 첫 토큰의 타임스탬프(세그먼트 기준)를 더한 값 */
const emitFinal = () => {
  if (!engine) return;
  const text = resultText();
  if (text) {
    const firstToken = engine.ccall('mss_first_ts', 'number', [], []) as unknown as number;
    post({ type: 'final', text, startMs: Math.round(segmentStartMs + firstToken * 1000), endMs: Math.round(nowMs()) });
  }
  engine.ccall('mss_reset', null, [], []);
  segmentStartMs = nowMs();
  lastPartial = '';
  post({ type: 'partial', text: '', processedMs: Math.round(nowMs()) });
};

const onAudio = (samples: Float32Array) => {
  if (!engine) return;
  const ptr = engine._malloc(samples.length * 4);
  engine.HEAPF32.set(samples, ptr >> 2);
  engine.ccall('mss_accept', null, ['number', 'number', 'number'], [SAMPLE_RATE, ptr, samples.length]);
  engine._free(ptr);
  totalSamples += samples.length;
  frameCount += 1;
  if (totalSamples - loggedSamples >= SAMPLE_RATE * 2) {
    loggedSamples = totalSamples;
    console.log(`[sw] processed ${Math.round(totalSamples / SAMPLE_RATE)}s (${frameCount} frames)`);
  }
  if (engine.ccall('mss_is_endpoint', 'number', [], [])) {
    emitFinal();
    return;
  }
  const at = performance.now();
  if (at - lastPollAt >= PARTIAL_POLL_MS) {
    lastPollAt = at;
    const text = resultText();
    if (text !== lastPartial || at - lastPartialAt >= PARTIAL_HEARTBEAT_MS) {
      lastPartial = text;
      lastPartialAt = at;
      post({ type: 'partial', text, processedMs: Math.round(nowMs()) });
    }
  }
};

const finish = () => {
  if (!engine) {
    post({ type: 'finished' });
    return;
  }
  engine.ccall('mss_input_finished', null, [], []);
  emitFinal();
  engine.ccall('mss_destroy', null, [], []);
  engine = null;
  post({ type: 'finished' });
};

self.onmessage = (event: MessageEvent<SherpaRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'load') {
      load(request.manifest, request.baseMs)
        .then(() => post({ type: 'loaded' }))
        .catch((error: unknown) =>
          post({
            type: 'load-error',
            message: error instanceof Error ? error.message : String(error),
            fileId: error instanceof LoadError ? error.fileId : null,
          }),
        );
    } else if (request.type === 'audio') {
      onAudio(request.samples);
    } else {
      finish();
    }
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};