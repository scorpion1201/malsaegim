"""학습 재료 목록과 분할 — $DATA/src 의 원천을 풀어 $DATA/inventory.json 을 만든다.

- Zeroth: parquet 의 오디오를 화자별 16 kHz WAV 로 풀고(대본 글자는 버린다), 화자 단위로 train/val/test 를 나눈다(시드 1103).
- MUSAN: 하위 디렉터리 LICENSE·ANNOTATIONS 를 읽어 비상업(NC) 조항 파일을 뺀다.
- 빈 방: 원음 녹음을 30초 조각으로 자르고, 말소리 같은 주기음이 보이는 조각은 지운다(듣지 않는다).
- 합성 잡음: 전원 험(50/60 Hz 와 배음), 핑크·브라운 잡음.
- TTS: macOS 한국어 음성 9개로 문장 30개와 맞장구 5개 (평가 전용).
    python -I scripts/diarization/inventory.py            # 만들기
    python -I scripts/diarization/inventory.py --summary  # 숫자만 출력
"""
import argparse
import hashlib
import io
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import soundfile

SAMPLE_RATE = 16000
SEED = 1103
SPLIT_SHARES = (('train', 0.75), ('val', 0.10), ('test', 0.15))
ROOM_SEGMENT_S = 30
TTS_VOICES = ['Yuna', 'Eddy', 'Flo', 'Grandma', 'Grandpa', 'Reed', 'Rocko', 'Sandy', 'Shelley']
TTS_SENTENCES = [
    '오늘 회의는 지난주에 이야기한 일정부터 확인하겠습니다.',
    '그 부분은 제가 다시 한번 정리해서 공유드릴게요.',
    '혹시 다른 의견 있으신 분 계신가요?',
    '예산이 조금 부족할 것 같아서 걱정입니다.',
    '다음 주 화요일까지 초안을 보내 주시면 됩니다.',
    '아까 말씀하신 내용이 정확히 어떤 뜻이었죠?',
    '현장에서는 생각보다 반응이 좋았습니다.',
    '그럼 이 안건은 여기서 마무리하겠습니다.',
    '자료는 공유 폴더에 올려 두었습니다.',
    '이번 분기 목표를 조금 낮추는 게 좋겠어요.',
    '고객사에서 추가 요청이 들어왔습니다.',
    '저는 첫 번째 방안이 더 현실적이라고 생각해요.',
    '시간이 많지 않으니 핵심만 말씀드리겠습니다.',
    '테스트 결과는 내일 오전에 나올 예정입니다.',
    '담당자를 한 명 더 배정해 주시면 좋겠습니다.',
    '지난번 문제는 원인을 찾아서 해결했습니다.',
    '이 일정이면 출시가 한 달 늦어집니다.',
    '좋습니다, 그렇게 진행하시죠.',
    '잠깐만요, 그 숫자가 맞는지 확인해 볼게요.',
    '회의록은 제가 작성해서 보내겠습니다.',
    '사용자 인터뷰를 다섯 건 더 해 보면 어떨까요.',
    '그건 법무팀 검토가 먼저 필요합니다.',
    '오후에 따로 시간을 잡아서 이야기해요.',
    '생각보다 비용이 많이 들어서 다시 계산했습니다.',
    '모두 동의하시면 다음 안건으로 넘어가겠습니다.',
    '저도 비슷한 경험이 있어서 공감합니다.',
    '이번에는 꼭 마감일을 지켜야 합니다.',
    '질문이 있으면 언제든지 연락 주세요.',
    '처음 계획과는 조금 달라졌습니다.',
    '오늘 이야기 나눠 주셔서 감사합니다.',
]
TTS_BACKCHANNELS = ['네', '음', '아', '응', '그렇죠']
NC_PATTERN = re.compile(r'non-?commercial|\bNC\b|by-nc', re.IGNORECASE)
# MUSAN 에는 키보드·기침·웃음 표시가 없다. sound-bible LICENSE 의 제목으로 사무실 잡음과 사람이 내는 비말소리를 고르고,
# 모자라는 것은 build_synthetic 이 만든다 (웃음은 상업 가능한 공개 자료를 찾지 못해 빠져 있다)
NOISE_KINDS = (
    ('keyboard', re.compile(r'keyboard|typing|typewriter|pen click|page turn|stapl', re.IGNORECASE)),
    ('cough-laugh', re.compile(r'cough|laugh|sneez|giggl|throat|applause|eat', re.IGNORECASE)),
    ('fan', re.compile(r'\bfan\b|air ?condition|hvac|hum\b|vent|refrigerator|fridge', re.IGNORECASE)),
)
# 사람 목소리가 섞인 잡음은 비말소리 라벨과 맞지 않아 뺀다
VOICE_IN_NOISE = re.compile(r'crowd|people|talk|voice|speech', re.IGNORECASE)


