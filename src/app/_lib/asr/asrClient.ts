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

type AsrResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { seconds?: unknown };
  error?: { message?: unknown };
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
    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
           'content-type': 'application/json',
          },
      body: JSON.stringify({
        model: config.model,
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
        stream: false,
        asr_options: { language: config.language, enable_itn: false },
        }),
      signal: controller.signal,
       });

    const payload = (await response.json().catch(() => ({}))) as AsrResponse;
    if (!response.ok) {
      const message =
         typeof payload.error?.message === 'string' ? payload.error.message : `HTTP ${response.status}`;
      throw new AsrHttpError(response.status, message);
       }
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('no transcription text in response');
       }
    const seconds = payload.usage?.seconds;
    return { text: content, seconds: typeof seconds === 'number' ? seconds : null };
    } finally {
    clearTimeout(timer);
    }
};