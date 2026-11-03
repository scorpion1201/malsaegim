# 화자 구분 학습·평가 도구

화자 구분 앞단의 말소리/겹침 분류 모델을 학습하고, 화자 구분 전체를 실패 사례 평가셋으로 잰다. 앱 의존성이 아니다.

## 경로

- 데이터·체크포인트·평가셋·venv 는 저장소 밖 `DATA` 에만 둔다.
- 오디오와 대본 글자는 커밋하지 않는다. 도구는 숫자만 출력한다.

```sh
export DATA=/path/to/malsaegim-diar
python3 -m venv $DATA/venv && $DATA/venv/bin/pip install -r scripts/diarization/requirements.txt
```

## 도구

| 파일 | 하는 일 |
|---|---|
| `ts-loader.mjs` | 앱 TS(`src/app/_lib`)를 node 에서 import 하게 하는 resolve 훅. `node --import ./scripts/diarization/ts-loader.mjs <script>` |
| `normalize.mjs` | stdin PCM16 → 앱 `levelNormalizer` → stdout PCM16. 녹음 저장과 같은 변환 |

## 데이터 출처

| 자료 | 라이선스 | 쓰임 |
|---|---|---|
| Zeroth Korean (`kresnik/zeroth_korean`) | CC BY 4.0 | 화자 음성 (학습·검증·평가, 화자 단위 분리) |
| MUSAN noise·music (OpenSLR 17) | 파일별 확인, 비상업(NC) 조항 파일 제외 | 잡음·음악 |
| macOS 한국어 TTS 9개 음성 | 로컬 생성, 평가 전용 | 평가 |
| 맥 내장 마이크 빈 방 녹음 | 직접 녹음. 30초 조각 중 말소리 같은 주기음이 보인 조각은 버리고 원본은 지운다 | 잡음 |
| 합성 잡음 | 전원 험, 핑크·브라운 잡음, 타자 딸깍, 기침 같은 비주기 폭발 | 잡음 |

MUSAN 에는 키보드·기침·웃음 표시가 없어 sound-bible 제목(펜 딸깍, 종이 넘기기, 박수, 먹는 소리)과 합성음으로 채운다.
웃음은 상업적으로 쓸 수 있는 공개 자료를 찾지 못해 빠져 있다. 사람 목소리가 섞인 잡음(군중 등)은 뺀다.

| 도구 | 하는 일 |
|---|---|
| `fetch-data.sh` | Zeroth parquet(고정 리비전)과 MUSAN 을 `$DATA/src` 로 받는다 |
| `inventory.py` | 화자 단위 분할(시드 1103), 잡음 분류, 빈 방 조각, 합성 잡음, TTS 를 `$DATA/inventory.json` 으로 |
| `rir.py`, `scenes.py` | 방 울림과 실패 사례 장면 생성기 (`scenes.py --check N`) |
| `build-eval.py` | 고정 평가셋(`eval`)·검증셋(`val`) |
| `train.py`, `model.py`, `tune-vad.py`, `export.py` | 분류 모델 학습, 판정 문턱, ONNX 내보내기 |
| `eval.mjs`, `metrics.mjs`, `tune-cluster.mjs` | 앱 파이프라인 평가, 묶기 값 고르기 |