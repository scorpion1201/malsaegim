/**
 * whisper 워커 하나를 앱 전체가 함께 쓴다 — 파일 전사와 실시간 받아쓰기가 같은 모델을 한 번만 올린다(Turbo 는 wasm 힙 ≈ 1.7 GB).
 * 둘은 화면에서 동시에 돌지 않지만, 순서가 겹쳐도 워커가 메시지를 하나씩 처리하므로 안전하다.
 * 인식은 워커 안에서 동기로 돌아 중간에 끊을 수 없다 — 취소는 결과를 버리거나(실시간) 워커를 내린다(파일 전사).
 */
import { deleteCachedFile, runtimeFile, type ModelBundle } from './modelStore';
import type { LoadFailure, WhisperBackend, WhisperRequest, WhisperResponse } from './whisperProtocol';

/** 아무도 쓰지 않은 채 이만큼 지나면 워커를 내려 메모리를 돌려준다 */
const IDLE_MS = 5 * 60_000;

export class WhisperLoadError extends Error {
  name = 'WhisperLoadError';
  constructor(
    message: string,
    readonly failure: LoadFailure,
  ) {
    super(message);
  }
}

/** 워커가 죽었거나 내려가 진행 중이던 요청이 끝나지 못했다 */
export class WhisperStoppedError extends Error {
  name = 'WhisperStoppedError';
}

type Job = { onMessage: (message: WhisperResponse) => void; onStop: (error: Error) => void };
type JobRequest = Exclude<WhisperRequest, { type: 'load' }>;

let worker: Worker | null = null;
let loadedKey: string | null = null;
let backend: WhisperBackend = 'cpu';
/** 이 탭에서 WebGPU 로드가 한 번 실패했다 — 다시 시도하지 않고 CPU 로 띄운다 */
let gpuFailed = false;
let ready: Promise<void> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let holds = 0;
let nextId = 0;
const jobs = new Map<number, Job>();

const clearIdle = () => {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
};

const armIdle = () => {
  clearIdle();
  if (holds === 0 && jobs.size === 0 && worker) idleTimer = setTimeout(shutdownWhisperWorker, IDLE_MS);
};

const stopJobs = (error: Error) => {
  const stopped = [...jobs.values()];
  jobs.clear();
  for (const job of stopped) job.onStop(error);
};

/** 워커를 내린다 — 모델 변경·삭제, 5분 유휴, 파일 전사 취소 시. 진행 중인 요청은 WhisperStoppedError 로 끝난다 */
export const shutdownWhisperWorker = (): void => {
  clearIdle();
  worker?.terminate();
  worker = null;
  loadedKey = null;
  ready = null;
  stopJobs(new WhisperStoppedError('인식 엔진이 종료되었습니다'));
};

const loadFailureMessage = (bundle: ModelBundle, failure: LoadFailure, message: string): string => {
  if (failure === 'missing') return '모델을 다시 내려받아야 합니다';
  if (failure === 'memory') {
    return bundle.model.tier === 'full'
      ? `이 기기의 메모리로는 ${bundle.model.label} 모델을 실행할 수 없습니다. 설정에서 Whisper small 모델로 바꿔 주세요`
      : `이 기기의 메모리로는 ${bundle.model.label} 모델을 실행할 수 없습니다`;
  }
  return message;
};

const GPU_PREF_KEY = 'malsaegim:ondevice-webgpu';
const gpuListeners = new Set<() => void>();

/** 설정 화면이 값 변화를 구독한다 (useSyncExternalStore) */
export const subscribeGpuPreference = (listener: () => void): (() => void) => {
  gpuListeners.add(listener);
  return () => gpuListeners.delete(listener);
};

/** WebGPU 가속 사용 여부 (설정) — 기본 켬. 끄면 CPU 런타임만 쓴다 */
export const readGpuPreference = (): boolean => {
  try {
    return localStorage.getItem(GPU_PREF_KEY) !== 'off';
  } catch {
    return true;
  }
};

export const writeGpuPreference = (enabled: boolean): void => {
  try {
    if (enabled) localStorage.removeItem(GPU_PREF_KEY);
    else localStorage.setItem(GPU_PREF_KEY, 'off');
  } catch {
    // 저장 실패 — 이번 방문에만 적용된다
  }
  gpuFailed = false;
  gpuListeners.forEach((listener) => listener());
  // 다음 인식부터 새 설정으로 띄운다
  shutdownWhisperWorker();
};

/** WebGPU 를 먼저 쓸지 — 설정이 켜져 있고, 브라우저에 WebGPU 가 있고, WebGPU 런타임이 배포됐고, 이 탭에서 실패한 적이 없을 때 */
const wantsGpu = (bundle: ModelBundle): boolean =>
  !gpuFailed &&
  readGpuPreference() &&
  typeof navigator !== 'undefined' &&
  'gpu' in navigator &&
  runtimeFile(bundle, 'engine-webgpu-js') !== undefined;

