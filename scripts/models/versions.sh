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