/**
 * 가져온 노트 파일의 문서 검증 — 파일은 외부에서 오므로 에디터가 쓰는 노드·마크·속성만 받는다.
 * 목록은 Editor.tsx 의 확장 구성과 맞춘다. 확장을 늘리면 여기도 함께 늘려야 가져오기가 된다.
 */
const MAX_DEPTH = 16;
const MAX_NODES = 200_000;
const MAX_TEXT_LENGTH = 5_000_000;

const LANGUAGE_TAG = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/;

type AttrCheck = (value: unknown) => boolean;

const isTime: AttrCheck = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isNullableLanguage: AttrCheck = (value) => value === null || (typeof value === 'string' && LANGUAGE_TAG.test(value));

const NODE_ATTRS: Record<string, Record<string, AttrCheck>> = {
  doc: {},
  paragraph: {
    role: (value) => value === null || value === 'translation' || value === 'source',
    lang: isNullableLanguage,
  },
  heading: { level: (value) => value === 1 || value === 2 || value === 3 },
  bulletList: {},
  orderedList: {
    start: (value) => Number.isInteger(value),
    type: (value) => value === null || value === '1' || value === 'a' || value === 'A' || value === 'i' || value === 'I',
  },
  listItem: {},
  hardBreak: {},
  // offset: 이어 붙인 파트의 시작 시각 — 화면에는 ms - offset 으로 보인다
  timestamp: { ms: isTime, offset: isTime },
  failedChunk: { startMs: isTime, endMs: isTime, offset: isTime },
  speaker: {
    id: (value) => Number.isInteger(value) && Number(value) >= 0,
    name: (value) => value === null || (typeof value === 'string' && value.length <= 40),
  },
};

const MARK_TYPES = new Set(['bold', 'italic', 'underline']);
const NODE_KEYS = new Set(['type', 'attrs', 'content', 'marks', 'text']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validAttrs = (type: string, attrs: unknown): boolean => {
  if (attrs === undefined) return true;
  if (!isRecord(attrs)) return false;
  const rules = NODE_ATTRS[type];
  return Object.entries(attrs).every(([name, value]) => Object.hasOwn(rules, name) && rules[name](value));
};

const validMarks = (marks: unknown): boolean =>
  marks === undefined ||
  (Array.isArray(marks) &&
    marks.every((mark) => isRecord(mark) && Object.keys(mark).length === 1 && typeof mark.type === 'string' && MARK_TYPES.has(mark.type)));

export const isValidNoteDoc = (doc: unknown): boolean => {
  let nodes = 0;
  let textLength = 0;

  const visit = (node: unknown, depth: number): boolean => {
    nodes += 1;
    if (depth > MAX_DEPTH || nodes > MAX_NODES || !isRecord(node) || typeof node.type !== 'string') return false;
    if (!Object.keys(node).every((key) => NODE_KEYS.has(key))) return false;
    if (node.type === 'text') {
      if (typeof node.text !== 'string' || node.text.length === 0 || node.content !== undefined || node.attrs !== undefined) return false;
      textLength += node.text.length;
      return textLength <= MAX_TEXT_LENGTH && validMarks(node.marks);
    }
    if (!Object.hasOwn(NODE_ATTRS, node.type) || node.text !== undefined || !validAttrs(node.type, node.attrs) || !validMarks(node.marks)) return false;
    if (node.content === undefined) return true;
    return Array.isArray(node.content) && node.content.every((child) => visit(child, depth + 1));
  };

  return isRecord(doc) && doc.type === 'doc' && visit(doc, 0);
};

export const isValidTranslationInfo = (value: unknown): boolean => {
  if (value === undefined) return true;
  if (!isRecord(value) || value.model !== 'gpt-realtime-translate') return false;
  const { sourceLanguage, targetLanguage } = value;
  return (
    typeof sourceLanguage === 'string' &&
    typeof targetLanguage === 'string' &&
    LANGUAGE_TAG.test(sourceLanguage) &&
    LANGUAGE_TAG.test(targetLanguage)
  );
};