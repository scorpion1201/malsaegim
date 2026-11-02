/** 화자 군집 결과 → 말 차례(turn), 말 차례 → 글자 나누기. 화자 번호는 0부터, 화면에는 "화자 1" 부터 보인다 */
export type SpeakerTurn = { startMs: number; endMs: number; speaker: number };
export type SpeakerSpan = SpeakerTurn & { text: string };

/** 라벨 튐을 없애는 다수결 창의 한쪽 길이 (창 개수) */
const SMOOTH_RADIUS = 2;
/** 이보다 짧은 차례는 앞뒤 화자에 넘긴다 — 짧은 차례는 임베딩을 믿기 어렵다 */
const MIN_TURN_MS = 1000;
/** 조각 안에서 이보다 짧은 화자 구간은 나누지 않는다 — 조각은 쉼에서 잘려 대개 한 사람 말이고, 글자를 시간 비례로 나누는 오차가 이만큼 크다 */
const MIN_SPAN_MS = 3000;
/** 나눌 자리를 찾는 범위 — 글자 수 대비 */
const SNAP_RATIO = 0.2;

const smooth = (labels: ArrayLike<number>): Int32Array =>
  Int32Array.from({ length: labels.length }, (_, center) => {
    const votes = new Map<number, number>();
    let best = labels[center];
    for (let i = Math.max(0, center - SMOOTH_RADIUS); i <= Math.min(labels.length - 1, center + SMOOTH_RADIUS); i += 1) {
      const count = (votes.get(labels[i]) ?? 0) + 1;
      votes.set(labels[i], count);
      if (count > (votes.get(best) ?? 0)) best = labels[i];
    }
    return best;
  });

const mergeSameSpeaker = <T extends SpeakerTurn>(turns: T[]): T[] => {
  const merged: T[] = [];
  for (const turn of turns) {
    const previous = merged.at(-1);
    if (previous?.speaker === turn.speaker) previous.endMs = turn.endMs;
    else merged.push({ ...turn });
  }
  return merged;
};

/** 짧은 차례를 앞 차례에 흡수한다 (맨 앞이면 뒤 차례가 시작을 당겨 온다) */
const absorbShortTurns = (turns: SpeakerTurn[]): SpeakerTurn[] => {
  const kept = turns.filter((turn) => turn.endMs - turn.startMs >= MIN_TURN_MS);
  if (kept.length === 0) return turns.slice(0, 1);
  kept[0].startMs = turns[0].startMs;
  for (let i = 1; i < kept.length; i += 1) kept[i].startMs = kept[i - 1].endMs;
  kept[kept.length - 1].endMs = turns[turns.length - 1].endMs;
  return mergeSameSpeaker(kept);
};

/** 창 시작 시각(ms)과 창별 화자로 시간축 전체를 빈틈없이 덮는 차례 목록을 만든다. 창 사이 무음은 앞뒤 화자가 반씩 가진다 */
export const buildSpeakerTurns = (windowStartMs: number[], labels: ArrayLike<number>, windowMs: number, totalMs: number): SpeakerTurn[] => {
  if (windowStartMs.length === 0) return [];
  const smoothed = smooth(labels);
  const centers = windowStartMs.map((start) => start + windowMs / 2);
  const turns = centers.map((center, index) => ({
    startMs: index === 0 ? 0 : (centers[index - 1] + center) / 2,
    endMs: index === centers.length - 1 ? totalMs : (center + centers[index + 1]) / 2,
    speaker: smoothed[index],
  }));
  return absorbShortTurns(mergeSameSpeaker(turns)).map((turn) => ({ ...turn, startMs: Math.round(turn.startMs), endMs: Math.round(turn.endMs) }));
};

/** 나눌 자리 — target 근처의 문장 끝, 없으면 띄어쓰기. 없으면 null */
const snapCut = (text: string, target: number): number | null => {
  const reach = Math.max(4, Math.round(text.length * SNAP_RATIO));
  const search = (matches: (index: number) => boolean): number | null => {
    for (let distance = 0; distance <= reach; distance += 1) {
      for (const index of [target - distance, target + distance]) if (index > 0 && index < text.length && matches(index)) return index;
    }
    return null;
  };
  return search((index) => /[.?!。？！]/.test(text[index - 1]) && text[index] === ' ') ?? search((index) => text[index] === ' ');
};

/**
 * 한 조각의 글자를 말 차례대로 나눈다. 인식기가 어절 시각을 주지 않으므로 말 빠르기가 일정하다고 보고 시간 비례로 자른다.
 * 차례 경계와 글자 경계는 문장 끝이나 띄어쓰기로 맞춘다. 차례가 없으면 빈 배열이다
 */
export const splitBySpeaker = (text: string, startMs: number, endMs: number, turns: SpeakerTurn[]): SpeakerSpan[] => {
  const clipped = turns
    .filter((turn) => turn.endMs > startMs && turn.startMs < endMs)
    .map((turn) => ({ speaker: turn.speaker, startMs: Math.max(turn.startMs, startMs), endMs: Math.min(turn.endMs, endMs), text: '' }));
  if (clipped.length === 0) return [];
  const spans = clipped.filter((span) => span.endMs - span.startMs >= MIN_SPAN_MS);
  if (spans.length === 0) {
    const longest = clipped.reduce((best, span) => (span.endMs - span.startMs > best.endMs - best.startMs ? span : best));
    return [{ ...longest, startMs, endMs, text }];
  }
  spans[0].startMs = startMs;
  for (let i = 1; i < spans.length; i += 1) spans[i].startMs = spans[i - 1].endMs;
  spans[spans.length - 1].endMs = endMs;
  const merged = mergeSameSpeaker(spans);

  const total = endMs - startMs;
  let cursor = 0;
  const pieces: SpeakerSpan[] = [];
  merged.forEach((span, index) => {
    const last = index === merged.length - 1;
    const cut = last ? null : snapCut(text, Math.round((text.length * (span.endMs - startMs)) / total));
    if (last || (cut !== null && cut > cursor)) {
      const piece = text.slice(cursor, cut ?? text.length).trim();
      if (piece) pieces.push({ ...span, text: piece });
      cursor = cut ?? text.length;
    }
  });
  // 자를 자리를 못 찾아 건너뛴 화자의 시간은 다음 화자에게 넘어간다
  pieces.forEach((piece, index) => {
    piece.startMs = index === 0 ? startMs : pieces[index - 1].endMs;
    if (index === pieces.length - 1) piece.endMs = endMs;
  });
  return pieces;
};