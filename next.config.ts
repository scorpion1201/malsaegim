import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  serverExternalPackages: ['@rhwp/core'],
  outputFileTracingIncludes: {
    '/api/export': ['./node_modules/@rhwp/core/**/*'],
  },
};

export default nextConfig;