# Architecture Overview

말새김은 음성을 받아 적고 다듬어 HWP/HWPX 로 내보내는 웹 앱이다. 오디오 처리, 인식, 편집은 브라우저에서 돌고, 서버는 API 중계와 문서 생성만 맡으며 아무것도 저장하지 않는다.

## 1. Project Structure

```text
.
├── crates/
│   ├── audio-splitter/     # 오디오 디코딩·분할 (Rust → wasm-pack)
│   └── engine/             # On-Device 엔진 malsaegim-engine (Rust + C 심, bin/xtask)
├── docs/                   # 아키텍처, 배포, 엔진 문서
├── public/                 # 정적 자산, models/ 는 빌드 산출물(git 제외)
├── scripts/
│   ├── models/             # 모델 변환·엔진 빌드, 버전 고정(versions.sh)
│   └── deploy.sh           # Docker Compose 배포 도우미
├── src/
│   ├── proxy.ts            # 공유 비밀번호 인증 미들웨어
│   └── app/
│       ├── api/asr/proxy/  # 외부 API pass-through
│       ├── api/export/     # HWP/HWPX 생성
│       ├── healthz/        # 헬스체크
│       ├── login/          # 로그인 페이지
│       ├── settings/       # 설정 페이지
│       ├── _components/    # Workspace, Editor, Translation, OnDevice, Settings 등 UI
│       └── _lib/
│           ├── asr/         # 인식 엔진 선택, 큐, 조립, BYOK 호출
│           ├── audio/       # 분할 워커, 마이크, 청커, WAV, IndexedDB
│           ├── auth/        # 세션 서명·검증
│           ├── editor/      # Tiptap 변환, 노트 저장
│           ├── engine/      # malsaegim-engine 파사드, 워커, 모델 저장소
│           ├── hwp/         # 문서 모델, rhwp 변환
│           ├── settings/    # BYOK, 번역, 작업 영역 설정
│           └── translation/ # 실시간 번역 WebRTC, 세그먼터, 에코 퓨즈
├── Dockerfile
└── docker-compose.yml
```

## 2. High-Level System Diagram

```text
[Audio File] --> [Splitter Worker] --+
                                     |
[Microphone] --> [LiveChunker] ------+
                                     |
                                     v
                               [selectEngine]
                                     |
        +----------------------------+
        |                            |
        v                            v
[On-Device WASM]               [BYOK Client] <--> [/api/asr/proxy] <--> [User API]
        |                            |
        +----------------------------+
        |
        v
[Transcript Assembly] --> [Tiptap Editor] <--> [Browser Storage]
                                 |
                                 v
                           [/api/export] --> [HWP/HWPX Download]

[Microphone] --> [Realtime Translation] <-- WebRTC --> [OpenAI Realtime API]
                            |
                            +--> [/api/asr/proxy]  (temporary key only)
                            |
                            +--> [Transcript Assembly]
```


- **표기:** `/api/*` 는 서버, `User API` 와 `OpenAI Realtime API` 는 외부 서비스, 나머지는 브라우저 안의 구성 요소다.
- **인식 경로:** 설정에 API 가 있으면 사용자 API(BYOK, 동시 8), 없으면 브라우저 안 whisper.cpp(동시 1)를 쓴다. 마이크 받아쓰기는 On-Device whisper 반복 인식(파일 전사와 같은 모델·워커), BYOK 조각 큐, Realtime 세션 중 하나를 쓴다. On-Device 가 실패해도 음성을 API 로 보내지 않는다.
- **번역 경로:** 미디어는 OpenAI 와 직결하고, 녹음, 조립, 노트 저장은 받아쓰기 경로를 그대로 탄다.
- **경계:** 원본 오디오는 서버에 저장되지 않는다. 서버를 지나는 것은 BYOK 조각과 내보낼 문서 내용뿐이며, 둘 다 요청 처리 후 남지 않는다.

## 3. Core Components

### 3.1. Frontend

**이름:** 말새김 웹 앱

**설명:** 노트 목록, 받아쓰기, 실시간 번역, Tiptap 검수, 녹음·재생, 설정을 제공한다.

