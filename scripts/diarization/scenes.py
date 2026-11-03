"""실패 사례 장면 생성기 — 대본(누가, 언제, 얼마나)을 무작위로 만들고 화자 음성·잡음·울림을 섞어 앱 음량 보정까지 통과시킨다.

라벨은 log-mel 프레임(10 ms, 400 샘플 창의 가운데)마다:
  speech   사람이 앞에서 말함 (노래·기침·웃음·TV 말소리는 0)
  overlap  두 명 이상 동시에 말함
  activity 화자별 말함 여부 (K × frames)
    python -I scripts/diarization/scenes.py --check 200   # 범주별 불변식 확인, 숫자만 출력
"""
import argparse
import functools
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile

sys.path.insert(0, str(Path(__file__).parent))
import rir  # noqa: E402
from features import FRAME_SAMPLES, HOP_SAMPLES, frame_count  # noqa: E402

SAMPLE_RATE = 16000
ROOT = Path(__file__).resolve().parents[2]
CATEGORIES = [
    'one-pause', 'short-tail', 'backchannel', 'n2', 'n3', 'n4', 'n5', 'n6', 'dominant', 'interrupt-cut',
    'interrupt-overlap', 'overlap-start', 'similar-voice', 'far', 'empty-room', 'fan', 'keyboard', 'cough-laugh',
    'music', 'level-jump', 'tts', 'tv',
]
EVAL_ONLY = {'tts', 'tv'}
NON_SPEECH = {'empty-room', 'fan', 'keyboard', 'music'}
SINGLE = {'one-pause', 'short-tail', 'backchannel'}
SPEAKER_COUNT = {'n2': 2, 'n3': 3, 'n4': 4, 'n5': 5, 'n6': 6}
ACTIVE_BELOW_PEAK_DB = 35
FILL_GAP_FRAMES = 20


@functools.lru_cache(maxsize=1)
def inventory():
    return json.loads((Path(os.environ.get('DATA', '/Users/lucian/orca/data/malsaegim-diar')) / 'inventory.json').read_text())


@functools.lru_cache(maxsize=4096)
def load(path):
    samples, rate = soundfile.read(path, dtype='float32')
    assert rate == SAMPLE_RATE, path
    return samples if samples.ndim == 1 else samples.mean(axis=1)


@functools.lru_cache(maxsize=64)
def rir_bank(split):
    """미리 만든 RIR 묶음 — 학습 중 매번 계산하지 않는다. 가까운 120개, 먼 40개"""
    bank_path = Path(os.environ.get('DATA', '/Users/lucian/orca/data/malsaegim-diar')) / f'rir-{split}.npz'
    if not bank_path.exists():
        rng = np.random.default_rng({'train': 1, 'val': 2, 'test': 3}[split])
        near = [rir.random_ir(rng) for _ in range(120)]
        far = [rir.random_ir(rng, far=True) for _ in range(40)]
        np.savez(bank_path, *near, *far, near_count=len(near))
    bank = np.load(bank_path)
    count = int(bank['near_count'])
    arrays = [bank[f'arr_{i}'] for i in range(len(bank.files) - 1)]
    return arrays[:count], arrays[count:]


def trim(samples):
    """앞뒤 무음을 자른다 (최대 대비 -40 dB)"""
    energy = np.convolve(samples * samples, np.ones(160) / 160, mode='same')
    loud = np.nonzero(energy > energy.max() * 1e-4)[0]
    return samples[loud[0] : loud[-1] + 1] if loud.size else samples[:0]


def activity_of(samples):
    """10 ms 프레임별 말함 여부 — 최대 대비 35 dB 안, 200 ms 미만 틈은 메운다"""
    frames = len(samples) // HOP_SAMPLES
    if frames == 0:
        return np.zeros(0, dtype=bool)
    power = (samples[: frames * HOP_SAMPLES].reshape(frames, HOP_SAMPLES) ** 2).mean(axis=1)
    active = power > power.max() * 10 ** (-ACTIVE_BELOW_PEAK_DB / 10)
    on = np.nonzero(active)[0]
    for a, b in zip(on[:-1], on[1:]):
        if 1 < b - a <= FILL_GAP_FRAMES:
            active[a:b] = True
    return active


