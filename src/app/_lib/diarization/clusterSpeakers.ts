/**
 * 화자 군집화 — 창마다 뽑은 화자 임베딩(L2 정규화)을 코사인 유사도로 묶는다.
 * 사람 수를 미리 받지 않는다. 평균 연결 계층 군집을 문턱에서 자르고, 아주 작은 군집은 흩어 가까운 화자에 넣은 뒤,
 * 중심점 재배정으로 경계를 다듬는다.
 */
/** 평균 유사도가 이 값 이상이면 같은 화자로 묶는다 — 먼 거리 마이크의 CAM++ 임베딩 기준 */
const MERGE_THRESHOLD = 0.18;
/**
 * 큰 두 묶음은 이 값 아래면 합치지 않는다 — 잡음 창 몇 개의 이상값은 작은 쪽이 작다. 스피커로 튼 두 목소리는 큰 묶음끼리
 * 0.2 근처에서 합쳐졌고, 한 목소리와 빈 방은 큰 두 묶음으로 갈리지 않았다
 */
const BALANCED_THRESHOLD = 0.3;
/** 큰 묶음으로 치는 비율 — 작은 쪽이 전체 창에서 이만큼 이상이어야 한다 */
const BALANCED_SHARE = 0.2;
/** 진단 로그에 남기는 마지막 병합 수 */
const LOGGED_MERGES = 8;
/** 전체 창에서 이 비율보다 작은 군집은 화자로 치지 않는다 (기침·물건 소리·겹친 말) */
const MIN_CLUSTER_SHARE = 0.01;
/** 이보다 창이 적은 군집은 화자로 치지 않는다 — 짧은 녹음에서는 비율 기준이 한 창이 된다 */
const MIN_CLUSTER_WINDOWS = 3;
/** 군집 중심끼리 이 값 이상 비슷하면 한 화자다 */
const CENTROID_MERGE_SIMILARITY = 0.6;
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

const cutTree = (merges: Merge[], n: number): Int32Array => {
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    return root;
  };
  const balanced = n * BALANCED_SHARE;
  for (const { a, b, similarity, smaller } of merges) {
    if (similarity >= (smaller >= balanced ? BALANCED_THRESHOLD : MERGE_THRESHOLD)) parent[find(b)] = find(a);
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

/** 중심이 서로 비슷한 군집을 합쳐 줄어든 중심 목록을 돌려준다 */
const mergeCentroids = (embeddings: Float32Array, dim: number, labels: Int32Array): Float32Array[] => {
  for (;;) {
    const groups = groupBy(labels);
    const ids = [...groups.keys()];
    const centroids = centroidsOf(embeddings, dim, groups.values());
    let pair: [number, number] | null = null;
    let best = CENTROID_MERGE_SIMILARITY;
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

/** 창별 화자 번호(0부터, 먼저 말한 사람이 0). 창이 없으면 빈 배열 */
export const clusterSpeakers = (embeddings: Float32Array, dim: number): Int32Array => {
  const count = embeddings.length / dim;
  if (count === 0) return new Int32Array(0);
  const stride = Math.ceil(count / MAX_CLUSTER_WINDOWS);
  const picks = Array.from({ length: Math.ceil(count / stride) }, (_, i) => i * stride);
  const merges = averageLinkage(similarityMatrix(embeddings, dim, picks), picks.length);
  const lastMerges = merges
    .map((merge) => merge.similarity)
    .sort((a, b) => a - b)
    .slice(0, LOGGED_MERGES)
    .map((similarity) => similarity.toFixed(3));
  console.debug(`[diarize] ${count} windows, lowest merges ${lastMerges.join(' ')}`);
  const tree = cutTree(merges, picks.length);

  const minSize = Math.max(MIN_CLUSTER_WINDOWS, Math.ceil(picks.length * MIN_CLUSTER_SHARE));
  const kept = [...groupBy(tree).values()].filter((members) => members.length >= minSize).map((members) => members.map((member) => picks[member]));
  if (kept.length === 0) return new Int32Array(count);

  let centroids = centroidsOf(embeddings, dim, kept);
  const labels = new Int32Array(count);
  for (let round = 0; round < REFINE_ROUNDS; round += 1) {
    for (let window = 0; window < count; window += 1) labels[window] = nearest(embeddings, dim, window, centroids);
    centroids = mergeCentroids(embeddings, dim, labels);
  }
  for (let window = 0; window < count; window += 1) labels[window] = nearest(embeddings, dim, window, centroids);

  const order = new Map<number, number>();
  return labels.map((label) => {
    if (!order.has(label)) order.set(label, order.size);
    return order.get(label)!;
  });
};