import type { TranscriptBlock } from '@/app/_lib/asr/assembleTranscript';
import type { TiptapDoc, TiptapNode } from '@/app/_lib/hwp/tiptapToDocModel';

/** 인식 실패 조각 노드 — 에디터에서 "인식 실패 mm:ss–mm:ss" + 재인식 버튼으로 그려진다. offset 은 이어 붙인 파트의 시작 시각 */
export const failedChunkNode = (startMs: number, endMs: number, offset = 0): TiptapNode => ({
  type: 'failedChunk',
  attrs: offset > 0 ? { startMs, endMs, offset } : { startMs, endMs },
});

/** 타임스탬프 노드 — ms 는 노트 전체 시간축(재생 이동), 화면에는 ms - offset(파트 안 시각)으로 보인다 */
export const timestampNode = (ms: number, offset = 0): TiptapNode => ({
  type: 'timestamp',
  attrs: offset > 0 ? { ms, offset } : { ms },
});

/** 이어 붙인 파트의 구분 제목 */
export const partHeadingNode = (partNumber: number, label: string): TiptapNode => ({
  type: 'heading',
  attrs: { level: 3 },
  content: [{ type: 'text', text: `Part ${partNumber} · ${label}` }],
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
        timestampNode(block.startMs),
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

/**
 * 조립된 블록 → 문서. offsetMs 를 주면 이어 붙인 파트다 — 블록 시각(파트 안)에 offsetMs 를 더해 노트 시간축으로 저장하고,
 * 화면에는 파트 안 시각이 보이도록 offset 을 함께 적는다
 */
export const blocksToTiptapDoc = (blocks: TranscriptBlock[], languages?: BlockLanguages, offsetMs = 0): TiptapDoc => {
  if (blocks.length === 0) return { type: 'doc', content: [{ type: 'paragraph' }] };
  const content: TiptapNode[] = blocks.flatMap((block) =>
    block.translation === undefined
      ? [
          {
            type: 'paragraph',
            content: [
              timestampNode(block.startMs + offsetMs, offsetMs),
              block.failed
                ? failedChunkNode(block.startMs + offsetMs, block.endMs + offsetMs, offsetMs)
                : { type: 'text', text: block.text },
            ],
          },
        ]
      : translationParagraphs(block, languages),
  );
  return { type: 'doc', content };
};