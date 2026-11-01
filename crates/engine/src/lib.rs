//! malsaegim-engine — On-Device 인식 엔진(wasm). JS 는 이 엔진 하나로만 부르고, 안에서 whisper.cpp 가
//! 파일 전사와 실시간 받아쓰기를 모두 처리한다 (--features whisper → msg_*).
//! 디렉터리는 기능별로: core(C++ FFI) · pipeline(전사 파이프라인) · utils(정리). 빌드 도구는 src/bin/xtask.rs.
//! 네이티브(비 emscripten) 빌드에서는 아무 심볼도 내지 않아 `cargo build`(lint)가 그냥 통과한다.

#[cfg(all(target_os = "emscripten", feature = "whisper"))]
mod core;
#[cfg(all(target_os = "emscripten", feature = "whisper"))]
mod pipeline;
#[cfg(all(target_os = "emscripten", feature = "whisper"))]
mod utils;