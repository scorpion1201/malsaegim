import 'server-only';

export type AsrConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  language: string;
  maxConcurrency: number;
};

export const readAsrConfig = (env: NodeJS.ProcessEnv = process.env): AsrConfig => {
  const apiKey = env.ASR_API_KEY;
  if (!apiKey) throw new Error('ASR_API_KEY is not set');
  const maxConcurrency = Number(env.ASR_MAX_CONCURRENCY ?? 8);
  return {
    apiKey,
    baseUrl: env.ASR_BASE_URL ?? 'https://api.example.com/compatible-mode/v1',
    model: env.ASR_MODEL ?? 'whisper-1',
    language: env.ASR_LANGUAGE ?? 'ko',
    maxConcurrency: Number.isFinite(maxConcurrency) && maxConcurrency > 0 ? maxConcurrency : 8,
     };
};