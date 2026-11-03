"""방 울림(RIR) — 직육면체 방의 이미지 방식. 새 의존성 없이 numpy 로 계산한다.

벽 반사 계수는 Sabine 식으로 rt60 에서 구한다. 거리 감쇠(1/r)와 분수 지연(sinc 창)을 넣는다.
"""
import numpy as np

SAMPLE_RATE = 16000
SPEED_OF_SOUND = 343.0
SINC_HALF = 16


def _reflection(room_m, rt60_s):
    lx, ly, lz = room_m
    volume = lx * ly * lz
    surface = 2 * (lx * ly + ly * lz + lx * lz)
    absorption = min(0.99, 0.161 * volume / (surface * rt60_s))
    return np.sqrt(1 - absorption)


def room_ir(room_m, src_m, mic_m, rt60_s, sr=SAMPLE_RATE):
    """RIR (float32, 직접음 크기 1 로 정규화). 반사는 rt60 길이까지만 더한다"""
    beta = _reflection(room_m, rt60_s)
    length = int(rt60_s * sr) + 2 * SINC_HALF
    max_order = int(np.ceil(rt60_s * SPEED_OF_SOUND / min(room_m))) + 1
    room = np.array(room_m, dtype=float)
    src = np.array(src_m, dtype=float)
    mic = np.array(mic_m, dtype=float)
    direct = np.linalg.norm(src - mic)
    orders = np.arange(-max_order, max_order + 1)
    n, p = np.meshgrid(orders, (0, 1), indexing='ij')
    n, p = n.ravel(), p.ravel()
    # 축마다 이미지 좌표와 반사 횟수를 따로 구한 뒤 세 축을 곱으로 펼친다
    coords = [(1 - 2 * p) * src[axis] + 2 * n * room[axis] - mic[axis] for axis in range(3)]
    bounces = np.abs(2 * n - p)
    dx, dy, dz = np.meshgrid(*coords, indexing='ij')
    bx, by, bz = np.meshgrid(bounces, bounces, bounces, indexing='ij')
    distance = np.sqrt(dx * dx + dy * dy + dz * dz).ravel()
    delay = distance / SPEED_OF_SOUND * sr
    keep = delay < length - SINC_HALF - 1
    delay, distance = delay[keep], distance[keep]
    gain = beta ** (bx + by + bz).ravel()[keep] * direct / np.maximum(distance, 1e-3)
    taps = np.arange(-SINC_HALF, SINC_HALF + 1)
    window = 0.5 + 0.5 * np.cos(np.pi * taps / (SINC_HALF + 1))
    center = np.floor(delay).astype(int)
    frac = delay - center
    index = center[:, None] + taps[None, :]
    values = gain[:, None] * np.sinc(taps[None, :] - frac[:, None]) * window[None, :]
    valid = index >= 0
    ir = np.zeros(length)
    np.add.at(ir, index[valid], values[valid])
    return ir.astype(np.float32)


def random_ir(rng, far=False):
    """무작위 방과 위치. far 이면 화자와 마이크 거리 2~3 m"""
    room = (rng.uniform(3, 8), rng.uniform(3, 8), rng.uniform(2.4, 3.2))
    mic = (rng.uniform(1, room[0] - 1), rng.uniform(1, room[1] - 1), rng.uniform(0.7, 1.2))
    distance = rng.uniform(2.0, 3.0) if far else rng.uniform(0.4, 1.2)
    for _ in range(50):
        angle = rng.uniform(0, 2 * np.pi)
        src = (mic[0] + distance * np.cos(angle), mic[1] + distance * np.sin(angle), rng.uniform(1.1, 1.7))
        if 0.3 < src[0] < room[0] - 0.3 and 0.3 < src[1] < room[1] - 0.3:
            return room_ir(room, src, mic, rng.uniform(0.2, 0.8))
    return room_ir(room, (room[0] / 2, room[1] / 2, 1.5), mic, 0.3)