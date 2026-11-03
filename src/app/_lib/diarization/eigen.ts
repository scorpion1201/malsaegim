/**
 * 실대칭 행렬 고유값 분해 — Householder 삼중대각화(tred2) + 암시적 QL(tql2). JAMA(공개 도메인) 구현을 옮겼다.
 * values 는 오름차순, vectors[i * n + k] 는 k 번째 고유벡터의 i 성분이다. 입력 행렬은 바꾸지 않는다.
 */
export const symmetricEigen = (matrix: Float64Array, n: number): { values: Float64Array; vectors: Float64Array } => {
  const V = Float64Array.from(matrix);
  const d = new Float64Array(n);
  const e = new Float64Array(n);
  if (n === 0) return { values: d, vectors: V };

  // tred2
  for (let j = 0; j < n; j += 1) d[j] = V[(n - 1) * n + j];
  for (let i = n - 1; i > 0; i -= 1) {
    let scale = 0;
    let h = 0;
    for (let k = 0; k < i; k += 1) scale += Math.abs(d[k]);
    if (scale === 0) {
      e[i] = d[i - 1];
      for (let j = 0; j < i; j += 1) {
        d[j] = V[(i - 1) * n + j];
        V[i * n + j] = 0;
        V[j * n + i] = 0;
      }
    } else {
      for (let k = 0; k < i; k += 1) {
        d[k] /= scale;
        h += d[k] * d[k];
      }
      let f = d[i - 1];
      let g = Math.sqrt(h);
      if (f > 0) g = -g;
      e[i] = scale * g;
      h -= f * g;
      d[i - 1] = f - g;
      for (let j = 0; j < i; j += 1) e[j] = 0;
      for (let j = 0; j < i; j += 1) {
        f = d[j];
        V[j * n + i] = f;
        g = e[j] + V[j * n + j] * f;
        for (let k = j + 1; k <= i - 1; k += 1) {
          g += V[k * n + j] * d[k];
          e[k] += V[k * n + j] * f;
        }
        e[j] = g;
      }
      f = 0;
      for (let j = 0; j < i; j += 1) {
        e[j] /= h;
        f += e[j] * d[j];
      }
      const hh = f / (h + h);
      for (let j = 0; j < i; j += 1) e[j] -= hh * d[j];
      for (let j = 0; j < i; j += 1) {
        f = d[j];
        g = e[j];
        for (let k = j; k <= i - 1; k += 1) V[k * n + j] -= f * e[k] + g * d[k];
        d[j] = V[(i - 1) * n + j];
        V[i * n + j] = 0;
      }
    }
    d[i] = h;
  }
  for (let i = 0; i < n - 1; i += 1) {
    V[(n - 1) * n + i] = V[i * n + i];
    V[i * n + i] = 1;
    const h = d[i + 1];
    if (h !== 0) {
      for (let k = 0; k <= i; k += 1) d[k] = V[k * n + i + 1] / h;
      for (let j = 0; j <= i; j += 1) {
        let g = 0;
        for (let k = 0; k <= i; k += 1) g += V[k * n + i + 1] * V[k * n + j];
        for (let k = 0; k <= i; k += 1) V[k * n + j] -= g * d[k];
      }
    }
    for (let k = 0; k <= i; k += 1) V[k * n + i + 1] = 0;
  }
  for (let j = 0; j < n; j += 1) {
    d[j] = V[(n - 1) * n + j];
    V[(n - 1) * n + j] = 0;
  }
  V[(n - 1) * n + n - 1] = 1;
  e[0] = 0;

  // tql2
  for (let i = 1; i < n; i += 1) e[i - 1] = e[i];
  e[n - 1] = 0;
  let f = 0;
  let tst1 = 0;
  const eps = 2 ** -52;
  for (let l = 0; l < n; l += 1) {
    tst1 = Math.max(tst1, Math.abs(d[l]) + Math.abs(e[l]));
    let m = l;
    while (m < n) {
      if (Math.abs(e[m]) <= eps * tst1) break;
      m += 1;
    }
    if (m > l) {
      do {
        let g = d[l];
        let p = (d[l + 1] - g) / (2 * e[l]);
        let r = Math.hypot(p, 1);
        if (p < 0) r = -r;
        d[l] = e[l] / (p + r);
        d[l + 1] = e[l] * (p + r);
        const dl1 = d[l + 1];
        let h = g - d[l];
        for (let i = l + 2; i < n; i += 1) d[i] -= h;
        f += h;
        p = d[m];
        let c = 1;
        let c2 = c;
        let c3 = c;
        const el1 = e[l + 1];
        let s = 0;
        let s2 = 0;
        for (let i = m - 1; i >= l; i -= 1) {
          c3 = c2;
          c2 = c;
          s2 = s;
          g = c * e[i];
          h = c * p;
          r = Math.hypot(p, e[i]);
          e[i + 1] = s * r;
          s = e[i] / r;
          c = p / r;
          p = c * d[i] - s * g;
          d[i + 1] = h + s * (c * g + s * d[i]);
          for (let k = 0; k < n; k += 1) {
            h = V[k * n + i + 1];
            V[k * n + i + 1] = s * V[k * n + i] + c * h;
            V[k * n + i] = c * V[k * n + i] - s * h;
          }
        }
        p = (-s * s2 * c3 * el1 * e[l]) / dl1;
        e[l] = s * p;
        d[l] = c * p;
      } while (Math.abs(e[l]) > eps * tst1);
    }
    d[l] += f;
    e[l] = 0;
  }
  // 오름차순 정렬
  for (let i = 0; i < n - 1; i += 1) {
    let k = i;
    let p = d[i];
    for (let j = i + 1; j < n; j += 1) {
      if (d[j] < p) {
        k = j;
        p = d[j];
      }
    }
    if (k !== i) {
      d[k] = d[i];
      d[i] = p;
      for (let j = 0; j < n; j += 1) {
        const t = V[j * n + i];
        V[j * n + i] = V[j * n + k];
        V[j * n + k] = t;
      }
    }
  }
  return { values: d, vectors: V };
};