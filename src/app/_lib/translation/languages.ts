export const AUTO_SOURCE = 'auto';

export type TranslationLanguage = { code: string; label: string };

/** 2026-11-01 발급 요청으로 확인한 코드. 중국어는 zh 만 받고 간체·번체를 구분하지 않는다 */
export const TARGET_LANGUAGES: TranslationLanguage[] = [
  { code: 'ko', label: '한국어' },
  { code: 'en', label: '영어' },
  { code: 'ja', label: '일본어' },
  { code: 'zh', label: '중국어' },
  { code: 'es', label: '스페인어' },
  { code: 'fr', label: '프랑스어' },
  { code: 'de', label: '독일어' },
  { code: 'it', label: '이탈리아어' },
  { code: 'pt', label: '포르투갈어' },
  { code: 'ru', label: '러시아어' },
  { code: 'ar', label: '아랍어' },
  { code: 'hi', label: '힌디어' },
  { code: 'vi', label: '베트남어' },
  { code: 'th', label: '태국어' },
  { code: 'id', label: '인도네시아어' },
  { code: 'tr', label: '튀르키예어' },
  { code: 'nl', label: '네덜란드어' },
  { code: 'pl', label: '폴란드어' },
  { code: 'sv', label: '스웨덴어' },
  { code: 'uk', label: '우크라이나어' },
  { code: 'ms', label: '말레이어' },
  { code: 'tl', label: '타갈로그어' },
  { code: 'bn', label: '벵골어' },
  { code: 'fa', label: '페르시아어' },
  { code: 'he', label: '히브리어' },
];

export const SOURCE_LANGUAGES: TranslationLanguage[] = [{ code: AUTO_SOURCE, label: '자동 감지' }, ...TARGET_LANGUAGES];

export const languageLabel = (code: string): string =>
  SOURCE_LANGUAGES.find((language) => language.code === code)?.label ?? code;

export const pairLabel = (source: string, target: string): string => `${languageLabel(source)} → ${languageLabel(target)}`;

/** 공백으로 단어를 나누지 않는 언어는 단어 조각 잇기 규칙을 끈다 */
export const usesSpaces = (code: string): boolean => code !== 'ja' && code !== 'zh' && code !== 'th';