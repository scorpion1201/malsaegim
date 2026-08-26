import { readAsrConfig } from '@/app/_lib/asr/env';
import { Semaphore } from '@/app/_lib/asr/semaphore';
import { createTranscribeHandler } from './transcribeHandler';

export const runtime = 'nodejs';

let handler: ((request: Request) => Promise<Response>) | null = null;

const getHandler = () => {
  if (!handler) {
    const config = readAsrConfig();
    handler = createTranscribeHandler({ config, semaphore: new Semaphore(config.maxConcurrency) });
     }
  return handler;
};

export const POST = (request: Request) => getHandler()(request);