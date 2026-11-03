/**
 * 스펙트럴 군집 + 정규화 고유값 간격(NME-SC, Park et al. 2019) — 화자 수를 문턱 없이 유사도 행렬에서 고른다.
 * 행마다 가장 비슷한 p 개만 남겨 이진화하고, 라플라시안 고유값 간격이 가장 뚜렷한 p 와 화자 수 k 를 함께 고른다.
 */
import { symmetricEigen } from './eigen';

/** 고유값 분해에 넣는 노드 상한 — 계산이 노드 수의 세제곱이다 (600개 ≈ 0.6초). 넘으면 이웃한 창을 평균해 줄인다 */
const MAX_NODES = 600;
/** p 후보 상한 — 노드 수의 이 비율까지 본다 */
const P_MAX_RATIO = 0.25;
const P_CANDIDATES = 12;
const KMEANS_ROUNDS = 30;

const normalizeRows = (rows: Float64Array, count: number, dim: number) => {
  for (let i = 0; i < count; i += 1) {
    let norm = 0;
    for (let k = 0; k < dim; k += 1) norm += rows[i * dim + k] ** 2;
    norm = Math.sqrt(norm) || 1;
    for (let k = 0; k < dim; k += 1) rows[i * dim + k] /= norm;
  }
};

/** 시간 순서로 이웃한 창을 group 개씩 평균해 노드를 만든다 */
const toNodes = (embeddings: Float32Array, dim: number, count: number): { nodes: Float64Array; size: number; group: number } => {
  const group = Math.ceil(count / MAX_NODES);
  const size = Math.ceil(count / group);
  const nodes = new Float64Array(size * dim);
  for (let i = 0; i < count; i += 1) {
    const node = Math.floor(i / group);
    for (let k = 0; k < dim; k += 1) nodes[node * dim + k] += embeddings[i * dim + k];
  }
  normalizeRows(nodes, size, dim);
  return { nodes, size, group };
};

const laplacianOf = (similarity: Float64Array, n: number, p: number): Float64Array => {
  const binary = new Float64Array(n * n);
  const order = Array.from({ length: n }, (_, j) => j);
  for (let i = 0; i < n; i += 1) {
    const row = similarity.subarray(i * n, (i + 1) * n);
    order.sort((a, b) => row[b] - row[a]);
    for (let r = 0; r < Math.min(p, n); r += 1) binary[i * n + order[r]] = 1;
  }
  const laplacian = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) {
    let degree = 0;
    for (let j = 0; j < n; j += 1) {
      const value = (binary[i * n + j] + binary[j * n + i]) / 2;
      laplacian[i * n + j] = -value;
      degree += value;
    }
    laplacian[i * n + i] += degree;
  }
  return laplacian;
};

/** 결정적 k-means — 첫 점에서 시작해 가장 먼 점을 차례로 중심으로 고른다 */
const kmeans = (points: Float64Array, n: number, dim: number, k: number): Int32Array => {
  const centers = new Float64Array(k * dim);
  centers.set(points.subarray(0, dim), 0);
  const nearest = new Float64Array(n).fill(Infinity);
  for (let c = 1; c < k; c += 1) {
    let far = 0;
    for (let i = 0; i < n; i += 1) {
      let distance = 0;
      for (let d = 0; d < dim; d += 1) distance += (points[i * dim + d] - centers[(c - 1) * dim + d]) ** 2;
      nearest[i] = Math.min(nearest[i], distance);
      if (nearest[i] > nearest[far]) far = i;
    }
    centers.set(points.subarray(far * dim, (far + 1) * dim), c * dim);
  }
  const labels = new Int32Array(n);
  for (let round = 0; round < KMEANS_ROUNDS; round += 1) {
    let changed = false;
    for (let i = 0; i < n; i += 1) {
      let best = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < k; c += 1) {
        let distance = 0;
        for (let d = 0; d < dim; d += 1) distance += (points[i * dim + d] - centers[c * dim + d]) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = c;
        }
      }
      if (labels[i] !== best) changed = true;
      labels[i] = best;
    }
    const sums = new Float64Array(k * dim);
    const counts = new Int32Array(k);
    for (let i = 0; i < n; i += 1) {
      counts[labels[i]] += 1;
      for (let d = 0; d < dim; d += 1) sums[labels[i] * dim + d] += points[i * dim + d];
    }
    for (let c = 0; c < k; c += 1) if (counts[c]) for (let d = 0; d < dim; d += 1) centers[c * dim + d] = sums[c * dim + d] / counts[c];
    if (!changed && round > 0) break;
  }
  return labels;
};

/**
 * 창별 화자 번호(0부터). oneSpeakerSimilarity: 노드 사이 평균 유사도가 이 값 이상이면 한 사람으로 본다 —
 * 고유값 간격은 화자가 한 명일 때 근거가 약하다
 */
export const spectralCluster = (embeddings: Float32Array, dim: number, maxSpeakers: number, oneSpeakerSimilarity: number): Int32Array => {
  const count = embeddings.length / dim;
  if (count < 3) return new Int32Array(count);
  const { nodes, size, group } = toNodes(embeddings, dim, count);
  const similarity = new Float64Array(size * size);
  let total = 0;
  for (let i = 0; i < size; i += 1) {
    for (let j = i; j < size; j += 1) {
      let dot = 0;
      for (let k = 0; k < dim; k += 1) dot += nodes[i * dim + k] * nodes[j * dim + k];
      similarity[i * size + j] = dot;
      similarity[j * size + i] = dot;
      if (j > i) total += dot;
    }
  }
  if (total / ((size * (size - 1)) / 2) >= oneSpeakerSimilarity) return new Int32Array(count);

  const pMax = Math.max(2, Math.floor(size * P_MAX_RATIO));
  const candidates = [...new Set(Array.from({ length: P_CANDIDATES }, (_, i) => Math.round(2 + ((pMax - 2) * i) / Math.max(1, P_CANDIDATES - 1))))];
  let best: { ratio: number; k: number; vectors: Float64Array } | null = null;
  for (const p of candidates) {
    const { values, vectors } = symmetricEigen(laplacianOf(similarity, size, p), size);
    // 간격은 상한의 두 배까지 본다 — 상한보다 많은 화자를 1명으로 잘못 고르지 않게. 고른 수는 상한으로 자른다
    const limit = Math.min(2 * maxSpeakers, size - 1);
    let gap = -Infinity;
    let k = 1;
    for (let i = 0; i < limit; i += 1) {
      if (values[i + 1] - values[i] > gap) {
        gap = values[i + 1] - values[i];
        k = Math.min(maxSpeakers, i + 1);
      }
    }
    const ratio = p / (gap / (values[size - 1] + 1e-10) + 1e-10);
    if (!best || ratio < best.ratio) best = { ratio, k, vectors };
  }
  if (!best || best.k === 1) return new Int32Array(count);

  const { k, vectors } = best;
  const spectral = new Float64Array(size * k);
  for (let i = 0; i < size; i += 1) for (let c = 0; c < k; c += 1) spectral[i * k + c] = vectors[i * size + c];
  normalizeRows(spectral, size, k);
  const nodeLabels = kmeans(spectral, size, k, k);
  return Int32Array.from({ length: count }, (_, i) => nodeLabels[Math.floor(i / group)]);
};