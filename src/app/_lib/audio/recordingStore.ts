/**
 * 노트 오디오 원본 저장소 — IndexedDB.
 * recordings: 노트 id 당 원본 하나 — 녹음 노트는 완성된 WAV, 파일 노트는 불러온 파일 그대로(mp3 등).
 * parts: 녹음 중 조각(PCM16 바이트)을 순서대로 쌓아 두는 임시 저장소
 * (탭이 죽어도 마지막 조각까지는 남는다). 중지하면 parts 를 이어 recordings 로 옮기고 지운다.
 */
const DB_NAME = 'malsaegim';
const DB_VERSION = 1;
const RECORDINGS = 'recordings';
const PARTS = 'parts';

export type StoredRecording = {
  id: string;
  blob: Blob;
  mimeType: string;
  durationMs: number;
  updatedAt: number;
};

type StoredPart = { key: string; id: string; seq: number; pcm: ArrayBuffer };

const partKey = (id: string, seq: number): string => `${id}:${String(seq).padStart(8, '0')}`;
const partRange = (id: string): IDBKeyRange => IDBKeyRange.bound(`${id}:`, `${id}:￿`);

const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('이 브라우저에서는 녹음을 저장할 수 없습니다 (IndexedDB 없음)'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORDINGS)) db.createObjectStore(RECORDINGS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(PARTS)) db.createObjectStore(PARTS, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 를 열 수 없습니다'));
  });

const run = <T>(store: string, mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
  openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const request = work(tx.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB 오류'));
        tx.oncomplete = () => db.close();
        tx.onabort = () => db.close();
      }),
  );

export const putRecordingPart = (id: string, seq: number, pcm: ArrayBuffer): Promise<void> =>
  run(PARTS, 'readwrite', (s) => s.put({ key: partKey(id, seq), id, seq, pcm } satisfies StoredPart)).then(() => undefined);

export const listRecordingParts = (id: string): Promise<ArrayBuffer[]> =>
  run<StoredPart[]>(PARTS, 'readonly', (s) => s.getAll(partRange(id))).then((parts) =>
    parts.sort((a, b) => a.seq - b.seq).map((part) => part.pcm),
  );

export const deleteRecordingParts = (id: string): Promise<void> =>
  run(PARTS, 'readwrite', (s) => s.delete(partRange(id))).then(() => undefined);

export const putRecording = (recording: StoredRecording): Promise<void> =>
  run(RECORDINGS, 'readwrite', (s) => s.put(recording)).then(() => undefined);

export const getRecording = (id: string): Promise<StoredRecording | null> =>
  run<StoredRecording | undefined>(RECORDINGS, 'readonly', (s) => s.get(id)).then((value) => value ?? null);

export const deleteRecording = (id: string): Promise<void> =>
  run(RECORDINGS, 'readwrite', (s) => s.delete(id)).then(() => undefined);