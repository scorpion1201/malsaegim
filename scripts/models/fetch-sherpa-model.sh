#!/usr/bin/env sh
# GitHub 릴리스 tar.bz2 에서 실시간 인식에 쓰는 파일만 꺼낸다: int8 encoder/joiner, fp32 decoder(작다), tokens
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/versions.sh"
OUT=${1:?출력 디렉터리}
WORK=${WORK:-/tmp/malsaegim-models}
mkdir -p "$OUT" "$WORK"

ARCHIVE="$WORK/$SHERPA_MODEL_NAME.tar.bz2"
[ -f "$ARCHIVE" ] || curl -fL --retry 3 -o "$ARCHIVE" "$SHERPA_MODEL_URL"
[ -d "$WORK/$SHERPA_MODEL_NAME" ] || tar -xjf "$ARCHIVE" -C "$WORK"
D="$WORK/$SHERPA_MODEL_NAME"
cp "$D/encoder-epoch-99-avg-1.int8.onnx" "$OUT/sherpa-encoder.onnx"
cp "$D/decoder-epoch-99-avg-1.onnx" "$OUT/sherpa-decoder.onnx"
cp "$D/joiner-epoch-99-avg-1.int8.onnx" "$OUT/sherpa-joiner.onnx"
cp "$D/tokens.txt" "$OUT/sherpa-tokens.txt"
ls -la "$OUT"