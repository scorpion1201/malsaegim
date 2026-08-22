import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
   output: 'standalone',
   serverExternalPackages: ['@rhwp/core'],
   outputFileTracingIncludes: {
      '/api/export': ['./node_modules/@rhwp/core/**/*'],
    },
};

export default nextConfig;