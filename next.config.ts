import type { NextConfig } from 'next';

/** On-Device 인식(wasm 스레드 = SharedArrayBuffer)에 필요한 교차 출처 격리. 폰트·로고·wasm 은 자체 서빙이고
 *  BYOK 호출은 서버 pass-through 라 깨지는 리소스가 없다. 외부 이미지·스크립트를 넣게 되면 crossorigin 처리가 필요하다 */
const ISOLATION_HEADERS = [
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  serverExternalPackages: ['@rhwp/core'],
  outputFileTracingIncludes: {
    '/api/export': ['./node_modules/@rhwp/core/**/*'],
  },
  headers: async () => [
    { source: '/:path*', headers: ISOLATION_HEADERS },
    // 모델 파일은 버전(해시) 경로라 영구 캐시, manifest 는 매번 확인 — 뒤의 규칙이 같은 키를 덮으므로 manifest 를 나중에 둔다
    { source: '/models/:version([0-9a-f]+)/:file*', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
    { source: '/models/manifest.json', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
  ],
};

export default nextConfig;