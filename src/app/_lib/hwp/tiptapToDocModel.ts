import { DocModelError, type Block, type DocModel, type HeadingLevel, type Run } from './docModel';

export type TiptapNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  text?: string;
  marks?: Array<{ type: string }>;
};

export type TiptapDoc = { type: 'doc'; content?: TiptapNode[] };

const runsOf = (nodes: TiptapNode[] | undefined): Run[][] => {
  // hardBreak 로 나뉜 런 그룹들을 돌려준다 (그룹 하나 = 문단 하나)
   const groups: Run[][] = [[]];
   for (const node of nodes ?? []) {
     if (node.type === 'text') {
       const marks = new Set((node.marks ?? []).map((m) => m.type));
       groups[groups.length - 1].push({
         text: node.text ?? '',
         bold: marks.has('bold'),
         italic: marks.has('italic'),
         underline: marks.has('underline'),
             });
       } else if (node.type === 'hardBreak') {
       groups.push([]);
       } else if (node.type === 'timestamp') {
        // 내보내기에서는 버린다
       } else {
       throw new DocModelError(`지원하지 않는 인라인 노드: ${node.type}`);
        }
      }
    return groups;
};

const clampLevel = (value: unknown): HeadingLevel => {
  const level = typeof value === 'number' ? value : 1;
  return Math.min(3, Math.max(1, Math.round(level))) as HeadingLevel;
};

const visitBlock = (node: TiptapNode, out: Block[]): void => {
  switch (node.type) {
    case 'paragraph':
      runsOf(node.content).forEach((runs) => out.push({ kind: 'paragraph', runs }));
      return;
    case 'heading':
      runsOf(node.content).forEach((runs) =>
            out.push({ kind: 'heading', level: clampLevel(node.attrs?.level), runs }),
        );
      return;
    case 'bulletList':
    case 'orderedList': {
      const ordered = node.type === 'orderedList';
          (node.content ?? []).forEach((item, i) => {
         if (item.type !== 'listItem') throw new DocModelError(`목록 안의 노드: ${item.type}`);
              (item.content ?? []).forEach((child, childIndex) => {
            if (child.type === 'paragraph' && childIndex === 0) {
              const [first, ...rest] = runsOf(child.content);
              out.push({ kind: 'listItem', ordered, index: i + 1, runs: first });
              rest.forEach((runs) => out.push({ kind: 'paragraph', runs }));
                } else {
                visitBlock(child, out);
                }
              });
            });
      return;
       }
    default:
      throw new DocModelError(`지원하지 않는 노드: ${node.type}`);
      }
};

export const tiptapToDocModel = (doc: TiptapDoc, title: string): DocModel => {
  const blocks: Block[] = [];
    (doc.content ?? []).forEach((node) => visitBlock(node, blocks));
  return { title: title.trim(), blocks };
};