export const AUTO_SOURCE = 'auto';

export type TranslationLanguage = { code: string; label: string };

/** 발급 오류 메시지의 지원 목록(2026-11-01)과 발급 성공을 확인한 bn. 중국어는 zh 만 받고 간체·번체를 구분하지 않는다 */
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
  { code: 'af', label: '아프리칸스어' },
  { code: 'az', label: '아제르바이잔어' },
  { code: 'be', label: '벨라루스어' },
  { code: 'bg', label: '불가리아어' },
  { code: 'bs', label: '보스니아어' },
  { code: 'ca', label: '카탈루냐어' },
  { code: 'cs', label: '체코어' },
  { code: 'cy', label: '웨일스어' },
  { code: 'da', label: '덴마크어' },
  { code: 'el', label: '그리스어' },
  { code: 'et', label: '에스토니아어' },
  { code: 'fi', label: '핀란드어' },
  { code: 'gl', label: '갈리시아어' },
  { code: 'hr', label: '크로아티아어' },
  { code: 'hu', label: '헝가리어' },
  { code: 'hy', label: '아르메니아어' },
  { code: 'is', label: '아이슬란드어' },
  { code: 'kk', label: '카자흐어' },
  { code: 'kn', label: '칸나다어' },
  { code: 'lt', label: '리투아니아어' },
  { code: 'lv', label: '라트비아어' },
  { code: 'mi', label: '마오리어' },
  { code: 'mk', label: '마케도니아어' },
  { code: 'mr', label: '마라티어' },
  { code: 'ne', label: '네팔어' },
  { code: 'no', label: '노르웨이어' },
  { code: 'ro', label: '루마니아어' },
  { code: 'sk', label: '슬로바키아어' },
  { code: 'sl', label: '슬로베니아어' },
  { code: 'sr', label: '세르비아어' },
  { code: 'sw', label: '스와힐리어' },
  { code: 'ta', label: '타밀어' },
  { code: 'ur', label: '우르두어' },
];

export const SOURCE_LANGUAGES: TranslationLanguage[] = [{ code: AUTO_SOURCE, label: '자동 감지' }, ...TARGET_LANGUAGES];

export const languageLabel = (code: string): string =>
  SOURCE_LANGUAGES.find((language) => language.code === code)?.label ?? code;

export const pairLabel = (source: string, target: string): string => `${languageLabel(source)} → ${languageLabel(target)}`;

/** 공백으로 단어를 나누지 않는 언어는 단어 조각 잇기 규칙을 끈다 */
export const usesSpaces = (code: string): boolean => code !== 'ja' && code !== 'zh' && code !== 'th';