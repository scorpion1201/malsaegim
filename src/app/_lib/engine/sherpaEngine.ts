import { deleteCachedFile, type ModelManifest } from './modelStore';
import type { LiveSegment, SherpaRequest, SherpaResponse } from './sherpaProtocol';
import { shutdownWhisperWorker } from './whisperEngine';

export type LiveRecognizerHandlers = {
  onPartial: (text: string, processedMs: number) => void;
  onFinal: (segment: LiveSegment) => void;
  /** 워커가 죽어 다시 띄우는 중 — 실시간 줄에 "인식 엔진 재시작" */
  onRestart: () => void;
  onError: (error: Error) => void;
};

export type LiveRecognizer = {
  /** 청커 시간축에 들어간 16 kHz 프레임 */
  push: (samples: Float32Array) => void;
  /** 마지막 세그먼트를 받고 워커를 내린다 */
  finish: () => Promise<void>;
  terminate: () => void;
};

const SAMPLE_RATE = 16000;
const FINISH_TIMEOUT_MS = 10_000;
const MAX_RESTARTS = 1;

/** 실시간 받아쓰기 엔진 — 녹음 한 회차마다 하나. whisper 워커와 동시에 두지 않는다(메모리) */
export const startLiveRecognizer = async (manifest: ModelManifest, handlers: LiveRecognizerHandlers): Promise<LiveRecognizer> => {
  shutdownWhisperWorker();
  let worker: Worker | null = null;
  let sentMs = 0;
  let restarts = 0;
  let onFinished: (() => void) | null = null;
  let partials = 0;
  let finals = 0;
  const startedAt = performance.now();

  const spawn = (baseMs: number): Promise<Worker> =>
    new Promise((resolve, reject) => {
      const instance = new Worker(new URL('./sherpa.worker.ts', import.meta.url), { type: 'module' });
      instance.onmessage = (event: MessageEvent<SherpaResponse>) => {
        const message = event.data;
        switch (message.type) {
          case 'loaded':
            console.log(`[sherpa] loaded in ${Math.round(performance.now() - startedAt)} ms (base ${baseMs} ms)`);
            resolve(instance);
            break;
          case 'load-error': {
            const file = message.fileId ? manifest.files.find((entry) => entry.id === message.fileId) : undefined;
            if (file) void deleteCachedFile(file.url);
            instance.terminate();
            reject(new Error(file ? '모델을 다시 내려받아야 합니다' : message.message));
            break;
          }
          case 'partial':
            partials += 1;
            if (partials === 1) console.log(`[sherpa] first partial at ${Math.round(sentMs)} ms sent`);
            handlers.onPartial(message.text, message.processedMs);
            break;
          case 'final':
            finals += 1;
            console.log(`[sherpa] final #${finals} ${message.startMs}–${message.endMs} ms: ${message.text.slice(0, 40)}`);
            handlers.onFinal({ text: message.text, startMs: message.startMs, endMs: message.endMs });
            break;
          case 'finished':
            onFinished?.();
            break;
          case 'error':
            handlers.onError(new Error(message.message));
            break;
        }
      };
      instance.onerror = (event) => {
        // 크래시: 한 번은 다시 띄우고 시각을 이어 붙인다. 녹음·WAV 저장은 영향 없다
        instance.terminate();
        const failure = new Error(event.message || '실시간 인식 엔진이 멈췄습니다');
        if (worker !== instance) {
          reject(failure);
          return;
        }
        worker = null;
        if (restarts >= MAX_RESTARTS) {
          handlers.onError(failure);
          return;
        }
        restarts += 1;
        handlers.onRestart();
        void spawn(sentMs)
          .then((next) => {
            worker = next;
          })
          .catch(handlers.onError);
      };
      instance.postMessage({ type: 'load', manifest, baseMs } satisfies SherpaRequest);
    });

  worker = await spawn(0);

  return {
    push: (samples) => {
      sentMs += (samples.length / SAMPLE_RATE) * 1000;
      if (!worker) return; // 재시작 중인 프레임은 버린다 (저장 WAV 에는 남는다)
      const copy = samples.slice();
      worker.postMessage({ type: 'audio', samples: copy } satisfies SherpaRequest, [copy.buffer]);
    },
    finish: () =>
      new Promise<void>((resolve) => {
        const current = worker;
        if (!current) {
          resolve();
          return;
        }
        let settled = false;
        onFinished = () => {
          if (settled) return;
          settled = true;
          console.log(`[sherpa] finished: ${Math.round(sentMs)} ms sent, ${partials} partials, ${finals} finals`);
          current.terminate();
          worker = null;
          resolve();
        };
        current.postMessage({ type: 'finish' } satisfies SherpaRequest);
        setTimeout(() => onFinished?.(), FINISH_TIMEOUT_MS);
      }),
    terminate: () => {
      worker?.terminate();
      worker = null;
    },
  };
};