**기술:** Next.js 16 App Router, React 19.3, TypeScript, CSS Modules, Tiptap 3, Web Worker, AudioWorklet, WebRTC, WebAssembly

**배포 대상:** Next.js standalone 서버가 정적 자산과 함께 서빙한다.

#### 3.1.1. Screen Layout

- **레이아웃:** 헤더, 탭 줄, 사이드바가 `--bg` 한 면이고 본문만 흰 시트로 뜬다.
- **상단 바:** 로고, 제목, 테마, 설정.
- **탭 줄:** `받아쓰기`, `실시간 번역`과 자동 저장 상태, HWP/HWPX 저장. 탭은 주소 없이 `malsaegim:workspace` 로 기억하고, 노트는 `translation` 필드 유무로 탭이 나뉜다.
- **사이드바:** `+ 새 노트북 ▾` 스플릿 버튼(왼쪽은 빈 노트, ▾ 는 노트·오디오 불러오기), 녹음 토글, 노트 목록. 행마다 `⋯` 메뉴로 이름 바꾸기, JSON 내보내기, HWPX/HWP 저장, 녹음 파일 다운로드, 삭제를 한다.
- **시트:** 에디터와 하단 플레이어. 녹음 중에는 플레이어 자리에 녹음 바가 온다.
- **모바일:** 767px 이하에서 사이드바는 서랍, 시작 레이어는 하단 시트가 된다.
- **테마와 글꼴:** `prefers-color-scheme` 기본에 `html[data-theme]` 수동 지정(`malsaegim:theme`)을 더한다. 글꼴은 `next/font` 로 자체 호스팅한 IBM Plex Sans KR 이다.
- **알림:** 진행·완료·오류는 우하단 토스트(`ToastProvider`)로 보여 준다. 노트 삭제처럼 확인이 필요한 일은 브라우저 `confirm` 대신 `DialogProvider.confirm` 으로 묻는다(Esc 취소, Enter 확인).

#### 3.1.2. Audio Splitting

- **위치:** `crates/audio-splitter`, `src/app/_lib/audio`
- **실행:** 브라우저 Web Worker
- **BYOK 분할:** 목표 225초, 최대 240초. 호출당 길이와 본문 크기를 제한하는 공급자에 맞춘 값이다.
- **On-Device 분할:** 목표 25초, 최대 30초. 조각마다 whisper 윈도우 하나가 되도록 해서 4~5배 느린 온도 폴백을 피한다.
- **브라우저 분할 이유:** 원본을 서버에 올리지 않기 위해서다.

#### 3.1.3. Recognition Engines and Queue

- **위치:** `src/app/_lib/asr`
- **엔진 선택:** `asrEngine.ts` 의 `TranscribeEngine` 인터페이스 한 곳(`selectEngine`)이다. 설정 세 값이 모두 있으면 BYOK, 아니면 On-Device 다. 큐와 녹음 파이프라인은 이 인터페이스만 본다.
- **오류 처리:** BYOK 는 조각별 HTTP 오류를 치명과 재시도로 나눈다. On-Device 는 워커 예외를 재시도, 모델 로드 실패를 치명으로 본다.
- **조립:** 인식 중에는 에디터를 잠그고 조립 결과로 내용을 통째로 교체한다. 순서가 뒤바뀐 조각은 앞 조각이 올 때까지 보류한다.
- **실패 조각:** 에디터 안에 `failedChunk` 노드(빨간 라벨 + 새로고침)로 표시되고, 새로고침을 누르면 그 조각만 재인식한다. 오디오가 연결돼 있지 않으면 파일 선택을 먼저 연다.

#### 3.1.4. On-Device Engine

