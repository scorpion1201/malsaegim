//! sherpa-onnx C 심(csrc/sherpa_shim.cpp) 바인딩 — 실시간 인식 엔진 저수준.
use std::os::raw::{c_char, c_float, c_int};

extern "C" {
    pub fn ssh_create(enc: *const c_char, dec: *const c_char, joiner: *const c_char, tokens: *const c_char) -> c_int;
    pub fn ssh_accept(sample_rate: c_int, samples: *const c_float, n: c_int);
    pub fn ssh_is_endpoint() -> c_int;
    pub fn ssh_reset();
    pub fn ssh_input_finished();
    pub fn ssh_result() -> *const c_char;
    pub fn ssh_first_ts() -> c_float;
    pub fn ssh_destroy();
}