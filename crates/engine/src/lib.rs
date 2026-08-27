//! malsaegim-engine — On-Device 인식 엔진(wasm). JS 는 이 엔진 하나로만 부르고, 안에서 파일 전사(whisper.cpp)와
//! 실시간(sherpa-onnx) 파이프라인이 함께 돈다. 스레드 모델이 달라(whisper pthread ↔ onnxruntime 비스레드)
//! 크레이트 하나를 feature 로 두 번 빌드해 두 wasm 을 낸다:
//!   --features whisper : 파일 전사 → msg_*
//!   --features stream  : 실시간   → mss_*
//! 디렉터리는 기능별로: core(C++ FFI) · pipeline(전사 파이프라인) · utils(정리/디토크나이즈). 빌드 도구는 src/bin/xtask.rs.
//! 네이티브(비 emscripten) 빌드에서는 아무 심볼도 내지 않아 `cargo build`(lint)가 그냥 통과한다.

#[cfg(all(target_os = "emscripten", any(feature = "whisper", feature = "stream")))]
mod core;
#[cfg(all(target_os = "emscripten", any(feature = "whisper", feature = "stream")))]
mod pipeline;
#[cfg(all(target_os = "emscripten", any(feature = "whisper", feature = "stream")))]
mod utils;