- **위치:** `src/app/_lib/engine`, `src/app/_lib/asr/{asrEngine,selectEngine}.ts`, `src/app/_components/OnDevice`, `crates/engine`, `scripts/models`
- **진입점:** 앱은 `malsaegimEngine.ts` 파사드 하나로만 접근한다.
- **런타임 두 벌:** `malsaegim-engine.{js,wasm}`(CPU, SIMD + pthread)과 `malsaegim-engine-webgpu.{js,wasm}`(ggml-webgpu, ASYNCIFY). WebGPU(shader-f16)를 먼저 쓰고 안 되면 CPU 로 돌린다. 파일 전사와 실시간이 같은 런타임·같은 모델을 쓴다.
- **빌드:** Rust 가 얇은 C 심으로 C++ 를 FFI 하고 할루시네이션 정리를 한다. 최종 링크는 emcc 가 한다. 자세한 내용은 [ENGINE.md](ENGINE.md) 에 있다.
- **모델:** whisper.cpp 공식 ggml 배포본(`ggerganov/whisper.cpp`, 리비전·sha256 고정). 기본은 large-v3-turbo Q8_0(874 MB, CPU wasm 힙 ≈ 1.67 GB), 메모리가 적은 모바일은 small Q8_0(264 MB, ≈ 1.0 GB). 기기 판별(`deviceProfile.ts`)이 기본값을 고르고 설정에서 바꿀 수 있다. 브라우저는 고른 모델 하나만 받는다. k-quant 는 wasm 에서 로드되지 않는다.
- **실행 조건:** 전 페이지 COOP/COEP 로 교차 출처 격리를 켠다. CPU 런타임은 pthread 풀(코어 수, 최대 8) + SIMD 다. SIMD 나 격리가 없으면 `unavailable` 로 BYOK 만 쓴다.
- **워커 수명:** whisper 워커 하나를 파일 전사와 실시간이 함께 쓴다(`whisperHost.ts`). 녹음 중에는 유지하고, 쓰지 않으면 5분 뒤 종료한다. 모델을 바꾸면 내린다. 녹음 중 워커가 죽으면 한 번 다시 띄우고 버퍼에 남은 오디오부터 이어서 인식한다.
- **워커 구조:** module 워커가 emscripten ES 모듈을 `import()` 로 읽고, 캐시의 모델 Blob 을 WORKERFS 로 붙여(복사 없음) `ccall` 로 Rust 함수를 부른다. 요청은 하나씩 처리한다.
- **파일 전사 흐름:** 진행률은 윈도우마다 갱신되고 토스트는 "인식 중 n%" 만 보여 준다. CPU wasm 의 30초 윈도우 인코더는 4코어 VM 에서 small ≈ 21초, Turbo ≈ 116초다(ENGINE.md).
- **실시간 흐름:** 청커 시간축(저장 WAV 와 같은 샘플)의 프레임을 `liveSession.ts` 가 모아 창을 반복 인식한다. 두 번 연속 같은 앞부분 어절을 확정하고(LocalAgreement-2), 700ms 무음이면 발화를 모두 확정한다. 버퍼는 문장이 끝날 때만 자르고, 다시 나온 확정 부분은 글자 단위 정렬로 걷어 낸다. CPU 에서는 부분 자막만 인코더를 줄이고 확정 인식은 30초 전체 인코더로 돌린다(정확도 우선). 확정 문장은 outcomes 에 들어가 문단이 되고, 실시간 줄에는 미확정 텍스트를 보여 준다. 요청은 한 번에 하나라 느린 기기에서는 자막만 늦어진다("처리 지연").
- **모델 내려받기 UX:** 사용자에게는 고른 모델 하나와 진행률 하나로 보인다. 첫 방문은 스플래시에서 자동으로 받고, "백그라운드에서 계속" 은 sessionStorage 에 기억한다. 우하단 플로팅 카드가 진행을 보여 주고, 설정 페이지 맨 위 카드에서 미리 받거나 지운다.

#### 3.1.5. Recording

