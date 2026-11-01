import { AsrHttpError, OPENAI_BASE_URL, type RealtimeEvent } from '@/app/_lib/asr/directTranscribe';
import { MIC_AUDIO_CONSTRAINTS } from '@/app/_lib/audio/micCapture';

export type TranslationServerEvent = {
  type?: string;
  delta?: string;
  elapsed_ms?: number | null;
  session?: { expires_at?: number };
  error?: RealtimeEvent['error'];
};

export type CallHandlers = {
  onEvent: (event: TranslationServerEvent) => void;
  /** sinceMs: 연결이 끊긴 것으로 보이기 시작한 시각 (performance.now) */
  onDown: (sinceMs: number) => void;
  onPlayBlocked: () => void;
};

export type TranslationCall = {
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

/**
 * 번역과 녹음이 함께 쓰는 마이크 트랙 하나. Chrome 은 같은 장치의 처리 설정을 첫 캡처에 묶어,
 * 원음 트랙과 에코 제거 트랙을 같이 열면 에코 제거가 꺼진다. remote-only 는 번역 음성만 지워 현장 소리는 남는다.
 */
export const openMicTrack = async (): Promise<MediaStreamTrack> => {
  const open = async (echoCancellation: ConstrainBoolean | { exact: string }) => {
    const constraints = { ...MIC_AUDIO_CONSTRAINTS, echoCancellation } as MediaTrackConstraints;
    return (await navigator.mediaDevices.getUserMedia({ audio: constraints })).getAudioTracks()[0];
  };
  try {
    return await open({ exact: 'remote-only' });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'OverconstrainedError') throw error;
    return open(true);
  }
};

/** 미디어와 이벤트는 OpenAI 와 직결이다. 말새김 서버는 오디오와 SDP 를 보지 않는다 */
export const openTranslationCall = async ({ secret, sendTrack, audio, handlers, signal }: CallOptions): Promise<TranslationCall> => {
  const pc = new RTCPeerConnection();
  const channel = pc.createDataChannel('oai-events');
  const sender = pc.addTrack(sendTrack, new MediaStream([sendTrack]));
  let closed = false;
  let downTimer: ReturnType<typeof setTimeout> | null = null;
  let disconnectedAtMs: number | null = null;

  const clearDownTimer = () => {
    if (downTimer !== null) clearTimeout(downTimer);
    downTimer = null;
  };

  const down = () => {
    if (closed) return;
    clearDownTimer();
    handlers.onDown(disconnectedAtMs ?? performance.now());
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
    else if (pc.connectionState === 'disconnected') {
      disconnectedAtMs ??= performance.now();
      downTimer ??= setTimeout(down, DISCONNECTED_GRACE_MS);
    } else {
      disconnectedAtMs = null;
      clearDownTimer();
    }
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
    setSendEnabled: (enabled) => {
      if (sender.track) sender.track.enabled = enabled;
    },
    requestClose: () => {
      if (channel.readyState === 'open') channel.send(JSON.stringify({ type: 'session.close' }));
    },
    close,
  };
};