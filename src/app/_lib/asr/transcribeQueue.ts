import type { AudioChunk } from '@/app/_lib/audio/types';
import type { ChunkOutcome } from './assembleTranscript';

export const CLIENT_CONCURRENCY = 8;

export type QueueOptions = {
  concurrency: number;
  maxRetries: number;
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  endpoint?: string;
};

export type QueueHandlers = {
  onOutcome: (outcome: ChunkOutcome) => void;
  onFatal: (error: Error) => void;
};

export type TranscribeQueue = {
  enqueue: (chunk: AudioChunk) => void;
  close: () => Promise<void>;
  abort: () => void;
};

class FatalUploadError extends Error {}
class RetryableUploadError extends Error {}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const uploadOnce = async (
  chunk: AudioChunk,
  endpoint: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<string> => {
  const form = new FormData();
  form.set('index', String(chunk.index));
  form.set('startMs', String(chunk.startMs));
  form.set('endMs', String(chunk.endMs));
  form.set('file', new Blob([chunk.wav.slice()], { type: 'audio/wav' }), `chunk-${chunk.index}.wav`);
  let response: Response;
  try {
    response = await fetchImpl(endpoint, { method: 'POST', body: form, signal });
    } catch (error) {
    if (signal.aborted) throw error;
    throw new RetryableUploadError(error instanceof Error ? error.message : 'network error');
    }
  if (response.status === 429 || response.status >= 500) {
    throw new RetryableUploadError(`HTTP ${response.status}`);
    }
  if (!response.ok) {
    throw new FatalUploadError(`HTTP ${response.status}`);
    }
  const body = (await response.json()) as { text?: unknown };
  return typeof body.text === 'string' ? body.text : '';
};

export const createTranscribeQueue = (
   {
     concurrency,
     maxRetries,
     baseDelayMs = 1000,
     fetchImpl = fetch,
     sleep = defaultSleep,
     endpoint = '/api/transcribe',
    }: QueueOptions,
    { onOutcome, onFatal }: QueueHandlers,
): TranscribeQueue => {
  const pending: AudioChunk[] = [];
  const controller = new AbortController();
  let active = 0;
  let closed = false;
  let fatalReported = false;
  let resolveDrained: (() => void) | null = null;

  const drainedIfIdle = () => {
    if (closed && active === 0 && pending.length === 0) resolveDrained?.();
     };

  const run = async (chunk: AudioChunk) => {
    const meta = { index: chunk.index, startMs: chunk.startMs, endMs: chunk.endMs };
    for (let attempt = 0; ; attempt += 1) {
      if (controller.signal.aborted) return;
      try {
        const text = await uploadOnce(chunk, endpoint, fetchImpl, controller.signal);
        onOutcome({ kind: 'ok', meta, text });
        return;
         } catch (error) {
         if (controller.signal.aborted) return;
         if (error instanceof FatalUploadError) {
           if (!fatalReported) {
             fatalReported = true;
             onFatal(error);
            }
           controller.abort();
           pending.length = 0;
           return;
          }
         if (attempt >= maxRetries) {
           onOutcome({ kind: 'failed', meta });
           return;
          }
         await sleep(baseDelayMs * 2 ** attempt);
         }
       }
     };

   const pump = () => {
     while (active < concurrency && pending.length > 0 && !controller.signal.aborted) {
       const chunk = pending.shift()!;
       active += 1;
       void run(chunk).finally(() => {
         active -= 1;
         pump();
         drainedIfIdle();
        });
       }
     drainedIfIdle();
     };

  return {
    enqueue: (chunk) => {
      if (closed || controller.signal.aborted) return;
      pending.push(chunk);
      pump();
       },
     close: () =>
       new Promise<void>((resolve) => {
         closed = true;
         resolveDrained = resolve;
         drainedIfIdle();
           }),
     abort: () => {
       controller.abort();
       pending.length = 0;
       drainedIfIdle();
       },
    };
};