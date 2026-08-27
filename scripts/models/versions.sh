# 모델·툴체인 버전 고정 — 여기 값을 바꾸면 산출물 해시(= manifest 버전)가 바뀌어 브라우저가 다시 내려받는다
WHISPER_CPP_REF=v1.9.3
WHISPER_HF_REPO=seastar105/whisper-small-komixv2
WHISPER_HF_REVISION=bb0a94da846d5d1b7001bb90810dea630a333084
# convert-h5-to-ggml.py 가 mel 필터(whisper/assets/mel_filters.npz)를 이 저장소에서 읽는다
OPENAI_WHISPER_REF=v20240930
TORCH_VERSION=2.8.0
TRANSFORMERS_VERSION=4.56.1
SHERPA_ONNX_REF=v1.13.6
SHERPA_MODEL_NAME=sherpa-onnx-streaming-zipformer-korean-2024-06-16
SHERPA_MODEL_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${SHERPA_MODEL_NAME}.tar.bz2"