def db_to_gain(db):
    return 10 ** (db / 20)


def rms_db(samples):
    return 20 * np.log10(np.sqrt(np.mean(samples * samples)) + 1e-12)


class Builder:
    """장면 한 개 — 샘플 단위 버퍼에 소리를 놓고, 화자별 활동을 10 ms 단위로 기록한다"""

    def __init__(self, seconds, speakers):
        self.audio = np.zeros(int(seconds * SAMPLE_RATE), dtype=np.float64)
        self.activity = np.zeros((speakers, len(self.audio) // HOP_SAMPLES + 1), dtype=bool)
        self.interrupts = []

    def place(self, samples, start, speaker=None, gain=1.0):
        end = min(len(self.audio), start + len(samples))
        if end <= start:
            return start
        self.audio[start:end] += samples[: end - start] * gain
        if speaker is not None:
            active = activity_of(samples[: end - start])
            first = start // HOP_SAMPLES
            self.activity[speaker, first : first + len(active)] |= active
        return end


def pick_speakers(split, count, rng, similar=False):
    pool = [s for s, e in inventory()['speakers'].items() if e['split'] == split]
    if similar:
        pool.sort(key=lambda s: inventory()['speakers'][s]['pitchHz'])
        start = int(rng.integers(0, max(1, len(pool) - count)))
        window = pool[start : start + count]
        if inventory()['speakers'][window[-1]]['pitchHz'] - inventory()['speakers'][window[0]]['pitchHz'] <= 20:
            return window
    return list(rng.choice(pool, size=count, replace=False))


def utterance(speaker, rng, max_s=None):
    entries = inventory()['speakers'][speaker]['utterances']
    samples = trim(load(entries[int(rng.integers(len(entries)))]['path']))
    if max_s is not None and len(samples) > max_s * SAMPLE_RATE:
        start = int(rng.integers(0, len(samples) - int(max_s * SAMPLE_RATE)))
        samples = samples[start : start + int(max_s * SAMPLE_RATE)]
    return samples


def fragment(speaker, rng):
    """맞장구처럼 짧은 말 — 문장에서 0.3~0.9초를 떼어 낸다"""
    samples = utterance(speaker, rng)
    length = int(rng.uniform(0.3, 0.9) * SAMPLE_RATE)
    if len(samples) <= length:
        return samples
    start = int(rng.integers(0, len(samples) - length))
    piece = samples[start : start + length].copy()
    fade = min(800, length // 4)
    piece[:fade] *= np.linspace(0, 1, fade)
    piece[-fade:] *= np.linspace(1, 0, fade)
    return piece


def noise_clip(kinds, split, seconds, rng):
    pool = [n for n in inventory()['noises'] if n['kind'] in kinds and n['split'] == ('test' if split == 'test' else 'train')]
    samples = load(pool[int(rng.integers(len(pool)))]['path'])
    need = int(seconds * SAMPLE_RATE)
    if len(samples) < need:
        samples = np.tile(samples, need // max(1, len(samples)) + 1)
    start = int(rng.integers(0, len(samples) - need + 1))
    return samples[start : start + need]


def reverb(samples, rng, split, far=False):
    near, distant = rir_bank(split)
    bank = distant if far else near
    ir = bank[int(rng.integers(len(bank)))]
    size = 1 << int(np.ceil(np.log2(len(samples) + len(ir))))
    wet = np.fft.irfft(np.fft.rfft(samples, size) * np.fft.rfft(ir, size), size)
    return wet[: len(samples) + len(ir) // 2]


def conversation(builder, voices, rng, start_s, end_s, turn_weights=None, pause=(0.2, 3.0), long_pause_p=0.1):
    """화자가 번갈아 말한다. 처음에는 모두 한 번씩 말하고, turn_weights 로 한 사람이 많이 말하게 할 수 있다"""
    at = int(start_s * SAMPLE_RATE)
    last = None
    first_round = [int(i) for i in rng.permutation(len(voices))]
    while at < end_s * SAMPLE_RATE or first_round:
        weights = np.array(turn_weights if turn_weights is not None else [1.0] * len(voices), dtype=float)
        if last is not None and len(voices) > 1 and turn_weights is None:
            weights[last] = 0.3
        speaker = first_round.pop() if first_round else int(rng.choice(len(voices), p=weights / weights.sum()))
        samples = voices[speaker](rng)
        at = builder.place(samples, at, speaker)
        gap = rng.uniform(5, 20) if rng.random() < long_pause_p else rng.uniform(*pause)
        at += int(gap * SAMPLE_RATE)
        last = speaker
    return at


def interrupt(builder, voices, rng, start_s, end_s, cut):
    """B 가 A 의 말 중간에 끼어든다 — cut 이면 A 가 0.2~1초 안에 끊기고, 아니면 0.3~2초 겹친다"""
    at = int(start_s * SAMPLE_RATE)
    while at < end_s * SAMPLE_RATE:
        a, b = rng.choice(len(voices), size=2, replace=False)
        first = voices[a](rng)
        split_at = int(len(first) * rng.uniform(0.35, 0.75))
        if cut:
            stop = split_at + int(rng.uniform(0.2, 1.0) * SAMPLE_RATE)
            first = first[:stop].copy()
            fade = min(1600, len(first) // 4)
            first[-fade:] *= np.linspace(1, 0, fade)
        else:
            split_at = max(0, len(first) - int(rng.uniform(0.3, 2.0) * SAMPLE_RATE))
        builder.place(first, at, int(a))
        builder.interrupts.append((at + split_at) / SAMPLE_RATE)
        second_end = builder.place(voices[b](rng), at + split_at, int(b))
        at = max(at + len(first), second_end) + int(rng.uniform(0.5, 3.0) * SAMPLE_RATE)
        at = conversation(builder, voices, rng, at / SAMPLE_RATE, at / SAMPLE_RATE + rng.uniform(3, 10))


def zeroth_voice(speaker, gain_db, rng, split, far=False, dry=False):
    def say(r):
        samples = utterance(speaker, r)
        if not dry:
            samples = reverb(samples, r, split, far)
        return samples / (np.sqrt(np.mean(samples * samples)) + 1e-9) * db_to_gain(gain_db)

    return say


def tts_voice(voice, gain_db, split):
    entries = [t for t in inventory()['tts'] if t['voice'] == voice and not t['backchannel']]

    def say(r):
        samples = reverb(trim(load(entries[int(r.integers(len(entries)))]['path'])), r, split)
        return samples / (np.sqrt(np.mean(samples * samples)) + 1e-9) * db_to_gain(gain_db)

    return say


@functools.lru_cache(maxsize=1)
def normalizer_command():
    return ['node', '--import', str(ROOT / 'scripts/diarization/ts-loader.mjs'), str(ROOT / 'scripts/diarization/normalize.mjs')]


def app_normalize(audio):
    """앱 levelNormalizer 를 그대로 통과 — 녹음 저장과 같은 상태가 된다"""
    clipped = np.clip(audio, -1, 1)
    pcm = np.where(clipped < 0, np.round(clipped * 0x8000), np.round(clipped * 0x7FFF)).astype('<i2')
    result = subprocess.run(normalizer_command(), input=pcm.tobytes(), capture_output=True, check=True, cwd=ROOT)
    return np.frombuffer(result.stdout, dtype='<i2').copy()


def make_scene(category, split, rng):
    """장면 하나 — { pcm int16, speech, overlap uint8 (frames), activity uint8 (K × frames), meta }"""
    seconds = float(rng.uniform(30, 180)) if split != 'train' else float(rng.uniform(20, 60))
    base_db = float(rng.uniform(-38, -18))
    count = SPEAKER_COUNT.get(category, 1 if category in SINGLE else 0 if category in NON_SPEECH else int(rng.integers(2, 4)))
    speakers = pick_speakers(split if split != 'test' else 'test', count, rng, similar=category == 'similar-voice') if count and category != 'tts' else []
    gains = [base_db + float(rng.uniform(-6, 6)) for _ in range(max(count, 1))]
    if category == 'tts':
        names = list(rng.choice([v for v in {t['voice'] for t in inventory()['tts']}], size=count, replace=False))
        voices = [tts_voice(name, gains[i], split) for i, name in enumerate(names)]
    else:
        far_index = 0 if category == 'far' else -1
        voices = [zeroth_voice(s, gains[i] - (20 if i == far_index else 0), rng, split, far=i == far_index) for i, s in enumerate(speakers)]
    lead = float(rng.uniform(0, 10))
    tail = float(rng.uniform(0, 10))
    # 모두가 한 번씩 말할 시간 — 한 사람 차례는 길면 15초 가까이 된다
    seconds = max(seconds, lead + tail + 15 * count + 10)
    builder = Builder(seconds, max(count, 1))

    if category == 'one-pause':
        conversation(builder, voices, rng, lead, seconds - tail, pause=(1.0, 20.0), long_pause_p=0.5)
    elif category == 'short-tail':
        end = conversation(builder, voices, rng, lead, seconds * 0.6)
        short = trim(voices[0](rng))[: int(rng.uniform(0.6, 1.9) * SAMPLE_RATE)]
        tail_start = min(len(builder.audio) - len(short) - int(3 * SAMPLE_RATE), end + int(rng.uniform(5, 20) * SAMPLE_RATE))
        builder.place(short, max(end, tail_start), 0)
    elif category == 'backchannel':
        at = int(lead * SAMPLE_RATE)
        while at < (seconds - tail) * SAMPLE_RATE:
            short = rng.random() < 0.5
            piece = fragment(speakers[0], rng) if short else voices[0](rng)
            piece = piece / (np.sqrt(np.mean(piece * piece)) + 1e-9) * db_to_gain(gains[0])
            at = builder.place(piece, at, 0) + int(rng.uniform(0.3, 4.0) * SAMPLE_RATE)
    elif category == 'dominant':
        conversation(builder, voices, rng, lead, seconds - tail, turn_weights=[0.9] + [0.1 / (count - 1)] * (count - 1))
    elif category in ('interrupt-cut', 'interrupt-overlap'):
        interrupt(builder, voices, rng, lead, seconds - tail, cut=category == 'interrupt-cut')
    elif category == 'overlap-start':
        at = int(lead * SAMPLE_RATE)
        while at < (seconds - tail) * SAMPLE_RATE:
            a, b = rng.choice(count, size=2, replace=False)
            end_a = builder.place(voices[a](rng), at, int(a))
            offset = int(rng.uniform(0, 0.3) * SAMPLE_RATE)
            builder.interrupts.append((at + offset) / SAMPLE_RATE)
            end_b = builder.place(voices[b](rng), at + offset, int(b))
            at = conversation(builder, voices, rng, max(end_a, end_b) / SAMPLE_RATE + 0.5, max(end_a, end_b) / SAMPLE_RATE + rng.uniform(4, 12))
    elif category == 'level-jump':
        conversation(builder, voices, rng, lead, seconds - tail)
        for _ in range(int(rng.integers(2, 5))):
            start = int(rng.uniform(0, seconds - 5) * SAMPLE_RATE)
            builder.audio[start : start + int(rng.uniform(2, 8) * SAMPLE_RATE)] *= db_to_gain(float(rng.choice([-15, 15])))
    elif count:
        conversation(builder, voices, rng, lead, seconds - tail)

    # 배경: 모든 장면에 방 바닥 잡음, 범주에 따라 잡음·음악·기침·TV 를 더한다
    floor = noise_clip({'room', 'fan'}, split, seconds, rng)
    builder.place(floor / (np.sqrt(np.mean(floor * floor)) + 1e-9), 0, gain=db_to_gain(base_db - float(rng.uniform(25, 45))))
    noise_kind = {'fan': {'fan'}, 'keyboard': {'keyboard'}, 'music': {'music'}, 'empty-room': {'room'}, 'cough-laugh': {'cough-laugh'}}.get(category)
    if noise_kind is None and split == 'train' and rng.random() < 0.6:
        noise_kind = {'noise', 'fan', 'music', 'keyboard', 'cough-laugh'}
    if noise_kind:
        snr = float(rng.uniform(-5, 30))
        if category == 'cough-laugh':
            for _ in range(int(rng.integers(3, 8))):
                event = noise_clip(noise_kind, split, rng.uniform(0.5, 2.0), rng)
                start = int(rng.uniform(0, seconds - 2) * SAMPLE_RATE)
                builder.place(event / (np.sqrt(np.mean(event * event)) + 1e-9), start, gain=db_to_gain(base_db - snr / 3))
        else:
            clip = noise_clip(noise_kind, split, seconds, rng)
            builder.place(clip / (np.sqrt(np.mean(clip * clip)) + 1e-9), 0, gain=db_to_gain(base_db - snr))
    if category == 'tv':
        tv_speaker = pick_speakers(split, 1, rng)[0]
        tv = zeroth_voice(tv_speaker, base_db - 15, rng, split, far=True)
        at = 0
        while at < len(builder.audio):
            at = builder.place(tv(rng), at) + int(rng.uniform(0.1, 1.0) * SAMPLE_RATE)

    pcm = app_normalize(builder.audio)
    frames = frame_count(len(pcm))
    centers = (np.arange(frames) * HOP_SAMPLES + FRAME_SAMPLES // 2) // HOP_SAMPLES
    activity = builder.activity[:, np.minimum(centers, builder.activity.shape[1] - 1)]
    if not count:
        activity = activity[:0]
    voiced = activity.sum(axis=0)
    return {
        'pcm': pcm,
        'speech': (voiced > 0).astype(np.uint8),
        'overlap': (voiced > 1).astype(np.uint8),
        'activity': activity.astype(np.uint8),
        'meta': {'category': category, 'speakers': count, 'seconds': round(len(pcm) / SAMPLE_RATE, 2), 'interrupts': [round(t, 3) for t in builder.interrupts]},
    }


def check(per_category):
    rng = np.random.default_rng(7)
    failures = {}
    for index in range(per_category * len(CATEGORIES)):
        category = CATEGORIES[index % len(CATEGORIES)]
        split = 'test' if category in EVAL_ONLY else ('train', 'val', 'test')[index % 3]
        scene = make_scene(category, split, rng)
        problems = []
        speakers_seen = int((scene['activity'].sum(axis=1) > 0).sum()) if scene['activity'].size else 0
        if category in SINGLE and speakers_seen != 1:
            problems.append(f'speakers={speakers_seen}')
        if category in SPEAKER_COUNT and speakers_seen != SPEAKER_COUNT[category]:
            problems.append(f'speakers={speakers_seen}')
        if category in NON_SPEECH and scene['speech'].any():
            problems.append('speech in non-speech scene')
        if category.startswith('interrupt') and not scene['meta']['interrupts']:
            problems.append('no interrupt')
        if category == 'interrupt-overlap' and not scene['overlap'].any():
            problems.append('no overlap')
        if np.abs(scene['pcm']).max() / 32768 > 0.951:
            problems.append('peak > 0.95')
        if problems:
            failures.setdefault(category, []).extend(problems)
        print(f"{index + 1}/{per_category * len(CATEGORIES)} {category} {split} s={scene['meta']['seconds']} speech={scene['speech'].mean():.2f} overlap={scene['overlap'].mean():.3f} speakers={speakers_seen} {'FAIL ' + ','.join(problems) if problems else 'ok'}", flush=True)
    print(f'violations={sum(len(v) for v in failures.values())} {json.dumps({k: len(v) for k, v in failures.items()})}')
    return 1 if failures else 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', type=int, metavar='N_TOTAL')
    args = parser.parse_args()
    if args.check:
        return check(max(1, args.check // len(CATEGORIES)))


if __name__ == '__main__':
    sys.exit(main())