- **위치:** `src/app/_lib/audio/{micCapture,liveChunker,wav,recordingStore}.ts`, `src/app/_components/Workspace/useLiveRecording.ts`
- **조각 규칙:** 마이크를 AudioWorklet 으로 16kHz 로 받아 `LiveChunker` 가 100ms 프레임 RMS 로 무음을 본다. 문장 쉼(4초 이후 600ms 무음), 10초(목표, 300ms 무음), 15초(최대)에서 자른다. 첫 문장이 말한 지 수 초 안에 나타나게 하기 위한 값이다.
- **문단:** 짧은 조각이 문단을 쪼개지 않도록 조립할 때 25초 안쪽의 연속 조각은 한 문단으로 합친다.
- **시작 무음:** 첫 말소리 전 무음은 0.3초 프리롤만 남기고 버린다. 저장되는 WAV 와 타임스탬프는 말소리 직전을 0초로 시작한다.
- **인식 전달:** 조각은 WAV 로 감싸 인식 큐로 보낸다. 전부 무음이거나 500ms 미만이면 보내지 않고 빈 결과로 채운다.
- **저장:** PCM 을 IndexedDB `parts` 에 쌓아 탭이 죽어도 마지막 조각까지 남긴다. 중지하면 모노 PCM16 WAV 하나로 `recordings` 에 저장하고 parts 를 지운다.
- **이어 쓰기:** 노트가 열려 있을 때 녹음을 시작하거나 오디오를 불러오면 "이어서 / 새 노트 / 취소" 를 묻는다. 이어서면 본문 끝에 `Part N · 라벨` 제목(h3)을 달고 결과를 붙이며, 처음 이어 붙이는 오디오 노트는 맨 위에 Part 1 제목도 단다.
- **파트 시간축:** 노트의 `parts` 가 파트마다 `offsetMs`(앞 파트들의 길이 합)를 가진다. 조각과 타임스탬프 노드의 `ms` 는 노트 전체 시간축이고, 타임스탬프·실패 조각 노드의 `offset` 으로 화면에는 파트 안 시각(00:00 부터)을 보인다. 조각 번호는 노트 안에서 이어진다.
- **파트 재생·재인식:** 원본은 `recordings` 에 `노트 id`(Part 1), `노트 id#N`(Part N) 으로 따로 둔다. 플레이어는 파트들을 하나처럼 이어 재생하고(타임스탬프를 누르면 그 파트로 넘어간다), 실패 조각은 그 파트 원본에서 파트 안 시각으로 잘라 다시 인식한다. 오디오 다운로드는 파트마다 파일 하나, 노트를 지우면 모든 파트 원본을 지운다.
- **공통 원본:** 이 WAV 가 재생, 다운로드(`<제목>.wav`), 실패 조각 재인식(디코딩 없이 바이트 슬라이스)에 함께 쓰인다.

#### 3.1.6. Realtime Translation

- **위치:** `src/app/_lib/translation`, `src/app/_lib/settings/translationSettings.ts`, `src/app/_components/Translation`
- **조각 나누기:** `translationRecognizer` 가 `LiveRecognizer` 를 구현해 `LiveChunker` 경계에서 원문·번역 델타를 `elapsed_ms` 로 나눈다.
- **저장 구조:** 끝난 블록은 번역 문단(타임스탬프 소유)과 원문 문단의 쌍(`paragraph.attrs.role`)으로 저장한다.
- **스피커:** 재협상 없이 `muted` 만 쓴다.
- **마이크:** `echoCancellation: 'remote-only'` 트랙 하나를 번역 송신과 녹음이 함께 쓴다. Chrome 은 같은 장치의 처리 설정을 첫 캡처에 묶어 트랙을 나누면 에코 제거가 꺼진다.
- **에코 퓨즈:** 원문이 직전 번역과 비슷해지거나 번역 글이 같은 말을 되풀이하면 번역 음성을 끈다(`echoFuse.ts`).
- **세션:** 끊기면 새 임시 키로 다시 연결한다. 만료(60분) 2분 전 조각 경계에서 교대하고, 일시정지가 60초를 넘으면 세션을 닫는다.
- **장애 격리:** 녹음은 번역 실패와 무관하게 계속된다.

### 3.2. Backend Services

#### 3.2.1. External API Proxy

**이름:** `/api/asr/proxy`

**설명:** 브라우저 직접 호출이 CORS 에 막히므로 `x-asr-target-url` 로 온 공개 https 주소에 필요한 헤더만 붙여 그대로 전달한다. 키, 주소, 모델을 갖지 않고 오디오나 응답을 저장·기록하지 않는다.

**기술:** Next.js Route Handler (Node)

**배포 대상:** Next.js standalone 서버

- **제한:** 같은 출처 요청만, 본문 12MB(읽는 도중 검사, 수신 60초), 응답 8MB, 상류 대기 2분, 프로세스당 동시 24건(최대 약 480MB).
- **대상 검증:** 공개 https 주소만 허용한다. 연결할 때 DNS 답을 직접 검사해 내부 주소로 풀리는 호스트를 막고, 리다이렉트는 따라가지 않는다(`src/app/_lib/asr/proxyTarget.ts`).
- **전달 헤더:** `authorization`, `content-type`.

