"""앱 fbank.ts 와 같은 80차 log-mel — Kaldi 방식(25 ms 창, 10 ms 간격, povey 창, 프리엠퍼시스 0.97, 512 FFT, 20 Hz~8 kHz).

학습 입력이 앱 추론 입력과 같아야 하므로 fbank.ts 의 계산 순서를 그대로 옮긴다.
    python -I scripts/diarization/features.py --compare in.wav ts.f32   # TS 결과와 최대 차이 출력
"""
import argparse
import sys

import numpy as np
import soundfile

SAMPLE_RATE = 16000
FRAME_SAMPLES = 400
HOP_SAMPLES = 160
FFT_SIZE = 512
MEL_BINS = 80
LOW_HZ = 20.0
HIGH_HZ = SAMPLE_RATE / 2
PREEMPHASIS = 0.97
ENERGY_FLOOR = 1.19e-7


def _hz_to_mel(hz):
    return 1127.0 * np.log(1.0 + hz / 700.0)


def _mel_matrix():
    """(FFT_SIZE/2 + 1, MEL_BINS) 삼각 필터 — 경계는 fbank.ts 처럼 열린 구간이다"""
    low = _hz_to_mel(LOW_HZ)
    step = (_hz_to_mel(HIGH_HZ) - low) / (MEL_BINS + 1)
    bins = np.arange(FFT_SIZE // 2 + 1)
    mel = _hz_to_mel(bins * SAMPLE_RATE / FFT_SIZE)
    matrix = np.zeros((bins.size, MEL_BINS))
    for index in range(MEL_BINS):
        left = low + step * index
        center = left + step
        right = center + step
        inside = (mel > left) & (mel < right)
        rising = np.where(mel <= center, (mel - left) / step, (right - mel) / step)
        matrix[inside, index] = rising[inside]
    return matrix


_WINDOW = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(FRAME_SAMPLES) / (FRAME_SAMPLES - 1))) ** 0.85
_MEL = _mel_matrix()


def frame_count(samples):
    return max(0, (samples - FRAME_SAMPLES) // HOP_SAMPLES + 1)


def log_mel(pcm):
    """int16 PCM → (frames, 80) float32, 평균 빼기 없음"""
    frames = frame_count(len(pcm))
    if frames == 0:
        return np.zeros((0, MEL_BINS), dtype=np.float32)
    index = np.arange(FRAME_SAMPLES)[None, :] + HOP_SAMPLES * np.arange(frames)[:, None]
    frame = pcm.astype(np.float64)[index]
    frame -= frame.mean(axis=1, keepdims=True)
    emphasized = frame.copy()
    emphasized[:, 1:] -= PREEMPHASIS * frame[:, :-1]
    emphasized[:, 0] -= PREEMPHASIS * frame[:, 0]
    spectrum = np.fft.rfft(emphasized * _WINDOW, n=FFT_SIZE)
    power = spectrum.real**2 + spectrum.imag**2
    return np.log(np.maximum(power @ _MEL, ENERGY_FLOOR)).astype(np.float32)


def window_features(mel, start_frame, frames):
    """화자 임베딩 창 — 시간축 평균을 뺀다 (fbank.ts createFbank 와 같음)"""
    window = mel[start_frame : start_frame + frames]
    return window - window.mean(axis=0, keepdims=True)


def read_pcm16(path):
    pcm, rate = soundfile.read(path, dtype='int16')
    if rate != SAMPLE_RATE or pcm.ndim != 1:
        raise SystemExit(f'16 kHz 모노가 아닙니다: {path}')
    return pcm


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--compare', nargs=2, metavar=('WAV', 'F32'))
    args = parser.parse_args()
    if args.compare:
        wav, raw = args.compare
        ours = log_mel(read_pcm16(wav))
        theirs = np.fromfile(raw, dtype=np.float32).reshape(-1, MEL_BINS)
        if ours.shape != theirs.shape:
            print(f'shape mismatch {ours.shape} {theirs.shape}')
            sys.exit(1)
        diff = float(np.abs(ours - theirs).max())
        print(f'frames={ours.shape[0]} max_abs_diff={diff:.2e}')
        sys.exit(0 if diff < 1e-4 else 1)


if __name__ == '__main__':
    main()