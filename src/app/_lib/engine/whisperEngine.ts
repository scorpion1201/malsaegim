import { AsrFatalError, AsrRetryableError, type TranscribeEngine } from '@/app/_lib/asr/asrEngine';
import { wavToFloat32 } from '@/app/_lib/audio/wav';
import { onDeviceThreads } from './capabilities';
import type { ModelBundle } from './modelStore';
import { WhisperLoadError, ensureWhisper, postWhisper, shutdownWhisperWorker } from './whisperHost';
import type { WhisperRequest } from './whisperProtocol';

/** 인식 언어 — 한국어 고정 (자동 감지는 짧은 조각에서 다른 언어로 튄다) */
export const WHISPER_LANGUAGE = 'ko';
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

/** 파일 전사용 On-Device 엔진 — 조각(≤240초)을 통째로 넘기고 whisper.cpp 가 30초 윈도우를 처리한다 */
export const createWhisperEngine = (bundle: ModelBundle): TranscribeEngine => ({
  kind: 'ondevice',
  concurrency: 1,
  transcribe: async (chunk, signal, onProgress) => {
    if (signal.aborted) throw new AsrRetryableError('중단됨');
    try {
      await ensureWhisper(bundle);
    } catch (error) {
      // 로드 실패(모델 파일 없음·메모리 부족)는 조각을 다시 보내도 같다 — 큐 전체를 멈춘다
      if (error instanceof WhisperLoadError) throw new AsrFatalError(error.message);
      throw new AsrRetryableError(error instanceof Error ? error.message : String(error));
    }
    const pcm = wavToFloat32(chunk.wav);
    const audioMs = Math.round(pcm.length / 16);
    if (peakDb(pcm) < SILENT_PEAK_DB) {
      console.debug(`[whisper] chunk ${chunk.index}: silent (${audioMs} ms), skipped`);
      return '';
    }
    const startedAt = performance.now();
    return new Promise<string>((resolve, reject) => {
      // 인식은 워커 안에서 동기로 돌아 취소 메시지를 받을 수 없다 — 중단은 워커 종료다
      const onAbort = () => {
        shutdownWhisperWorker();
        reject(new AsrRetryableError('중단됨'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      postWhisper(
        (id) => ({ type: 'transcribe', id, pcm, language: WHISPER_LANGUAGE, threads: onDeviceThreads() }) satisfies WhisperRequest,
        {
          onMessage: (message) => {
            if (message.type === 'progress') {
              onProgress?.(message.ratio);
              return;
            }
            signal.removeEventListener('abort', onAbort);
            if (message.type === 'done') {
              console.debug(`[whisper] chunk ${chunk.index}: ${audioMs} ms audio in ${Math.round(performance.now() - startedAt)} ms`);
              resolve(message.text);
            } else if (message.type === 'error') {
              reject(new AsrRetryableError(message.message));
            }
          },
          onStop: (error) => {
            signal.removeEventListener('abort', onAbort);
            reject(new AsrRetryableError(error.message));
          },
        },
        [pcm.buffer],
      );
    });
  },
});