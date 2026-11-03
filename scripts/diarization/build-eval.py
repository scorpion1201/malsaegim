"""고정 평가셋 — 범주마다 고정 시드로 장면을 만들어 $DATA/<out>/<category>/<n>.{wav,labels.bin,json} 로 저장한다.

labels.bin = [speech T][overlap T][activity K×T] (uint8), json = meta + frames + activityRows. node 평가 도구(lib.mjs)가 읽는다.
    python -I -B scripts/diarization/build-eval.py --split test --per-category 50 --out eval
    python -I -B scripts/diarization/build-eval.py --split val --per-category 20 --out val
"""
import argparse
import hashlib
import json
import os
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import soundfile

sys.path.insert(0, str(Path(__file__).parent))
from scenes import CATEGORIES, EVAL_ONLY, SAMPLE_RATE, make_scene  # noqa: E402


def seed_of(split, category, index):
    return int(hashlib.sha256(f'{split}:{category}:{index}'.encode()).hexdigest()[:8], 16)


def build_one(job):
    out, split, category, index = job
    base = out / category / f'{index:03d}'
    if base.with_suffix('.json').exists():
        return category
    scene = make_scene(category, 'test' if category in EVAL_ONLY else split, np.random.default_rng(seed_of(split, category, index)))
    base.parent.mkdir(parents=True, exist_ok=True)
    soundfile.write(base.with_suffix('.wav'), scene['pcm'], SAMPLE_RATE, subtype='PCM_16')
    frames = len(scene['speech'])
    rows = scene['activity'].reshape(-1, frames) if scene['activity'].size else np.zeros((0, frames), dtype=np.uint8)
    np.concatenate([scene['speech'], scene['overlap'], rows.ravel()]).astype(np.uint8).tofile(f'{base}.labels.bin')
    base.with_suffix('.json').write_text(json.dumps({**scene['meta'], 'frames': frames, 'activityRows': int(rows.shape[0])}))
    return category


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--split', choices=['val', 'test'], required=True)
    parser.add_argument('--per-category', type=int, required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) - 2))
    args = parser.parse_args()
    out = Path(os.environ.get('DATA', '/Users/lucian/orca/data/malsaegim-diar')) / args.out
    categories = [c for c in CATEGORIES if args.split == 'test' or c not in EVAL_ONLY]
    jobs = [(out, args.split, category, index) for category in categories for index in range(args.per_category)]
    done = {}
    with ProcessPoolExecutor(args.workers) as pool:
        for category in pool.map(build_one, jobs, chunksize=2):
            done[category] = done.get(category, 0) + 1
            if done[category] == args.per_category:
                print(f'{category} {done[category]}', flush=True)
    print(f'scenes={sum(done.values())} categories={len(done)}')


if __name__ == '__main__':
    main()