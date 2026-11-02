import type { SpeakerTurn } from './speakerTurns';

/** ortUrl: onnxruntime-web ES 모듈, wasmBaseUrl: 그 wasm 이 있는 디렉터리(끝에 /), modelUrl: 화자 임베딩 ONNX */
export type DiarizeRuntime = { ortUrl: string; wasmBaseUrl: string; modelUrl: string };

/** pcm 은 16 kHz 모노 */
export type DiarizeRequest = { pcm: Int16Array; runtime: DiarizeRuntime; threads: number };

export type DiarizeResponse =
  | { type: 'progress'; ratio: number }
  | { type: 'done'; turns: SpeakerTurn[] }
  | { type: 'error'; message: string };