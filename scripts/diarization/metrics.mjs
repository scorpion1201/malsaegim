// 화자 구분 지표 — 프레임은 log-mel 과 같은 10 ms (가운데 시각 = t × 10 + 12.5 ms)

const HOP_MS = 10;
const CENTER_MS = 12.5;

export const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** 말 차례와 말소리 프레임 → 프레임별 가설 화자 (말소리가 아니면 -1) */
export const hypFrames = (turns, speechFrames, frames) => {
  const out = new Int16Array(frames).fill(-1);
  let index = 0;
  for (let t = 0; t < frames; t += 1) {
    if (!speechFrames[t]) continue;
    const ms = t * HOP_MS + CENTER_MS;
    while (index < turns.length - 1 && turns[index].endMs <= ms) index += 1;
    if (turns.length && turns[index].startMs <= ms && ms < turns[index].endMs) out[t] = turns[index].speaker;
  }
  return out;
};

/** 말소리 오탐(비말소리 프레임 중)·놓침(말소리 프레임 중) 비율. 분모가 0 이면 null */
export const frameErrors = (ref, hyp) => {
  let speech = 0;
  let silence = 0;
  let falseAlarm = 0;
  let miss = 0;
  for (let t = 0; t < ref.length; t += 1) {
    if (ref[t]) {
      speech += 1;
      if (!hyp[t]) miss += 1;
    } else {
      silence += 1;
      if (hyp[t]) falseAlarm += 1;
    }
  }
  return { falseAlarm: silence ? falseAlarm / silence : null, miss: speech ? miss / speech : null };
};

/** 최대 가중 일대일 대응 (헝가리안, 정사각 행렬) — 행 i 에 대응한 열을 돌려준다 */
const assign = (weights) => {
  const n = weights.length;
  const cost = weights.map((row) => row.map((value) => -value));
  const u = new Float64Array(n + 1);
  const v = new Float64Array(n + 1);
  const p = new Int32Array(n + 1);
  const way = new Int32Array(n + 1);
  for (let i = 1; i <= n; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(n + 1).fill(Infinity);
    const used = new Uint8Array(n + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j += 1) {
        if (used[j]) continue;
        const current = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (current < minv[j]) {
          minv[j] = current;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j += 1) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const result = new Int32Array(n).fill(-1);
  for (let j = 1; j <= n; j += 1) if (p[j]) result[p[j] - 1] = j - 1;
  return result;
};

/**
 * DER = (놓침 + 오탐 + 혼동) / 정답 화자 시간. activity: 화자별 Uint8Array, hyp: 프레임별 가설 화자(-1 없음).
 * 정답 경계 앞뒤 collarFrames 는 채점하지 않는다. 정답 말소리가 없으면 null
 */
export const der = (activity, hyp, collarFrames) => {
  const frames = hyp.length;
  const scored = new Uint8Array(frames).fill(1);
  for (const row of activity) {
    for (let t = 1; t < frames; t += 1) {
      if (row[t] === row[t - 1]) continue;
      for (let k = Math.max(0, t - collarFrames); k < Math.min(frames, t + collarFrames); k += 1) scored[k] = 0;
    }
  }
  const labels = [...new Set(hyp)].filter((label) => label >= 0);
  const size = Math.max(labels.length, activity.length);
  const weights = Array.from({ length: size }, () => new Array(size).fill(0));
  for (let t = 0; t < frames; t += 1) {
    if (!scored[t] || hyp[t] < 0) continue;
    const h = labels.indexOf(hyp[t]);
    activity.forEach((row, r) => {
      if (row[t]) weights[h][r] += 1;
    });
  }
  const mapping = assign(weights);
  let total = 0;
  let errors = 0;
  for (let t = 0; t < frames; t += 1) {
    if (!scored[t]) continue;
    let refCount = 0;
    for (const row of activity) refCount += row[t];
    const hypCount = hyp[t] >= 0 ? 1 : 0;
    const mapped = hypCount ? mapping[labels.indexOf(hyp[t])] : -1;
    const correct = mapped >= 0 && mapped < activity.length && activity[mapped][t] ? 1 : 0;
    total += refCount;
    errors += Math.max(refCount, hypCount) - correct;
  }
  return total ? errors / total : null;
};

/** 끼어든 시각(초)마다 가장 가까운 가설 차례 경계까지의 거리(ms) */
export const boundaryErrorMs = (interruptsSec, turns) => {
  const boundaries = turns.slice(1).map((turn) => turn.startMs);
  return interruptsSec.map((sec) => (boundaries.length ? Math.min(...boundaries.map((ms) => Math.abs(ms - sec * 1000))) : 60_000));
};