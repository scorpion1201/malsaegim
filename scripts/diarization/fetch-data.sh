#!/usr/bin/env sh
# 학습 재료를 $DATA/src 로 받는다 — Zeroth Korean(고정 리비전 parquet), MUSAN(OpenSLR 17). 받은 파일의 sha256 을 SHA256SUMS 에 남긴다.
# 사용: DATA=/Users/lucian/orca/data/malsaegim-diar sh scripts/diarization/fetch-data.sh
set -eu
DATA=${DATA:?DATA 경로}
SRC="$DATA/src"
ZEROTH_REVISION=1fe937899f828af822293d05e086200946088bdf
ZEROTH_BASE="https://huggingface.co/datasets/kresnik/zeroth_korean/resolve/$ZEROTH_REVISION/data"
MUSAN_URL=https://openslr.elda.org/resources/17/musan.tar.gz
mkdir -p "$SRC/zeroth" "$SRC/musan"

fetch() {
  url=$1
  dest=$2
  [ -f "$dest" ] && return 0
  curl -fsSL --retry 5 -C - -o "$dest.part" "$url"
  mv "$dest.part" "$dest"
}

for name in test-00000-of-00001 train-00000-of-00006 train-00001-of-00006 train-00002-of-00006 train-00003-of-00006 train-00004-of-00006 train-00005-of-00006; do
  fetch "$ZEROTH_BASE/$name.parquet" "$SRC/zeroth/$name.parquet"
done
fetch "$MUSAN_URL" "$SRC/musan.tar.gz"
[ -d "$SRC/musan/noise" ] || tar -xzf "$SRC/musan.tar.gz" -C "$SRC/musan" --strip-components=1 musan/noise musan/music musan/README

( cd "$SRC" && shasum -a 256 zeroth/*.parquet musan.tar.gz > SHA256SUMS )
cat "$SRC/SHA256SUMS"