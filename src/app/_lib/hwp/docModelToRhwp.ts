import 'server-only';
import type { HwpDocument } from '@rhwp/core';
import type { Block, DocModel, ExportFormat, HeadingLevel, Run } from './docModel';
import type { RhwpEngine } from './rhwpEngine';

const HEADING_SIZE: Record<HeadingLevel, number> = { 1: 1800, 2: 1600, 3: 1400 };
const LIST_MARGIN_LEFT = 1500; // HWPUNIT ≈ 5.3mm
const LIST_INDENT = -900;

const blockPrefix = (block: Block): string => {
  if (block.kind !== 'listItem') return '';
  return block.ordered ? `${block.index}. ` : '• ';
};

const plainText = (runs: Run[]): string => runs.map((r) => r.text).join('');

const applyRuns = (doc: HwpDocument, paraIdx: number, offset: number, runs: Run[]): void => {
  let cursor = offset;
  for (const run of runs) {
    const end = cursor + run.text.length;
    if (run.text.length > 0 && (run.bold || run.italic || run.underline)) {
       doc.applyCharFormat(
              0,
             paraIdx,
             cursor,
             end,
             JSON.stringify({ bold: run.bold, italic: run.italic, underline: run.underline }),
         );
        }
     cursor = end;
   }
};

const writeBlock = (doc: HwpDocument, paraIdx: number, block: Block): void => {
  const prefix = blockPrefix(block);
  const text = prefix + plainText(block.runs);
  if (text.length > 0) doc.insertText(0, paraIdx, 0, text);
  applyRuns(doc, paraIdx, prefix.length, block.runs);
  if (block.kind === 'heading') {
    if (text.length > 0) {
       doc.applyCharFormat(0, paraIdx, 0, text.length, JSON.stringify({ bold: true, fontSize: HEADING_SIZE[block.level] }));
        }
     doc.applyParaFormat(0, paraIdx, JSON.stringify({ spacingBefore: 600, spacingAfter: 300 }));
       } else if (block.kind === 'listItem') {
     doc.applyParaFormat(0, paraIdx, JSON.stringify({ marginLeft: LIST_MARGIN_LEFT, indent: LIST_INDENT }));
       }
};

export const buildDocument = (model: DocModel, engine: RhwpEngine, format: ExportFormat): Uint8Array => {
  const blocks: Block[] = model.title
      ? [{ kind: 'heading', level: 1, runs: [{ text: model.title, bold: false, italic: false, underline: false }] }, ...model.blocks]
      : model.blocks;

  const doc = engine.createDocument();
  try {
     doc.createBlankDocument(); // 한컴 blank2010 템플릿: 구역 1개, 빈 문단 1개
     blocks.forEach((block, i) => {
       if (i > 0) doc.insertParagraph(0, i); // 현재 문단 수 == i 인 자리 → 끝에 추가
         writeBlock(doc, i, block);
       });
     return format === 'hwp' ? doc.exportHwp() : doc.exportHwpx();
  } finally {
     doc.free();
  }
};