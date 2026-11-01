export type EchoFuse = {
  noteOutput: (text: string, wallMs: number) => void;
  /** 작동이면 true */
  check: (source: string, wallMs: number) => boolean;
  reset: () => void;
};

const WINDOW_MS = 30_000;
const MIN_CHARS = 12;
const MIN_DICE = 0.6;
const CONSECUTIVE = 2;

const normalize = (text: string): string => text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

const bigrams = (text: string): Map<string, number> => {
  const counts = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i += 1) {
    const pair = text.slice(i, i + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
};

export const diceBigrams = (a: string, b: string): number => {
  if (a.length < 2 || b.length < 2) return 0;
  const left = bigrams(a);
  const right = bigrams(b);
  let shared = 0;
  for (const [pair, count] of left) shared += Math.min(count, right.get(pair) ?? 0);
  return (2 * shared) / (a.length - 1 + (b.length - 1));
};

/** 스피커 소리가 마이크로 되돌아오면 원문 전사에 번역문이 그대로 찍힌다 — 그 일치를 잡는 2차 방어 */
export const createEchoFuse = (): EchoFuse => {
  let outputs: { text: string; wallMs: number }[] = [];
  let streak = 0;

  return {
    noteOutput: (text, wallMs) => {
      const last = outputs[outputs.length - 1];
      // 델타를 잇따라 붙여 한 줄로 비교한다
      if (last && wallMs - last.wallMs < 1000) {
        last.text += text;
        last.wallMs = wallMs;
      } else {
        outputs.push({ text, wallMs });
      }
    },
    check: (source, wallMs) => {
      outputs = outputs.filter((entry) => wallMs - entry.wallMs <= WINDOW_MS);
      const normalized = normalize(source);
      if (normalized.length < MIN_CHARS) {
        streak = 0;
        return false;
      }
      const recent = normalize(outputs.map((entry) => entry.text).join(''));
      // 원문 길이만큼의 창을 움직이며 가장 비슷한 구간을 찾는다
      let best = 0;
      const step = Math.max(1, Math.floor(normalized.length / 4));
      for (let start = 0; start === 0 || start + normalized.length <= recent.length + step; start += step) {
        best = Math.max(best, diceBigrams(normalized, recent.slice(start, start + normalized.length)));
      }
      streak = best >= MIN_DICE ? streak + 1 : 0;
      return streak >= CONSECUTIVE;
    },
    reset: () => {
      outputs = [];
      streak = 0;
    },
  };
};