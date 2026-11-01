import { AsrHttpError, AsrNetworkError, mintTranslationSecret, realtimeError } from '@/app/_lib/asr/directTranscribe';
import { RECORDING_SAMPLE_RATE } from '@/app/_lib/audio/wav';
import type { LiveRecognizer, LiveRecognizerHandlers } from '@/app/_lib/engine/sherpaEngine';
import type { NoiseReduction } from '@/app/_lib/settings/translationSettings';
import { formatTimestamp } from '@/app/_lib/time';
import { createEchoFuse } from './echoFuse';
import { usesSpaces } from './languages';
import { applySpeaker, audible, type SpeakerState } from './speaker';
import { openMicTrack, openTranslationCall, type TranslationCall, type TranslationServerEvent } from './translationCall';
import { OUTPUT_SHIFT_MS, createSegmenter, type ClosedBlock, type SegmentStream } from './translationSegmenter';

export type TranslationStatus = 'connecting' | 'live' | 'paused' | 'parked' | 'reconnecting' | 'unavailable' | 'draining';

export type TranslationHandlers = Omit<LiveRecognizerHandlers, 'onRestart'> & {
  onStatus: (status: TranslationStatus) => void;
  onDelay: (delayed: boolean) => void;
  onSpeaker: (state: SpeakerState) => void;
  onFuseTripped: () => void;
  /** 번역 마이크가 끊겼다. 녹음 경로도 같은 장치라 함께 멈췄을 수 있다 */
  onMicLost: () => void;
};

export type TranslationRecognizer = LiveRecognizer & {
  /** 녹음도 이 트랙을 복제해 쓴다 — 같은 장치를 다른 설정으로 또 열면 에코 제거가 꺼진다 */
  micTrack: MediaStreamTrack;
  /** 켜기는 blocked, fuseTripped 를 초기화한다 */
  setSpeaker: (intent: 'on' | 'off') => Promise<void>;
  pause: () => void;
  resume: () => Promise<void>;
  /** unavailable 에서 다시 연결 */
  reconnect: () => Promise<void>;
};

export type TranslationStartOptions = {
  apiKey: string;
  targetLanguage: string;
  noiseReduction: NoiseReduction;
  speakerOn: boolean;
  signal: AbortSignal;
};

export type StartErrorKind = 'mic' | 'session' | 'key' | 'access' | 'request' | 'quota' | 'proxy' | 'network' | 'aborted';

/** 세션 하나의 연결 상태 */
type Connection = {
  call: TranslationCall;
  startWallMs: number | null;
  /** 교대·정지로 물러난 세션 — 남은 델타만 받는다 */
  retired: boolean;
};

const PARK_AFTER_MS = 60_000;
const RECONNECT_DELAYS_MS = [1000, 3000, 8000];
const STABLE_RESET_MS = 60_000;
const HANDOFF_BEFORE_MS = 120_000;
const HANDOFF_FORCE_MS = 10_000;
const FINISH_TIMEOUT_MS = 15_000;
const DELAY_AFTER_MS = 5000;
const TICK_MS = 500;
const READY_TIMEOUT_MS = 15_000;
/** 물러난 세션이 session.closed 를 내고 남은 번역을 흘려보낼 시간 */
const RETIRE_MS = 10_000;

