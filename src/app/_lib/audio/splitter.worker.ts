import init, { split_mp3 } from './pkg/audio_splitter';
import type { SplitterRequest, SplitterResponse } from './types';

const ready = init(new URL('./pkg/audio_splitter_bg.wasm', import.meta.url));

type WorkerScope = {
   postMessage(message: unknown, transfer: Transferable[]): void;
};

const post = (message: SplitterResponse, transfer: Transferable[] = []) => {
  (self as unknown as WorkerScope).postMessage(message, transfer);
};

self.onmessage = async (event: MessageEvent<SplitterRequest>) => {
  const { file, options } = event.data;
  try {
    await ready;
    const summary = split_mp3(
      new Uint8Array(file),
      options.targetSecs,
      options.maxSecs,
      options.silenceDb,
        (index: number, startMs: number, endMs: number, wav: Uint8Array) => {
          // wasm-bindgen의 Uint8Array::from 은 JS 힙에 새 버퍼를 만들므로 그대로 이전(transfer)한다.
          post({ type: 'chunk', chunk: { index, startMs, endMs, wav } }, [wav.buffer]);
        },
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