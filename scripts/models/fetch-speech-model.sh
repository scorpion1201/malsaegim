#!/usr/bin/env sh
# 화자 구분 앞단의 말소리/겹침 분류 모델(자체 학습, scripts/diarization)을 고정 릴리스에서 받아 sha256 을 검증한다.
# 결과: <out>/speech-crnn.onnx
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/versions.sh"
OUT=${1:?출력 디렉터리}
WORK=${WORK:-/tmp/malsaegim-models}
mkdir -p "$OUT" "$WORK"

dest="$WORK/$SPEECH_MODEL_FILE"
if [ ! -f "$dest" ] || ! echo "$SPEECH_MODEL_SHA256  $dest" | sha256sum -c - >/dev/null 2>&1; then
  curl -fL --retry 3 -o "$dest.part" "$SPEECH_MODEL_URL"
  mv "$dest.part" "$dest"
fi
echo "$SPEECH_MODEL_SHA256  $dest" | sha256sum -c -
cp "$dest" "$OUT/$SPEECH_MODEL_FILE"