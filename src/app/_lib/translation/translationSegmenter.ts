export type SegmentStream = 'input' | 'output';

export type ClosedBlock = { startMs: number; endMs: number; source: string; translation: string };

export type SegmenterOptions = {
  /** 공백으로 단어를 나누는 언어면 경계에 걸린 단어 조각을 앞 블록에 잇는다 */
  glueWords: boolean;
  formatGap: (startMs: number, endMs: number) => string;
  onClose: (block: ClosedBlock) => void;
};

export type Segmenter = {
  delta: (stream: SegmentStream, text: string, wallMs: number) => void;
  cut: (range: { startMs: number; endMs: number; voiced: boolean }, wallMs: number) => void;
  /** 3초 시한 처리 */
  tick: (wallMs: number) => void;
  /** 끊긴 즉시 연다. 닫히기 전에 공개되는 블록도 표식을 받는다 */
  openGap: (fromWallMs: number) => void;
  closeGap: (toWallMs: number) => void;
  /** 남은 블록 전부 확정 */
  flush: () => void;
  partial: () => { source: string; translation: string };
};

type OpenBlock = {
  startWallMs: number;
  cutWallMs: number;
  range: { startMs: number; endMs: number };
  voiced: boolean;
  source: string;
  translation: string;
  /** 경계 뒤 델타를 본 스트림 */
  passed: Record<SegmentStream, boolean>;
};

/** 경계 후 번역 꼬리를 기다리는 시한 */
export const CLOSE_GRACE_MS = 3000;
/** 입력과 출력의 elapsed_ms 차이가 0.2초 안쪽이라 보정하지 않는다 */
export const OUTPUT_SHIFT_MS = 0;

const WORD_BREAK_START = /^[\s\p{P}]/u;
const WORD_BREAK_END = /[\s\p{P}]$/u;
const NO_SPACE_SCRIPT = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

/** 델타를 문단 경계에 배정한다. 시각은 전부 인자로 받는다 */
export const createSegmenter = ({ glueWords, formatGap, onClose }: SegmenterOptions): Segmenter => {
  const open: OpenBlock[] = [];
  const gaps: { fromWallMs: number; toWallMs: number | null }[] = [];
  let progress = { source: '', translation: '' };
  let lastCutWallMs = 0;
  let lastEndMs = 0;

  const field = (stream: SegmentStream) => (stream === 'input' ? 'source' : 'translation');

  const publish = (block: OpenBlock) => {
    const source = block.source.trim();
    let translation = block.translation.trim();
    if (block.voiced) {
      const { startMs, endMs } = block.range;
      for (const gap of gaps) {
        const toWallMs = gap.toWallMs ?? block.cutWallMs;
        if (gap.fromWallMs >= block.cutWallMs || toWallMs <= block.startWallMs) continue;
        const from = Math.max(startMs, endMs - (block.cutWallMs - gap.fromWallMs));
        const to = Math.max(from, Math.min(endMs, endMs - (block.cutWallMs - toWallMs)));
        translation = `${translation} ${formatGap(from, to)}`.trim();
      }
    }
    if (source || translation) onClose({ startMs: block.range.startMs, endMs: block.range.endMs, source, translation });
  };

  /** 닫힘은 앞에서부터만 공개한다 */
  const closeReady = (wallMs: number) => {
    while (open[0]) {
      const head = open[0];
      const expired = wallMs >= head.cutWallMs + CLOSE_GRACE_MS;
      if (!expired && !(head.passed.input && head.passed.output)) return;
      open.shift();
      publish(head);
    }
  };

  /** 경계에 걸린 단어 조각을 앞 블록에 붙이고 남은 글을 돌려준다. 공백이 안 나왔으면 경계를 넘지 않은 것으로 둔다 */
  const glue = (block: OpenBlock, stream: SegmentStream, text: string): { rest: string; crossed: boolean } => {
    const key = field(stream);
    const tail = block[key];
    if (!glueWords || !tail || WORD_BREAK_END.test(tail) || WORD_BREAK_START.test(text) || NO_SPACE_SCRIPT.test(text)) {
      return { rest: text, crossed: true };
    }
    const end = text.search(/\s/);
    if (end < 0) {
      block[key] += text;
      return { rest: '', crossed: false };
    }
    block[key] += text.slice(0, end);
    return { rest: text.slice(end), crossed: true };
  };

  return {
    delta: (stream, text, wallMs) => {
      const key = field(stream);
      const owner = open.find((block) => block.cutWallMs >= wallMs);
      if (owner) {
        owner[key] += text;
        for (const block of open) if (block.cutWallMs < wallMs) block.passed[stream] = true;
      } else {
        const last = open[open.length - 1];
        const fresh = last && !last.passed[stream];
        const { rest, crossed } = fresh ? glue(last, stream, text) : { rest: text, crossed: true };
        if (crossed) for (const block of open) block.passed[stream] = true;
        progress[key] += rest;
      }
      closeReady(wallMs);
    },
    cut: (range, wallMs) => {
      open.push({
        startWallMs: lastCutWallMs,
        cutWallMs: wallMs,
        range: { startMs: range.startMs, endMs: range.endMs },
        voiced: range.voiced,
        source: progress.source,
        translation: progress.translation,
        passed: { input: false, output: false },
      });
      progress = { source: '', translation: '' };
      lastCutWallMs = wallMs;
      lastEndMs = range.endMs;
    },
    tick: closeReady,
    openGap: (fromWallMs) => {
      gaps.push({ fromWallMs, toWallMs: null });
    },
    closeGap: (toWallMs) => {
      const last = gaps[gaps.length - 1];
      if (last) last.toWallMs = toWallMs;
    },
    flush: () => {
      const last = open[open.length - 1];
      if (last) {
        last.source += progress.source;
        last.translation += progress.translation;
      } else if (progress.source.trim() || progress.translation.trim()) {
        open.push({
          startWallMs: lastCutWallMs,
          cutWallMs: lastCutWallMs,
          range: { startMs: lastEndMs, endMs: lastEndMs },
          voiced: false,
          source: progress.source,
          translation: progress.translation,
          passed: { input: true, output: true },
        });
      }
      progress = { source: '', translation: '' };
      while (open[0]) publish(open.shift() as OpenBlock);
    },
    partial: () => ({
      source: (open.map((block) => block.source).join('') + progress.source).trim(),
      translation: (open.map((block) => block.translation).join('') + progress.translation).trim(),
    }),
  };
};