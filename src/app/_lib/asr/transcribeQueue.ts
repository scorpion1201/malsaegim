import type { AudioChunk } from '@/app/_lib/audio/types';
import { readByokSettings } from '@/app/_lib/settings/byokSettings';
import type { ChunkOutcome } from './assembleTranscript';
import { ASR_LANGUAGE, AsrHttpError, AsrNetworkError, transcribeDirect } from './directTranscribe';

export const CLIENT_CONCURRENCY = 8;

export type QueueOptions = {
  concurrency: number;
  maxRetries: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
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

/** 조각 하나를 설정 페이지의 API 로 직접 보낸다. 429/5xx·네트워크 오류는 재시도, 그 밖의 오류는 치명적 */
const uploadOnce = async (chunk: AudioChunk, signal: AbortSignal): Promise<string> => {
  const settings = readByokSettings();
  try {
    return (await transcribeDirect(chunk.wav, { ...settings, language: ASR_LANGUAGE }, signal)).text;
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof AsrNetworkError) throw new RetryableUploadError(error.message);
    if (error instanceof AsrHttpError) {
      if (error.status === 429 || error.status >= 500) throw new RetryableUploadError(`HTTP ${error.status}`);
      throw new FatalUploadError(`${error.message} (HTTP ${error.status})`);
    }
    throw new RetryableUploadError(error instanceof Error ? error.message : 'unknown error');
  }
};

export const createTranscribeQueue = (
   {
     concurrency,
     maxRetries,
     baseDelayMs = 1000,
     sleep = defaultSleep,
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
        const text = await uploadOnce(chunk, controller.signal);
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