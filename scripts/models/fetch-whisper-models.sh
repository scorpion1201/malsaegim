#!/usr/bin/env sh
# whisper.cpp 공식 ggml 모델을 고정 리비전으로 내려받고 sha256 을 검증한다. 결과: <out>/ggml-*.bin
# (q8_0: wasm SIMD 경로가 있고, q6_k 등 k-quant 는 wasm 빌드에서 로드되지 않는다 — docs/ENGINE.md)
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/versions.sh"
OUT=${1:?출력 디렉터리}
WORK=${WORK:-/tmp/malsaegim-models}
mkdir -p "$OUT" "$WORK"

fetch() {
  file=$1
  sha=$2
  dest="$WORK/$file"
  if [ ! -f "$dest" ] || ! echo "$sha  $dest" | sha256sum -c - >/dev/null 2>&1; then
    curl -fL --retry 3 -o "$dest.part" "https://huggingface.co/$WHISPER_MODEL_REPO/resolve/$WHISPER_MODEL_REVISION/$file"
    mv "$dest.part" "$dest"
  fi
  echo "$sha  $dest" | sha256sum -c -
  cp "$dest" "$OUT/$file"
}

fetch "$WHISPER_TURBO_FILE" "$WHISPER_TURBO_SHA256"
fetch "$WHISPER_SMALL_FILE" "$WHISPER_SMALL_SHA256"
ls -la "$OUT"