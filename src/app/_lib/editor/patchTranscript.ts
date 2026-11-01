import type { TiptapDoc, TiptapNode } from '@/app/_lib/hwp/tiptapToDocModel';
import { failedChunkNode, timestampNode } from './blocksToTiptapDoc';

/** 예전 버전이 만들던 텍스트형 placeholder 의 접두사 */
export const FAILED_PREFIX = '[인식 실패';

const hasTimestamp = (node: TiptapNode, startMs: number): boolean =>
  (node.content ?? []).some((child) => child.type === 'timestamp' && Number(child.attrs?.ms) === startMs);

const hasFailedMarker = (node: TiptapNode): boolean =>
  (node.content ?? []).some(
    (child) =>
      child.type === 'failedChunk' ||
      (child.type === 'text' && (child.text ?? '').startsWith(FAILED_PREFIX)),
  );

const isFailedParagraph = (node: TiptapNode, startMs: number): boolean =>
  node.type === 'paragraph' && hasTimestamp(node, startMs) && hasFailedMarker(node);

/** 문단 타임스탬프의 파트 오프셋 (이어 붙인 파트가 아니면 0) */
const offsetOf = (node: TiptapNode): number => {
  const stamp = (node.content ?? []).find((child) => child.type === 'timestamp');
  return Number(stamp?.attrs?.offset ?? 0);
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
      timestampNode(startMs, offsetOf(content[index])),
      ...(trimmed.length > 0 ? [{ type: 'text', text: trimmed }] : []),
    ],
  };
  const nextContent = [...content];
  nextContent[index] = replaced;
  return { doc: { ...doc, content: nextContent }, patched: true };
};

/**
 * 예전 프로젝트의 텍스트형 placeholder("[인식 실패 …]")를 failedChunk 노드로 바꾼다.
 * 저장된 실패 조각 목록과 timestamp ms 가 맞는 문단만 대상이다.
 */
export const upgradeFailedPlaceholders = (
  doc: TiptapDoc,
  failed: Array<{ startMs: number; endMs: number }>,
): TiptapDoc => {
  if (failed.length === 0 || !doc.content) return doc;
  let changed = false;
  const content = doc.content.map((node) => {
    const chunk = failed.find((f) => isFailedParagraph(node, f.startMs));
    if (!chunk) return node;
    const alreadyNode = (node.content ?? []).some((child) => child.type === 'failedChunk');
    if (alreadyNode) return node;
    changed = true;
    const offset = offsetOf(node);
    return {
      type: 'paragraph',
      content: [timestampNode(chunk.startMs, offset), failedChunkNode(chunk.startMs, chunk.endMs, offset)],
    };
  });
  return changed ? { ...doc, content } : doc;
};