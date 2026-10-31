import { createResampler } from '@/app/_lib/audio/micCapture';
import { RECORDING_SAMPLE_RATE, floatToPcm16 } from '@/app/_lib/audio/wav';
import type { LiveRecognizer, LiveRecognizerHandlers } from '@/app/_lib/engine/malsaegimEngine';
import {
  AsrNetworkError,
  REALTIME_SAMPLE_RATE,
  mintRealtimeSecret,
  openRealtimeSocket,
  realtimeError,
  realtimeSessionUpdate,
  toBase64,
  type DirectTarget,
  type RealtimeEvent,
} from './directTranscribe';

type TurnRange = { startMs: number; endMs: number };
type Turn = TurnRange & { itemId?: string };
type Item = { text: string; done: boolean };

const FINISH_TIMEOUT_MS = 15_000;
const MAX_RESTARTS = 2;
/** 이보다 짧은 버퍼는 commit 하지 않고 다음 턴에 붙인다 — 100ms */
const MIN_COMMIT_SAMPLES = REALTIME_SAMPLE_RATE / 10;

/**
 * BYOK 실시간 받아쓰기 — 녹음 한 회차에 Realtime 세션 하나를 유지하며 프레임을 흘려보낸다.
 * 이 모델들은 서버 VAD 가 없어 턴 끝을 클라이언트가 알려야 하므로 청커의 조각 경계(endTurn)에서 commit 한다.
 * 완료 순서는 보장되지 않아 commit 순서대로 묶어 onFinal 을 낸다.
 */
export const startRealtimeRecognizer = async (target: DirectTarget, handlers: LiveRecognizerHandlers): Promise<LiveRecognizer> => {
  const resample = createResampler(RECORDING_SAMPLE_RATE, REALTIME_SAMPLE_RATE);
  const turns: Turn[] = [];
  const items = new Map<string, Item>();
  let socket: WebSocket | null = null;
  let sentMs = 0;
  let restarts = 0;
  let closed = false;
  let onDrained: (() => void) | null = null;
  /** 아직 commit 하지 않은 오디오 — 연결이 끊기면 새 세션에 다시 보낸다 */
  let uncommitted: string[] = [];
  let uncommittedSamples = 0;
  /** commit 을 건너뛴 경계가 있으면 다음 턴이 그 시작 시각을 이어받는다 */
  let turnStartMs: number | null = null;

  const itemOf = (id: string): Item => {
    const existing = items.get(id);
    if (existing) return existing;
    const created = { text: '', done: false };
    items.set(id, created);
    return created;
  };

  const publish = () => {
    while (turns[0]?.itemId) {
      const { itemId, startMs, endMs } = turns[0];
      const item = items.get(itemId);
      if (!item?.done) break;
      turns.shift();
      items.delete(itemId);
      const text = item.text.trim();
      if (text) handlers.onFinal({ text, startMs, endMs });
    }
    const partial = [...items.values()].map((item) => item.text.trim()).filter(Boolean).join(' ');
    handlers.onPartial(partial, sentMs);
    if (turns.length === 0) onDrained?.();
  };

  /** 세션이 끝나 완료 이벤트를 더 받을 수 없을 때 — 받아 둔 부분 텍스트를 확정한다 */
  const settle = () => {
    while (turns[0] && !turns[0].itemId) turns.shift();
    for (const turn of turns) if (turn.itemId) itemOf(turn.itemId).done = true;
    publish();
    items.clear();
  };

  const onMessage = (event: MessageEvent<string>) => {
    const message = JSON.parse(event.data) as RealtimeEvent;
    switch (message.type) {
      case 'input_audio_buffer.committed': {
        const turn = turns.find((candidate) => !candidate.itemId);
        if (turn) turn.itemId = message.item_id;
        break;
      }
      case 'conversation.item.input_audio_transcription.delta':
        if (message.item_id) itemOf(message.item_id).text += message.delta ?? '';
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (message.item_id && typeof message.transcript === 'string') {
          items.set(message.item_id, { text: message.transcript, done: true });
          restarts = 0;
        }
        break;
      case 'conversation.item.input_audio_transcription.failed':
        if (message.item_id) itemOf(message.item_id).done = true;
        handlers.onError(realtimeError(message.error));
        break;
      case 'error':
        handlers.onError(realtimeError(message.error));
        return;
      default:
        return;
    }
    publish();
  };

  const connect = async (): Promise<void> => {
    const secret = await mintRealtimeSecret(target);
    const next = openRealtimeSocket(target, secret);
    await new Promise<void>((resolve, reject) => {
      next.onopen = () => resolve();
      next.onerror = () => reject(new AsrNetworkError('Realtime 서버에 연결하지 못했습니다'));
    });
    next.onerror = null;
    next.onmessage = onMessage;
    next.onclose = onClose;
    next.send(realtimeSessionUpdate(target));
    for (const audio of uncommitted) next.send(JSON.stringify({ type: 'input_audio_buffer.append', audio }));
    socket = next;
  };

  const onClose = (event: CloseEvent) => {
    socket = null;
    if (closed) return;
    settle();
    if (restarts >= MAX_RESTARTS) {
      closed = true;
      handlers.onError(new AsrNetworkError(`Realtime 연결이 끊겼습니다 (${event.code})`));
      return;
    }
    restarts += 1;
    handlers.onRestart();
    void connect().catch((error: unknown) => {
      closed = true;
      handlers.onError(error instanceof Error ? error : new Error(String(error)));
    });
  };

  await connect();

  return {
    push: (samples) => {
      sentMs += (samples.length / RECORDING_SAMPLE_RATE) * 1000;
      if (closed) return;
      const pcm = floatToPcm16(resample(samples));
      if (pcm.length === 0) return;
      const audio = toBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      uncommitted.push(audio);
      uncommittedSamples += pcm.length;
      socket?.send(JSON.stringify({ type: 'input_audio_buffer.append', audio }));
    },
    endTurn: ({ startMs, endMs }) => {
      turnStartMs ??= startMs;
      if (!socket || uncommittedSamples < MIN_COMMIT_SAMPLES) return;
      socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      turns.push({ startMs: turnStartMs, endMs });
      turnStartMs = null;
      uncommitted = [];
      uncommittedSamples = 0;
    },
    finish: () =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          onDrained = null;
          closed = true;
          settle();
          socket?.close();
          socket = null;
          resolve();
        };
        const timer = setTimeout(done, FINISH_TIMEOUT_MS);
        if (turns.length === 0) done();
        else onDrained = done;
      }),
    terminate: () => {
      closed = true;
      socket?.close();
      socket = null;
    },
  };
};