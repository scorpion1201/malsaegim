export type AudioChunk = {
  index: number;
  startMs: number;
  endMs: number;
  wav: Uint8Array;
};

export type SplitSummary = {
  totalMs: number;
  chunkCount: number;
  sampleRate: number;
};

export type SplitOptions = {
  targetSecs: number;
  maxSecs: number;
  silenceDb: number;
};

export const DEFAULT_SPLIT_OPTIONS: SplitOptions = {
  targetSecs: 225,
  maxSecs: 240,
  silenceDb: -40,
};

/**
 * On-Device(whisper.cpp) 용 분할 — 30초 한 윈도우 안에 들어가게 자른다.
 * whisper_full 은 오디오 끝에 닿는 윈도우만 그대로 받아들이고, 그 앞 윈도우는 타임스탬프 판정에 실패하면
 * 온도 폴백(디코더 5개 × 여러 온도)으로 4~5배 느려진다. 무음 경계 ≤30초 조각이면 조각마다 한 윈도우라 항상 빠른 경로다.
 */
export const ON_DEVICE_SPLIT_OPTIONS: SplitOptions = {
  targetSecs: 25,
  maxSecs: 30,
  silenceDb: -40,
};

/**
 * 화자 구분을 함께 돌리는 BYOK 분할 — 조각 글자에는 시각이 없어 한 조각 안의 화자는 시간 비례로만 나눌 수 있다.
 * 조각을 실시간 녹음과 같은 길이로 줄여 조각 하나가 대개 한 사람의 말이 되게 한다.
 */
export const DIARIZED_SPLIT_OPTIONS: SplitOptions = {
  targetSecs: 12,
  maxSecs: 15,
  silenceDb: -40,
};

/** 재인식용 추출 구간. endMs === null 은 "스트림 끝까지"(마지막 조각 규칙). */
export type ExtractRange = {
  index: number;
  startMs: number;
  endMs: number | null;
};

export type SplitterRequest =
  | { type: 'split'; file: ArrayBuffer; options: SplitOptions }
  | { type: 'extract'; file: ArrayBuffer; ranges: ExtractRange[] };

export type SplitterResponse =
  | { type: 'chunk'; chunk: AudioChunk }
  | { type: 'done'; summary: SplitSummary }
  | { type: 'error'; message: string };