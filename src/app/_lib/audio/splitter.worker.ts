import init, { extract_ranges, split_audio } from './pkg/audio_splitter';
import type { SplitterRequest, SplitterResponse } from './types';

const ready = init(new URL('./pkg/audio_splitter_bg.wasm', import.meta.url));

type WorkerScope = {
  postMessage(message: unknown, transfer: Transferable[]): void;
};

const post = (message: SplitterResponse, transfer: Transferable[] = []) => {
  (self as unknown as WorkerScope).postMessage(message, transfer);
};

const onChunk = (index: number, startMs: number, endMs: number, wav: Uint8Array) => {
  // wasm-bindgen의 Uint8Array::from 은 JS 힙에 새 버퍼를 만들므로 그대로 이전(transfer)한다.
  post({ type: 'chunk', chunk: { index, startMs, endMs, wav } }, [wav.buffer]);
};

self.onmessage = async (event: MessageEvent<SplitterRequest>) => {
  const request = event.data;
  try {
    await ready;
    const bytes = new Uint8Array(request.file);
    const summary =
      request.type === 'split'
        ? split_audio(
            bytes,
            request.options.targetSecs,
            request.options.maxSecs,
            request.options.silenceDb,
            onChunk,
          )
        : extract_ranges(
            bytes,
            new Uint32Array(request.ranges.map((range) => range.index)),
            new Float64Array(request.ranges.map((range) => range.startMs)),
            new Float64Array(request.ranges.map((range) => range.endMs ?? -1)),
            onChunk,
          );
    post({
      type: 'done',
      summary: {
        totalMs: summary.total_ms,
        chunkCount: summary.chunk_count,
        sampleRate: summary.sample_rate,
      },
    });
    summary.free();
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};