//! 말새김 엔진 빌드 — bash 스크립트 없이 Rust 가 cargo/emcc 를 불러 엔진 wasm 을 만든다.
//! 사용법: WHISPER_CPP_DIR=<whisper.cpp> cargo run -p malsaegim-engine --bin xtask --release -- <out-dir> [work-dir]
//!  - malsaegim-engine.{js,wasm}        : Rust 래퍼 + whisper.cpp CPU (파일 전사·실시간 공용, pthread + SIMD)
//!  - malsaegim-engine-webgpu.{js,wasm} : 위 + ggml WebGPU 백엔드 (ASYNCIFY). GPU 가 없거나 실패하면 앱이 CPU 런타임으로 돌아간다
//! ASYNCIFY 계측은 CPU 경로까지 느리게 하므로 두 런타임을 따로 둔다.
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
const WHISPER_CPP_REF: &str = "v1.9.5";

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

fn build_whisper(out: &Path, whisper_dir: &str, webgpu: bool) {
    let variant = if webgpu { "webgpu" } else { "cpu" };
    run(
        &format!("malsaegim-engine (whisper, {variant}) 정적 라이브러리 (pthread, build-std)"),
        Command::new("cargo")
            .args(["+nightly", "build", "-p", "malsaegim-engine", "--lib", "--features", "whisper", "--target", TARGET, "--release", "-Z", "build-std=std,panic_abort"])
            .env("MSG_PTHREAD", "1")
            .env("MSG_WEBGPU", if webgpu { "1" } else { "0" })
            .env("RUSTFLAGS", "-C target-feature=+atomics,+bulk-memory,+mutable-globals")
            .env("WHISPER_CPP_DIR", whisper_dir),
    );
    let rustlib = rel().join("libmalsaegim_engine.a");
    assert!(rustlib.exists(), "{} 없음", rustlib.display());
    let libs = read_libs(if webgpu { "whisper-webgpu" } else { "whisper" });
    let name = if webgpu { "malsaegim-engine-webgpu.js" } else { "malsaegim-engine.js" };
    let mut link = Command::new("emcc");
    // workerfs: 캐시의 Blob 을 복사 없이 FS 에 붙여 whisper 가 읽는 만큼만 FileReaderSync 로 가져온다 (모델 ≈ 874 MB)
    link.args(["-O3", "-msimd128", "-pthread", "-lworkerfs.js", "-Wl,--start-group"]).arg(&rustlib);
    for l in &libs { link.arg(l); }
    link.arg("-Wl,--end-group").arg("-o").arg(out.join(name)).args([
        "-sINVOKE_RUN=0", "-sMODULARIZE=1", "-sEXPORT_ES6=1", "-sEXPORT_NAME=createMalsaegimEngine",
        "-sENVIRONMENT=worker", "-sPTHREAD_POOL_SIZE=10", "-sPTHREAD_POOL_SIZE_STRICT=2",
        "-sINITIAL_MEMORY=512MB", "-sMAXIMUM_MEMORY=2048MB", "-sALLOW_MEMORY_GROWTH=1", "-sFORCE_FILESYSTEM=1",
        "-sEXPORTED_FUNCTIONS=_msg_init,_msg_gpu_name,_msg_free,_msg_transcribe,_msg_transcribe_live,_msg_free_cstr,_malloc,_free",
        "-sEXPORTED_RUNTIME_METHODS=ccall,cwrap,FS,WORKERFS,HEAPU8,HEAPF32,UTF8ToString,stringToUTF8,lengthBytesUTF8,print,printErr",
    ]);
    if webgpu {
        // ggml-webgpu 는 어댑터·버퍼 매핑을 기다린다 — ASYNCIFY 로 동기 C++ 호출을 JS Promise 에 잇는다 (워커는 ccall async 로 부른다)
        link.args(["--use-port=emdawnwebgpu", "-sASYNCIFY", "-sASYNCIFY_STACK_SIZE=1048576", "-fexceptions"]);
    }
    run(&format!("emcc 링크: {name}"), &mut link);
}

fn main() {
    let out = PathBuf::from(env::args().nth(1).expect("사용법: xtask <out-dir> [work-dir]"));
    std::fs::create_dir_all(&out).unwrap();
    let work = PathBuf::from(env::args().nth(2).unwrap_or_else(|| "target/engine-src".into()));
    std::fs::create_dir_all(&work).unwrap();

    // whisper.cpp 체크아웃 — 환경변수로 주면 그것을, 아니면 work 에 클론한다
    let whisper = env::var("WHISPER_CPP_DIR").map(PathBuf::from).unwrap_or_else(|_| {
        let d = work.join("whisper.cpp");
        ensure_checkout(&d, "https://github.com/ggml-org/whisper.cpp", WHISPER_CPP_REF);
        d
    });

    build_whisper(&out, whisper.to_str().unwrap(), false);
    build_whisper(&out, whisper.to_str().unwrap(), true);
    eprintln!("[xtask] 완료 → {}", out.display());
}