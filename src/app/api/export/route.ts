import { loadRhwpEngine } from '@/app/_lib/hwp/rhwpEngine';
import { createExportHandler } from './exportHandler';

export const runtime = 'nodejs';

export const POST = async (request: Request) => {
  const engine = await loadRhwpEngine();
  return createExportHandler({ engine })(request);
};