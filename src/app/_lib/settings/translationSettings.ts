import { AUTO_SOURCE, SOURCE_LANGUAGES, TARGET_LANGUAGES } from '@/app/_lib/translation/languages';
import { getApiKey, setApiKey } from './apiKeyStore';
import type { ByokSettings } from './byokSettings';

export type NoiseReduction = 'near_field' | 'far_field';

/** 실시간 번역 설정 — BYOK 와 따로 둔다. 전사 공급자와 관계없이 OpenAI 키가 필요하기 때문이다 */
export type TranslationSettings = {
  /** 비면 BYOK 가 OpenAI 일 때 그 키를 쓴다 */
  apiKey: string;
  sourceLanguage: string;
  targetLanguage: string;
  speakerOn: boolean;
  noiseReduction: NoiseReduction;
  speakerHintSeen: boolean;
};

export const DEFAULT_TRANSLATION_SETTINGS: TranslationSettings = {
  apiKey: '',
  sourceLanguage: AUTO_SOURCE,
  targetLanguage: 'ko',
  speakerOn: true,
  noiseReduction: 'far_field',
  speakerHintSeen: false,
};

const STORAGE_KEY = 'malsaegim:translation' as const;

const normalize = (value: unknown): TranslationSettings => {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Partial<Record<keyof TranslationSettings, unknown>>;
  const base = DEFAULT_TRANSLATION_SETTINGS;
  const known = (list: { code: string }[], code: unknown, fallback: string): string =>
    list.some((language) => language.code === code) ? (code as string) : fallback;
  return {
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
    sourceLanguage: known(SOURCE_LANGUAGES, raw.sourceLanguage, base.sourceLanguage),
    targetLanguage: known(TARGET_LANGUAGES, raw.targetLanguage, base.targetLanguage),
    speakerOn: typeof raw.speakerOn === 'boolean' ? raw.speakerOn : base.speakerOn,
    noiseReduction: raw.noiseReduction === 'near_field' ? 'near_field' : base.noiseReduction,
    speakerHintSeen: raw.speakerHintSeen === true,
  };
};

export const readTranslationSettings = (): TranslationSettings => {
  if (typeof window === 'undefined') return DEFAULT_TRANSLATION_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const stored = normalize(raw ? JSON.parse(raw) : {});
    return { ...stored, apiKey: stored.apiKey || getApiKey(STORAGE_KEY) };
  } catch {
    return DEFAULT_TRANSLATION_SETTINGS;
  }
};

export const writeTranslationSettings = (settings: TranslationSettings): TranslationSettings => {
  const next = normalize(settings);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...next, apiKey: '' }));
    setApiKey(STORAGE_KEY, next.apiKey);
  } catch {
    // 저장 실패(용량·프라이빗 모드)는 조용히 — 이번 세션 값은 그대로 쓴다
  }
  return next;
};

export const isOpenAiBaseUrl = (baseUrl: string): boolean => {
  try {
    return new URL(baseUrl.trim()).hostname === 'api.openai.com';
  } catch {
    return false;
  }
};

/** 다른 공급자 키를 OpenAI 로 보내지 않는다 */
export const resolveTranslationKey = (byok: ByokSettings, settings: TranslationSettings): string =>
  settings.apiKey || (isOpenAiBaseUrl(byok.baseUrl) ? byok.apiKey : '');