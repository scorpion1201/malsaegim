/**
 * On-Device 실시간 받아쓰기 — 공용 whisper 워커(파일 전사와 같은 모델)로 오디오 창을 반복 인식한다.
 * 버퍼·갱신·확정 규칙은 liveSession.ts, 여기서는 워커 요청·재시작·세션 수명만 다룬다.
 * 마이크 수집과 화면은 메인 스레드, 인식은 워커라 추론이 UI·녹음을 멈추지 않는다.
 */
import { onDeviceThreads } from './capabilities';
import { createLiveSession, type Recognize } from './liveSession';
import type { LiveRecognizer, LiveRecognizerHandlers } from './liveTypes';
import type { ModelBundle } from './modelStore';
import { WHISPER_LANGUAGE } from './whisperEngine';
import { ensureWhisper, holdWhisper, postWhisper, whisperBackend } from './whisperHost';
import type { LiveWord, WhisperRequest } from './whisperProtocol';

/** 녹음 한 회차에서 워커를 다시 띄우는 횟수 */
const MAX_RESTARTS = 1;

export type WhisperLiveOptions = {
  /** 부분 자막 인식의 인코더를 창 길이로 줄인다(audio_ctx). 기본: CPU 백엔드일 때만. 확정 인식은 항상 전체 인코더 */
  reduceAudioCtx?: boolean;
};

export const startWhisperLive = async (
  bundle: ModelBundle,
  handlers: LiveRecognizerHandlers,
  options: WhisperLiveOptions = {},
): Promise<LiveRecognizer> => {
  await ensureWhisper(bundle);
  const release = holdWhisper();
  const threads = onDeviceThreads();
  let restarts = 0;

  const recognize: Recognize = (pcm, audioCtx) => {
    let cancel: () => void = () => {};
    const promise = new Promise<LiveWord[]>((resolve, reject) => {
      cancel = postWhisper(
        (id) => ({ type: 'live', id, pcm, language: WHISPER_LANGUAGE, threads, audioCtx }) satisfies WhisperRequest,
        {
          onMessage: (message) => {
            if (message.type === 'live-done') resolve(message.words);
            else if (message.type === 'error') resolve([]); // 이 창만 실패 — 다음 창에서 다시 인식한다
          },
          onStop: reject,
        },
        [pcm.buffer],
      );
    });
    return { promise, cancel: () => cancel() };
  };

  const session = createLiveSession(
    recognize,
    {
      onPartial: (text, processedMs) => handlers.onPartial(text, processedMs),
      onFinal: handlers.onFinal,
      onError: handlers.onError,
      // 워커가 죽으면 한 번은 다시 띄운다 — 그동안 들어온 오디오는 버퍼에 남아 이어서 인식한다. 녹음·WAV 저장은 영향 없다
      recover: async () => {
        if (restarts >= MAX_RESTARTS) return false;
        restarts += 1;
        handlers.onRestart();
        try {
          await ensureWhisper(bundle);
          return true;
        } catch (error) {
          handlers.onError(error instanceof Error ? error : new Error(String(error)));
          return false;
        }
      },
      log: (message) => console.debug(`[whisper-live] ${message}`),
    },
    { reduceAudioCtx: options.reduceAudioCtx ?? whisperBackend() === 'cpu' },
  );

  return {
    push: session.push,
    finish: async () => {
      try {
        await session.finish();
      } finally {
        release();
        const stats = session.stats();
        console.debug(
          `[whisper-live] finished: ${Math.round(stats.audioMs)} ms audio, ${stats.passes} passes, avg ${stats.passes ? Math.round(stats.inferMs / stats.passes) : 0} ms, skipped ${Math.round(stats.skippedMs)} ms`,
        );
      }
    },
    terminate: () => {
      session.terminate();
      release();
    },
  };
};