import { getApiKey, setApiKey } from './apiKeyStore';

/** 설정 페이지에서 저장하는 음성 인식 API 설정 — 주소와 모델은 localStorage, 키는 암호화 금고에 남는다 */
export type ByokSettings = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export const EMPTY_BYOK_SETTINGS: ByokSettings = { apiKey: '', baseUrl: '', model: '' };

const STORAGE_KEY = 'malsaegim:byok' as const;

const normalize = (value: unknown): ByokSettings => {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Partial<Record<keyof ByokSettings, unknown>>;
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return { apiKey: text(raw.apiKey), baseUrl: text(raw.baseUrl), model: text(raw.model) };
};

export const readByokSettings = (): ByokSettings => {
  if (typeof window === 'undefined') return EMPTY_BYOK_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const stored = normalize(raw ? JSON.parse(raw) : {});
    return { ...stored, apiKey: stored.apiKey || getApiKey(STORAGE_KEY) };
  } catch {
    return EMPTY_BYOK_SETTINGS;
  }
};

/** 모두 비어 있으면 항목 자체를 지운다 (= 서버 설정 사용) */
export const writeByokSettings = (settings: ByokSettings): ByokSettings => {
  const next = normalize(settings);
  try {
    if (!next.apiKey && !next.baseUrl && !next.model) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...next, apiKey: '' }));
    setApiKey(STORAGE_KEY, next.apiKey);
  } catch {
    // 저장 실패(용량·프라이빗 모드)는 조용히 — 이번 세션 값은 그대로 쓴다
  }
  return next;
};

/** 세 값이 모두 있어야 인식을 보낼 수 있다 — 브라우저가 이 주소로 직접 요청하며 서버 기본값은 없다 */
export const isByokComplete = (settings: ByokSettings): boolean =>
  settings.apiKey.length > 0 && settings.baseUrl.length > 0 && settings.model.length > 0;