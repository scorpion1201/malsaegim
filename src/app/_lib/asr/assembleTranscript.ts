import { splitBySpeaker, type SpeakerTurn } from '@/app/_lib/diarization/speakerTurns';
import { formatTimestamp } from '@/app/_lib/time';

export type ChunkMeta = { index: number; startMs: number; endMs: number };

export type ChunkOutcome =
    | { kind: 'ok'; meta: ChunkMeta; text: string; translation?: string }
    | { kind: 'failed'; meta: ChunkMeta };

export type TranscriptBlock = {
  startMs: number;
  endMs: number;
  text: string;
  failed: boolean;
  /** 번역 노트만 있다. 정의돼 있으면 문단 쌍으로 저장한다 */
  translation?: string;
  /** 화자 번호 (0부터). 화자 구분을 거치지 않은 블록에는 없다 */
  speaker?: number;
};

export type AssembledTranscript = {
  blocks: TranscriptBlock[];
  readyCount: number;
  heldCount: number;
  complete: boolean;
};

const SENTENCE_END = /[.?!다요]$/;

const joinText = (a: string, b: string): string => [a, b].filter(Boolean).join(' ');

/**
 * index 순으로 연속된 조각만 문단으로 조립한다.
 * mergeWindowMs 가 있으면(녹음 노트) 앞 문단이 그 길이보다 짧을 때 문장이 끝났어도 이어 붙인다 —
 * 실시간 조각은 문장 쉼마다 잘려 4~10초짜리라, 그대로 두면 문단이 너무 잘게 쪼개진다.
 * speakerTurns 가 있으면 조각을 말 차례대로 나누고, 화자가 바뀌는 곳에서는 항상 문단을 나눈다.
 */
export const assembleTranscript = (
  outcomes: ReadonlyMap<number, ChunkOutcome>,
  expectedCount: number | null,
  mergeWindowMs: number | null = null,
  speakerTurns: SpeakerTurn[] | null = null,
): AssembledTranscript => {
  const blocks: TranscriptBlock[] = [];
  let readyCount = 0;
  const appendSpeech = (startMs: number, endMs: number, text: string, translation: string | undefined, speaker: number | undefined) => {
    const previous = blocks[blocks.length - 1];
    const shortParagraph = mergeWindowMs !== null && previous !== undefined && previous.endMs - previous.startMs < mergeWindowMs;
    // 원문이 비어 있으면 번역 끝으로 문장 끝을 본다
    if (
      previous &&
      !previous.failed &&
      previous.speaker === speaker &&
      (shortParagraph || !SENTENCE_END.test(previous.text || (previous.translation ?? '')))
    ) {
      previous.text = joinText(previous.text, text);
      if (translation !== undefined) previous.translation = joinText(previous.translation ?? '', translation);
      previous.endMs = endMs;
    } else {
      blocks.push({
        startMs,
        endMs,
        text,
        failed: false,
        ...(translation === undefined ? {} : { translation }),
        ...(speaker === undefined ? {} : { speaker }),
      });
    }
  };
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
       const translation = outcome.translation?.trim();
       if (speakerTurns && text.length > 0 && translation === undefined) {
         for (const span of splitBySpeaker(text, startMs, endMs, speakerTurns)) appendSpeech(span.startMs, span.endMs, span.text, undefined, span.speaker);
       } else if (text.length > 0 || translation) {
         appendSpeech(startMs, endMs, text, translation, undefined);
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