import type { TranscriptBlock } from '@/app/_lib/asr/assembleTranscript';
import type { TiptapDoc, TiptapNode } from '@/app/_lib/hwp/tiptapToDocModel';

/** 인식 실패 조각 노드 — 에디터에서 "인식 실패 mm:ss–mm:ss" + 재인식 버튼으로 그려진다 */
export const failedChunkNode = (startMs: number, endMs: number): TiptapNode => ({
  type: 'failedChunk',
  attrs: { startMs, endMs },
});

export const blocksToTiptapDoc = (blocks: TranscriptBlock[]): TiptapDoc => {
  if (blocks.length === 0) return { type: 'doc', content: [{ type: 'paragraph' }] };
  const content: TiptapNode[] = blocks.map((block) => ({
    type: 'paragraph',
    content: [
      { type: 'timestamp', attrs: { ms: block.startMs } },
      block.failed ? failedChunkNode(block.startMs, block.endMs) : { type: 'text', text: block.text },
    ],
  }));
  return { type: 'doc', content };
};