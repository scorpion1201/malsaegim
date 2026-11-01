/**
 * API 키 금고 — 키는 브라우저를 닫아도 남되 평문으로 저장하지 않는다.
 * 원문을 꺼낼 수 없는(non-extractable) AES-GCM 키를 IndexedDB 에 두고, 그 키로 암호화한 값만 저장한다.
 * 저장소를 복사해 가도 키가 나오지 않지만, 이 출처에서 실행되는 스크립트는 복호화를 호출할 수 있다. 그쪽은 CSP 가 막는다.
 * Web Crypto 가 없는 환경(평문 http 등)에서는 키를 잃지 않도록 예전처럼 설정 레코드에 그대로 둔다.
 */
export type ApiKeySlot = 'malsaegim:byok' | 'malsaegim:translation';

const SLOTS: ApiKeySlot[] = ['malsaegim:byok', 'malsaegim:translation'];
const DB_NAME = 'malsaegim-vault';
const STORE = 'keys';
const MASTER = 'master';

type Sealed = { iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer };

const cache = new Map<ApiKeySlot, string>();
let ready: Promise<boolean> | null = null;
let writes: Promise<unknown> = Promise.resolve();

const request = <T>(run: () => IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    const pending = run();
    pending.onsuccess = () => resolve(pending.result);
    pending.onerror = () => reject(pending.error);
  });

const openVault = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const opening = indexedDB.open(DB_NAME, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore(STORE);
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });

const store = (db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore => db.transaction(STORE, mode).objectStore(STORE);

/** 다른 탭이 먼저 만들었으면 add 가 실패하므로 그 키를 다시 읽는다 */
const masterKey = async (db: IDBDatabase): Promise<CryptoKey> => {
  const existing = await request<CryptoKey | undefined>(() => store(db, 'readonly').get(MASTER));
  if (existing) return existing;
  const created = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  try {
    await request(() => store(db, 'readwrite').add(created, MASTER));
    return created;
  } catch {
    return (await request<CryptoKey>(() => store(db, 'readonly').get(MASTER)));
  }
};

const seal = async (db: IDBDatabase, slot: ApiKeySlot, value: string): Promise<void> => {
  const key = await masterKey(db);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(slot) }, key, new TextEncoder().encode(value));
  await request(() => store(db, 'readwrite').put({ iv, data } satisfies Sealed, slot));
};

const unseal = async (db: IDBDatabase, slot: ApiKeySlot): Promise<string> => {
  const sealed = await request<Sealed | undefined>(() => store(db, 'readonly').get(slot));
  if (!sealed) return '';
  const key = await masterKey(db);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv, additionalData: new TextEncoder().encode(slot) }, key, sealed.data);
  return new TextDecoder().decode(plain);
};

const readRecord = (slot: ApiKeySlot): Record<string, unknown> | null => {
  const raw = window.localStorage.getItem(slot);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
};

/** 예전 버전이 평문으로 남긴 키를 금고로 옮긴다 — 암호화가 끝난 뒤에야 평문을 지운다 */
const migrate = async (db: IDBDatabase, slot: ApiKeySlot): Promise<void> => {
  const record = readRecord(slot);
  if (typeof record?.apiKey !== 'string' || !record.apiKey) return;
  await seal(db, slot, record.apiKey);
  window.localStorage.setItem(slot, JSON.stringify({ ...record, apiKey: '' }));
};

/** 금고를 열어 키를 메모리로 올린다. 키를 읽는 화면은 이 약속이 끝난 뒤에 그린다 */
export const whenApiKeysReady = (): Promise<boolean> => {
  ready ??= (async () => {
    try {
      const db = await openVault();
      for (const slot of SLOTS) {
        await migrate(db, slot);
        if (!cache.has(slot)) cache.set(slot, await unseal(db, slot));
      }
      db.close();
      return true;
    } catch {
      return false;
    }
  })();
  return ready;
};

export const getApiKey = (slot: ApiKeySlot): string => cache.get(slot) ?? '';

/** 메모리는 바로 바꾸고 저장은 순서대로 처리한다. 금고를 못 쓰면 설정 레코드에 남긴다 */
export const setApiKey = (slot: ApiKeySlot, value: string): void => {
  cache.set(slot, value);
  writes = writes
    .then(async () => {
      if (!(await whenApiKeysReady())) {
        const record = readRecord(slot);
        if (record) window.localStorage.setItem(slot, JSON.stringify({ ...record, apiKey: value }));
        return;
      }
      const db = await openVault();
      if (value) await seal(db, slot, value);
      else await request(() => store(db, 'readwrite').delete(slot));
      db.close();
    })
    .catch(() => undefined);
};