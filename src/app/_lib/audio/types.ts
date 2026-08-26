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
  targetSecs: 150,
  maxSecs: 170,
  silenceDb: -40,
};

export type SplitterRequest = {
  type: 'split';
  file: ArrayBuffer;
  options: SplitOptions;
};

export type SplitterResponse =
   | { type: 'chunk'; chunk: AudioChunk }
   | { type: 'done'; summary: SplitSummary }
   | { type: 'error'; message: string };