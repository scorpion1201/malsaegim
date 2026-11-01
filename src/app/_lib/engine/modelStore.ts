/**
 * On-Device 모델 저장소 — 서버의 /models/manifest.json 이 가리키는 파일 중 이 기기에 필요한 묶음(엔진 런타임 + 고른 모델 하나)만
 * Cache Storage 에 한 번 내려받아 둔다. 실시간 받아쓰기와 파일 전사는 같은 워커가 같은 캐시 파일을 읽으므로 중복으로 받지 않는다.
 * 파일은 받는 대로 해시하며 캐시에 흘려 넣어(스트리밍) 모델 크기만큼의 메모리를 따로 잡지 않는다.
 */
import { createSha256 } from './sha256';

export type ModelFile = { id: string; name: string; url: string; bytes: number; sha256: string };
/** full = PC·고사양 기기 기본, lite = 메모리가 부족한 기기 기본 */
export type ModelTier = 'full' | 'lite';
/** 실행 엔진 — 지금은 whisper.cpp(wasm) 하나. 다른 엔진이 생기면 여기에 더하고 워커를 고른다 */
export type ModelEngine = 'whisper';
export type WhisperModel = {
  id: string;
  label: string;
  quant: string;
  tier: ModelTier;
  /** 모델을 올린 뒤 wasm 힙 실측치(MB) — 안내용 */
  memoryMB: number;
  engine: ModelEngine;
  file: ModelFile;
};
export type ModelManifest = { runtime: { version: string; files: ModelFile[] }; models: WhisperModel[] };
/** 이 기기에 내려받는 묶음 — 엔진 런타임 + 모델 하나. key 가 바뀌면(엔진·모델 갱신, 모델 변경) 바뀐 파일만 다시 받는다 */
export type ModelBundle = { key: string; model: WhisperModel; files: ModelFile[]; totalBytes: number };
export type ModelProgress = { receivedBytes: number; totalBytes: number; etaSec: number | null };
export type ModelState = { key: string; readyAt: number };

export const MODEL_CACHE = 'malsaegim-models';
const STATE_KEY = 'malsaegim:models';
const MANIFEST_URL = '/models/manifest.json';
const PROGRESS_INTERVAL_MS = 150;
const SPEED_WINDOW_MS = 5000;
/** 캐시 응답에 실제 크기를 적어 두어 다시 읽지 않고 완료 여부를 판단한다 */
const BYTES_HEADER = 'x-model-bytes';

export class ModelNetworkError extends Error {
  name = 'ModelNetworkError';
}
export class ModelQuotaError extends Error {
  name = 'ModelQuotaError';
}
export class ModelIntegrityError extends Error {
  name = 'ModelIntegrityError';
  constructor(readonly file: ModelFile) {
    super(`${file.name} 의 내용이 서버와 다릅니다`);
  }
}

const isFile = (value: unknown): value is ModelFile => {
  const file = value as Partial<ModelFile> | null;
  return (
    typeof file?.id === 'string' &&
    typeof file.name === 'string' &&
    typeof file.url === 'string' &&
    typeof file.bytes === 'number' &&
    typeof file.sha256 === 'string'
  );
};

const isModel = (value: unknown): value is WhisperModel => {
  const model = value as Partial<WhisperModel> | null;
  return (
    typeof model?.id === 'string' &&
    typeof model.label === 'string' &&
    typeof model.quant === 'string' &&
    (model.tier === 'full' || model.tier === 'lite') &&
    typeof model.memoryMB === 'number' &&
    model.engine === 'whisper' &&
    isFile(model.file)
  );
};

/** 서버에 모델이 없으면(404) null — 앱은 BYOK 만으로 동작한다 */
export const fetchManifest = async (): Promise<ModelManifest | null> => {
  const response = await fetch(MANIFEST_URL, { cache: 'no-cache' });
  if (response.status === 404) return null;
  if (!response.ok) throw new ModelNetworkError(`manifest ${response.status}`);
  const body = (await response.json().catch(() => null)) as Partial<ModelManifest> | null;
  const runtime = body?.runtime;
  if (
    typeof runtime?.version !== 'string' ||
    !Array.isArray(runtime.files) ||
    !runtime.files.every(isFile) ||
    !Array.isArray(body?.models) ||
    body.models.length === 0 ||
    !body.models.every(isModel)
  ) {
    throw new ModelNetworkError('manifest 형식이 잘못되었습니다');
  }
  return { runtime: { version: runtime.version, files: runtime.files }, models: body.models };
};

