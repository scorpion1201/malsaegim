//! 말새김 엔진 빌드 — bash 스크립트 없이 Rust 가 cargo/emcc 를 불러 두 wasm 을 만든다.
//! 사용법: WHISPER_CPP_DIR=<whisper.cpp> SHERPA_ONNX_DIR=<sherpa-onnx> cargo run -p xtask -- <out-dir>
//!  - malsaegim-engine.{js,wasm}        : Rust 래퍼 + whisper.cpp (파일 전사, pthread)
//!  - malsaegim-engine-stream.{js,wasm} : Rust 래퍼 + sherpa-onnx (실시간, 단일 스레드)
//! 래퍼는 Rust staticlib, 최종 링크는 emcc 가 한다 (rustc 가 직접 emscripten 링크하면 ggml 계산이 멈춘다).

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn run(desc: &str, cmd: &mut Command) {
    eprintln!("[xtask] {desc}");
    let status = cmd.status().unwrap_or_else(|e| panic!("{desc}: 실행 실패 {e}"));
    assert!(status.success(), "{desc}: 명령 실패");
}

const TARGET: &str = "wasm32-unknown-emscripten";

// 엔진 소스 고정 리비전 (scripts/models/versions.sh 와 맞춘다)
const WHISPER_CPP_REF: &str = "v1.9.3";
const SHERPA_ONNX_REF: &str = "v1.13.6";

/// 없으면 얕은 클론한다. 있으면 그대로 쓴다.
fn ensure_checkout(dir: &Path, url: &str, git_ref: &str) {
    if dir.join(".git").exists() || dir.join("CMakeLists.txt").exists() {
        return;
    }
    run(
        &format!("clone {url} @ {git_ref}"),
        Command::new("git").args([
            "clone", "--depth", "1", "--branch", git_ref, url,
            dir.to_str().unwrap(),
        ]),
    );
}

fn rel() -> PathBuf {
    PathBuf::from("target").join(TARGET).join("release")
}

fn find_file(dir: &Path, name: &str) -> Option<PathBuf> {
    let mut hit = None;
    let mut newest = std::time::UNIX_EPOCH;
    fn walk(dir: &Path, name: &str, hit: &mut Option<PathBuf>, newest: &mut std::time::SystemTime) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, name, hit, newest);
            } else if p.file_name().map(|n| n == name).unwrap_or(false) {
                if let Ok(m) = p.metadata().and_then(|m| m.modified()) {
                    if m >= *newest { *newest = m; *hit = Some(p); }
                }
            }
        }
    }
    walk(dir, name, &mut hit, &mut newest);
    hit
}

/// build.rs 가 OUT_DIR 에 남긴 <feature>.libs (가장 최근 것) 을 읽는다
fn read_libs(feature: &str) -> Vec<PathBuf> {
    let name = format!("{feature}.libs");
    let f = find_file(&rel().join("build"), &name).unwrap_or_else(|| panic!("{name} 없음"));
    std::fs::read_to_string(&f)
        .unwrap()
        .lines()
        .filter(|l| !l.is_empty())
        .map(PathBuf::from)
        .collect()
}

fn build_whisper(out: &Path, whisper_dir: &str) {
    run(
        "malsaegim-engine (whisper) 정적 라이브러리 (pthread, build-std)",
        Command::new("cargo")
            .args(["+nightly", "build", "-p", "malsaegim-engine", "--lib", "--features", "whisper", "--target", TARGET, "--release", "-Z", "build-std=std,panic_abort"])
            .env("MSG_PTHREAD", "1")
            .env("RUSTFLAGS", "-C target-feature=+atomics,+bulk-memory,+mutable-globals")
            .env("WHISPER_CPP_DIR", whisper_dir),
    );
    let rustlib = rel().join("libmalsaegim_engine.a");
    assert!(rustlib.exists(), "{} 없음", rustlib.display());
    let libs = read_libs("whisper");
    let mut link = Command::new("emcc");
    link.args(["-O3", "-msimd128", "-pthread", "-Wl,--start-group"]).arg(&rustlib);
    for l in &libs { link.arg(l); }
    link.arg("-Wl,--end-group").arg("-o").arg(out.join("malsaegim-engine.js")).args([
        "-sINVOKE_RUN=0", "-sMODULARIZE=1", "-sEXPORT_ES6=1", "-sEXPORT_NAME=createMalsaegimEngine",
        "-sENVIRONMENT=worker", "-sPTHREAD_POOL_SIZE=10", "-sPTHREAD_POOL_SIZE_STRICT=2",
        "-sINITIAL_MEMORY=512MB", "-sMAXIMUM_MEMORY=2048MB", "-sALLOW_MEMORY_GROWTH=1", "-sFORCE_FILESYSTEM=1",
        "-sEXPORTED_FUNCTIONS=_msg_init,_msg_free,_msg_transcribe,_msg_free_cstr,_malloc,_free",
        "-sEXPORTED_RUNTIME_METHODS=ccall,cwrap,FS,HEAPU8,HEAPF32,UTF8ToString,stringToUTF8,lengthBytesUTF8,print,printErr",
    ]);
    run("emcc 링크: malsaegim-engine (whisper.cpp)", &mut link);
}

