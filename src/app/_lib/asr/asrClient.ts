import 'server-only';
import type { AsrConfig } from './env';

export class AsrHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AsrHttpError';
  }
}

export type TranscribeInput = {
  wav: Uint8Array;
  config: AsrConfig;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type TranscribeResult = {
  text: string;
  seconds: number | null;
};

// ASR 네이티브 응답: output.text 에 전체 텍스트, usage.duration 에 오디오 초.
type AsrResponse = {
  output?: { text?: unknown };
  usage?: { duration?: unknown };
  code?: unknown;
  message?: unknown;
};

const GENERATION_PATH = '/api/v1/services/aigc/multimodal-generation/generation';

/**
 * ASR 콘솔이 주는 base URL(…/compatible-mode/v1)에서 호스트를 떼어
 * ASR 모델이 쓰는 ASR 네이티브 경로를 만든다.
 * whisper-1 는 OpenAI 호환 chat/completions 로는 호출되지 않는다.
 */
export const generationUrl = (baseUrl: string): string => {
  const { origin } = new URL(baseUrl);
  return `${origin}${GENERATION_PATH}`;
};

export const transcribeWav = async ({
  wav,
  config,
  fetchImpl = fetch,
  timeoutMs = 120_000,
}: TranscribeInput): Promise<TranscribeResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(generationUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
        'x-asr-sse': 'disable',
      },
      body: JSON.stringify({
        model: config.model,
        input: {
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'input_audio',
                  input_audio: { data: `data:audio/wav;base64,${Buffer.from(wav).toString('base64')}` },
                },
              ],
            },
          ],
        },
        // parameters 가 없으면 400 — 조각은 항상 16kHz PCM16 WAV 다.
        parameters: { format: 'wav', sample_rate: '16000', language_hints: [config.language] },
      }),
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => ({}))) as AsrResponse;
    if (!response.ok) {
      const message = typeof payload.message === 'string' ? payload.message : `HTTP ${response.status}`;
      throw new AsrHttpError(response.status, message);
    }
    const text = payload.output?.text;
    if (typeof text !== 'string') {
      throw new Error('no transcription text in response');
    }
    const duration = payload.usage?.duration;
    return { text, seconds: typeof duration === 'number' ? duration : null };
  } finally {
    clearTimeout(timer);
  }
};