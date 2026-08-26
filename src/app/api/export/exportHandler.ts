import 'server-only';
import { DocModelError, type ExportFormat } from '@/app/_lib/hwp/docModel';
import { buildDocument } from '@/app/_lib/hwp/docModelToRhwp';
import { normalizePageLayout } from '@/app/_lib/hwp/pageLayout';
import type { RhwpEngine } from '@/app/_lib/hwp/rhwpEngine';
import { tiptapToDocModel, type TiptapDoc } from '@/app/_lib/hwp/tiptapToDocModel';

export type ExportHandlerDeps = { engine: RhwpEngine };

const MAX_BODY_BYTES = 5 * 1024 * 1024;

const isFormat = (value: unknown): value is ExportFormat => value === 'hwp' || value === 'hwpx';

const isTiptapDoc = (value: unknown): value is TiptapDoc =>
   typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'doc';

export const sanitizeFilename = (title: string): string => {
  const cleaned = title
       .replace(/[\\/:*?"<>|]+/g, '-')
       .replace(/\s+/g, ' ')
       .trim()
       .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'transcript';
};

export const createExportHandler =
    ({ engine }: ExportHandlerDeps) =>
   async (request: Request): Promise<Response> => {
     const raw = await request.text();
     if (raw.length > MAX_BODY_BYTES) {
       return Response.json({ error: '본문이 너무 큽니다' }, { status: 413 });
       }
     let body: { format?: unknown; title?: unknown; doc?: unknown; layout?: unknown };
     try {
       body = JSON.parse(raw) as typeof body;
       } catch {
       return Response.json({ error: 'JSON 본문이 필요합니다' }, { status: 400 });
       }
     if (!isFormat(body.format) || !isTiptapDoc(body.doc)) {
       return Response.json({ error: 'format(hwp|hwpx)과 doc이 필요합니다' }, { status: 400 });
       }
     const title = typeof body.title === 'string' ? body.title : '';

     let bytes: Uint8Array;
     const startedAt = Date.now();
     try {
       const model = tiptapToDocModel(body.doc, title);
       // layout 이 없거나 깨져 있으면 기본 편집 용지(A4 세로)로 만든다
       bytes = buildDocument(model, engine, body.format, normalizePageLayout(body.layout));
       console.info(`[export] ${body.format} blocks=${model.blocks.length} ms=${Date.now() - startedAt}`);
       } catch (error) {
       if (error instanceof DocModelError) {
         return Response.json({ error: error.message }, { status: 400 });
          }
       const detail = error instanceof Error ? error.message : String(error);
       console.error('[export] failed', detail);
       return Response.json({ error: '문서 생성 실패', detail }, { status: 500 });
       }

     const filename = `${encodeURIComponent(sanitizeFilename(title))}.${body.format}`;
     return new Response(bytes.slice(), {
       status: 200,
       headers: {
            'content-type': 'application/octet-stream',
            'content-disposition': `attachment; filename*=UTF-8''${filename}`,
            'content-length': String(bytes.byteLength),
           },
       });
     };