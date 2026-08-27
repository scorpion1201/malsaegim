//! malsaegim-engine 빌드: feature 에 따라 whisper.cpp(파일 전사) 또는 sherpa-onnx(실시간) 의 C 심을 컴파일하고,
//! 최종 emcc 링크(xtask)에 넘길 정적 라이브러리 목록을 `target/<...>/release/<feature>.libs` 로 남긴다.
//! bash 없이 build.rs(Rust)가 emcmake/emcc 를 직접 부른다. 네이티브 빌드에서는 아무것도 하지 않는다.

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn run(cmd: &mut Command) {
    let status = cmd.status().unwrap_or_else(|e| panic!("실행 실패 {cmd:?}: {e}"));
    assert!(status.success(), "명령 실패: {cmd:?}");
}

fn find_archives(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            find_archives(&p, out);
        } else if p.extension().map(|x| x == "a").unwrap_or(false) {
            out.push(p);
        }
    }
}

fn write_libs(out: &Path, feature: &str, libs: &[PathBuf]) {
    let list: Vec<String> = libs.iter().map(|p| p.display().to_string()).collect();
    std::fs::write(out.join(format!("{feature}.libs")), list.join("\n")).unwrap();
}

fn build_whisper(out: &Path, pthread: bool) {
    let whisper_dir = env::var("WHISPER_CPP_DIR").expect("WHISPER_CPP_DIR 필요 (feature whisper)");
    let build_dir = out.join("whisper-build");
    let cflags = format!("-DCMAKE_C_FLAGS={}", if pthread { "-pthread -msimd128" } else { "-msimd128" });
    let cxxflags = format!("-DCMAKE_CXX_FLAGS={}", if pthread { "-pthread -msimd128" } else { "-msimd128" });
    run(Command::new("emcmake").args([
        "cmake", "-S", &whisper_dir, "-B", build_dir.to_str().unwrap(),
        "-DCMAKE_BUILD_TYPE=Release", "-DWHISPER_BUILD_EXAMPLES=OFF", "-DWHISPER_BUILD_TESTS=OFF",
        "-DGGML_OPENMP=OFF", "-DGGML_NATIVE=OFF", "-DBUILD_SHARED_LIBS=OFF", &cflags, &cxxflags,
    ]));
    run(Command::new("cmake").args(["--build", build_dir.to_str().unwrap(), "--target", "whisper", "-j", "8"]));

    let shim_o = out.join("whisper_shim.o");
    let inc1 = format!("{whisper_dir}/include");
    let inc2 = format!("{whisper_dir}/ggml/include");
    let manifest = env::var("CARGO_MANIFEST_DIR").unwrap();
    let src = format!("{manifest}/csrc/whisper_shim.cpp");
    let shim_o_s = shim_o.to_str().unwrap().to_string();
    let mut shim: Vec<&str> = vec!["-c", "-std=c++17", "-O3", "-msimd128"];
    if pthread { shim.push("-pthread"); }
    shim.extend(["-I", &inc1, "-I", &inc2, &src, "-o", &shim_o_s]);
    run(Command::new("emcc").args(&shim));
    let shim_a = out.join("libwhisper_shim.a");
    let _ = std::fs::remove_file(&shim_a);
    run(Command::new("emar").args(["rcs", shim_a.to_str().unwrap(), &shim_o_s]));

    let mut libs = vec![shim_a];
    find_archives(&build_dir, &mut libs);
    write_libs(out, "whisper", &libs);
    println!("cargo:rerun-if-changed=csrc/whisper_shim.cpp");
    println!("cargo:rerun-if-env-changed=WHISPER_CPP_DIR");
}

fn build_stream(out: &Path) {
    let sherpa_dir = env::var("SHERPA_ONNX_DIR").expect("SHERPA_ONNX_DIR 필요 (feature stream)");
    let sherpa_build = env::var("SHERPA_BUILD_DIR").expect("SHERPA_BUILD_DIR 필요 (feature stream)");
    let manifest = env::var("CARGO_MANIFEST_DIR").unwrap();
    let shim_o = out.join("sherpa_shim.o");
    let src = format!("{manifest}/csrc/sherpa_shim.cpp");
    let shim_o_s = shim_o.to_str().unwrap().to_string();
    run(Command::new("emcc").args(["-c", "-std=c++17", "-O3", "-msimd128", "-I", &sherpa_dir, &src, "-o", &shim_o_s]));
    let shim_a = out.join("libsherpa_shim.a");
    let _ = std::fs::remove_file(&shim_a);
    run(Command::new("emar").args(["rcs", shim_a.to_str().unwrap(), &shim_o_s]));

    let mut libs = vec![shim_a];
    find_archives(Path::new(&sherpa_build), &mut libs);
    write_libs(out, "stream", &libs);
    println!("cargo:rerun-if-changed=csrc/sherpa_shim.cpp");
    println!("cargo:rerun-if-env-changed=SHERPA_BUILD_DIR");
}

fn main() {
    let target = env::var("TARGET").unwrap_or_default();
    if !target.contains("emscripten") {
        return;
    }
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    if env::var("CARGO_FEATURE_WHISPER").is_ok() {
        let pthread = std::env::var("MSG_PTHREAD").as_deref() != Ok("0");
        build_whisper(&out, pthread);
    }
    if env::var("CARGO_FEATURE_STREAM").is_ok() {
        build_stream(&out);
    }
}