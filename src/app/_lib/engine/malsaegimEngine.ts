/**
 * 말새김 On-Device 인식 엔진 (malsaegim-engine) — 앱이 On-Device 인식을 부르는 단 하나의 진입점.
 * whisper.cpp(wasm) 하나로 파일 전사와 실시간 받아쓰기를 모두 처리하고, 둘은 같은 워커·같은 모델 파일을 쓴다.
 * 런타임은 WebGPU 를 먼저 쓰고, 쓸 수 없으면 CPU(SIMD + pthread)로 돌린다. 모델은 기기에 맞춰 하나만 내려받는다.
 */
export { createWhisperEngine, WHISPER_LANGUAGE } from './whisperEngine';
export { shutdownWhisperWorker, whisperBackend, readGpuPreference, writeGpuPreference, subscribeGpuPreference, WhisperLoadError } from './whisperHost';
export { startWhisperLive } from './whisperLive';
export type { LiveRecognizer, LiveRecognizerHandlers, LiveSegment } from './liveTypes';
export type { WhisperBackend } from './whisperProtocol';
export {
  fetchManifest,
  bundleFor,
  readModelState,
  writeModelState,
  clearModelState,
  isComplete,
  purgeExcept,
  purgeStale,
  downloadModels,
  deleteModels,
  deleteCachedFile,
  cachedBytes,
  MODEL_CACHE,
  ModelNetworkError,
  ModelQuotaError,
  ModelIntegrityError,
  type ModelBundle,
  type ModelFile,
  type ModelManifest,
  type ModelProgress,
  type ModelState,
  type ModelEngine,
  type ModelTier,
  type WhisperModel,
} from './modelStore';
export {
  detectDeviceProfile,
  defaultTier,
  autoModel,
  resolveModel,
  readModelChoice,
  writeModelChoice,
  type DeviceKind,
  type DeviceProfile,
  type ModelChoice,
} from './deviceProfile';
export { detectCapabilities, onDeviceThreads, type OnDeviceCapabilities } from './capabilities';
export { formatMb, formatEta } from './format';