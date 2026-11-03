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
| 맥 내장 마이크 빈 방 녹음 | 직접 녹음 | 잡음 |