/**
 * 사용자가 설정한 API 로 보내는 음성 인식 호출 (BYOK).
 * 키·주소·모델은 설정 페이지에 저장된 값이다. 브라우저 직접 호출은 대부분의 API 가 CORS 로 막으므로
 * 요청을 /api/asr/proxy 에 넘기고, 서버는 x-asr-target-url 로 온 주소에 그대로 전달만 한다(저장·기록 없음).
 * 그 밖은 OpenAI 호환 /audio/transcriptions.
 */
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

const trimSlash = (url: string): string => url.replace(/\/+$/, '');

/** 큰 바이트 배열을 base64 로 — 한 번에 String.fromCharCode 를 부르면 인자 개수 제한에 걸린다 */
const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
};

/** pass-through 로 보낸다. 프록시 자체가 거부(403/413)하거나 네트워크가 끊기면 AsrNetworkError */
const send = async (url: string, init: RequestInit & { headers: Record<string, string> }): Promise<Response> => {
  try {
    const response = await fetch(PROXY_PATH, { ...init, headers: { ...init.headers, 'x-asr-target-url': url } });
    if (response.status === 403 || response.status === 413) {
      const body = (await response.json().catch(() => ({}))) as { error?: unknown };
      throw new AsrNetworkError(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`);
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

export const transcribeDirect = (wav: Uint8Array, target: DirectTarget, signal?: AbortSignal): Promise<DirectResult> =>
  isASRUrl(target.baseUrl) ? transcribeASR(wav, target, signal) : transcribeOpenAiCompatible(wav, target, signal);