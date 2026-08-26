import {
  DEFAULT_SPLIT_OPTIONS,
  type AudioChunk,
  type ExtractRange,
  type SplitOptions,
  type SplitSummary,
  type SplitterRequest,
  type SplitterResponse,
} from './types';

export type SplitHandle = {
  done: Promise<SplitSummary>;
  cancel: () => void;
};

/** 워커를 하나 띄워 요청을 처리한다. buffer 는 transfer 되므로 호출 후 detach 된다 (해시는 먼저 계산할 것). */
const runWorker = (request: SplitterRequest, onChunk: (chunk: AudioChunk) => void): SplitHandle => {
  const worker = new Worker(new URL('./splitter.worker.ts', import.meta.url), { type: 'module' });
  let settled = false;

  const done = new Promise<SplitSummary>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<SplitterResponse>) => {
      const message = event.data;
      if (message.type === 'chunk') {
        onChunk(message.chunk);
        return;
      }
      settled = true;
      worker.terminate();
      if (message.type === 'done') resolve(message.summary);
      else reject(new Error(message.message));
    };
    worker.onerror = (event) => {
      settled = true;
      worker.terminate();
      reject(new Error(event.message || 'audio worker failed'));
    };
    worker.postMessage(request, [request.file]);
  });

  const cancel = () => {
    if (settled) return;
    settled = true;
    worker.terminate();
  };

  return { done, cancel };
};

/** 새 노트: 무음 경계 분할 후 전 조각을 순서대로 방출 */
export const splitAudioBuffer = (
  buffer: ArrayBuffer,
  onChunk: (chunk: AudioChunk) => void,
  options: SplitOptions = DEFAULT_SPLIT_OPTIONS,
): SplitHandle => runWorker({ type: 'split', file: buffer, options }, onChunk);

/** 재인식: 저장된 시간 구간만 추출해 방출 (분할 알고리즘과 무관하게 결정적) */
export const extractAudioRanges = (
  buffer: ArrayBuffer,
  ranges: ExtractRange[],
  onChunk: (chunk: AudioChunk) => void,
): SplitHandle => runWorker({ type: 'extract', file: buffer, ranges }, onChunk);