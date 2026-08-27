//! 파일 전사 파이프라인 — whisper.cpp 로 세그먼트를 얻어 할루시네이션을 정리한 텍스트를 돌려준다.
//! 워커는 ccall 로 msg_init / msg_transcribe / msg_free / msg_free_cstr 를 부른다. 진행률은 whisper 가 "PROG\t<n>" 를 stdout 으로 찍는다.

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_float, c_int};

use crate::core::whisper as ffi;
use crate::utils::clean;

/// 모델(ggml .bin)을 FS 경로에서 연다. 0 이면 성공
#[no_mangle]
pub extern "C" fn msg_init(path: *const c_char) -> c_int {
    unsafe { ffi::wsh_init(path) }
}

/// 컨텍스트를 내린다
#[no_mangle]
pub extern "C" fn msg_free() {
    unsafe { ffi::wsh_free() }
}

/// 정리된 텍스트를 담은 malloc C 문자열을 돌려준다 (JS 가 UTF8ToString 후 msg_free_cstr 로 해제). 실패하면 널 포인터.
#[no_mangle]
pub extern "C" fn msg_transcribe(
    pcm: *const c_float,
    n: c_int,
    lang: *const c_char,
    threads: c_int,
) -> *mut c_char {
    let rc = unsafe { ffi::wsh_transcribe(pcm, n, lang, threads) };
    if rc != 0 {
        return std::ptr::null_mut();
    }
    let audio_ms = unsafe { ffi::wsh_audio_ms() };
    let count = unsafe { ffi::wsh_n_segments() };
    let mut segs = Vec::with_capacity(count as usize);
    for i in 0..count {
        let text = unsafe { CStr::from_ptr(ffi::wsh_seg_text(i)) }
            .to_string_lossy()
            .into_owned();
        segs.push(clean::Segment {
            t0_ms: unsafe { ffi::wsh_seg_t0(i) },
            t1_ms: unsafe { ffi::wsh_seg_t1(i) },
            no_speech_prob: unsafe { ffi::wsh_seg_nsp(i) },
            avg_logprob: unsafe { ffi::wsh_seg_logprob(i) },
            text,
        });
    }
    let cleaned = clean::clean_segments(&segs, audio_ms);
    match CString::new(cleaned) {
        Ok(s) => s.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

/// msg_transcribe 가 준 문자열을 해제한다
#[no_mangle]
pub extern "C" fn msg_free_cstr(ptr: *mut c_char) {
    if !ptr.is_null() {
        unsafe { drop(CString::from_raw(ptr)) };
    }
}