#### 3.2.2. Document Export

**이름:** `/api/export`

**설명:** Tiptap 내용을 문서 모델로 바꿔 HWP/HWPX 파일을 만든다.

**기술:** Next.js Route Handler (Node), `@rhwp/core` wasm

**배포 대상:** Next.js standalone 서버

- **생성 경로:** HWP 바이너리는 rhwp 의 한컴 템플릿(`createBlankDocument`) 경로로만 만든다.
- **레이아웃:** 용지 종류·방향·여백 mm, 본문 글꼴·크기, 제목 크기는 노트마다 `layout` 으로 저장돼 내보내기 요청에 실린다. 서버는 `normalizePageLayout` 으로 메운 뒤 `setPageDef`(HWPUNIT = mm × 283.465)와 `findOrCreateFontId` + `fontId`/`fontSize` 로 적용한다. 글꼴 이름 키는 rhwp 가 무시한다.
- **서식:** 제목은 가운데, 본문은 양쪽 정렬이다. 목록은 글머리 문자와 왼쪽 여백으로 표현한다(rhwp 에 Bullet/Numbering 생성 헬퍼 없음).
- **설정 패널:** 에디터 툴바의 용지 아이콘으로 오른쪽에서 슬라이드로 열린다.

#### 3.2.3. Authentication and Health Check

**이름:** `src/proxy.ts`, `/login`, `/healthz`

**설명:** 선택 기능인 공유 비밀번호 로그인과 인증을 거치지 않는 헬스체크를 제공한다. `APP_SHARED_PASSWORD` 가 없으면 로그인이 꺼지고 모든 경로가 열린다.

**기술:** Next.js Proxy, 서명된 세션 쿠키

**배포 대상:** Next.js standalone 서버

## 4. Data Stores

서버 저장소는 없다. 모든 데이터는 각 사용자의 브라우저에 남는다.

### 4.1. localStorage

**이름:** `malsaegim:*`

**유형:** 브라우저 키-값 저장소

**목적:** 노트 텍스트와 설정 보관

**주요 키:** `malsaegim:projects`, `malsaegim:project:<id>`, `malsaegim:byok`, `malsaegim:translation`, `malsaegim:workspace`, `malsaegim:models`, `malsaegim:ondevice-model`, `malsaegim:ondevice-webgpu`, `malsaegim:theme`

- 노트에는 제목, 편집 내용, 조각 시간표, 오디오 SHA-256 이 들어간다. 코드와 저장 키는 `project` 이름을 유지한다.
- 노트는 JSON 으로 내보내고 가져올 수 있다. 녹음 원본은 포함하지 않는다.

### 4.2. IndexedDB

**이름:** `recordings`, `parts`

**유형:** 브라우저 객체 저장소

**목적:** 오디오 원본과 녹음 중 PCM 보관

- `recordings` 는 노트 id(이어 붙인 파트는 `id#N`)로 원본 Blob 을 보관해, 다시 열 때 재생, 재인식, 다운로드에 파일을 다시 고를 필요가 없게 한다. Safari 프라이빗 창처럼 Blob 을 넣지 못하면 같은 내용을 `ArrayBuffer` 로 저장한다.
- 원본이 없으면(가져온 JSON 노트, 지워진 저장소) 같은 오디오를 다시 선택해 해시로 식별한다. 실패한 조각만 저장된 시간 구간으로 wasm 에서 추출(`extract_ranges`)해 재인식하고, 전부 완료된 노트면 재생용으로만 연결한다.
- 마지막 조각은 항상 "스트림 끝까지" 추출해 디코더가 바뀌어 총 길이가 달라져도 안전하다.

### 4.3. Cache Storage

**이름:** `malsaegim-models`

**유형:** 브라우저 HTTP 캐시 저장소

**목적:** On-Device 모델과 wasm 보관

**주요 구조:** `public/models/manifest.json`(schema 2: runtime 파일 + models)과 `public/models/runtime/<hash>/`, `public/models/<model-id>/<sha256 12자리>/`

