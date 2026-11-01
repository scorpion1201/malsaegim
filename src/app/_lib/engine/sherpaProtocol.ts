import type { ModelManifest } from './modelStore';

export type SherpaRequest =
  /** baseMs: 재시작 시 이어 붙일 시각 (첫 시작은 0) */
  | { type: 'load'; manifest: ModelManifest; baseMs: number }
  | { type: 'audio'; samples: Float32Array }
  | { type: 'finish' };

export type LiveSegment = {
  text: string;
  startMs: number;
  endMs: number;
  /** 번역 세션만 채운다 */
  translation?: string;
};

export type SherpaResponse =
  | { type: 'loaded' }
  | { type: 'load-error'; message: string; fileId: string | null }
  /** 현재 세그먼트의 잠정 텍스트. processedMs = 워커가 처리한 오디오 시각 (지연 계산용) */
  | { type: 'partial'; text: string; processedMs: number }
  | ({ type: 'final' } & LiveSegment)
  | { type: 'finished' }
  | { type: 'error'; message: string };