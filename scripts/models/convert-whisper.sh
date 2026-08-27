#!/usr/bin/env sh
# HF whisper-small-komixv2 → ggml(f16) → q8_0. 결과: <out>/whisper-ko-q8_0.bin
# (q8_0: wasm SIMD 경로가 있어 q5_1 보다 빠르고 정확하다. q6_k 등 k-quant 는 wasm 빌드에서 로드되지 않는다)
# 필요: python3, pip, git, cmake, C 컴파일러 (Dockerfile 의 convert 스테이지가 준비한다)
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/versions.sh"
OUT=${1:?출력 디렉터리}
WORK=${WORK:-/tmp/malsaegim-models}
mkdir -p "$OUT" "$WORK"

python3 -m pip install --no-cache-dir "torch==$TORCH_VERSION" --index-url https://download.pytorch.org/whl/cpu
python3 -m pip install --no-cache-dir "transformers==$TRANSFORMERS_VERSION" "huggingface_hub>=0.25" numpy safetensors

[ -d "$WORK/whisper.cpp" ] || git clone --depth 1 --branch "$WHISPER_CPP_REF" https://github.com/ggml-org/whisper.cpp "$WORK/whisper.cpp"
[ -d "$WORK/whisper" ] || git clone --depth 1 --branch "$OPENAI_WHISPER_REF" https://github.com/openai/whisper "$WORK/whisper"

# 변환에 필요한 파일만 고정 리비전으로 받는다 (flax·이벤트 로그 제외)
python3 - <<PY
from huggingface_hub import snapshot_download
snapshot_download(
    "$WHISPER_HF_REPO",
    revision="$WHISPER_HF_REVISION",
    local_dir="$WORK/hf",
    allow_patterns=["config.json", "model.safetensors", "vocab.json", "added_tokens.json", "merges.txt",
                    "tokenizer_config.json", "special_tokens_map.json", "generation_config.json",
                    "preprocessor_config.json", "normalizer.json"],
)
PY

python3 "$WORK/whisper.cpp/models/convert-h5-to-ggml.py" "$WORK/hf" "$WORK/whisper" "$WORK"
test -f "$WORK/ggml-model.bin"

cmake -S "$WORK/whisper.cpp" -B "$WORK/whisper.cpp/build" -DCMAKE_BUILD_TYPE=Release \
  -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF
cmake --build "$WORK/whisper.cpp/build" --target whisper-quantize -j"$(nproc)"
"$WORK/whisper.cpp/build/bin/whisper-quantize" "$WORK/ggml-model.bin" "$OUT/whisper-ko-q8_0.bin" q8_0
ls -la "$OUT"