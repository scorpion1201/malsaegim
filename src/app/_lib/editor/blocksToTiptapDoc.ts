import type { TranscriptBlock } from '@/app/_lib/asr/assembleTranscript';
import type { TiptapDoc, TiptapNode } from '@/app/_lib/hwp/tiptapToDocModel';

/** 인식 실패 조각 노드 — 에디터에서 "인식 실패 mm:ss–mm:ss" + 재인식 버튼으로 그려진다 */
export const failedChunkNode = (startMs: number, endMs: number): TiptapNode => ({
  type: 'failedChunk',
  attrs: { startMs, endMs },
});

/** 원문만 있고 번역이 오지 않은 블록의 번역 문단 */
export const NO_TRANSLATION = '[번역 없음]';

/** source 는 자동 감지면 null */
export type BlockLanguages = { source: string | null; target: string };

const roleAttrs = (role: 'translation' | 'source', lang: string | null | undefined): Record<string, unknown> =>
  lang ? { role, lang } : { role };

/** 번역 블록은 문단 쌍이다. 타임스탬프를 번역 문단이 가져서 원문을 숨겨도 재생 이동이 살아 있다 */
const translationParagraphs = (block: TranscriptBlock, languages?: BlockLanguages): TiptapNode[] => {
  const paragraphs: TiptapNode[] = [
    {
      type: 'paragraph',
      attrs: roleAttrs('translation', languages?.target),
      content: [
        { type: 'timestamp', attrs: { ms: block.startMs } },
        { type: 'text', text: block.translation || NO_TRANSLATION },
      ],
    },
  ];
  if (block.text) {
    paragraphs.push({
      type: 'paragraph',
      attrs: roleAttrs('source', languages?.source),
      content: [{ type: 'text', text: block.text }],
    });
  }
  return paragraphs;
};

export const blocksToTiptapDoc = (blocks: TranscriptBlock[], languages?: BlockLanguages): TiptapDoc => {
  if (blocks.length === 0) return { type: 'doc', content: [{ type: 'paragraph' }] };
  const content: TiptapNode[] = blocks.flatMap((block) =>
    block.translation === undefined
      ? [
          {
            type: 'paragraph',
            content: [
              { type: 'timestamp', attrs: { ms: block.startMs } },
              block.failed ? failedChunkNode(block.startMs, block.endMs) : { type: 'text', text: block.text },
            ],
          },
        ]
      : translationParagraphs(block, languages),
  );
  return { type: 'doc', content };
};