import { formatTimestamp } from '@/app/_lib/time';

export type ChunkMeta = { index: number; startMs: number; endMs: number };

export type ChunkOutcome =
    | { kind: 'ok'; meta: ChunkMeta; text: string }
    | { kind: 'failed'; meta: ChunkMeta };

export type TranscriptBlock = {
  startMs: number;
  endMs: number;
  text: string;
  failed: boolean;
};

export type AssembledTranscript = {
  blocks: TranscriptBlock[];
  readyCount: number;
  heldCount: number;
  complete: boolean;
};

const SENTENCE_END = /[.?!다요]$/;

/**
 * index 순으로 연속된 조각만 문단으로 조립한다.
 * mergeWindowMs 가 있으면(녹음 노트) 앞 문단이 그 길이보다 짧을 때 문장이 끝났어도 이어 붙인다 —
 * 실시간 조각은 문장 쉼마다 잘려 4~10초짜리라, 그대로 두면 문단이 너무 잘게 쪼개진다.
 */
export const assembleTranscript = (
  outcomes: ReadonlyMap<number, ChunkOutcome>,
  expectedCount: number | null,
  mergeWindowMs: number | null = null,
): AssembledTranscript => {
  const blocks: TranscriptBlock[] = [];
  let readyCount = 0;
  while (outcomes.has(readyCount)) {
    const outcome = outcomes.get(readyCount)!;
    const { startMs, endMs } = outcome.meta;
    if (outcome.kind === 'failed') {
      blocks.push({
        startMs,
        endMs,
        text: `[인식 실패 ${formatTimestamp(startMs)}–${formatTimestamp(endMs)}]`,
        failed: true,
            });
      } else {
       const text = outcome.text.trim();
       if (text.length > 0) {
         const previous = blocks[blocks.length - 1];
         const shortParagraph = mergeWindowMs !== null && previous !== undefined && previous.endMs - previous.startMs < mergeWindowMs;
         if (previous && !previous.failed && (shortParagraph || !SENTENCE_END.test(previous.text))) {
           previous.text = `${previous.text} ${text}`;
           previous.endMs = endMs;
             } else {
           blocks.push({ startMs, endMs, text, failed: false });
             }
          }
      }
    readyCount += 1;
    }
  return {
    blocks,
    readyCount,
    heldCount: outcomes.size - readyCount,
    complete: expectedCount !== null && readyCount >= expectedCount,
       };
};