export const bundleFor = (manifest: ModelManifest, model: WhisperModel): ModelBundle => {
  const files = [...manifest.runtime.files, model.file];
  return {
    key: `${manifest.runtime.version}/${model.id}/${model.file.sha256.slice(0, 12)}`,
    model,
    files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
};

export type RuntimeFileId = 'engine-js' | 'engine-wasm' | 'engine-webgpu-js' | 'engine-webgpu-wasm';

export const runtimeFile = (bundle: ModelBundle, id: RuntimeFileId): ModelFile | undefined =>
  bundle.files.find((file) => file.id === id);

export const readModelState = (): ModelState | null => {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw) as Partial<ModelState>;
    return typeof state.key === 'string' && typeof state.readyAt === 'number' ? { key: state.key, readyAt: state.readyAt } : null;
  } catch {
    return null;
  }
};

export const writeModelState = (state: ModelState): void => {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // 저장 실패는 조용히 — 다음 방문에 캐시를 다시 훑어 판단한다
  }
};

export const clearModelState = (): void => {
  try {
    localStorage.removeItem(STATE_KEY);
  } catch {
    // ignore
  }
};

const openCache = async (): Promise<Cache> => {
  if (typeof caches === 'undefined') throw new ModelQuotaError('이 브라우저에서는 모델을 저장할 수 없습니다 (Cache Storage 없음)');
  return caches.open(MODEL_CACHE);
};

/** 캐시에 있고 크기가 맞는 파일만 "받은 것"으로 친다 */
const cachedSize = async (cache: Cache, file: ModelFile): Promise<number> => {
  const hit = await cache.match(file.url);
  if (!hit) return 0;
  return Number(hit.headers.get(BYTES_HEADER)) === file.bytes ? file.bytes : 0;
};

export const cachedBytes = async (bundle: ModelBundle): Promise<number> => {
  const cache = await openCache();
  let sum = 0;
  for (const file of bundle.files) sum += await cachedSize(cache, file);
  return sum;
};

export const isComplete = async (bundle: ModelBundle): Promise<boolean> => (await cachedBytes(bundle)) === bundle.totalBytes;

/** keep 에 없는 캐시 파일을 지운다 — 엔진·모델 갱신, 모델 변경 뒤 이전 파일 정리 */
export const purgeExcept = async (keep: ModelFile[]): Promise<void> => {
  const cache = await openCache();
  const urls = new Set(keep.map((file) => new URL(file.url, location.origin).pathname));
  for (const request of await cache.keys()) {
    if (!urls.has(new URL(request.url).pathname)) await cache.delete(request);
  }
};

/** manifest 어디에도 없는 파일(이전 버전)만 지운다 — 다른 모델로 바꾸는 중에도 받아 둔 현재 버전 모델은 남긴다 */
export const purgeStale = async (manifest: ModelManifest): Promise<void> =>
  purgeExcept([...manifest.runtime.files, ...manifest.models.map((model) => model.file)]);

export const deleteModels = async (): Promise<void> => {
  clearModelState();
  if (typeof caches !== 'undefined') await caches.delete(MODEL_CACHE);
};

/** 로드에 실패한 파일 하나만 지운다 — 다음 시작 때 그 파일만 다시 받는다 */
export const deleteCachedFile = async (url: string): Promise<void> => {
  const cache = await openCache();
  await cache.delete(url);
  clearModelState();
};

/**
 * 워커가 모델 파일을 읽는다 — 없으면 null (다시 내려받아야 한다).
 * Blob 으로 넘겨 메모리에 올리지 않고(브라우저가 디스크에 둔 채) WORKERFS 가 필요한 만큼만 읽게 한다.
 */
export const readCachedBlob = async (url: string): Promise<Blob | null> => {
  const cache = await openCache();
  const hit = await cache.match(url);
  return hit ? hit.blob() : null;
};

const isQuotaError = (error: unknown): boolean =>
  error instanceof DOMException && (error.name === 'QuotaExceededError' || error.code === 22);

