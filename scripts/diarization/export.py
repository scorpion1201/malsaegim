"""ONNX 내보내기 — 입력 logmel (1, T, 80), 출력 probs (1, T, 2) 시그모이드 포함, opset 17, T 동적.
    python -I -B scripts/diarization/export.py --ckpt $DATA/ckpt/best.pt --check
--check: 파일 크기 < 1 MB, onnxruntime 와 PyTorch 최대 차이 < 1e-4 (무작위 입력, val 장면 3개)
"""
import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

import numpy as np
import onnxruntime
import torch

sys.path.insert(0, str(Path(__file__).parent))
from model import Exported, SpeechNet  # noqa: E402
from train import validation_scenes  # noqa: E402

DATA = Path(os.environ.get('DATA', '/Users/lucian/orca/data/malsaegim-diar'))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ckpt', required=True)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    net = SpeechNet()
    net.load_state_dict(torch.load(args.ckpt, map_location='cpu'))
    model = Exported(net).eval()
    out = DATA / 'export' / 'speech-crnn.onnx'
    out.parent.mkdir(exist_ok=True)
    torch.onnx.export(
        model,
        (torch.randn(1, 1200, 80),),
        out,
        input_names=['logmel'],
        output_names=['probs'],
        dynamic_axes={'logmel': {1: 'frames'}, 'probs': {1: 'frames'}},
        opset_version=17,
        dynamo=False,
    )
    sha = hashlib.sha256(out.read_bytes()).hexdigest()
    meta_path = DATA / 'export' / 'speech-crnn.json'
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    meta.update({'sha256': sha, 'bytes': out.stat().st_size})
    meta_path.write_text(json.dumps(meta))
    print(f'bytes={out.stat().st_size} sha256={sha}')
    if not args.check:
        return
    session = onnxruntime.InferenceSession(str(out))
    inputs = [np.random.default_rng(0).standard_normal((1, frames, 80)).astype(np.float32) * 4 for frames in (37, 1200, 3001)]
    inputs += [mel[None, :1200] for _, mel, _ in validation_scenes()[:3]]
    worst = 0.0
    with torch.no_grad():
        for x in inputs:
            ours = model(torch.from_numpy(x)).numpy()
            theirs = session.run(['probs'], {'logmel': x})[0]
            worst = max(worst, float(np.abs(ours - theirs).max()))
    ok = out.stat().st_size < 1_048_576 and worst < 1e-4
    print(f'max_abs_diff={worst:.2e} size_ok={out.stat().st_size < 1_048_576} {"ok" if ok else "FAIL"}')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()