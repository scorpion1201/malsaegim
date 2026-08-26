import type { TiptapDoc, TiptapNode } from '@/app/_lib/hwp/tiptapToDocModel';

/** assembleTranscript 가 만드는 실패 placeholder 문단의 텍스트 접두사 */
export const FAILED_PREFIX = '[인식 실패';

const isFailedParagraph = (node: TiptapNode, startMs: number): boolean => {
  if (node.type !== 'paragraph' || !node.content) return false;
  const hasTimestamp = node.content.some(
    (child) => child.type === 'timestamp' && Number(child.attrs?.ms) === startMs,
  );
  const hasPlaceholder = node.content.some(
    (child) => child.type === 'text' && (child.text ?? '').startsWith(FAILED_PREFIX),
  );
  return hasTimestamp && hasPlaceholder;
};

/**
 * 재인식 성공한 조각의 placeholder 문단을 본문 텍스트로 교체한다.
 * 사용자가 placeholder 를 지웠거나 고쳐 썼으면 아무것도 바꾸지 않는다 (patched: false).
 */
export const patchFailedParagraph = (
  doc: TiptapDoc,
  startMs: number,
  text: string,
): { doc: TiptapDoc; patched: boolean } => {
  const content = doc.content ?? [];
  const index = content.findIndex((node) => isFailedParagraph(node, startMs));
  if (index < 0) return { doc, patched: false };
  const trimmed = text.trim();
  const replaced: TiptapNode = {
    type: 'paragraph',
    content: [
      { type: 'timestamp', attrs: { ms: startMs } },
      ...(trimmed.length > 0 ? [{ type: 'text', text: trimmed }] : []),
    ],
  };
  const nextContent = [...content];
  nextContent[index] = replaced;
  return { doc: { ...doc, content: nextContent }, patched: true };
};