/**
 * 화자 군집화 — 창마다 뽑은 화자 임베딩(L2 정규화)을 코사인 유사도로 묶는다.
 * 사람 수를 미리 받지 않는다. 평균 연결 계층 군집을 문턱에서 자르고, 아주 작은 군집은 흩어 가까운 화자에 넣은 뒤,
 * 중심점 재배정으로 경계를 다듬는다.
 */
import { spectralCluster } from './spectralCluster';

/**
 * 묶기 방식과 값 — scripts/diarization/tune-cluster.mjs 가 검증셋에서 고른다.
 * mergeThreshold: 평균 유사도가 이 값 이상이면 같은 화자 (평균 연결)
 * balancedThreshold / balancedShare: 작은 쪽이 전체의 balancedShare 이상인 큰 두 묶음은 balancedThreshold 아래면 합치지 않는다
 * minClusterWindows: 이보다 창이 적은 묶음은 화자로 치지 않는다
 * centroidMergeSimilarity: 묶음 중심끼리 이 값 이상 비슷하면 한 화자
 * oneSpeakerSimilarity: (nme) 평균 유사도가 이 값 이상이면 한 사람
 * shortSpeechMs / shortSplitSimilarity: 말소리 총량이 shortSpeechMs 미만이면 중심 유사도가 shortSplitSimilarity 이상인 화자를 합친다
 */
export type ClusterParams = {
  method: 'ahc' | 'nme';
  mergeThreshold: number;
  balancedThreshold: number;
  balancedShare: number;
  minClusterWindows: number;
  centroidMergeSimilarity: number;
  oneSpeakerSimilarity: number;
  shortSpeechMs: number;
  shortSplitSimilarity: number;
};

export const CLUSTER_PARAMS: ClusterParams = {
  method: 'ahc',
  mergeThreshold: 0.38,
  balancedThreshold: 0.35,
  balancedShare: 0.3,
  minClusterWindows: 3,
  centroidMergeSimilarity: 0.6,
  oneSpeakerSimilarity: 1,
  shortSpeechMs: 10_000,
  shortSplitSimilarity: 1,
};

/** 화자 수 상한 — 이보다 많이 나뉘면 가장 비슷한 화자부터 합친다 */
export const MAX_SPEAKERS = 8;
/** 진단 로그에 남기는 마지막 병합 수 */
const LOGGED_MERGES = 8;
/** 전체 창에서 이 비율보다 작은 군집은 화자로 치지 않는다 (기침·물건 소리·겹친 말) */
const MIN_CLUSTER_SHARE = 0.01;
/** 중심점 재배정 횟수 */
const REFINE_ROUNDS = 5;
/** 계층 군집에 넣는 창의 상한 — 메모리가 창 수의 제곱이다 (4000개면 64 MB). 넘으면 간격을 두고 뽑고 나머지는 재배정이 맡는다 */
const MAX_CLUSTER_WINDOWS = 4000;

/** smaller: 합쳐지는 두 묶음 중 작은 쪽의 창 수 */
type Merge = { a: number; b: number; similarity: number; smaller: number };

const similarityMatrix = (embeddings: Float32Array, dim: number, picks: number[]): Float32Array => {
  const n = picks.length;
  const matrix = new Float32Array(n * n);
  for (let i = 0; i < n; i += 1) {
    const a = picks[i] * dim;
    for (let j = i; j < n; j += 1) {
      const b = picks[j] * dim;
      let sum = 0;
      for (let k = 0; k < dim; k += 1) sum += embeddings[a + k] * embeddings[b + k];
      matrix[i * n + j] = sum;
      matrix[j * n + i] = sum;
    }
  }
  return matrix;
};

/** 평균 연결 계층 군집(NN-chain) — 창 수의 제곱 시간. matrix 는 작업 공간으로 덮어쓴다 */
const averageLinkage = (matrix: Float32Array, n: number): Merge[] => {
  const size = new Int32Array(n).fill(1);
  const alive = new Uint8Array(n).fill(1);
  const merges: Merge[] = [];
  const chain: number[] = [];
  let next = 0;
  while (merges.length < n - 1) {
    if (chain.length === 0) {
      while (!alive[next]) next += 1;
      chain.push(next);
    }
    const a = chain[chain.length - 1];
    const previous = chain.length > 1 ? chain[chain.length - 2] : -1;
    let best = previous;
    let bestSimilarity = previous >= 0 ? matrix[a * n + previous] : -Infinity;
    for (let j = 0; j < n; j += 1) {
      if (alive[j] && j !== a && matrix[a * n + j] > bestSimilarity) {
        bestSimilarity = matrix[a * n + j];
        best = j;
      }
    }
    if (best !== previous) {
      chain.push(best);
      continue;
    }
    chain.length -= 2;
    const b = previous;
    const smaller = Math.min(size[a], size[b]);
    const total = size[a] + size[b];
    for (let j = 0; j < n; j += 1) {
      if (!alive[j] || j === a || j === b) continue;
      const merged = (size[a] * matrix[a * n + j] + size[b] * matrix[b * n + j]) / total;
      matrix[a * n + j] = merged;
      matrix[j * n + a] = merged;
    }
    alive[b] = 0;
    size[a] = total;
    merges.push({ a, b, similarity: bestSimilarity, smaller });
  }
  return merges;
};

