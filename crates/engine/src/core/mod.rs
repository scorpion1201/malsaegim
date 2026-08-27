//! 저수준 C++ FFI — 얇은 C 심(csrc/*.cpp)을 통해 whisper.cpp / sherpa-onnx 를 그대로 끌어온다(Rust 재구현 아님).

#[cfg(feature = "whisper")]
pub mod whisper;
#[cfg(feature = "stream")]
pub mod stream;