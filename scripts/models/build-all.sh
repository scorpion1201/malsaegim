#!/usr/bin/env sh
# Docker 없이 같은 순서로: emsdk(4.0.23)·Rust nightly(+wasm32-unknown-emscripten,rust-src)·cmake·curl·node 가 PATH 에 있어야 한다.
# 보통은 `yarn models`(Docker 스테이지 export)를 쓰고, 이 스크립트는 툴체인을 직접 갖춘 머신용이다.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
OUT=${1:?출력 디렉터리 (예: public/models)}
WORK=${WORK:-/tmp/malsaegim-models}
STAGE="$WORK/stage"
mkdir -p "$STAGE"
WORK="$WORK" sh "$HERE/fetch-whisper-models.sh" "$STAGE"
# 엔진 wasm (Rust 래퍼 + whisper.cpp) — bash 대신 Rust xtask 가 만든다
( cd "$ROOT" && cargo run -p malsaegim-engine --bin xtask --release -- "$STAGE" "$WORK/engine-src" )
node "$HERE/write-manifest.mjs" "$STAGE" "$OUT"