const cutTree = (merges: Merge[], n: number, params: ClusterParams): Int32Array => {
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    return root;
  };
  const balanced = n * params.balancedShare;
  for (const { a, b, similarity, smaller } of merges) {
    if (similarity >= (smaller >= balanced ? params.balancedThreshold : params.mergeThreshold)) parent[find(b)] = find(a);
  }
  return Int32Array.from({ length: n }, (_, i) => find(i));
};

/** 군집마다 중심(L2 정규화) */
const centroidsOf = (embeddings: Float32Array, dim: number, members: Iterable<number[]>): Float32Array[] =>
  [...members].map((windows) => {
    const centroid = new Float32Array(dim);
    for (const window of windows) for (let k = 0; k < dim; k += 1) centroid[k] += embeddings[window * dim + k];
    let norm = 0;
    for (let k = 0; k < dim; k += 1) norm += centroid[k] * centroid[k];
    norm = Math.sqrt(norm) || 1;
    return centroid.map((value) => value / norm);
  });

const cosine = (a: Float32Array, b: Float32Array): number => {
  let sum = 0;
  for (let k = 0; k < a.length; k += 1) sum += a[k] * b[k];
  return sum;
};

const nearest = (embeddings: Float32Array, dim: number, window: number, centroids: Float32Array[]): number => {
  const vector = embeddings.subarray(window * dim, (window + 1) * dim);
  let best = 0;
  let bestSimilarity = -Infinity;
  centroids.forEach((centroid, index) => {
    const similarity = cosine(vector, centroid);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      best = index;
    }
  });
  return best;
};

const groupBy = (labels: ArrayLike<number>): Map<number, number[]> => {
  const groups = new Map<number, number[]>();
  for (let i = 0; i < labels.length; i += 1) {
    const group = groups.get(labels[i]);
    if (group) group.push(i);
    else groups.set(labels[i], [i]);
  }
  return groups;
};

/** 중심이 threshold 이상 비슷한 군집과, MAX_SPEAKERS 를 넘는 군집을 합쳐 줄어든 중심 목록을 돌려준다 */
const mergeCentroids = (embeddings: Float32Array, dim: number, labels: Int32Array, threshold: number): Float32Array[] => {
  for (;;) {
    const groups = groupBy(labels);
    const ids = [...groups.keys()];
    const centroids = centroidsOf(embeddings, dim, groups.values());
    let pair: [number, number] | null = null;
    let best = ids.length > MAX_SPEAKERS ? -Infinity : threshold;
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const similarity = cosine(centroids[i], centroids[j]);
        if (similarity >= best) {
          best = similarity;
          pair = [ids[i], ids[j]];
        }
      }
    }
    if (!pair) return centroids;
    for (let i = 0; i < labels.length; i += 1) if (labels[i] === pair[1]) labels[i] = pair[0];
  }
};

/** 창별 화자 번호(0부터, 먼저 말한 사람이 0). 창이 없으면 빈 배열. speechMs: 녹음의 말소리 총량 */
export const clusterWith = (embeddings: Float32Array, dim: number, speechMs: number, params: ClusterParams): Int32Array => {
  const count = embeddings.length / dim;
  if (count === 0) return new Int32Array(0);
  const stride = Math.ceil(count / MAX_CLUSTER_WINDOWS);
  const picks = Array.from({ length: Math.ceil(count / stride) }, (_, i) => i * stride);
  let tree: Int32Array;
  if (params.method === 'nme') {
    const picked = new Float32Array(picks.length * dim);
    picks.forEach((window, i) => picked.set(embeddings.subarray(window * dim, (window + 1) * dim), i * dim));
    tree = spectralCluster(picked, dim, MAX_SPEAKERS, params.oneSpeakerSimilarity);
    console.debug(`[diarize] ${count} windows, spectral ${new Set(tree).size} groups`);
  } else {
    const merges = averageLinkage(similarityMatrix(embeddings, dim, picks), picks.length);
    const lastMerges = merges
      .map((merge) => merge.similarity)
      .sort((a, b) => a - b)
      .slice(0, LOGGED_MERGES)
      .map((similarity) => similarity.toFixed(3));
    console.debug(`[diarize] ${count} windows, lowest merges ${lastMerges.join(' ')}`);
    tree = cutTree(merges, picks.length, params);
  }

  const minSize = Math.max(params.minClusterWindows, Math.ceil(picks.length * MIN_CLUSTER_SHARE));
  const kept = [...groupBy(tree).values()].filter((members) => members.length >= minSize).map((members) => members.map((member) => picks[member]));
  if (kept.length === 0) return new Int32Array(count);

  let centroids = centroidsOf(embeddings, dim, kept);
  const labels = new Int32Array(count);
  for (let round = 0; round < REFINE_ROUNDS; round += 1) {
    for (let window = 0; window < count; window += 1) labels[window] = nearest(embeddings, dim, window, centroids);
    centroids = mergeCentroids(embeddings, dim, labels, params.centroidMergeSimilarity);
  }
  for (let window = 0; window < count; window += 1) labels[window] = nearest(embeddings, dim, window, centroids);
  if (speechMs < params.shortSpeechMs && centroids.length > 1) {
    centroids = mergeCentroids(embeddings, dim, labels, params.shortSplitSimilarity);
    for (let window = 0; window < count; window += 1) labels[window] = nearest(embeddings, dim, window, centroids);
  }

  const order = new Map<number, number>();
  return labels.map((label) => {
    if (!order.has(label)) order.set(label, order.size);
    return order.get(label)!;
  });
};