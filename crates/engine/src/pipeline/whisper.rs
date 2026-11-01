//! whisper 파이프라인 — whisper.cpp 로 세그먼트를 얻어 할루시네이션을 정리한다.
//! 워커는 ccall 로 msg_init / msg_gpu_name / msg_transcribe / msg_transcribe_live / msg_free / msg_free_cstr 를 부른다.
//! 파일 전사 진행률은 whisper 가 "PROG\t<n>" 를 stdout 으로 찍는다.

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_float, c_int};

use crate::core::whisper as ffi;
use crate::utils::clean;

/// 모델(ggml .bin)을 FS 경로에서 연다. use_gpu 면 GPU 백엔드(WebGPU 빌드)를 쓴다. 0 이면 성공
#[no_mangle]
pub extern "C" fn msg_init(path: *const c_char, use_gpu: c_int) -> c_int {
    unsafe { ffi::wsh_init(path, use_gpu) }
}

/// 인식에 쓰는 GPU 장치 이름 (빈 문자열이면 CPU). 정적 문자열이라 해제하지 않는다
#[no_mangle]
pub extern "C" fn msg_gpu_name() -> *const c_char {
    unsafe { ffi::wsh_gpu_name() }
}

/// 컨텍스트를 내린다
#[no_mangle]
pub extern "C" fn msg_free() {
    unsafe { ffi::wsh_free() }
}

fn c_text(ptr: *const c_char) -> String {
    unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned()
}

fn into_c(text: String) -> *mut c_char {
    match CString::new(text) {
        Ok(s) => s.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

fn segments() -> Vec<clean::Segment> {
    let count = unsafe { ffi::wsh_n_segments() };
    (0..count)
        .map(|i| clean::Segment {
            t0_ms: unsafe { ffi::wsh_seg_t0(i) },
            t1_ms: unsafe { ffi::wsh_seg_t1(i) },
            no_speech_prob: unsafe { ffi::wsh_seg_nsp(i) },
            avg_logprob: unsafe { ffi::wsh_seg_logprob(i) },
            text: c_text(unsafe { ffi::wsh_seg_text(i) }),
        })
        .collect()
}

/// 파일 전사 — 정리된 텍스트를 담은 malloc C 문자열을 돌려준다 (JS 가 UTF8ToString 후 msg_free_cstr 로 해제). 실패하면 널 포인터.
#[no_mangle]
pub extern "C" fn msg_transcribe(pcm: *const c_float, n: c_int, lang: *const c_char, threads: c_int) -> *mut c_char {
    let rc = unsafe { ffi::wsh_transcribe(pcm, n, lang, threads, 0, 0) };
    if rc != 0 {
        return std::ptr::null_mut();
    }
    let audio_ms = unsafe { ffi::wsh_audio_ms() };
    into_c(clean::clean_segments(&segments(), audio_ms))
}

/// 실시간 창 인식 — 믿을 만한 세그먼트의 어절을 한 줄에 하나씩 "t0_ms\tt1_ms\t어절" 로 돌려준다 (창 시작 기준 ms).
/// 확정 여부는 JS 가 앞뒤 인식 결과를 비교해 정한다. 실패하면 널 포인터.
#[no_mangle]
pub extern "C" fn msg_transcribe_live(
    pcm: *const c_float,
    n: c_int,
    lang: *const c_char,
    threads: c_int,
    audio_ctx: c_int,
) -> *mut c_char {
    let rc = unsafe { ffi::wsh_transcribe(pcm, n, lang, threads, 1, audio_ctx) };
    if rc != 0 {
        return std::ptr::null_mut();
    }
    let audio_ms = unsafe { ffi::wsh_audio_ms() };
    let keep: Vec<bool> = segments().iter().map(|s| clean::keep_live_segment(s, audio_ms)).collect();
    let mut out = String::new();
    for i in 0..unsafe { ffi::wsh_n_words() } {
        let seg = unsafe { ffi::wsh_word_seg(i) } as usize;
        if !keep.get(seg).copied().unwrap_or(false) {
            continue;
        }
        let text = c_text(unsafe { ffi::wsh_word_text(i) });
        let text = text.trim().replace(['\t', '\n'], " ");
        if text.is_empty() {
            continue;
        }
        let t0 = unsafe { ffi::wsh_word_t0(i) }.min(audio_ms);
        let t1 = unsafe { ffi::wsh_word_t1(i) }.clamp(t0, audio_ms);
        out.push_str(&format!("{t0}\t{t1}\t{text}\n"));
    }
    into_c(out)
}

/// msg_transcribe / msg_transcribe_live 가 준 문자열을 해제한다
#[no_mangle]
pub extern "C" fn msg_free_cstr(ptr: *mut c_char) {
    if !ptr.is_null() {
        unsafe { drop(CString::from_raw(ptr)) };
    }
}