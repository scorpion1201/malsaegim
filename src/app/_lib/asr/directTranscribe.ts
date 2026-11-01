/**
 * 사용자가 설정한 API 로 보내는 음성 인식 호출 (BYOK).
 * 키·주소·모델은 설정 페이지에 저장된 값이다. 브라우저 직접 호출은 대부분의 API 가 CORS 로 막으므로
 * 요청을 /api/asr/proxy 에 넘기고, 서버는 x-asr-target-url 로 온 주소에 그대로 전달만 한다(저장·기록 없음).
 * Realtime 전용 모델이면 WebSocket 세션, 그 밖은 OpenAI 호환 /audio/transcriptions.
 */
import { resampleLinear } from '@/app/_lib/audio/micCapture';
import { RECORDING_SAMPLE_RATE, floatToPcm16, wavToFloat32 } from '@/app/_lib/audio/wav';
import type { NoiseReduction } from '@/app/_lib/settings/translationSettings';

export type DirectTarget = {
  apiKey: string;
  baseUrl: string;
  model: string;
  language: string;
};

/** 인식 언어 힌트 — 지금은 한국어 고정 */
export const ASR_LANGUAGE = 'ko';

/** API 가 응답은 했지만 오류 상태인 경우 (429/5xx 는 재시도 대상) */
export class AsrHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AsrHttpError';
  }
}

/** 요청 자체가 실패한 경우 — 네트워크, 또는 프록시가 거부한 요청 */
export class AsrNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AsrNetworkError';
  }
}

export type DirectResult = { text: string };

const PROXY_PATH = '/api/asr/proxy';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** /audio/transcriptions 가 없고 Realtime 전사 세션으로만 되는 모델 */
const REALTIME_ONLY_MODEL = /^(gpt-live-transcribe|gpt-realtime-whisper)(-|$)/i;
export const REALTIME_SAMPLE_RATE = 24000;
/** input_audio_buffer.append 한 번에 보내는 샘플 수 — 200ms */
const REALTIME_APPEND_SAMPLES = 4800;
/** 연결·전송 여유. 조각 길이만큼 더 기다린다 */
const REALTIME_BASE_TIMEOUT_MS = 60_000;

const trimSlash = (url: string): string => url.replace(/\/+$/, '');

/** 큰 바이트 배열을 base64 로 — 한 번에 String.fromCharCode 를 부르면 인자 개수 제한에 걸린다 */
export const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
};

/** pass-through 로 보낸다. 프록시 자체가 거부(403/413, error 가 문자열)하거나 네트워크가 끊기면 AsrNetworkError */
const send = async (url: string, init: RequestInit & { headers: Record<string, string> }): Promise<Response> => {
  try {
    const response = await fetch(PROXY_PATH, { ...init, headers: { ...init.headers, 'x-asr-target-url': url } });
    if (response.status === 403 || response.status === 413) {
      // 업스트림의 403 은 error 가 객체다 — 응답을 그대로 돌려 원래 메시지를 살린다
      const body = (await response.clone().json().catch(() => ({}))) as { error?: unknown };
      if (typeof body.error === 'string') throw new AsrNetworkError(body.error);
    }
    return response;
  } catch (error) {
    if (init.signal?.aborted || error instanceof AsrNetworkError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new AsrNetworkError(`요청을 보내지 못했습니다 (${message})`);
  }
};

const errorMessage = (payload: unknown, status: number): string => {
  const body = (typeof payload === 'object' && payload !== null ? payload : {}) as {
    message?: unknown;
    error?: unknown;
  };
  if (typeof body.message === 'string') return body.message;
  const error = body.error as { message?: unknown } | undefined;
  if (typeof error?.message === 'string') return error.message;
  if (typeof body.error === 'string') return body.error;
  return `HTTP ${status}`;
};

/** OpenAI 호환: multipart(file, model, language) → { text } */
const transcribeOpenAiCompatible = async (wav: Uint8Array, target: DirectTarget, signal?: AbortSignal): Promise<DirectResult> => {
  const form = new FormData();
  form.set('file', new Blob([wav.slice()], { type: 'audio/wav' }), 'chunk.wav');
  form.set('model', target.model);
  form.set('language', target.language);
  form.set('response_format', 'json');
  const response = await send(`${trimSlash(target.baseUrl)}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${target.apiKey}` },
    body: form,
    signal,
  });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new AsrHttpError(response.status, errorMessage(payload, response.status));
  const text = (payload as { text?: unknown }).text;
  if (typeof text !== 'string') throw new AsrHttpError(response.status, '응답에 인식 텍스트가 없습니다');
  return { text };
};

