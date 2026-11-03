import type { SpeakerTurn } from './speakerTurns';

/** ortUrl: onnxruntime-web ES 모듈, wasmBaseUrl: 그 wasm 이 있는 디렉터리(끝에 /), modelUrl: 화자 임베딩 ONNX */
export type DiarizeRuntime = { ortUrl: string; wasmBaseUrl: string; modelUrl: string };

/** pcm 은 16 kHz 모노 */
export type DiarizeRequest = { pcm: Int16Array; runtime: DiarizeRuntime; threads: number };

/** 화자 한 명의 지문 재료 — 목소리 지문 등록(하위 프로젝트 B)이 쓴다. cleanSpans 는 겹치지 않고 말소리가 확실한 구간 */
export type SpeakerPrint = {
  speaker: number;
  centroid: number[];
  cleanSpans: { startMs: number; endMs: number }[];
  speakerModelSha256: string;
  speechModelSha256: string | null;
};

/** speechFrames: log-mel 프레임(10 ms)별 말소리 판정 — 평가 도구용이라 메인 스레드로 보내지 않는다 */
export type DiarizeResult = { turns: SpeakerTurn[]; speakers: SpeakerPrint[]; speechFrames: Uint8Array };

export type DiarizeResponse =
  | { type: 'progress'; ratio: number }
  | { type: 'done'; turns: SpeakerTurn[] }
  | { type: 'error'; message: string };