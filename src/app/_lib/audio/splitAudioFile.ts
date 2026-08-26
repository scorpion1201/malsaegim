import {
  DEFAULT_SPLIT_OPTIONS,
  type AudioChunk,
  type SplitOptions,
  type SplitSummary,
  type SplitterRequest,
  type SplitterResponse,
} from './types';

export type SplitHandle = {
  done: Promise<SplitSummary>;
  cancel: () => void;
};

export const splitAudioFile = (
  file: File,
  onChunk: (chunk: AudioChunk) => void,
  options: SplitOptions = DEFAULT_SPLIT_OPTIONS,
): SplitHandle => {
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
    file
       .arrayBuffer()
       .then((buffer) => {
        const request: SplitterRequest = { type: 'split', file: buffer, options };
        worker.postMessage(request, [buffer]);
       })
       .catch((error: unknown) => {
        settled = true;
        worker.terminate();
        reject(error instanceof Error ? error : new Error(String(error)));
       });
    });

  const cancel = () => {
    if (settled) return;
    settled = true;
    worker.terminate();
   };

  return { done, cancel };
};