import type { NextConfig } from 'next';

/** On-Device 인식(wasm 스레드 = SharedArrayBuffer)에 필요한 교차 출처 격리. 폰트·로고·wasm 은 자체 서빙이고
 *  BYOK 호출은 서버 pass-through, 실시간 번역은 CORS 를 여는 OpenAI 와 WebRTC 직결이라 깨지는 리소스가 없다.
 *  외부 이미지·스크립트를 넣게 되면 crossorigin 처리가 필요하다 */
const ISOLATION_HEADERS = [
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
];

/**
 * 외부 스크립트를 막아 키를 읽을 코드가 들어오지 못하게 하고, 연결 대상을 좁혀 읽더라도 밖으로 보내기 어렵게 한다.
 * BYOK 호출은 같은 출처 프록시를 거치므로 직결 대상은 OpenAI 뿐이다. blob: 은 오디오 워클릿, unsafe-inline 은 Next.js 인라인 스크립트용이다.
 * 개발 서버의 React 는 eval 이 필요해 production 에서만 뺀다.
 */
const SCRIPT_SRC = `'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:${process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'"}`;
const CONNECT_SRC = `'self' blob: data: https://api.openai.com wss://api.openai.com${process.env.NODE_ENV === 'production' ? '' : ' ws:'}`;

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src ${SCRIPT_SRC}`,
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "worker-src 'self' blob:",
  `connect-src ${CONNECT_SRC}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

/** 강제 전 점검용 — Next.js 인라인 스크립트에 nonce 를 붙이기 전까지는 브라우저 콘솔에 위반만 남긴다 */
const CONTENT_SECURITY_POLICY_REPORT_ONLY = "script-src 'self' 'wasm-unsafe-eval' blob:";

const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY },
  { key: 'Content-Security-Policy-Report-Only', value: CONTENT_SECURITY_POLICY_REPORT_ONLY },
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
    { source: '/:path*', headers: [...ISOLATION_HEADERS, ...SECURITY_HEADERS] },
    // 엔진·모델 파일은 /models/<묶음>/<내용 해시>/ 경로라 영구 캐시, manifest 는 매번 확인 — 뒤의 규칙이 같은 키를 덮으므로 manifest 를 나중에 둔다
    {
      source: '/models/:group([a-z0-9._-]+)/:version([0-9a-f]{12})/:file*',
      headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
    },
    { source: '/models/manifest.json', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
  ],
};

export default nextConfig;