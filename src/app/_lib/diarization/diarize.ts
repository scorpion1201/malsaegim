/**
 * 화자 구분 — 받아쓰기가 끝난 녹음을 브라우저 워커에서 분석해 누가 언제 말했는지 돌려준다.
 * 오디오는 서버로 나가지 않는다. 런타임과 모델은 내용 해시 경로(/models/speaker/...)라 HTTP 캐시에 남는다.
 */
import { onDeviceThreads } from '@/app/_lib/engine/capabilities';
import type { ModelManifest } from '@/app/_lib/engine/modelStore';
import type { DiarizeRequest, DiarizeResponse, DiarizeRuntime } from './diarizeProtocol';
import type { SpeakerTurn } from './speakerTurns';

/** 코어를 다 쓰면 끝난 뒤 편집 화면이 버벅인다 */
const MAX_THREADS = 4;
/** 이보다 짧은 오디오는 나눌 말 차례가 없다 */
export const MIN_DIARIZE_MS = 20_000;

const directoryOf = (url: string): string => url.slice(0, url.lastIndexOf('/') + 1);

/** manifest 에서 화자 구분 런타임을 찾는다. 서버에 없으면 null — 받아쓰기는 화자 표시 없이 끝난다 */
export const speakerRuntimeOf = (manifest: ModelManifest | null): DiarizeRuntime | null => {
  const files = manifest?.speaker?.files ?? [];
  const url = (id: string) => files.find((file) => file.id === id)?.url;
  const ortUrl = url('ort-js');
  const wasmUrl = url('ort-wasm');
  const modelUrl = url('speaker-model');
  return ortUrl && wasmUrl && modelUrl ? { ortUrl, wasmBaseUrl: directoryOf(wasmUrl), modelUrl } : null;
};

export const diarizeAudio = (
  pcm: Int16Array,
  runtime: DiarizeRuntime,
  onProgress: (ratio: number) => void,
  signal: AbortSignal,
): Promise<SpeakerTurn[]> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./diarize.worker.ts', import.meta.url), { type: 'module' });
    const finish = () => {
      signal.removeEventListener('abort', onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      finish();
      reject(new DOMException('중단됨', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<DiarizeResponse>) => {
      const message = event.data;
      if (message.type === 'progress') {
        onProgress(message.ratio);
        return;
      }
      finish();
      if (message.type === 'done') resolve(message.turns);
      else reject(new Error(message.message));
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || '화자 구분 워커가 멈췄습니다'));
    };
    const request: DiarizeRequest = { pcm, runtime, threads: Math.min(onDeviceThreads(), MAX_THREADS) };
    worker.postMessage(request, [pcm.buffer as ArrayBuffer]);
  });