/**
 * On-Device 모델 저장소 — 서버의 /models/manifest.json 이 가리키는 파일들을 Cache Storage 에 한 번만 내려받아 둔다.
 * 진행률은 파일 두 묶음(whisper·sherpa)을 합쳐 하나로 보고, 파일 단위로 완료 즉시 저장해 끊겨도 완료된 파일은 남는다.
 * 워커는 readCachedFile 로 모델을 읽어 emscripten FS 에 써 넣는다.
 */
export type ModelEngine = 'whisper' | 'sherpa';
export type ModelFile = { id: string; name: string; url: string; bytes: number; sha256: string; engine: ModelEngine };
export type ModelManifest = { version: string; totalBytes: number; files: ModelFile[] };
export type ModelProgress = { receivedBytes: number; totalBytes: number; etaSec: number | null };
export type ModelState = { version: string; readyAt: number };

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
    typeof file.sha256 === 'string' &&
    (file.engine === 'whisper' || file.engine === 'sherpa')
  );
};

/** 서버에 모델이 없으면(404) null — 앱은 BYOK 만으로 동작한다 */
export const fetchManifest = async (): Promise<ModelManifest | null> => {
  const response = await fetch(MANIFEST_URL, { cache: 'no-cache' });
  if (response.status === 404) return null;
  if (!response.ok) throw new ModelNetworkError(`manifest ${response.status}`);
  const body = (await response.json().catch(() => null)) as Partial<ModelManifest> | null;
  if (typeof body?.version !== 'string' || !Array.isArray(body.files) || !body.files.every(isFile)) {
    throw new ModelNetworkError('manifest 형식이 잘못되었습니다');
  }
  const files = body.files;
  return { version: body.version, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), files };
};

export const readModelState = (): ModelState | null => {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw) as Partial<ModelState>;
    return typeof state.version === 'string' && typeof state.readyAt === 'number'
      ? { version: state.version, readyAt: state.readyAt }
      : null;
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

export const cachedBytes = async (manifest: ModelManifest): Promise<number> => {
  const cache = await openCache();
  let sum = 0;
  for (const file of manifest.files) sum += await cachedSize(cache, file);
  return sum;
};

export const isComplete = async (manifest: ModelManifest): Promise<boolean> =>
  (await cachedBytes(manifest)) === manifest.totalBytes;

/** 다른 버전의 파일은 지운다 (모델 업데이트 — 새 파일만 다시 받는다) */
export const purgeOtherVersions = async (manifest: ModelManifest): Promise<void> => {
  const cache = await openCache();
  const prefix = `/models/${manifest.version}/`;
  for (const request of await cache.keys()) {
    if (!new URL(request.url).pathname.startsWith(prefix)) await cache.delete(request);
  }
};

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

/** 워커가 모델 파일을 읽는다 — 없으면 null (다시 내려받아야 한다) */
export const readCachedFile = async (url: string): Promise<ArrayBuffer | null> => {
  const cache = await openCache();
  const hit = await cache.match(url);
  return hit ? hit.arrayBuffer() : null;
};

const hex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');

const isQuotaError = (error: unknown): boolean =>
  error instanceof DOMException && (error.name === 'QuotaExceededError' || error.code === 22);

/** 파일 하나를 스트림으로 받아 검증한 뒤 캐시에 넣는다. onBytes 는 받은 바이트 증가분 */
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
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    onBytes(value.byteLength);
  }
  const blob = new Blob(chunks);
  if (blob.size !== file.bytes) throw new ModelIntegrityError(file);
  const digest = hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  if (digest !== file.sha256) throw new ModelIntegrityError(file);
  try {
    await cache.put(
      file.url,
      new Response(blob, { headers: { [BYTES_HEADER]: String(blob.size), 'content-type': 'application/octet-stream' } }),
    );
  } catch (error) {
    if (isQuotaError(error)) throw new ModelQuotaError('브라우저 저장 공간이 부족합니다');
    throw error;
  }
};

export type DownloadOptions = { signal: AbortSignal; onProgress: (progress: ModelProgress) => void };

/** manifest 의 파일을 순서대로 받는다. 이미 받은 파일은 건너뛰고, 내용이 다르면 그 파일만 한 번 더 받는다 */
export const downloadModels = async (manifest: ModelManifest, { signal, onProgress }: DownloadOptions): Promise<void> => {
  const cache = await openCache();
  let received = 0;
  for (const file of manifest.files) received += await cachedSize(cache, file);

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
    const etaSec = speed > 0 && elapsed >= 1000 ? Math.round((manifest.totalBytes - received) / speed / 1000) : null;
    onProgress({ receivedBytes: received, totalBytes: manifest.totalBytes, etaSec });
  };

  report(true);
  for (const file of manifest.files) {
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
        if (error instanceof ModelIntegrityError && attempt === 0) {
          await cache.delete(file.url);
          continue;
        }
        throw error;
      }
    }
    report(true);
  }
  writeModelState({ version: manifest.version, readyAt: Date.now() });
};