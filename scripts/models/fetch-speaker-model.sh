#!/usr/bin/env sh
# 화자 구분에 쓰는 임베딩 모델과 onnxruntime-web wasm 런타임을 고정 버전으로 받아 sha256 을 검증한다.
# 결과: <out>/speaker-campplus.onnx, <out>/ort.wasm.min.mjs, <out>/ort-wasm-simd-threaded.{mjs,wasm}
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/versions.sh"
OUT=${1:?출력 디렉터리}
WORK=${WORK:-/tmp/malsaegim-models}
mkdir -p "$OUT" "$WORK"

fetch() {
  url=$1
  sha=$2
  dest=$3
  if [ ! -f "$dest" ] || ! echo "$sha  $dest" | sha256sum -c - >/dev/null 2>&1; then
    curl -fL --retry 3 -o "$dest.part" "$url"
    mv "$dest.part" "$dest"
  fi
  echo "$sha  $dest" | sha256sum -c -
}

fetch "$SPEAKER_MODEL_URL" "$SPEAKER_MODEL_SHA256" "$WORK/$SPEAKER_MODEL_FILE"
cp "$WORK/$SPEAKER_MODEL_FILE" "$OUT/$SPEAKER_MODEL_FILE"

ORT_TGZ="$WORK/onnxruntime-web-$ORT_WEB_VERSION.tgz"
fetch "https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-$ORT_WEB_VERSION.tgz" "$ORT_WEB_SHA256" "$ORT_TGZ"
tar -xzf "$ORT_TGZ" -C "$OUT" --strip-components=2 \
  package/dist/ort.wasm.min.mjs \
  package/dist/ort-wasm-simd-threaded.mjs \
  package/dist/ort-wasm-simd-threaded.wasm
ls -la "$OUT"