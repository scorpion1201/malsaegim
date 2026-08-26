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

export const assembleTranscript = (
  outcomes: ReadonlyMap<number, ChunkOutcome>,
  expectedCount: number | null,
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
         if (previous && !previous.failed && !SENTENCE_END.test(previous.text)) {
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