/// sherpa-onnx wasm 정적 라이브러리 빌드 (한 번, upstream 빌드 스크립트). install/lib 경로를 돌려준다.
fn build_sherpa_libs(sherpa_dir: &str) -> PathBuf {
    let install = PathBuf::from(sherpa_dir).join("build-wasm-simd-asr/install/lib");
    if install.join("libsherpa-onnx-c-api.a").exists() {
        eprintln!("[xtask] sherpa 정적 라이브러리 이미 있음 → 건너뜀");
        return install;
    }
    // CMake 가 존재만 검사하는 assets 를 빈 파일로 채운다
    let assets = PathBuf::from(sherpa_dir).join("wasm/asr/assets");
    std::fs::create_dir_all(&assets).unwrap();
    for f in ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"] {
        let _ = std::fs::write(assets.join(f), b"");
    }
    run(
        "sherpa-onnx wasm 빌드 (정적 라이브러리, upstream)",
        Command::new("./build-wasm-simd-asr.sh").current_dir(sherpa_dir),
    );
    install
}

fn build_stream(out: &Path, sherpa_dir: &str) {
    let install = build_sherpa_libs(sherpa_dir);
    run(
        "malsaegim-engine (stream) 정적 라이브러리 (단일 스레드)",
        Command::new("cargo")
            .args(["build", "-p", "malsaegim-engine", "--lib", "--features", "stream", "--target", TARGET, "--release"])
            .env("SHERPA_ONNX_DIR", sherpa_dir)
            .env("SHERPA_BUILD_DIR", &install),
    );
    let rustlib = rel().join("libmalsaegim_engine.a");
    assert!(rustlib.exists(), "{} 없음", rustlib.display());
    let libs = read_libs("stream");
    let mut link = Command::new("emcc");
    link.args(["-O3", "-msimd128", "-sSTACK_SIZE=10485760", "-Wl,--start-group"]).arg(&rustlib);
    for l in &libs { link.arg(l); }
    link.arg("-Wl,--end-group").arg("-o").arg(out.join("malsaegim-engine-stream.js")).args([
        "-sINVOKE_RUN=0", "-sMODULARIZE=1", "-sEXPORT_ES6=1", "-sEXPORT_NAME=createMalsaegimStream",
        "-sENVIRONMENT=worker", "-sINITIAL_MEMORY=512MB", "-sMAXIMUM_MEMORY=2048MB",
        "-sALLOW_MEMORY_GROWTH=1", "-sFORCE_FILESYSTEM=1",
        "-sEXPORTED_FUNCTIONS=_mss_create,_mss_accept,_mss_is_endpoint,_mss_reset,_mss_input_finished,_mss_result,_mss_first_ts,_mss_destroy,_mss_free_cstr,_malloc,_free",
        "-sEXPORTED_RUNTIME_METHODS=ccall,cwrap,FS,HEAPU8,HEAPF32,UTF8ToString,stringToUTF8,lengthBytesUTF8,print,printErr",
    ]);
    run("emcc 링크: malsaegim-engine-stream (sherpa-onnx)", &mut link);
}

fn main() {
    let out = PathBuf::from(env::args().nth(1).expect("사용법: xtask <out-dir> [work-dir]"));
    std::fs::create_dir_all(&out).unwrap();
    let work = PathBuf::from(env::args().nth(2).unwrap_or_else(|| "target/engine-src".into()));
    std::fs::create_dir_all(&work).unwrap();

    // whisper.cpp / sherpa-onnx 체크아웃 — 환경변수로 주면 그것을, 아니면 work 에 클론한다
    let whisper = env::var("WHISPER_CPP_DIR").map(PathBuf::from).unwrap_or_else(|_| {
        let d = work.join("whisper.cpp");
        ensure_checkout(&d, "https://github.com/ggml-org/whisper.cpp", WHISPER_CPP_REF);
        d
    });
    let sherpa = env::var("SHERPA_ONNX_DIR").map(PathBuf::from).unwrap_or_else(|_| {
        let d = work.join("sherpa-onnx");
        ensure_checkout(&d, "https://github.com/k2-fsa/sherpa-onnx", SHERPA_ONNX_REF);
        d
    });

    build_whisper(&out, whisper.to_str().unwrap());
    build_stream(&out, sherpa.to_str().unwrap());
    eprintln!("[xtask] 완료 → {}", out.display());
}