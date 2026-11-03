"""말소리/겹침 분류 모델 학습 (PyTorch, MPS).

장면을 매번 만들면 앱 음량 보정(node)을 부르느라 느려서, 학습 장면은 미리 만들어 log-mel(float16)과 라벨만 캐시한다(오디오는 저장하지 않는다).
    python -I -B scripts/diarization/train.py cache --scenes 6000       # $DATA/cache/train-*.npz
    python -I -B scripts/diarization/train.py fit --smoke               # 1,000 스텝
    python -I -B scripts/diarization/train.py fit                       # 본 학습, val 기준 조기 종료
"""
import argparse
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import torch
from torch import nn

sys.path.insert(0, str(Path(__file__).parent))
from features import log_mel  # noqa: E402
from model import SpeechNet  # noqa: E402

DATA = Path(os.environ.get('DATA', '/Users/lucian/orca/data/malsaegim-diar'))
CROP_FRAMES = 800
BATCH = 32
STEPS_PER_EPOCH = 1000
PATIENCE = 5
MAX_EPOCHS = 40
NON_SPEECH = {'empty-room', 'fan', 'keyboard', 'music'}


def _cache_one(index):
    from scenes import CATEGORIES, EVAL_ONLY, make_scene

    path = DATA / 'cache' / f'train-{index:05d}.npz'
    if path.exists():
        return
    categories = [c for c in CATEGORIES if c not in EVAL_ONLY]
    rng = np.random.default_rng(100_000 + index)
    scene = make_scene(categories[index % len(categories)], 'train', rng)
    mel = log_mel(scene['pcm']).astype(np.float16)
    np.savez(path, mel=mel, speech=scene['speech'], overlap=scene['overlap'])


def build_cache(count, workers):
    (DATA / 'cache').mkdir(parents=True, exist_ok=True)
    started = time.time()
    with ProcessPoolExecutor(workers) as pool:
        for done, _ in enumerate(pool.map(_cache_one, range(count), chunksize=4), 1):
            if done % 200 == 0:
                print(f'cache {done}/{count} {time.time() - started:.0f}s', flush=True)
    print(f'cache done {count}')


class Crops:
    """캐시에서 8초 구간을 무작위로 뽑는다. 음량 증강은 장면 생성 때 이미 들어갔다"""

    def __init__(self, rng):
        self.paths = sorted((DATA / 'cache').glob('train-*.npz'))
        self.rng = rng
        self.cache = {}

    def scene(self, path):
        if path not in self.cache:
            if len(self.cache) > 1500:
                self.cache.pop(next(iter(self.cache)))
            data = np.load(path)
            self.cache[path] = (data['mel'], data['speech'], data['overlap'])
        return self.cache[path]

    def batch(self):
        mels, labels = [], []
        for _ in range(BATCH):
            mel, speech, overlap = self.scene(self.paths[int(self.rng.integers(len(self.paths)))])
            start = int(self.rng.integers(0, max(1, len(mel) - CROP_FRAMES)))
            m = mel[start : start + CROP_FRAMES].astype(np.float32)
            y = np.stack([speech[start : start + CROP_FRAMES], overlap[start : start + CROP_FRAMES]], axis=1).astype(np.float32)
            if len(m) < CROP_FRAMES:
                pad = CROP_FRAMES - len(m)
                m = np.pad(m, ((0, pad), (0, 0)), mode='edge')
                y = np.pad(y, ((0, pad), (0, 0)))
            mels.append(m)
            labels.append(y)
        return torch.from_numpy(np.stack(mels)), torch.from_numpy(np.stack(labels))


def validation_scenes():
    """build-eval.py --split val 결과 — (범주, log-mel, speech) 목록"""
    import soundfile

    scenes = []
    for meta_path in sorted((DATA / 'val').glob('*/*.json')):
        meta = json.loads(meta_path.read_text())
        pcm, _ = soundfile.read(meta_path.with_suffix('.wav'), dtype='int16')
        labels = np.fromfile(f'{meta_path.with_suffix("")}.labels.bin', dtype=np.uint8)
        scenes.append((meta['category'], log_mel(pcm), labels[: meta['frames']]))
    return scenes


