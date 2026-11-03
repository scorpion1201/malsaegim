"""말소리 판정 문턱 고르기 — val 장면을 앱과 같은 방식(10초 조각, 앞뒤 1초 겹침)으로 추론하고 후처리 값을 격자 탐색한다.

후처리(speechClassifier.ts 와 같아야 한다): 1) 히스테리시스(꺼져 있으면 on 이상에서 켜짐, 켜져 있으면 off 미만에서 꺼짐)
2) MIN_SILENCE 프레임보다 짧은 쉼은 메운다 3) MIN_SPEECH 프레임보다 짧은 말은 지운다.
    python -I -B scripts/diarization/tune-vad.py --ckpt $DATA/ckpt/best.pt   # $DATA/export/speech-crnn.json 에 문턱 기록
"""
import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).parent))
from model import SpeechNet  # noqa: E402
from train import NON_SPEECH, validation_scenes  # noqa: E402

DATA = Path(os.environ.get('DATA', '/Users/lucian/orca/data/malsaegim-diar'))
CHUNK_FRAMES = 1000
CONTEXT_FRAMES = 100
MIN_SPEECH_FRAMES = 20
MIN_SILENCE_FRAMES = 30


def chunked_probs(run, mel):
    """앱 classifyChunks 와 같은 조각 추론 — 조각마다 앞뒤 CONTEXT_FRAMES 를 붙여 넣고 가운데만 쓴다. 끝은 반사로 채운다"""
    frames = len(mel)
    out = np.zeros((frames, 2), dtype=np.float32)
    for start in range(0, frames, CHUNK_FRAMES):
        end = min(frames, start + CHUNK_FRAMES)
        left = max(0, start - CONTEXT_FRAMES)
        right = min(frames, end + CONTEXT_FRAMES)
        piece = mel[left:right]
        need = (end - start) + 2 * CONTEXT_FRAMES - len(piece)
        if need > 0:
            piece = np.pad(piece, ((0, need), (0, 0)), mode='reflect' if len(piece) > 1 else 'edge')
        probs = run(piece)
        out[start:end] = probs[start - left : start - left + end - start]
    return out


def speech_mask(probs, on, off, min_speech=MIN_SPEECH_FRAMES, min_silence=MIN_SILENCE_FRAMES):
    active = np.zeros(len(probs), dtype=bool)
    state = False
    for t, p in enumerate(probs):
        state = p >= off if state else p >= on
        active[t] = state
    on_frames = np.flatnonzero(active)
    if on_frames.size:
        gaps = np.flatnonzero(np.diff(on_frames) > 1)
        for g in gaps:
            a, b = on_frames[g], on_frames[g + 1]
            if b - a - 1 < min_silence:
                active[a:b] = True
    edges = np.flatnonzero(np.diff(np.concatenate([[0], active.astype(np.int8), [0]])))
    for a, b in zip(edges[::2], edges[1::2]):
        if b - a < min_speech:
            active[a:b] = False
    return active


def score(results, on, off):
    per = {}
    for category, probs, ref in results:
        hyp = speech_mask(probs[:, 0], on, off)
        ref = ref.astype(bool)[: len(hyp)]
        fa = (hyp & ~ref).sum() / max(1, (~ref).sum())
        miss = (~hyp & ref).sum() / max(1, ref.sum()) if ref.any() else 0.0
        per.setdefault(category, []).append((fa, miss))
    table = {c: (float(np.mean([v[0] for v in vals])), float(np.mean([v[1] for v in vals]))) for c, vals in per.items()}
    return float(np.mean([fa + miss for fa, miss in table.values()])), table


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ckpt', required=True)
    args = parser.parse_args()
    net = SpeechNet()
    net.load_state_dict(torch.load(args.ckpt, map_location='cpu'))
    net.eval()

    @torch.no_grad()
    def run(piece):
        return torch.sigmoid(net(torch.from_numpy(piece).unsqueeze(0)))[0].numpy()

    results = [(category, chunked_probs(run, mel), speech) for category, mel, speech in validation_scenes()]
    best = None
    for on in np.arange(0.30, 0.81, 0.05):
        for off in np.arange(0.20, on + 1e-9, 0.05):
            value, table = score(results, round(float(on), 2), round(float(off), 2))
            if best is None or value < best[0]:
                best = (value, round(float(on), 2), round(float(off), 2), table)
    value, on, off, table = best
    for category, (fa, miss) in sorted(table.items()):
        print(f'{category:18s} fa={fa:.3f} miss={miss:.3f}{"  (non-speech)" if category in NON_SPEECH else ""}')
    print(f'on={on} off={off} objective={value:.4f}')
    (DATA / 'export').mkdir(exist_ok=True)
    (DATA / 'export' / 'speech-crnn.json').write_text(json.dumps({'onThreshold': on, 'offThreshold': off, 'minSpeechMs': MIN_SPEECH_FRAMES * 10, 'minSilenceMs': MIN_SILENCE_FRAMES * 10, 'ckpt': str(args.ckpt)}))


if __name__ == '__main__':
    main()