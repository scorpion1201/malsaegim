import type { TranscriptBlock } from '@/app/_lib/asr/assembleTranscript';
import type { TiptapDoc, TiptapNode } from '@/app/_lib/hwp/tiptapToDocModel';

export const blocksToTiptapDoc = (blocks: TranscriptBlock[]): TiptapDoc => {
  if (blocks.length === 0) return { type: 'doc', content: [{ type: 'paragraph' }] };
  const content: TiptapNode[] = blocks.map((block) => ({
    type: 'paragraph',
    content: [
          { type: 'timestamp', attrs: { ms: block.startMs } },
       block.failed
          ? { type: 'text', text: block.text, marks: [{ type: 'italic' }] }
          : { type: 'text', text: block.text },
        ],
     }));
  return { type: 'doc', content };
};