import 'server-only';

export type AsrConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  language: string;
  maxConcurrency: number;
};

export const readAsrConfig = (env: NodeJS.ProcessEnv = process.env): AsrConfig => {
  const apiKey = env.API_KEY;
  if (!apiKey) throw new Error('API_KEY is not set');
  const maxConcurrency = Number(env.ASR_MAX_CONCURRENCY ?? 8);
  return {
    apiKey,
    baseUrl: env.API_ENDPOINT_URL ?? 'https://token-plan.ap-southeast-1.maas.example.com',
    model: env.ASR_MODEL ?? 'whisper-1',
    language: env.ASR_LANGUAGE ?? 'ko',
    maxConcurrency: Number.isFinite(maxConcurrency) && maxConcurrency > 0 ? maxConcurrency : 8,
     };
};