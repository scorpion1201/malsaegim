import 'server-only';
import type { HwpDocument } from '@rhwp/core';
import type { Block, DocModel, ExportFormat, HeadingLevel, Run } from './docModel';
import { mmToHwpUnit, paperSizeMm, ptToHwpUnit, type PageLayout } from './pageLayout';
import type { RhwpEngine } from './rhwpEngine';

/** 소제목(H1~H3) 크기 — HWPUNIT (1000 = 10pt). 본문보다 작아지지는 않는다 */
const HEADING_SIZE: Record<HeadingLevel, number> = { 1: 1800, 2: 1600, 3: 1400 };

type TextStyle = { fontId: number; bodySize: number; titleSize: number };
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

const writeBlock = (doc: HwpDocument, paraIdx: number, block: Block, style: TextStyle, isTitle: boolean): void => {
  const prefix = blockPrefix(block);
  const text = prefix + plainText(block.runs);
  if (text.length > 0) {
    doc.insertText(0, paraIdx, 0, text);
    // 글꼴은 이름이 아니라 font id 로만 바뀐다 (fontFamily 키는 무시됨)
    doc.applyCharFormat(0, paraIdx, 0, text.length, JSON.stringify({ fontId: style.fontId, fontSize: style.bodySize }));
  }
  applyRuns(doc, paraIdx, prefix.length, block.runs);
  if (isTitle) {
    if (text.length > 0) doc.applyCharFormat(0, paraIdx, 0, text.length, JSON.stringify({ bold: true, fontSize: style.titleSize }));
    doc.applyParaFormat(0, paraIdx, JSON.stringify({ alignment: 'center', spacingBefore: 0, spacingAfter: 600 }));
    return;
  }
  if (block.kind === 'heading') {
    if (text.length > 0) {
      const fontSize = Math.max(style.bodySize, HEADING_SIZE[block.level]);
      doc.applyCharFormat(0, paraIdx, 0, text.length, JSON.stringify({ bold: true, fontSize }));
    }
    doc.applyParaFormat(0, paraIdx, JSON.stringify({ alignment: 'justify', spacingBefore: 600, spacingAfter: 300 }));
  } else if (block.kind === 'listItem') {
    doc.applyParaFormat(0, paraIdx, JSON.stringify({ alignment: 'justify', marginLeft: LIST_MARGIN_LEFT, indent: LIST_INDENT }));
  } else {
    doc.applyParaFormat(0, paraIdx, JSON.stringify({ alignment: 'justify' }));
  }
};

/** 구역 0 의 편집 용지: 노트의 문서 레이아웃(mm) → HWPUNIT */
const applyPageLayout = (doc: HwpDocument, layout: PageLayout): void => {
  const size = paperSizeMm(layout);
  const m = layout.margins;
  doc.setPageDef(
    0,
    JSON.stringify({
      width: mmToHwpUnit(size.width),
      height: mmToHwpUnit(size.height),
      marginLeft: mmToHwpUnit(m.left),
      marginRight: mmToHwpUnit(m.right),
      marginTop: mmToHwpUnit(m.top),
      marginBottom: mmToHwpUnit(m.bottom),
      marginHeader: mmToHwpUnit(m.header),
      marginFooter: mmToHwpUnit(m.footer),
      marginGutter: mmToHwpUnit(m.gutter),
      landscape: layout.orientation === 'landscape',
    }),
  );
};

export const buildDocument = (model: DocModel, engine: RhwpEngine, format: ExportFormat, layout: PageLayout): Uint8Array => {
  const hasTitle = model.title.length > 0;
  const blocks: Block[] = hasTitle
      ? [{ kind: 'heading', level: 1, runs: [{ text: model.title, bold: false, italic: false, underline: false }] }, ...model.blocks]
      : model.blocks;

  const doc = engine.createDocument();
  try {
     doc.createBlankDocument(); // 한컴 blank2010 템플릿: 구역 1개, 빈 문단 1개
     applyPageLayout(doc, layout);
     const style: TextStyle = {
       fontId: doc.findOrCreateFontId(layout.bodyFont),
       bodySize: ptToHwpUnit(layout.bodyPt),
       titleSize: ptToHwpUnit(layout.titlePt),
     };
     blocks.forEach((block, i) => {
       if (i > 0) doc.insertParagraph(0, i); // 현재 문단 수 == i 인 자리 → 끝에 추가
         writeBlock(doc, i, block, style, hasTitle && i === 0);
       });
     return format === 'hwp' ? doc.exportHwp() : doc.exportHwpx();
  } finally {
     doc.free();
  }
};