- 런타임 + 고른 모델 하나만 받는다. 받으면서 스트리밍 SHA-256 으로 검사해 캐시에 넣고, `malsaegim:models` 에 묶음 키를 남겨 준비 여부를 빠르게 판단한다. 고른 모델은 `malsaegim:ondevice-model`, WebGPU 끄기는 `malsaegim:ondevice-webgpu` 에 둔다.

## 5. External Integrations / APIs

**서비스:** 사용자 지정 음성 인식 API (BYOK)

**목적:** 파일과 마이크 음성을 글로 변환

**연동 방식:** `/api/asr/proxy` 를 거치는 REST, Realtime 전용 모델은 WebSocket

- API Base URL, API Key, 모델 이름은 `/settings` 에서 저장한다. 주소와 모델은 `malsaegim:byok` 에, 키는 암호화 금고에 남는다. 세 값이 없으면 On-Device 를 쓴다.
- OpenAI 호환 `POST {base}/audio/transcriptions`(multipart file, model, language)를 쓴다.
- `gpt-live-transcribe`, `gpt-realtime-whisper` 는 프록시로 임시 키를 받아 브라우저가 Realtime WebSocket 세션을 연다.
- 연결 테스트는 1초 무음 WAV 로 같은 경로를 확인한다.

**서비스:** OpenAI `gpt-realtime-translate`

**목적:** 실시간 음성 번역

**연동 방식:** WebRTC, `oai-events` 데이터 채널

- 표준 키는 `/api/asr/proxy` 로 수명 60초의 임시 키를 받을 때만 쓴다.
- SDP 교환, 미디어, 데이터 채널은 브라우저가 OpenAI 와 직결한다. 서버는 오디오와 SDP 를 보지 않는다.

**서비스:** rhwp (`@rhwp/core`)

**목적:** HWP/HWPX 생성

**연동 방식:** 서버 안에서 실행하는 npm 패키지 wasm

## 6. Deployment & Infrastructure

**클라우드 제공자:** 특정 제공자에 묶이지 않는다. Docker 나 Node 가 돌아가는 서버에 직접 배포한다.

**주요 서비스:** Docker 이미지 또는 Next.js standalone Node 서버, 앞단 리버스 프록시(HTTPS 종단)

**CI/CD 파이프라인:** 저장소에 없다. `docker compose up -d --build` 나 `scripts/deploy.sh` 로 수동 배포한다.

**모니터링 및 로깅:** `/healthz` 헬스체크와 `docker compose logs`

- 모델과 엔진 wasm 은 Docker 빌드 안에서 만들어 `public/models/` 로 정적 서빙한다.
- 앱이 보내는 COOP/COEP 헤더를 프록시가 벗기면 On-Device 인식이 멈춘다.
- 절차와 프록시 설정은 [DEPLOYMENT.md](DEPLOYMENT.md) 에 있다.

## 7. Security Considerations

**인증:** 선택 기능인 공유 비밀번호와 서명된 세션 쿠키. 쿠키는 프로덕션에서 `Secure` 다.

**인가:** 역할 구분이 없다. 로그인하면 모든 기능을 쓴다. `/healthz` 만 인증을 거치지 않는다.

**데이터 암호화:** 전송 구간은 리버스 프록시의 HTTPS 에 맡긴다. 브라우저 저장소의 키와 노트는 별도로 암호화하지 않는다.

**주요 보안 도구 및 관행:**

