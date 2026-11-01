//! 전사 파이프라인 — 저수준 엔진(core)으로 인식하고 결과를 utils 로 다듬어 JS(ccall) 로 내보낸다.
//! 파일 전사(msg_transcribe)와 실시간 창 인식(msg_transcribe_live)이 같은 whisper 컨텍스트를 쓴다.

pub mod whisper;