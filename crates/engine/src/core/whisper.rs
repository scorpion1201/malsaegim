//! whisper.cpp C 심(csrc/whisper_shim.cpp) 바인딩 — 파일 전사·실시간 공용 엔진 저수준.
use std::os::raw::{c_char, c_float, c_int};

extern "C" {
    pub fn wsh_init(path: *const c_char, use_gpu: c_int) -> c_int;
    pub fn wsh_gpu_name() -> *const c_char;
    pub fn wsh_free();
    pub fn wsh_transcribe(pcm: *const c_float, n: c_int, lang: *const c_char, threads: c_int, live: c_int, audio_ctx: c_int) -> c_int;
    pub fn wsh_audio_ms() -> i64;
    pub fn wsh_n_segments() -> c_int;
    pub fn wsh_seg_t0(i: c_int) -> i64;
    pub fn wsh_seg_t1(i: c_int) -> i64;
    pub fn wsh_seg_nsp(i: c_int) -> c_float;
    pub fn wsh_seg_logprob(i: c_int) -> c_float;
    pub fn wsh_seg_text(i: c_int) -> *const c_char;
    pub fn wsh_n_words() -> c_int;
    pub fn wsh_word_t0(i: c_int) -> i64;
    pub fn wsh_word_t1(i: c_int) -> i64;
    pub fn wsh_word_seg(i: c_int) -> c_int;
    pub fn wsh_word_text(i: c_int) -> *const c_char;
}