const spawn = (bundle: ModelBundle, gpu: boolean): Promise<void> => {
  const js = runtimeFile(bundle, gpu ? 'engine-webgpu-js' : 'engine-js');
  if (!js) return Promise.reject(new WhisperLoadError('manifest 에 엔진 런타임이 없습니다', 'other'));
  const instance = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' });
  worker = instance;
  loadedKey = bundle.key;
  const startedAt = performance.now();
  return new Promise<void>((resolve, reject) => {
    instance.onmessage = (event: MessageEvent<WhisperResponse>) => {
      const message = event.data;
      if (message.type === 'loaded') {
        backend = message.backend;
        console.debug(
          `[whisper] ${bundle.model.id} on ${message.backend}${message.gpuName ? ` (${message.gpuName})` : ''} loaded in ${Math.round(performance.now() - startedAt)} ms (init ${message.initMs} ms, heap ${message.heapMB} MB)`,
        );
        resolve();
        return;
      }
      if (message.type === 'load-error') {
        // 캐시 파일이 없거나 깨졌으면 지워서 다음 시작 때 그 파일만 다시 받게 한다
        const file = message.fileId ? bundle.files.find((entry) => entry.id === message.fileId) : undefined;
        if (file) void deleteCachedFile(file.url);
        reject(new WhisperLoadError(loadFailureMessage(bundle, message.failure, message.message), message.failure));
        return;
      }
      const job = jobs.get(message.id);
      if (!job) return; // 버린 요청(취소된 실시간 세션)의 결과
      if (message.type !== 'progress') jobs.delete(message.id);
      job.onMessage(message);
      armIdle();
    };
    instance.onerror = (event) => {
      event.preventDefault();
      // 크래시: 로드 중이면 로드 실패(메모리 부족이 가장 흔하다), 인식 중이면 진행 중인 요청만 실패 → 다음 요청에서 다시 띄운다
      const text = event.message || '인식 엔진이 멈췄습니다';
      const memory = /memory|OOM|allocation/i.test(text);
      // GPU 런타임이 죽었으면 이 탭에서는 CPU 로 다시 띄운다
      if (gpu) gpuFailed = true;
      reject(new WhisperLoadError(loadFailureMessage(bundle, memory ? 'memory' : 'other', text), memory ? 'memory' : 'other'));
      if (worker === instance) {
        worker = null;
        loadedKey = null;
        ready = null;
      }
      instance.terminate();
      stopJobs(new WhisperStoppedError(text));
    };
    instance.postMessage({
      type: 'load',
      runtimeUrl: js.url,
      gpu,
      model: { id: bundle.model.id, fileId: bundle.model.file.id, url: bundle.model.file.url },
    } satisfies WhisperRequest);
  });
};

/** WebGPU 로 먼저 띄우고, 어댑터가 없거나 GPU 로드가 실패하면 그 워커를 내리고 CPU 런타임으로 다시 띄운다 */
const spawnWithFallback = async (bundle: ModelBundle): Promise<void> => {
  if (wantsGpu(bundle)) {
    try {
      await spawn(bundle, true);
      return;
    } catch (error) {
      if (error instanceof WhisperLoadError && error.failure === 'missing') throw error;
      console.warn('[whisper] WebGPU unavailable, falling back to CPU:', error instanceof Error ? error.message : error);
      gpuFailed = true;
      worker?.terminate();
      worker = null;
    }
  }
  await spawn(bundle, false);
};

/** 지금 올라간 워커의 백엔드 — 실시간 창 설정(audio_ctx)과 안내에 쓴다 */
export const whisperBackend = (): WhisperBackend => backend;

/** 이 묶음의 모델이 올라간 워커를 준비한다. 다른 모델이 올라가 있으면 내리고 새로 띄운다 */
export const ensureWhisper = async (bundle: ModelBundle): Promise<void> => {
  clearIdle();
  if (loadedKey !== bundle.key) shutdownWhisperWorker();
  if (!ready) ready = spawnWithFallback(bundle);
  const current = ready;
  try {
    await current;
  } catch (error) {
    if (ready === current) shutdownWhisperWorker();
    throw error;
  } finally {
    armIdle();
  }
};

/** 요청을 보낸다. 돌려준 함수로 결과를 버릴 수 있다(워커 안의 계산은 끝까지 돈다) */
export const postWhisper = (build: (id: number) => JobRequest, job: Job, transfer: Transferable[]): (() => void) => {
  const instance = worker;
  if (!instance) {
    job.onStop(new WhisperStoppedError('인식 엔진이 준비되지 않았습니다'));
    return () => {};
  }
  clearIdle();
  const id = (nextId += 1);
  jobs.set(id, job);
  instance.postMessage(build(id), transfer);
  return () => {
    jobs.delete(id);
    armIdle();
  };
};

/** 실시간 세션 동안 유휴 종료를 막는다 — 돌려준 함수로 푼다 */
export const holdWhisper = (): (() => void) => {
  holds += 1;
  clearIdle();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    armIdle();
  };
};