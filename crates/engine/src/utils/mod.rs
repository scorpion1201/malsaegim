//! 순수 Rust 헬퍼 — 인식 결과를 사람이 읽을 텍스트로 다듬는다.

/// whisper 할루시네이션 억제 (파일 전사)
#[cfg(feature = "whisper")]
pub mod clean;

/// sherpa BPE 토큰을 사람이 읽을 텍스트로: ▁(U+2581)→공백, 여분 공백 접기 (실시간)
#[cfg(feature = "stream")]
pub fn detokenize(raw: &str) -> String {
    raw.replace('\u{2581}', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}