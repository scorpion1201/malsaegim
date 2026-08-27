import { AsrFatalError, AsrRetryableError, type TranscribeEngine } from '@/app/_lib/asr/asrEngine';
import { wavToFloat32 } from '@/app/_lib/audio/wav';
import { onDeviceThreads } from './capabilities';
import { deleteCachedFile, type ModelManifest } from './modelStore';
import type { WhisperRequest, WhisperResponse } from './whisperProtocol';

/** 마지막 조각 뒤 이만큼 놀면 워커를 내린다 (메모리 ≈ 600 MB) */
const IDLE_MS = 5 * 60_000;
const LANGUAGE = 'ko';
/** 조각 최대 진폭이 이보다 작으면(dBFS) 말소리가 없는 조각 — whisper 를 돌리지 않는다 (무음 위 환각 방지) */
const SILENT_PEAK_DB = -50;

const peakDb = (pcm: Float32Array): number => {
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const value = Math.abs(pcm[i]);
    if (value > peak) peak = value;
  }
  return 20 * Math.log10(peak + 1e-9);
};

type Pending = { resolve: (text: string) => void; reject: (error: Error) => void; onProgress?: (ratio: number) => void };

// 워커는 앱에 하나 — 큐가 동시성 1 로 부르므로 pending 은 실제로 0~1개다
let worker: Worker | null = null;
let ready: Promise<void> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let nextId = 0;
const pending = new Map<number, Pending>();

const clearIdle = () => {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
};

/** 워커를 내린다 — 녹음(sherpa) 시작 전, 5분 유휴, 중단 시. 진행 중인 조각은 재시도 가능 오류로 끝난다 */
export const shutdownWhisperWorker = (): void => {
  clearIdle();
  worker?.terminate();
  worker = null;
  ready = null;
  for (const item of pending.values()) item.reject(new AsrRetryableError('인식 엔진이 종료되었습니다'));
  pending.clear();
};

const armIdle = () => {
  clearIdle();
  idleTimer = setTimeout(shutdownWhisperWorker, IDLE_MS);
};

const spawn = (manifest: ModelManifest): Promise<void> => {
  const instance = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' });
  worker = instance;
  const loaded = new Promise<void>((resolve, reject) => {
    instance.onmessage = (event: MessageEvent<WhisperResponse>) => {
      const message = event.data;
      if (message.type === 'loaded') {
        resolve();
        return;
      }
      if (message.type === 'load-error') {
        // 캐시 파일이 없거나 깨졌으면 지워서 다음 시작 때 그 파일만 다시 받게 한다
        const file = message.fileId ? manifest.files.find((entry) => entry.id === message.fileId) : undefined;
        if (file) void deleteCachedFile(file.url);
        reject(new AsrFatalError(file ? '모델을 다시 내려받아야 합니다' : message.message));
        return;
      }
      const item = pending.get(message.id);
      if (!item) return;
      if (message.type === 'progress') {
        item.onProgress?.(message.ratio);
        return;
      }
      pending.delete(message.id);
      if (message.type === 'done') item.resolve(message.text);
      else item.reject(new AsrRetryableError(message.message));
      if (pending.size === 0) armIdle();
    };
    instance.onerror = (event) => {
      // 워커 크래시: 로드 중이면 치명, 인식 중이면 그 조각만 실패 → 다음 조각에서 다시 띄운다
      const message = event.message || '인식 엔진이 멈췄습니다';
      reject(new AsrFatalError(message));
      for (const item of pending.values()) item.reject(new AsrRetryableError(message));
      pending.clear();
      instance.terminate();
      if (worker === instance) {
        worker = null;
        ready = null;
      }
    };
  });
  instance.postMessage({ type: 'load', manifest } satisfies WhisperRequest);
  return loaded;
};

/** 파일 전사용 On-Device 엔진 — 조각(≤240초)을 통째로 넘기고 whisper.cpp 가 30초 윈도우를 처리한다 */
export const createWhisperEngine = (manifest: ModelManifest): TranscribeEngine => ({
  kind: 'ondevice',
  concurrency: 1,
  transcribe: async (chunk, signal, onProgress) => {
    if (signal.aborted) throw new AsrRetryableError('중단됨');
    clearIdle();
    if (!worker || !ready) {
      const loadStartedAt = performance.now();
      ready = spawn(manifest).then(() => console.debug(`[whisper] loaded in ${Math.round(performance.now() - loadStartedAt)} ms`));
    }
    try {
      await ready;
    } catch (error) {
      shutdownWhisperWorker();
      throw error;
    }
    const instance = worker;
    if (!instance) throw new AsrRetryableError('인식 엔진이 종료되었습니다');
    const id = (nextId += 1);
    const pcm = wavToFloat32(chunk.wav);
    const audioMs = Math.round(pcm.length / 16);
    if (peakDb(pcm) < SILENT_PEAK_DB) {
      console.debug(`[whisper] chunk ${chunk.index}: silent (${audioMs} ms), skipped`);
      armIdle();
      return '';
    }
    const startedAt = performance.now();
    return new Promise<string>((resolve, reject) => {
      // 인식은 워커 안에서 동기로 돌아 취소 메시지를 받을 수 없다 — 중단은 워커 종료다
      const onAbort = () => {
        pending.delete(id);
        shutdownWhisperWorker();
        reject(new AsrRetryableError('중단됨'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      pending.set(id, {
        resolve: (text) => {
          signal.removeEventListener('abort', onAbort);
          console.debug(`[whisper] chunk ${chunk.index}: ${audioMs} ms audio in ${Math.round(performance.now() - startedAt)} ms`);
          resolve(text);
        },
        reject: (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
        onProgress,
      });
      instance.postMessage({ type: 'transcribe', id, pcm, language: LANGUAGE, threads: onDeviceThreads() } satisfies WhisperRequest, [
        pcm.buffer,
      ]);
    });
  },
});