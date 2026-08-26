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