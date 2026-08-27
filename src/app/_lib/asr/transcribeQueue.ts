import type { AudioChunk } from '@/app/_lib/audio/types';
import type { ChunkOutcome } from './assembleTranscript';
import { AsrFatalError, type TranscribeEngine } from './asrEngine';

export type QueueOptions = {
  engine: TranscribeEngine;
  maxRetries: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type QueueHandlers = {
  onOutcome: (outcome: ChunkOutcome) => void;
  onFatal: (error: Error) => void;
  /** 조각 안의 진행률 (On-Device 엔진만 준다) */
  onProgress?: (index: number, ratio: number) => void;
};

export type TranscribeQueue = {
  enqueue: (chunk: AudioChunk) => void;
  close: () => Promise<void>;
  abort: () => void;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 조각을 engine.concurrency 개씩 처리한다. 치명 오류(AsrFatalError)는 한 번만 보고하고 전체를 멈춘다; 그 밖은 지수 백오프로 재시도 */
export const createTranscribeQueue = (
  { engine, maxRetries, baseDelayMs = 1000, sleep = defaultSleep }: QueueOptions,
  { onOutcome, onFatal, onProgress }: QueueHandlers,
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
        const text = await engine.transcribe(chunk, controller.signal, (ratio) => onProgress?.(chunk.index, ratio));
        onOutcome({ kind: 'ok', meta, text });
        return;
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof AsrFatalError) {
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
    while (active < engine.concurrency && pending.length > 0 && !controller.signal.aborted) {
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