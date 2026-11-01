/** 실시간 받아쓰기 공용 타입 — On-Device(whisper)·BYOK Realtime·실시간 번역이 같은 인터페이스로 녹음 흐름에 붙는다 */
export type LiveSegment = {
  text: string;
  startMs: number;
  endMs: number;
  /** 번역 세션만 채운다 */
  translation?: string;
};

export type LiveRecognizerHandlers = {
  /** 아직 확정되지 않은 자막. processedMs = 엔진이 처리를 마친 오디오 시각 (지연 계산용) */
  onPartial: (text: string, processedMs: number, translationPartial?: string) => void;
  /** 확정 자막 — 한 번 낸 것은 바꾸지 않는다 */
  onFinal: (segment: LiveSegment) => void;
  /** 엔진이 죽어 다시 띄우는 중 — 실시간 줄에 "인식 엔진 재시작" */
  onRestart: () => void;
  onError: (error: Error) => void;
};

export type LiveRecognizer = {
  /** 녹음 시간축(저장 WAV 와 같은 샘플)에 들어간 16 kHz 프레임 */
  push: (samples: Float32Array) => void;
  /** 조각 경계를 알린다 — 서버가 턴을 나누지 않는 엔진(Realtime)만 쓴다. wav 가 있으면 말소리가 있는 조각이다 */
  endTurn?: (range: { startMs: number; endMs: number; wav?: Uint8Array }) => void;
  /** 마지막 발화까지 확정해 내보낸 뒤 끝낸다 */
  finish: () => Promise<void>;
  /** 즉시 버린다 — 진행 중인 인식 결과는 새 세션에 섞이지 않게 무시된다 */
  terminate: () => void;
};