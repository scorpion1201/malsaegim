import type { ModelManifest } from './modelStore';

export type WhisperRequest =
  | { type: 'load'; manifest: ModelManifest }
  | { type: 'transcribe'; id: number; pcm: Float32Array; language: string; threads: number };

export type WhisperResponse =
  | { type: 'loaded' }
  /** fileId 가 있으면 그 캐시 파일이 없거나 깨진 것 — 엔진이 지우고 다시 받게 한다 */
  | { type: 'load-error'; message: string; fileId: string | null }
  | { type: 'progress'; id: number; ratio: number }
  | { type: 'done'; id: number; text: string }
  | { type: 'error'; id: number; message: string };