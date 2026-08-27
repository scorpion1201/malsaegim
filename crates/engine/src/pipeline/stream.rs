//! 실시간 파이프라인 — sherpa-onnx 로 스트리밍 인식하고 BPE 토큰을 사람이 읽을 텍스트로 돌려준다.
//! 워커는 ccall 로 mss_create / mss_accept / mss_is_endpoint / mss_reset / mss_result / mss_first_ts / mss_input_finished / mss_destroy 를 부른다.

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_float, c_int};

use crate::core::stream as ffi;
use crate::utils::detokenize;

/// encoder/decoder/joiner/tokens (FS 경로) 로 인식기+스트림을 만든다. 0 이면 성공
#[no_mangle]
pub extern "C" fn mss_create(enc: *const c_char, dec: *const c_char, joiner: *const c_char, tokens: *const c_char) -> c_int {
    unsafe { ffi::ssh_create(enc, dec, joiner, tokens) }
}

/// 16 kHz PCM 조각을 넣고 준비되는 만큼 디코드한다
#[no_mangle]
pub extern "C" fn mss_accept(sample_rate: c_int, samples: *const c_float, n: c_int) {
    unsafe { ffi::ssh_accept(sample_rate, samples, n) }
}

/// 발화 끝(엔드포인트)인가
#[no_mangle]
pub extern "C" fn mss_is_endpoint() -> c_int {
    unsafe { ffi::ssh_is_endpoint() }
}

/// 스트림을 리셋한다 (확정 세그먼트를 낸 뒤)
#[no_mangle]
pub extern "C" fn mss_reset() {
    unsafe { ffi::ssh_reset() }
}

/// 입력 종료를 알린다 (녹음 종료 시)
#[no_mangle]
pub extern "C" fn mss_input_finished() {
    unsafe { ffi::ssh_input_finished() }
}

/// 현재 인식 텍스트(정리됨)를 담은 malloc C 문자열. JS 가 UTF8ToString 후 mss_free_cstr 로 해제
#[no_mangle]
pub extern "C" fn mss_result() -> *mut c_char {
    let raw = unsafe { CStr::from_ptr(ffi::ssh_result()) }.to_string_lossy().into_owned();
    match CString::new(detokenize(&raw)) {
        Ok(s) => s.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

/// 현재 세그먼트 첫 토큰의 타임스탬프(초)
#[no_mangle]
pub extern "C" fn mss_first_ts() -> c_float {
    unsafe { ffi::ssh_first_ts() }
}

/// 인식기+스트림을 내린다
#[no_mangle]
pub extern "C" fn mss_destroy() {
    unsafe { ffi::ssh_destroy() }
}

/// mss_result 가 준 문자열을 해제한다
#[no_mangle]
pub extern "C" fn mss_free_cstr(ptr: *mut c_char) {
    if !ptr.is_null() {
        unsafe { drop(CString::from_raw(ptr)) };
    }
}