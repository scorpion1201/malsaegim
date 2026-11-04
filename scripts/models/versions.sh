# 모델·툴체인 버전 고정 — 여기 값을 바꾸면 산출물 해시(= 배포 URL)가 바뀌어 브라우저가 바뀐 파일만 다시 내려받는다
WHISPER_CPP_REF=v1.9.5
# whisper.cpp 공식 ggml 배포본 (ggerganov/whisper.cpp) — 리비전과 sha256 을 고정해 받은 뒤 검증한다
WHISPER_MODEL_REPO=ggerganov/whisper.cpp
WHISPER_MODEL_REVISION=5359861c739e955e79d9a303bcbc70fb988958b1
# PC·고사양 기기 기본: large-v3-turbo Q8_0 (874,188,075 B)
WHISPER_TURBO_FILE=ggml-large-v3-turbo-q8_0.bin
WHISPER_TURBO_SHA256=317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1
# 메모리가 부족한 모바일 기본: small Q8_0 (264,464,607 B)
WHISPER_SMALL_FILE=ggml-small-q8_0.bin
WHISPER_SMALL_SHA256=49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f
# 화자 구분: 3D-Speaker CAM++ (Apache-2.0, sherpa-onnx 의 ONNX 변환본, 28,281,164 B)
SPEAKER_MODEL_URL=https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx
SPEAKER_MODEL_FILE=speaker-campplus.onnx
SPEAKER_MODEL_SHA256=aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2
# 화자 구분 앞단: 말소리/겹침 분류 모델 (자체 학습, scripts/diarization, 776,967 B)
SPEECH_MODEL_URL=https://github.com/scorpion1201/malsaegim/releases/download/speech-model-v1/speech-crnn.onnx
SPEECH_MODEL_FILE=speech-crnn.onnx
SPEECH_MODEL_SHA256=3acd01abf5317ec816256771b1b3ead4316f1baadf684d11ea1886e6f0ff00be
# 화자 구분 런타임: onnxruntime-web (MIT). 앱 번들에 넣지 않고 npm 배포본에서 wasm 런타임 파일만 꺼낸다
ORT_WEB_VERSION=1.31.1
ORT_WEB_SHA256=bdccdb9fbb9ab537247c0c734e9b1d2b1b338b4f2a09faa58f0dc1cfa27c312c