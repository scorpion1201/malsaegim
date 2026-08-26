import 'server-only';
import type { AsrConfig } from '@/app/_lib/asr/env';
import { AsrHttpError, transcribeWav } from '@/app/_lib/asr/asrClient';
import { Semaphore, SemaphoreTimeoutError } from '@/app/_lib/asr/semaphore';

export type TranscribeHandlerDeps = {
  config: AsrConfig;
  semaphore: Semaphore;
  fetchImpl?: typeof fetch;
  waitTimeoutMs?: number;
  maxBytes?: number;
};

const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;

const isWav = (bytes: Uint8Array): boolean =>
   bytes.length >= 12 &&
   String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
   String.fromCharCode(...bytes.subarray(8, 12)) === 'WAVE';

const parseIndex = (value: FormDataEntryValue | null): number | null => {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  return Number(value);
};

const parseMs = (value: FormDataEntryValue | null): number =>
   typeof value === 'string' && Number.isFinite(Number(value)) ? Number(value) : 0;

export const createTranscribeHandler =
   ({
     config,
     semaphore,
     fetchImpl = fetch,
     waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
     maxBytes = DEFAULT_MAX_BYTES,
     }: TranscribeHandlerDeps) =>
   async (request: Request): Promise<Response> => {
     let form: FormData;
     try {
       form = await request.formData();
       } catch {
       return Response.json({ error: 'multipart/form-data 본문이 필요합니다' }, { status: 400 });
       }
     const index = parseIndex(form.get('index'));
     const file = form.get('file');
     if (index === null || !(file instanceof Blob)) {
       return Response.json({ error: 'index와 file이 필요합니다' }, { status: 400 });
       }
     if (file.size > maxBytes) {
       return Response.json({ error: `파일이 ${maxBytes} 바이트를 넘습니다` }, { status: 413 });
       }
     const wav = new Uint8Array(await file.arrayBuffer());
     if (!isWav(wav)) {
       return Response.json({ error: 'WAV 파일이 아닙니다' }, { status: 400 });
       }
     const startMs = parseMs(form.get('startMs'));
     const endMs = parseMs(form.get('endMs'));

     let release: () => void;
     try {
       release = await semaphore.acquire(waitTimeoutMs);
       } catch (error) {
       if (error instanceof SemaphoreTimeoutError) {
         return Response.json(
             { error: '서버가 바쁩니다. 잠시 후 다시 시도하세요' },
             { status: 503, headers: { 'retry-after': '5' } },
         );
         }
       throw error;
       }

     try {
       const result = await transcribeWav({ wav, config, fetchImpl });
       return Response.json({ index, text: result.text, durationMs: Math.max(0, endMs - startMs) });
       } catch (error) {
       if (error instanceof AsrHttpError) {
         const status = error.status === 429 ? 429 : 502;
         return Response.json({ error: `음성 인식 실패 (${error.status}): ${error.message}` }, { status });
         }
       const message = error instanceof Error ? error.message : 'unknown error';
       return Response.json({ error: `음성 인식 실패: ${message}` }, { status: 502 });
       } finally {
       release();
       }
     };