/** On-Device 인식 가능 여부 — wasm SIMD 는 필수, 스레드(SharedArrayBuffer)는 교차 출처 격리가 켜져 있어야 한다 */
export type OnDeviceCapabilities = {
  supported: boolean;
  threads: boolean;
  /** supported === false 인 이유 — 설정 카드와 토스트에 그대로 보여 준다 */
  reason: string | null;
};

// wasm-feature-detect 의 SIMD 탐지 모듈: v128 을 쓰는 최소 함수 하나 (validate 만 한다)
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

export const detectCapabilities = (): OnDeviceCapabilities => {
  if (typeof WebAssembly !== 'object' || typeof WebAssembly.validate !== 'function') {
    return { supported: false, threads: false, reason: '이 브라우저는 WebAssembly 를 지원하지 않습니다' };
  }
  let simd = false;
  try {
    simd = WebAssembly.validate(SIMD_PROBE);
  } catch {
    simd = false;
  }
  if (!simd) {
    return { supported: false, threads: false, reason: '이 브라우저는 On-Device 인식을 지원하지 않습니다 (WebAssembly SIMD 없음)' };
  }
  const isolated = typeof crossOriginIsolated === 'boolean' && crossOriginIsolated;
  if (!isolated || typeof SharedArrayBuffer === 'undefined') {
    return { supported: false, threads: false, reason: '교차 출처 격리가 꺼져 있어 On-Device 인식을 쓸 수 없습니다 (COOP/COEP 헤더 확인)' };
  }
  return { supported: true, threads: true, reason: null };
};

/** whisper 스레드 수 — 코어 수를 따르되 8 을 넘기지 않는다 (wasm pthread 풀 크기와 맞춘다) */
export const onDeviceThreads = (): number => Math.min(navigator.hardwareConcurrency ?? 4, 8);