/** 남은 저장 공간이 모자라면 미리 알린다. 큰 모델이 정리(eviction)되지 않도록 영구 저장도 요청한다 (거절돼도 진행) */
const ensureSpace = async (needBytes: number): Promise<void> => {
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
  await storage?.persist?.().catch(() => false);
  const estimate = await storage?.estimate?.().catch(() => undefined);
  if (!estimate?.quota) return;
  const free = estimate.quota - (estimate.usage ?? 0);
  if (free < needBytes) {
    throw new ModelQuotaError(
      `브라우저 저장 공간이 부족합니다 (필요 약 ${Math.ceil(needBytes / 1048576)} MB · 남은 공간 약 ${Math.floor(free / 1048576)} MB)`,
    );
  }
};

/** 파일 하나를 받으면서 해시하고 그대로 캐시에 흘려 넣는다. 끝난 뒤 크기·해시가 다르면 지운다. onBytes 는 받은 바이트 증가분 */
const downloadFile = async (cache: Cache, file: ModelFile, signal: AbortSignal, onBytes: (delta: number) => void): Promise<void> => {
  let response: Response;
  try {
    response = await fetch(file.url, { signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ModelNetworkError('네트워크 오류');
  }
  if (!response.ok || !response.body) throw new ModelNetworkError(`${file.name} ${response.status}`);
  // 로그인이 풀리면 리다이렉트된 HTML 이 온다
  if ((response.headers.get('content-type') ?? '').includes('text/html')) throw new ModelNetworkError('로그인이 필요합니다');
  const hasher = createSha256();
  let size = 0;
  const hashed = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        hasher.update(chunk);
        size += chunk.byteLength;
        onBytes(chunk.byteLength);
        controller.enqueue(chunk);
      },
    }),
    { signal },
  );
  try {
    await cache.put(
      file.url,
      new Response(hashed, { headers: { [BYTES_HEADER]: String(file.bytes), 'content-type': 'application/octet-stream' } }),
    );
  } catch (error) {
    if (signal.aborted) throw error;
    if (isQuotaError(error)) throw new ModelQuotaError('브라우저 저장 공간이 부족합니다');
    // Chromium 시크릿 창은 메모리 저장소라 큰 파일을 넣으면 UnknownError 를 낸다
    if (error instanceof DOMException && error.name === 'UnknownError') {
      throw new ModelQuotaError('모델을 저장할 수 없습니다 (시크릿 창이거나 저장 공간이 부족합니다)');
    }
    throw new ModelNetworkError(error instanceof Error ? error.message : '네트워크 오류');
  }
  if (size !== file.bytes || hasher.hex() !== file.sha256) {
    await cache.delete(file.url);
    throw new ModelIntegrityError(file);
  }
};

export type DownloadOptions = { signal: AbortSignal; onProgress: (progress: ModelProgress) => void };

/** 묶음의 파일을 순서대로 받는다. 이미 받은 파일은 건너뛰고, 내용이 다르면 그 파일만 한 번 더 받는다 */
export const downloadModels = async (bundle: ModelBundle, { signal, onProgress }: DownloadOptions): Promise<void> => {
  const cache = await openCache();
  let received = 0;
  for (const file of bundle.files) received += await cachedSize(cache, file);
  await ensureSpace(bundle.totalBytes - received);

  // 최근 5초 속도로 남은 시간을 추정한다
  const samples: Array<{ at: number; bytes: number }> = [{ at: performance.now(), bytes: received }];
  let lastReport = 0;
  const report = (force: boolean) => {
    const now = performance.now();
    if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return;
    lastReport = now;
    samples.push({ at: now, bytes: received });
    while (samples.length > 2 && now - samples[0].at > SPEED_WINDOW_MS) samples.shift();
    const first = samples[0];
    const elapsed = now - first.at;
    const speed = elapsed > 0 ? (received - first.bytes) / elapsed : 0; // bytes/ms
    const etaSec = speed > 0 && elapsed >= 1000 ? Math.round((bundle.totalBytes - received) / speed / 1000) : null;
    onProgress({ receivedBytes: received, totalBytes: bundle.totalBytes, etaSec });
  };

  report(true);
  for (const file of bundle.files) {
    if ((await cachedSize(cache, file)) === file.bytes) continue;
    for (let attempt = 0; ; attempt += 1) {
      const before = received;
      try {
        await downloadFile(cache, file, signal, (delta) => {
          received += delta;
          report(false);
        });
        break;
      } catch (error) {
        received = before;
        if (error instanceof ModelIntegrityError && attempt === 0) continue;
        throw error;
      }
    }
    report(true);
  }
  writeModelState({ key: bundle.key, readyAt: Date.now() });
};