/**
 * 말새김 On-Device 인식 엔진 (malsaegim-engine) — 앱이 On-Device 인식을 부르는 단 하나의 진입점.
 * 안에서 두 개의 wasm 을 굴린다: 파일 전사는 whisper.cpp(멀티스레드), 실시간 받아쓰기는 sherpa-onnx.
 * 두 엔진은 스레드 모델(whisper pthread ↔ onnxruntime 비스레드)이 달라 하나의 wasm 으로 합칠 수 없어
 * 각자 최적 빌드를 유지하고, 앱은 이 파사드 하나로만 접근한다.
 */
export { createWhisperEngine, shutdownWhisperWorker } from './whisperEngine';
export { startLiveRecognizer, type LiveRecognizer, type LiveRecognizerHandlers } from './sherpaEngine';
export type { LiveSegment } from './sherpaProtocol';
export {
  fetchManifest,
  readModelState,
  writeModelState,
  clearModelState,
  isComplete,
  purgeOtherVersions,
  downloadModels,
  deleteModels,
  deleteCachedFile,
  readCachedFile,
  cachedBytes,
  MODEL_CACHE,
  ModelNetworkError,
  ModelQuotaError,
  ModelIntegrityError,
  type ModelFile,
  type ModelManifest,
  type ModelProgress,
  type ModelState,
  type ModelEngine,
} from './modelStore';
export { detectCapabilities, onDeviceThreads, type OnDeviceCapabilities } from './capabilities';
export { formatMb, formatEta } from './format';