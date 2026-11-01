import { AsrHttpError, OPENAI_BASE_URL, type RealtimeEvent } from '@/app/_lib/asr/directTranscribe';
import { MIC_AUDIO_CONSTRAINTS } from '@/app/_lib/audio/micCapture';

export type TranslationServerEvent = {
  type?: string;
  delta?: string;
  elapsed_ms?: number | null;
  session?: { expires_at?: number };
  error?: RealtimeEvent['error'];
};

/** raw 는 원음 송신, aec 는 스피커가 켜졌을 때의 송신. aec 를 못 열면 null */
export type MicTracks = { raw: MediaStreamTrack; aec: MediaStreamTrack | null; stop: () => void };

export type CallHandlers = {
  onEvent: (event: TranslationServerEvent) => void;
  onDown: () => void;
  onPlayBlocked: () => void;
};

export type TranslationCall = {
  setSendTrack: (track: MediaStreamTrack) => Promise<void>;
  setSendEnabled: (enabled: boolean) => void;
  /** session.close, 채널이 닫혀 있으면 무시 */
  requestClose: () => void;
  close: () => void;
};

type CallOptions = {
  secret: string;
  sendTrack: MediaStreamTrack;
  audio: HTMLAudioElement;
  handlers: CallHandlers;
  signal?: AbortSignal;
};

/** disconnected 는 잠깐 끊겼다 돌아오기도 해서 이만큼 지속될 때만 끊김으로 본다 */
const DISCONNECTED_GRACE_MS = 5000;

const openAecTrack = async (deviceId: string | undefined): Promise<MediaStreamTrack | null> => {
  const device = deviceId ? { deviceId: { exact: deviceId } } : {};
  for (const echoCancellation of [{ exact: 'remote-only' }, true]) {
    try {
      const constraints = { ...MIC_AUDIO_CONSTRAINTS, ...device, echoCancellation } as MediaTrackConstraints;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
      return stream.getAudioTracks()[0] ?? null;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'OverconstrainedError') return null;
    }
  }
  return null;
};

/** 고정하지 않으면 두 트랙이 서로 다른 마이크를 잡는다 — AEC 트랙을 원음 트랙의 장치에 묶는다 */
export const openMicTracks = async (): Promise<MicTracks> => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_AUDIO_CONSTRAINTS });
  const raw = stream.getAudioTracks()[0];
  const aec = await openAecTrack(raw.getSettings().deviceId);
  return {
    raw,
    aec,
    stop: () => {
      raw.stop();
      aec?.stop();
    },
  };
};

/** 미디어와 이벤트는 OpenAI 와 직결이다. 말새김 서버는 오디오와 SDP 를 보지 않는다 */
export const openTranslationCall = async ({ secret, sendTrack, audio, handlers, signal }: CallOptions): Promise<TranslationCall> => {
  const pc = new RTCPeerConnection();
  const channel = pc.createDataChannel('oai-events');
  const sender = pc.addTrack(sendTrack, new MediaStream([sendTrack]));
  let sendEnabled = true;
  let closed = false;
  let downTimer: ReturnType<typeof setTimeout> | null = null;

  const clearDownTimer = () => {
    if (downTimer !== null) clearTimeout(downTimer);
    downTimer = null;
  };

  const down = () => {
    if (closed) return;
    clearDownTimer();
    handlers.onDown();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    clearDownTimer();
    channel.close();
    pc.close();
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') down();
    else if (pc.connectionState === 'disconnected') downTimer ??= setTimeout(down, DISCONNECTED_GRACE_MS);
    else clearDownTimer();
  };
  pc.ontrack = (event) => {
    audio.srcObject = event.streams[0];
    audio.play().catch((error: unknown) => {
      if (error instanceof Error && error.name === 'NotAllowedError') handlers.onPlayBlocked();
    });
  };
  channel.onclose = down;
  channel.onmessage = (event: MessageEvent<string>) => {
    try {
      handlers.onEvent(JSON.parse(event.data) as TranslationServerEvent);
    } catch {
      // 깨진 메시지는 건너뛴다
    }
  };

  try {
    await pc.setLocalDescription(await pc.createOffer());
    const response = await fetch(`${OPENAI_BASE_URL}/realtime/translations/calls`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/sdp' },
      body: pc.localDescription?.sdp,
      signal,
    });
    const body = await response.text();
    if (!response.ok) throw new AsrHttpError(response.status, body.slice(0, 300) || `HTTP ${response.status}`);
    await pc.setRemoteDescription({ type: 'answer', sdp: body });
  } catch (error) {
    close();
    throw error;
  }

  return {
    setSendTrack: async (track) => {
      track.enabled = sendEnabled;
      await sender.replaceTrack(track);
    },
    setSendEnabled: (enabled) => {
      sendEnabled = enabled;
      if (sender.track) sender.track.enabled = enabled;
    },
    requestClose: () => {
      if (channel.readyState === 'open') channel.send(JSON.stringify({ type: 'session.close' }));
    },
    close,
  };
};