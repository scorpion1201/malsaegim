//! 전사 파이프라인 — 저수준 엔진(core)으로 인식하고 결과를 utils 로 다듬어 JS(ccall) 로 내보낸다.
//! JS 는 malsaegim-engine 하나로만 부르고, 파일 전사(msg_*)와 실시간(mss_*) 파이프라인이 여기 함께 있다.

#[cfg(feature = "whisper")]
pub mod whisper;
#[cfg(feature = "stream")]
pub mod stream;