const MIC_ERRORS = new Set(['NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'SecurityError']);

const abortError = (): DOMException => new DOMException('번역 시작을 취소했습니다', 'AbortError');

export const classifyStartError = (error: unknown): StartErrorKind => {
  if (error instanceof AsrHttpError) {
    if (error.status === 401) return error.message === 'unauthorized' ? 'session' : 'key';
    if (error.status === 403) return 'access';
    if (error.status === 429) return /quota|billing/i.test(error.message) ? 'quota' : 'network';
    return error.status >= 500 ? 'network' : 'request';
  }
  if (error instanceof AsrNetworkError) return error.message.startsWith('요청을 보내지 못했습니다') ? 'network' : 'proxy';
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'aborted';
    if (MIC_ERRORS.has(error.name)) return 'mic';
  }
  return 'network';
};

/** 재시도해도 소용없는 시작 오류 */
const isFatal = (error: unknown): boolean => {
  const kind = classifyStartError(error);
  return kind === 'session' || kind === 'key' || kind === 'access' || kind === 'request' || kind === 'quota' || kind === 'proxy';
};

/**
 * 실시간 번역 — 기존 LiveRecognizer 를 구현해 녹음, WAV 저장, 노트 조립을 그대로 탄다.
 * 오디오는 청커 프레임이 아니라 별도 마이크 트랙이 WebRTC 로 나간다. push 는 지연 계산용 시각만 센다.
 */
export const startTranslationRecognizer = async (
  options: TranslationStartOptions,
  handlers: TranslationHandlers,
): Promise<TranslationRecognizer> => {
  const { apiKey, targetLanguage, noiseReduction, speakerOn } = options;
  // 정리되면 진행 중인 발급과 연결을 함께 끊는다. 그래야 끝난 인식기가 세션을 새로 열지 않는다
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  // 사용자 제스처 안에서 만들어야 자동재생이 막히지 않는다 — 첫 await 앞에 둔다
  const audio = new Audio();
  audio.autoplay = true;
  audio.muted = !speakerOn;

  let mic: MediaStreamTrack | null = null;
  let connection: Connection | null = null;
  let speaker: SpeakerState = { intent: speakerOn ? 'on' : 'off', blocked: false, fuseTripped: false };
  let speakerQueue: Promise<void> = Promise.resolve();
  let status: TranslationStatus = 'connecting';
  let sentMs = 0;
  let closed = false;
  let paused = false;
  let micLost = false;
  let reconnecting = false;
  let expiresAtMs: number | null = null;
  let handoffRunning = false;
  let gapOpen = false;
  let lastInputMs = 0;
  let lastOutputMs = 0;
  let delayed = false;
  let parkTimer: ReturnType<typeof setTimeout> | null = null;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  let onSessionClosed: (() => void) | null = null;
  let attempts = 0;

  const retired = new Set<Connection>();
  const fuse = createEchoFuse();

  const setStatus = (next: TranslationStatus) => {
    status = next;
    handlers.onStatus(next);
  };

  const setDelayed = (next: boolean) => {
    if (delayed === next) return;
    delayed = next;
    handlers.onDelay(next);
  };

  const updateSpeaker = (next: SpeakerState): Promise<void> => {
    speakerQueue = speakerQueue.then(async () => {
      if (closed) return;
      speaker = await applySpeaker(next, audio);
      handlers.onSpeaker(speaker);
    });
    return speakerQueue;
  };

  const tripFuse = () => {
    fuse.reset();
    void updateSpeaker({ ...speaker, fuseTripped: true });
    handlers.onFuseTripped();
  };

  const emitPartial = () => {
    const { source, translation } = segmenter.partial();
    handlers.onPartial(source, sentMs, translation);
  };

  const onBlockClosed = (block: ClosedBlock) => {
    handlers.onFinal({ text: block.source, translation: block.translation, startMs: block.startMs, endMs: block.endMs });
    if (audible(speaker) && fuse.check(block.source, performance.now())) tripFuse();
  };

  const segmenter = createSegmenter({
    glueWords: usesSpaces(targetLanguage),
    formatGap: (startMs, endMs) => `[번역 끊김 ${formatTimestamp(startMs)}–${formatTimestamp(endMs)}]`,
    onClose: onBlockClosed,
  });

  const clearParkTimer = () => {
    if (parkTimer !== null) clearTimeout(parkTimer);
    parkTimer = null;
  };

  const clearStableTimer = () => {
    if (stableTimer !== null) clearTimeout(stableTimer);
    stableTimer = null;
  };

  /** 침묵 세션도 과금될 수 있어 일시정지의 낭비 상한을 60초로 묶는다 */
  const armPark = () => {
    clearParkTimer();
    parkTimer = setTimeout(() => {
      parkTimer = null;
      if (!connection || status !== 'paused') return;
      retire(connection);
      connection = null;
      setStatus('parked');
    }, PARK_AFTER_MS);
  };

  /** 세션을 물러나게 한다 — session.close 를 보내고 남은 번역을 잠시 더 받는다 */
  const retire = (target: Connection) => {
    target.retired = true;
    target.call.requestClose();
    retired.add(target);
    setTimeout(() => {
      retired.delete(target);
      target.call.close();
    }, RETIRE_MS);
  };

  const onDelta = (target: Connection, stream: SegmentStream, event: TranslationServerEvent) => {
    const text = event.delta ?? '';
    const now = performance.now();
    const shift = stream === 'output' ? OUTPUT_SHIFT_MS : 0;
    const elapsed = event.elapsed_ms;
    const wallMs = typeof elapsed === 'number' && target.startWallMs !== null ? target.startWallMs + elapsed - shift : now;
    if (stream === 'input') {
      lastInputMs = now;
      if (lastOutputMs === 0) lastOutputMs = now;
    } else {
      lastOutputMs = now;
      setDelayed(false);
      fuse.noteOutput(text, now);
    }
    segmenter.delta(stream, text, wallMs);
    emitPartial();
  };

  const connect = async (track: MediaStreamTrack): Promise<void> => {
    const secret = await mintTranslationSecret({ apiKey, targetLanguage, noiseReduction }, signal);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let failed = false;
      const settle = (run: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        run();
      };
      const fail = (error: unknown) =>
        settle(() => {
          failed = true;
          reject(error);
        });
      const onAbort = () => fail(abortError());
      const timer = setTimeout(() => fail(new AsrNetworkError('요청을 보내지 못했습니다 (세션 응답 없음)')), READY_TIMEOUT_MS);
      signal.addEventListener('abort', onAbort);

      const target: Connection = { call: null as unknown as TranslationCall, startWallMs: null, retired: false };
      openTranslationCall({
        secret,
        sendTrack: track,
        audio,
        signal,
        handlers: {
          onEvent: (event) => {
            switch (event.type) {
              case 'session.created':
                target.startWallMs = performance.now();
                expiresAtMs = typeof event.session?.expires_at === 'number' ? event.session.expires_at * 1000 : null;
                settle(resolve);
                break;
              case 'session.input_transcript.delta':
                onDelta(target, 'input', event);
                break;
              case 'session.output_transcript.delta':
                onDelta(target, 'output', event);
                break;
              case 'session.closed':
                if (target === connection && onSessionClosed) onSessionClosed();
                else if (target === connection && !target.retired) void onDown(performance.now());
                break;
              case 'error':
                handlers.onError(realtimeError(event.error));
                break;
              default:
                break;
            }
          },
          onDown: (sinceMs) => {
            if (!settled) {
              fail(new AsrNetworkError('요청을 보내지 못했습니다 (연결 끊김)'));
              return;
            }
            if (target === connection && !target.retired) void onDown(sinceMs);
          },
          onPlayBlocked: () => void updateSpeaker({ ...speaker, blocked: true }),
        },
      })
        .then((call) => {
          target.call = call;
          if (failed) {
            call.close();
            return;
          }
          connection = target;
          target.call.setSendEnabled(!paused);
        })
        .catch(fail);
    }).catch((error: unknown) => {
      connection?.call.close();
      connection = null;
      throw error;
    });
  };

  const beginGap = (wallMs: number) => {
    if (gapOpen) return;
    gapOpen = true;
    segmenter.openGap(wallMs);
  };

  const markLive = () => {
    if (closed || status === 'draining') return;
    if (micLost) {
      connection?.call.close();
      connection = null;
      setStatus('unavailable');
      return;
    }
    if (gapOpen) segmenter.closeGap(performance.now());
    gapOpen = false;
    setStatus(paused ? 'paused' : 'live');
    if (paused) armPark();
    clearStableTimer();
    stableTimer = setTimeout(() => {
      attempts = 0;
    }, STABLE_RESET_MS);
  };

  /** 재연결: 기존 pc 폐기 → 새 임시 키 → 같은 트랙과 같은 audio 요소. 녹음은 멈추지 않는다 */
  const runReconnect = async (sinceMs = performance.now()): Promise<void> => {
    if (reconnecting || closed) return;
    reconnecting = true;
    clearStableTimer();
    setStatus('reconnecting');
    beginGap(sinceMs);
    connection?.call.close();
    connection = null;
    while (!closed && attempts < RECONNECT_DELAYS_MS.length) {
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAYS_MS[attempts]));
      attempts += 1;
      if (closed || micLost || !mic) break;
      try {
        await connect(mic);
        reconnecting = false;
        markLive();
        return;
      } catch (error) {
        if (isFatal(error)) {
          handlers.onError(error instanceof Error ? error : new Error(String(error)));
          break;
        }
      }
    }
    reconnecting = false;
    if (!closed) setStatus('unavailable');
  };

  const onDown = async (sinceMs: number): Promise<void> => {
    if (closed || status === 'draining') {
      onSessionClosed?.();
      return;
    }
    if (paused) {
      connection?.call.close();
      connection = null;
      clearParkTimer();
      setStatus('parked');
      return;
    }
    await runReconnect(sinceMs);
  };

  const watchMic = (track: MediaStreamTrack) => {
    track.onended = () => {
      if (closed || status === 'draining') return;
      micLost = true;
      beginGap(performance.now());
      connection?.call.close();
      connection = null;
      setStatus('unavailable');
      handlers.onMicLost();
    };
  };

  /** 만료 전 교대: 옛 세션을 드레인하며 새 세션을 연다. 재연결 횟수에 넣지 않는다 */
  const handoff = async (): Promise<void> => {
    const old = connection;
    if (handoffRunning || !old || !mic) return;
    handoffRunning = true;
    beginGap(performance.now());
    retire(old);
    connection = null;
    try {
      await connect(mic);
      markLive();
    } catch {
      if (!closed) await runReconnect();
    } finally {
      handoffRunning = false;
    }
  };

  const handoffDue = (marginMs: number): boolean =>
    expiresAtMs !== null && status === 'live' && Date.now() >= expiresAtMs - marginMs;

  const tickTimer = setInterval(() => {
    const now = performance.now();
    segmenter.tick(now);
    emitPartial();
    if (lastInputMs > 0 && lastInputMs - lastOutputMs >= DELAY_AFTER_MS) setDelayed(true);
    if (handoffDue(HANDOFF_FORCE_MS)) void handoff();
    if (audible(speaker) && fuse.looping(now)) tripFuse();
  }, TICK_MS);

  const cleanup = () => {
    closed = true;
    lifetime.abort();
    clearInterval(tickTimer);
    clearParkTimer();
    clearStableTimer();
    connection?.call.close();
    connection = null;
    for (const target of retired) target.call.close();
    retired.clear();
    audio.srcObject = null;
    mic?.stop();
    mic = null;
  };

  try {
    if (signal.aborted) throw abortError();
    mic = await openMicTrack();
    if (signal.aborted) throw abortError();
    watchMic(mic);
    await connect(mic);
  } catch (error) {
    cleanup();
    throw error;
  }
  setStatus('live');

  return {
    micTrack: mic,
    push: (samples) => {
      sentMs += (samples.length / RECORDING_SAMPLE_RATE) * 1000;
    },
    endTurn: ({ startMs, endMs, wav }) => {
      segmenter.cut({ startMs, endMs, voiced: wav !== undefined }, performance.now());
      // 경계는 말 쉼이나 침묵이라 교대로 잃는 말이 가장 적다
      if (handoffDue(HANDOFF_BEFORE_MS)) void handoff();
    },
    finish: () =>
      new Promise<void>((resolve) => {
        setStatus('draining');
        clearParkTimer();
        const current = connection;
        const done = () => {
          clearTimeout(limit);
          onSessionClosed = null;
          segmenter.flush();
          cleanup();
          resolve();
        };
        const limit = setTimeout(done, FINISH_TIMEOUT_MS);
        // 세션이 아직 뜨지 않았으면 받을 번역도 없다 — 연결을 취소하고 끝낸다
        if (!current || current.startWallMs === null) {
          done();
          return;
        }
        // 남은 글은 session.closed 전에 온다 — 실측 4.6~5.8초. 상한은 15초
        onSessionClosed = done;
        current.call.setSendEnabled(false);
        current.call.requestClose();
      }),
    terminate: cleanup,
    setSpeaker: (intent) => {
      if (intent === 'on') fuse.reset();
      return updateSpeaker(intent === 'on' ? { intent, blocked: false, fuseTripped: false } : { ...speaker, intent });
    },
    pause: () => {
      paused = true;
      connection?.call.setSendEnabled(false);
      if (status === 'live') setStatus('paused');
      armPark();
    },
    resume: async () => {
      paused = false;
      clearParkTimer();
      if (status === 'paused') {
        connection?.call.setSendEnabled(true);
        setStatus('live');
      } else if (status === 'parked' && mic) {
        // 재개 후 연결되는 동안의 말은 번역되지 않는다
        beginGap(performance.now());
        setStatus('connecting');
        try {
          await connect(mic);
          markLive();
        } catch {
          await runReconnect();
        }
      }
    },
    reconnect: async () => {
      attempts = 0;
      await runReconnect();
    },
  };
};