@torch.no_grad()
def validate(net, scenes):
    """범주별 (오탐 + 놓침) 평균, 문턱 0.5 — 체크포인트 고르기용. 긴 장면의 GRU 는 MPS 보다 CPU 가 열 배 빨라 CPU 복사본으로 잰다"""
    copy = SpeechNet()
    copy.load_state_dict({key: value.cpu() for key, value in net.state_dict().items()})
    copy.eval()
    per_category = {}
    for category, mel, speech in scenes:
        probs = torch.sigmoid(copy(torch.from_numpy(mel).unsqueeze(0)))[0, :, 0].numpy()
        hyp = probs >= 0.5
        ref = speech.astype(bool)[: len(hyp)]
        fa = (hyp & ~ref).sum() / max(1, (~ref).sum())
        miss = (~hyp & ref).sum() / max(1, ref.sum()) if ref.any() else 0.0
        per_category.setdefault(category, []).append(fa + miss)
    means = {category: float(np.mean(values)) for category, values in per_category.items()}
    return float(np.mean(list(means.values()))), means


def fit(smoke):
    device = torch.device('mps' if torch.backends.mps.is_available() else 'cpu')
    torch.manual_seed(1103)
    net = SpeechNet().to(device)
    crops = Crops(np.random.default_rng(1103))
    sample = [crops.batch()[1] for _ in range(20)]
    overlap_rate = float(torch.cat(sample)[..., 1].mean())
    pos_weight = torch.tensor([1.0, min(20.0, (1 - overlap_rate) / max(overlap_rate, 1e-4))], device=device)
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
    optimizer = torch.optim.AdamW(net.parameters(), lr=1e-3, weight_decay=1e-4)
    scenes = validation_scenes()
    (DATA / 'ckpt').mkdir(exist_ok=True)
    print(f'device={device} overlap_rate={overlap_rate:.4f} overlap_pos_weight={float(pos_weight[1]):.1f} val_scenes={len(scenes)}', flush=True)
    best, stale = float('inf'), 0
    epochs = 1 if smoke else MAX_EPOCHS
    for epoch in range(1, epochs + 1):
        started, total = time.time(), 0.0
        for step in range(STEPS_PER_EPOCH):
            mel, target = crops.batch()
            loss = loss_fn(net(mel.to(device)), target.to(device))
            optimizer.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(net.parameters(), 5.0)
            optimizer.step()
            total += float(loss)
            if smoke and step % 200 == 199:
                print(f'step {step + 1} loss {total / (step + 1):.4f}', flush=True)
        score, means = validate(net, scenes)
        torch.save(net.state_dict(), DATA / 'ckpt' / f'epoch-{epoch:02d}.pt')
        improved = score < best
        if improved:
            best, stale = score, 0
            torch.save(net.state_dict(), DATA / 'ckpt' / 'best.pt')
        else:
            stale += 1
        worst = max(means, key=means.get)
        print(f'epoch {epoch} loss {total / STEPS_PER_EPOCH:.4f} val {score:.4f} worst {worst}={means[worst]:.3f} {"*" if improved else ""} {time.time() - started:.0f}s', flush=True)
        if stale >= PATIENCE:
            break
    print(f'best val {best:.4f}')


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    cache = sub.add_parser('cache')
    cache.add_argument('--scenes', type=int, default=6000)
    cache.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) - 2))
    run = sub.add_parser('fit')
    run.add_argument('--smoke', action='store_true')
    args = parser.parse_args()
    if args.command == 'cache':
        build_cache(args.scenes, args.workers)
    else:
        fit(args.smoke)


if __name__ == '__main__':
    main()