/** Realtime 임시 키 발급 — 브라우저 WebSocket 은 Authorization 헤더를 못 넣으므로 원래 키는 프록시 호출에만 쓴다 */
export const mintRealtimeSecret = async (target: DirectTarget, signal?: AbortSignal): Promise<string> => {
  const response = await send(`${trimSlash(target.baseUrl)}/realtime/client_secrets`, {
    method: 'POST',
    headers: { authorization: `Bearer ${target.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ session: { type: 'transcription' } }),
    signal,
  });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new AsrHttpError(response.status, errorMessage(payload, response.status));
  const secret = (payload as { value?: unknown }).value;
  if (typeof secret !== 'string') throw new AsrHttpError(response.status, '응답에 임시 키가 없습니다');
  return secret;
};

export type TranslationSecretRequest = { apiKey: string; targetLanguage: string; noiseReduction: NoiseReduction };

/** 번역 세션 임시 키 발급 — 표준 키는 프록시까지만 가고, 수명 60초의 임시 키로 SDP 를 직접 교환한다 */
export const mintTranslationSecret = async (request: TranslationSecretRequest, signal?: AbortSignal): Promise<string> => {
  const response = await send(`${OPENAI_BASE_URL}/realtime/translations/client_secrets`, {
    method: 'POST',
    headers: { authorization: `Bearer ${request.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      expires_after: { anchor: 'created_at', seconds: 60 },
      session: {
        model: 'gpt-realtime-translate',
        audio: {
          input: {
            transcription: { model: 'gpt-realtime-whisper' },
            noise_reduction: { type: request.noiseReduction },
          },
          output: { language: request.targetLanguage },
        },
      },
    }),
    signal,
  });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new AsrHttpError(response.status, errorMessage(payload, response.status));
  const body = payload as { value?: unknown; client_secret?: { value?: unknown } };
  const secret = body.value ?? body.client_secret?.value;
  if (typeof secret !== 'string') throw new AsrHttpError(response.status, '응답에 임시 키가 없습니다');
  return secret;
};

export type RealtimeEvent = {
  type?: string;
  item_id?: string;
  delta?: string;
  transcript?: unknown;
  error?: { type?: unknown; code?: unknown; message?: unknown };
};

/** Realtime 오류 이벤트를 HTTP 상태로 옮긴다 — 재시도 판단(429/5xx)을 다른 경로와 같게 하려고 */
export const realtimeError = (error: RealtimeEvent['error']): AsrHttpError => {
  const kind = `${String(error?.type)} ${String(error?.code)}`;
  const status = kind.includes('rate_limit') ? 429 : kind.includes('server_error') ? 500 : kind.includes('invalid_api_key') ? 401 : 400;
  return new AsrHttpError(status, typeof error?.message === 'string' ? error.message : 'Realtime API 오류');
};

export const isRealtimeTarget = (target: Pick<DirectTarget, 'baseUrl' | 'model'>): boolean =>
  REALTIME_ONLY_MODEL.test(target.model);

export const openRealtimeSocket = (target: DirectTarget, secret: string): WebSocket =>
  new WebSocket(`${trimSlash(target.baseUrl).replace(/^http/, 'ws')}/realtime?intent=transcription`, [
    'realtime',
    `openai-insecure-api-key.${secret}`,
  ]);

/** 언어 필드는 모델마다 다르다 — gpt-live-transcribe 는 languages, gpt-realtime-whisper 는 language */
export const realtimeSessionUpdate = (target: DirectTarget): string => {
  const model = target.model.toLowerCase();
  const hint = model.startsWith('gpt-live-transcribe') ? { languages: [target.language] } : { language: target.language };
  return JSON.stringify({
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: REALTIME_SAMPLE_RATE },
          transcription: { model, ...hint },
          turn_detection: null,
        },
      },
    },
  });
};

/** Realtime 전사: 조각마다 세션 하나 — 오디오를 다 보내고 commit 하면 턴이 하나라 첫 completed 가 곧 결과다 */
const transcribeRealtime = async (wav: Uint8Array, target: DirectTarget, signal?: AbortSignal): Promise<DirectResult> => {
  const secret = await mintRealtimeSecret(target, signal);
  const samples = resampleLinear(wavToFloat32(wav), RECORDING_SAMPLE_RATE, REALTIME_SAMPLE_RATE);
  const pcm = floatToPcm16(samples);

  return new Promise<DirectResult>((resolve, reject) => {
    const socket = openRealtimeSocket(target, secret);
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.onclose = null;
      socket.close();
      settle();
    };
    const onAbort = () => finish(() => reject(signal?.reason));
    const timer = setTimeout(
      () => finish(() => reject(new AsrNetworkError('Realtime 응답이 없습니다'))),
      REALTIME_BASE_TIMEOUT_MS + (pcm.length / REALTIME_SAMPLE_RATE) * 1000,
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort);

    socket.onopen = () => {
      socket.send(realtimeSessionUpdate(target));
      for (let start = 0; start < pcm.length; start += REALTIME_APPEND_SAMPLES) {
        const part = pcm.subarray(start, start + REALTIME_APPEND_SAMPLES);
        const audio = toBase64(new Uint8Array(part.buffer, part.byteOffset, part.byteLength));
        socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio }));
      }
      socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    };
    socket.onmessage = (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as RealtimeEvent;
      if (message.type === 'conversation.item.input_audio_transcription.completed') {
        const text = message.transcript;
        finish(() =>
          typeof text === 'string' ? resolve({ text }) : reject(new AsrHttpError(502, '응답에 인식 텍스트가 없습니다')),
        );
      } else if (message.type === 'conversation.item.input_audio_transcription.failed' || message.type === 'error') {
        finish(() => reject(realtimeError(message.error)));
      }
    };
    socket.onerror = () => finish(() => reject(new AsrNetworkError('Realtime 서버에 연결하지 못했습니다')));
    socket.onclose = (event) => finish(() => reject(new AsrNetworkError(`Realtime 연결이 끊겼습니다 (${event.code})`)));
  });
};

export const transcribeDirect = (wav: Uint8Array, target: DirectTarget, signal?: AbortSignal): Promise<DirectResult> => {
  if (isRealtimeTarget(target)) return transcribeRealtime(wav, target, signal);
  return transcribeOpenAiCompatible(wav, target, signal);
};