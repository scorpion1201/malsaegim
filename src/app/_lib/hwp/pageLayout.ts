/**
 * 문서 레이아웃 — 노트마다 저장되고 HWP/HWPX 로 내보낼 때 적용된다.
 * 길이는 mm, 글자 크기는 pt. rhwp 로 넘길 때 HWPUNIT(1mm ≈ 283.465, 1pt = 100) 으로 바꾼다.
 * 클라이언트·서버가 함께 쓰므로 server-only 를 import 하지 않는다.
 */
export type PaperId = 'A4' | 'A3' | 'B4' | 'B5' | 'Letter' | 'Legal';

export type Orientation = 'portrait' | 'landscape';

export type PageMargins = {
  top: number;
  bottom: number;
  left: number;
  right: number;
  header: number;
  footer: number;
  gutter: number;
};

export type PageLayout = {
  paper: PaperId;
  orientation: Orientation;
  margins: PageMargins;
  bodyFont: string;
  bodyPt: number;
  titlePt: number;
};

export const PAPERS: Record<PaperId, { label: string; width: number; height: number }> = {
  A4: { label: 'A4', width: 210, height: 297 },
  A3: { label: 'A3', width: 297, height: 420 },
  B4: { label: 'B4', width: 257, height: 364 },
  B5: { label: 'B5', width: 182, height: 257 },
  Letter: { label: 'Letter', width: 216, height: 279 },
  Legal: { label: 'Legal', width: 216, height: 356 },
};

export const PAPER_IDS = Object.keys(PAPERS) as PaperId[];

/** 한글에 기본으로 들어 있는 글꼴만 — 받는 쪽 PC 에 없으면 한글이 대체 글꼴로 연다 */
export const BODY_FONTS = ['함초롬돋움', '함초롬바탕', '맑은 고딕', '나눔고딕', '바탕', '돋움'];

/** 한글 기본 편집 용지(A4 세로, 위 20 · 아래 15 · 좌우 30 · 머리말/꼬리말 15) */
export const DEFAULT_PAGE_LAYOUT: PageLayout = {
  paper: 'A4',
  orientation: 'portrait',
  margins: { top: 20, bottom: 15, left: 30, right: 30, header: 15, footer: 15, gutter: 0 },
  bodyFont: '함초롬돋움',
  bodyPt: 12,
  titlePt: 20,
};

const MARGIN_KEYS: Array<keyof PageMargins> = ['top', 'bottom', 'left', 'right', 'header', 'footer', 'gutter'];

const clampNumber = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n * 10) / 10));
};

const isPaperId = (value: unknown): value is PaperId => typeof value === 'string' && value in PAPERS;

/** 저장값·요청 본문처럼 믿을 수 없는 값을 기본값으로 메워 안전한 레이아웃으로 만든다 */
export const normalizePageLayout = (value: unknown): PageLayout => {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Partial<Record<keyof PageLayout, unknown>>;
  const rawMargins = (typeof raw.margins === 'object' && raw.margins !== null ? raw.margins : {}) as Partial<
    Record<keyof PageMargins, unknown>
  >;
  const margins = { ...DEFAULT_PAGE_LAYOUT.margins };
  for (const key of MARGIN_KEYS) margins[key] = clampNumber(rawMargins[key], DEFAULT_PAGE_LAYOUT.margins[key], 0, 100);
  return {
    paper: isPaperId(raw.paper) ? raw.paper : DEFAULT_PAGE_LAYOUT.paper,
    orientation: raw.orientation === 'landscape' ? 'landscape' : 'portrait',
    margins,
    bodyFont: typeof raw.bodyFont === 'string' && raw.bodyFont.trim().length > 0 ? raw.bodyFont.trim().slice(0, 40) : DEFAULT_PAGE_LAYOUT.bodyFont,
    bodyPt: clampNumber(raw.bodyPt, DEFAULT_PAGE_LAYOUT.bodyPt, 1, 72),
    titlePt: clampNumber(raw.titlePt, DEFAULT_PAGE_LAYOUT.titlePt, 1, 96),
  };
};

/** 용지 크기(mm) — 가로 방향이면 너비·높이를 바꾼다 */
export const paperSizeMm = (layout: PageLayout): { width: number; height: number } => {
  const { width, height } = PAPERS[layout.paper];
  return layout.orientation === 'landscape' ? { width: height, height: width } : { width, height };
};

export const mmToHwpUnit = (mm: number): number => Math.round(mm * 283.465);

export const ptToHwpUnit = (pt: number): number => Math.round(pt * 100);