- 서버는 무상태다. 오디오, 문서, 키를 저장하거나 기록하지 않는다.
- 프록시는 같은 출처 요청과 공개 https 주소만 허용한다. 연결 시점에 DNS 답을 검사하고 리다이렉트를 따라가지 않으며, 본문·응답 크기와 동시 요청 수를 제한한다.
- `sec-fetch-site` 는 브라우저 밖 클라이언트가 위조할 수 있고 프록시 자체 인증이 아니다. 인터넷에 공개하는 배포는 `APP_SHARED_PASSWORD` 를 설정한다.
- 사용자 API 키는 브라우저를 닫아도 남는다. 원문을 꺼낼 수 없는 Web Crypto 키로 암호화해 IndexedDB(`malsaegim-vault`)에 두고 `localStorage` 에는 남기지 않는다. 저장소를 복사해도 키가 나오지 않지만, 이 출처에서 실행되는 코드는 복호화를 호출할 수 있어 CSP 와 함께 써야 한다. Web Crypto 가 없는 평문 http 에서는 키를 잃지 않도록 설정 레코드에 평문으로 남는다.
- 전사와 번역 글은 텍스트 노드로만 렌더링한다. 원시 HTML 로 바꾸는 변경은 별도 보안 검토 대상이다.
- 가져오는 노트 파일은 `noteSchema.ts` 로 노드, 마크, 속성, 깊이, 크기를 검사한다. 에디터 확장을 늘리면 이 목록도 함께 늘린다.
- CSP 는 외부 스크립트, 인라인 이벤트, 객체 삽입, 외부 임베딩을 막고, 직접 연결 대상을 같은 출처와 OpenAI 로 제한한다. Next.js 인라인 스크립트 때문에 `script-src` 에 `unsafe-inline` 이 남아 있고, 제거는 nonce 통합이 필요해 Report-Only 로 점검한다. WebRTC 는 CSP 로 제한되지 않는다.
- `ASR_PROXY_ALLOWED_HOSTS` 를 설정하면 프록시 대상을 지정한 호스트로 제한한다.
- 실시간 연결은 표준 키 대신 수명이 짧은 임시 키를 쓴다.
- 비밀값은 `.dockerignore` 로 이미지에서 제외하고 실행 시 환경 변수로 넘긴다.
- 마이크는 HTTPS 또는 `localhost` 에서만 동작한다.

## 8. Development & Testing Environment

**로컬 설정:**

```sh
yarn install
yarn dev
yarn models   # 선택: On-Device 모델 빌드
```

Node 20+, Yarn 4, Rust stable, `wasm32-unknown-unknown`, wasm-pack 이 필요하다. 자세한 요구 사항은 [DEPLOYMENT.md](DEPLOYMENT.md) 에 있다.

**테스트 프레임워크:** 저장소에 테스트 코드를 두지 않는다. lint, build, 브라우저 동작으로 검증한다.

**코드 품질 도구:** `yarn lint`(`next typegen`, `tsc --noEmit`, ESLint), Prettier

## 9. Future Considerations / Roadmap

- **작은 소리 번역:** 작은 소리의 중국어가 인식되지 않는 문제의 원인을 아직 찾지 못했다.
- **번역 통합 시험:** 앱에서 번역, 녹음, 저장을 이어서 돌리는 시험, Wi-Fi 복구, 60분 세션 교대, 과금, HWP 외국어 표시를 시험하지 못했다.
- **WebGPU 실기기 검증:** 개발 환경에 GPU 가 없어 WebGPU 경로의 속도·정확도는 검증하지 못했다(폴백만 검증).
- **모바일 실기기 검증:** iPhone·iPad·Android 에서 Turbo 로딩과 실시간 처리 여부를 확인해야 한다.
- **파인튜닝:** 사투리·구어체 평가셋(`scripts/eval`)으로 약점을 잰 뒤 GPU 환경에서 별도로 진행한다.

## 10. Project Identification

**Project Name:** malsaegim (말새김, `malsaegim-app`)

**Repository URL:** https://github.com/scorpion1201/malsaegim

**Primary Contact:** Seongwoo Park

**Date of Last Update:** 2026-11-01

## 11. Glossary / Acronyms

- **BYOK:** Bring Your Own Key. Users supply their own API key and base URL.
- **On-Device:** Speech recognition that runs in the browser through wasm, with no server involved.
- **Note (노트):** The unit of work. Code and storage keys call it `project`.
- **Chunk (조각):** The audio segment sent in one recognition request.
- **AEC:** Acoustic echo cancellation. Removes speaker output that leaks back into the microphone.
- **COOP/COEP:** Response headers that enable cross-origin isolation, which wasm threads require.
- **HWPUNIT:** The HWP length unit. 1 mm equals 283.465 HWPUNIT.
- **rhwp:** The library that generates HWP/HWPX files.
- **SDP:** Session Description Protocol. The format WebRTC peers use to exchange connection parameters.