def data_dir():
    return Path(os.environ.get('DATA', '/Users/lucian/orca/data/malsaegim-diar'))


def write_wav(path, samples):
    path.parent.mkdir(parents=True, exist_ok=True)
    soundfile.write(path, samples, SAMPLE_RATE, subtype='PCM_16')


def split_of(key, shares=SPLIT_SHARES):
    """키 해시로 고정 분할 — 실행 순서와 관계없이 같은 결과"""
    value = int(hashlib.sha256(f'{SEED}:{key}'.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    edge = 0.0
    for name, share in shares:
        edge += share
        if value < edge:
            return name
    return shares[-1][0]


def frame_periodicity(frame):
    """80~400 Hz 정규화 자기상관 봉우리 — 앱 voiceDetector 와 같은 기준(4 kHz 로 내려 계산)"""
    signal = frame.reshape(-1, 4).sum(axis=1)
    signal = signal - signal.mean()
    best = 0.0
    values = []
    for lag in range(9, 52):
        left, right = signal[:-lag], signal[lag:]
        norm = np.sqrt((left * left).sum() * (right * right).sum())
        values.append((left * right).sum() / norm if norm > 0 else 0.0)
    for i in range(1, len(values) - 1):
        if values[i] > values[i - 1] and values[i] >= values[i + 1]:
            best = max(best, values[i])
    return best


def mean_pitch(samples):
    """유성 프레임의 평균 F0 (Hz) — 비슷한 목소리 장면을 고르는 데만 쓴다"""
    pitches = []
    for start in range(0, len(samples) - 1600, 1600):
        frame = samples[start : start + 1600]
        if np.sqrt((frame * frame).mean()) < 0.01:
            continue
        signal = frame.reshape(-1, 4).sum(axis=1)
        signal = signal - signal.mean()
        scores = [(signal[:-lag] * signal[lag:]).sum() / (np.sqrt((signal[:-lag] ** 2).sum() * (signal[lag:] ** 2).sum()) + 1e-12) for lag in range(10, 51)]
        lag = int(np.argmax(scores)) + 10
        if scores[lag - 10] > 0.5:
            pitches.append(4000 / lag)
    return float(np.median(pitches)) if pitches else 0.0


def build_zeroth(src, out):
    speakers = {}
    for parquet in sorted((src / 'zeroth').glob('*.parquet')):
        table = pq.read_table(parquet, columns=['id', 'speaker_id', 'audio'])
        for row in table.to_pylist():
            speaker = str(row['speaker_id'])
            path = out / 'zeroth' / speaker / f"{row['id']}.wav"
            if not path.exists():
                samples, rate = soundfile.read(io.BytesIO(row['audio']['bytes']), dtype='float32')
                if rate != SAMPLE_RATE:
                    raise SystemExit(f'{row["id"]}: {rate} Hz')
                write_wav(path, samples)
            info = soundfile.info(path)
            speakers.setdefault(speaker, {'utterances': []})['utterances'].append({'path': str(path), 'ms': round(info.duration * 1000)})
    for speaker, entry in speakers.items():
        entry['split'] = split_of(f'speaker:{speaker}')
        sample = np.concatenate([soundfile.read(u['path'], dtype='float32')[0] for u in entry['utterances'][:5]])
        entry['pitchHz'] = round(mean_pitch(sample), 1)
    return speakers


def musan_license_ok(folder):
    """LICENSE 에 비상업 조항이 있는 파일 이름 집합과 폴더 전체 허용 여부"""
    license_path = folder / 'LICENSE'
    text = license_path.read_text(errors='ignore') if license_path.exists() else ''
    blocked = set()
    for line in text.splitlines():
        if NC_PATTERN.search(line):
            blocked.update(re.findall(r'(?:noise|music)-[\w-]+-\d{4}', line))
    folder_nc = bool(NC_PATTERN.search(text)) and not blocked
    return blocked, folder_nc


def noise_kind(text, default):
    for kind, pattern in NOISE_KINDS:
        if pattern.search(text):
            return kind
    return default


def build_musan(src):
    entries = []
    excluded = 0
    for top in ('noise', 'music'):
        for folder in sorted((src / 'musan' / top).glob('*')):
            if not folder.is_dir():
                continue
            blocked, folder_nc = musan_license_ok(folder)
            annotations = {}
            annotation_path = folder / 'ANNOTATIONS'
            if annotation_path.exists():
                for line in annotation_path.read_text(errors='ignore').splitlines():
                    parts = line.split(None, 1)
                    if parts:
                        annotations[parts[0]] = parts[1] if len(parts) > 1 else ''
            # sound-bible 은 LICENSE 에 파일 이름 다음 줄로 Title 이 있다
            license_path = folder / 'LICENSE'
            current = None
            for line in license_path.read_text(errors='ignore').splitlines() if license_path.exists() else []:
                if re.fullmatch(r'(?:noise|music)-[\w-]+-\d{4}', line.strip()):
                    current = line.strip()
                elif current and line.startswith('Title:'):
                    annotations[current] = annotations.get(current, '') + ' ' + line[len('Title:') :].strip()
            for wav in sorted(folder.glob('*.wav')):
                name = wav.stem
                if folder_nc or name in blocked or NC_PATTERN.search(annotations.get(name, '')):
                    excluded += 1
                    continue
                if top == 'noise' and VOICE_IN_NOISE.search(annotations.get(name, '')):
                    excluded += 1
                    continue
                kind = 'music' if top == 'music' else noise_kind(annotations.get(name, ''), 'noise')
                entries.append({'path': str(wav), 'kind': kind, 'split': split_of(f'noise:{name}', (('train', 0.85), ('test', 0.15))), 'license': f'MUSAN {top}/{folder.name}'})
    return entries, excluded


def build_room(src, out):
    entries = []
    dropped = 0
    for raw in sorted((src / 'room').glob('*.wav')):
        samples, rate = soundfile.read(raw, dtype='float32')
        step = ROOM_SEGMENT_S * rate
        for index, start in enumerate(range(0, len(samples) - step + 1, step)):
            segment = samples[start : start + step]
            frames = segment[: len(segment) // 1600 * 1600].reshape(-1, 1600)
            db = 20 * np.log10(np.sqrt((frames * frames).mean(axis=1)) + 1e-9)
            floor = np.percentile(db, 20)
            periodic = sum(1 for frame, level in zip(frames, db) if level >= floor + 6 and frame_periodicity(frame) >= 0.5)
            if periodic >= 3:
                dropped += 1
                continue
            path = out / 'room' / f'{raw.stem}-{index:03d}.wav'
            write_wav(path, segment)
            entries.append({'path': str(path), 'kind': 'room', 'split': 'train' if index % 4 else 'test', 'license': 'own recording'})
    return entries, dropped


def build_synthetic(out):
    rng = np.random.default_rng(SEED)
    entries = []
    seconds = 60
    n = seconds * SAMPLE_RATE
    t = np.arange(n) / SAMPLE_RATE
    for index in range(12):
        kind = ('hum', 'pink', 'brown')[index % 3]
        if kind == 'hum':
            base = 50 if index % 2 else 60
            signal = sum(rng.uniform(0.2, 1.0) / k * np.sin(2 * np.pi * base * k * t + rng.uniform(0, 6.3)) for k in range(1, 8))
        else:
            white = rng.standard_normal(n)
            spectrum = np.fft.rfft(white)
            freqs = np.maximum(np.fft.rfftfreq(n, 1 / SAMPLE_RATE), 1.0)
            spectrum /= np.sqrt(freqs) if kind == 'pink' else freqs
            signal = np.fft.irfft(spectrum, n)
        signal = signal / (np.abs(signal).max() + 1e-9) * 0.5
        path = out / 'synthetic' / f'{kind}-{index:02d}.wav'
        write_wav(path, signal.astype(np.float32))
        entries.append({'path': str(path), 'kind': 'fan', 'split': 'test' if index >= 9 else 'train', 'license': 'synthetic'})
    for index in range(12):
        signal = np.zeros(n)
        if index % 2 == 0:
            # 타자 소리: 초당 3~8번 짧은 딸깍(3~8 ms 감쇠 잡음, 고역), 가끔 세 배 긴 스페이스바
            kind, rate, at = 'keyboard', rng.uniform(3, 8), 0.0
            while at < seconds - 0.1:
                length = int(rng.uniform(0.003, 0.008) * SAMPLE_RATE) * (3 if rng.random() < 0.1 else 1)
                burst = np.diff(rng.standard_normal(length + 1)) * np.exp(-np.arange(length) / (length / 4)) * rng.uniform(0.3, 1.0)
                start = int(at * SAMPLE_RATE)
                signal[start : start + length] += burst
                at += rng.exponential(1 / rate)
        else:
            # 기침 같은 소리: 0.2~0.5초 비주기 잡음 폭발, 400~1500 Hz 공명
            kind = 'cough-laugh'
            for at in np.sort(rng.uniform(0, seconds - 1, size=int(rng.integers(8, 20)))):
                length = int(rng.uniform(0.2, 0.5) * SAMPLE_RATE)
                envelope = np.minimum(1, np.arange(length) / 160) * np.exp(-np.arange(length) / (length / 3))
                spectrum = np.fft.rfft(rng.standard_normal(length) * envelope)
                freqs = np.fft.rfftfreq(length, 1 / SAMPLE_RATE)
                spectrum *= 1 / (1 + ((freqs - rng.uniform(400, 1500)) / 400) ** 2)
                start = int(at * SAMPLE_RATE)
                signal[start : start + length] += np.fft.irfft(spectrum, length)
        signal = signal / (np.abs(signal).max() + 1e-9) * 0.5
        path = out / 'synthetic' / f'{kind}-{index:02d}.wav'
        write_wav(path, signal.astype(np.float32))
        entries.append({'path': str(path), 'kind': kind, 'split': 'test' if index >= 10 else 'train', 'license': 'synthetic'})
    return entries


def build_tts(out):
    entries = []
    texts = [(f's{index:02d}', text) for index, text in enumerate(TTS_SENTENCES)] + [(f'b{index:02d}', text) for index, text in enumerate(TTS_BACKCHANNELS)]
    for voice in TTS_VOICES:
        for text_id, text in texts:
            path = out / 'tts' / voice / f'{text_id}.wav'
            if not path.exists():
                path.parent.mkdir(parents=True, exist_ok=True)
                subprocess.run(['say', '-v', f'{voice} (한국어(한국))', '-o', str(path), '--data-format=LEI16@16000', text], check=True)
            entries.append({'voice': voice, 'path': str(path), 'textId': text_id, 'backchannel': text_id.startswith('b')})
    return entries


def summary(inventory):
    splits = {}
    for entry in inventory['speakers'].values():
        splits[entry['split']] = splits.get(entry['split'], 0) + 1
    kinds = {}
    for entry in inventory['noises']:
        key = f"{entry['kind']}/{entry['split']}"
        kinds[key] = kinds.get(key, 0) + 1
    hours = sum(u['ms'] for s in inventory['speakers'].values() for u in s['utterances']) / 3_600_000
    print(f"speakers={len(inventory['speakers'])} splits={json.dumps(splits, sort_keys=True)} speech_hours={hours:.1f}")
    print(f"noises={json.dumps(dict(sorted(kinds.items())))}")
    print(f"excluded_nc={inventory['excludedNc']} room_dropped={inventory['roomDropped']} tts={len(inventory['tts'])}")
    by_split = {}
    for speaker, entry in inventory['speakers'].items():
        by_split.setdefault(entry['split'], set()).add(speaker)
    names = list(by_split)
    overlap = sum(len(by_split[a] & by_split[b]) for i, a in enumerate(names) for b in names[i + 1 :])
    print(f'split_overlap={overlap}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--summary', action='store_true')
    args = parser.parse_args()
    root = data_dir()
    path = root / 'inventory.json'
    if args.summary:
        summary(json.loads(path.read_text()))
        return
    src, out = root / 'src', root / 'audio'
    speakers = build_zeroth(src, out)
    musan, excluded = build_musan(src)
    room, dropped = build_room(src, out)
    inventory = {
        'speakers': speakers,
        'noises': musan + room + build_synthetic(out),
        'tts': build_tts(out),
        'excludedNc': excluded,
        'roomDropped': dropped,
    }
    path.write_text(json.dumps(inventory))
    summary(inventory)


if __name__ == '__main__':
    sys.exit(main())