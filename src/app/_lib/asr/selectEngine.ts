import { createWhisperEngine } from '@/app/_lib/engine/malsaegimEngine';
import type { ModelManifest } from '@/app/_lib/engine/malsaegimEngine';
import { isByokComplete, readByokSettings } from '@/app/_lib/settings/byokSettings';
import { createByokEngine, type TranscribeEngine } from './asrEngine';

/** 설정 세 값이 모두 있으면 BYOK, 아니면 On-Device(whisper). 서버에 모델이 없으면 null */
export const selectEngine = (manifest: ModelManifest | null): TranscribeEngine | null => {
  const settings = readByokSettings();
  if (isByokComplete(settings)) return createByokEngine(settings);
  return manifest ? createWhisperEngine(manifest) : null;
};