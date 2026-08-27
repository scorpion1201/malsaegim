import type { AudioChunk } from '@/app/_lib/audio/types';
import type { ByokSettings } from '@/app/_lib/settings/byokSettings';
import { ASR_LANGUAGE, AsrHttpError, AsrNetworkError, transcribeDirect } from './directTranscribe';

export type EngineKind = 'byok' | 'ondevice';

/** 인식 전체를 멈춰야 하는 오류 — 키·주소 오류, 모델 로드 실패 */
export class AsrFatalError extends Error {
  name = 'AsrFatalError';
}

/** 이 조각만 다시 시도할 오류 — 429/5xx, 네트워크, 워커 예외 */
export class AsrRetryableError extends Error {
  name = 'AsrRetryableError';
}

/** 큐·녹음 파이프라인이 보는 유일한 인식 인터페이스. BYOK 와 On-Device 는 여기서만 갈린다 */
export type TranscribeEngine = {
  kind: EngineKind;
  /** 동시에 처리할 조각 수 — BYOK 8, On-Device 1 */
  concurrency: number;
  /** 조각 하나 → 텍스트. onProgress 는 조각 안의 진행률(0~1, On-Device 만 준다) */
  transcribe: (chunk: AudioChunk, signal: AbortSignal, onProgress?: (ratio: number) => void) => Promise<string>;
};

export const BYOK_CONCURRENCY = 8;

/** 설정 페이지의 API 로 보낸다 (pass-through). 429/5xx·네트워크는 재시도, 그 밖의 HTTP 오류는 치명적 */
export const createByokEngine = (settings: ByokSettings): TranscribeEngine => ({
  kind: 'byok',
  concurrency: BYOK_CONCURRENCY,
  transcribe: async (chunk, signal) => {
    try {
      return (await transcribeDirect(chunk.wav, { ...settings, language: ASR_LANGUAGE }, signal)).text;
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof AsrNetworkError) throw new AsrRetryableError(error.message);
      if (error instanceof AsrHttpError) {
        if (error.status === 429 || error.status >= 500) throw new AsrRetryableError(`HTTP ${error.status}`);
        throw new AsrFatalError(`${error.message} (HTTP ${error.status})`);
      }
      throw new AsrRetryableError(error instanceof Error ? error.message : 'unknown error');
    }
  },
});