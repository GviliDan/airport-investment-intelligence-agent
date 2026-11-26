import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

/** The Express API is a separate backend. The browser only talks to this origin; /api is proxied, so no key or backend URL reaches it. */
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3001';

const config: NextConfig = {
  // Self-contained server bundle for the Docker image. The tracing root is the monorepo root so hoisted dependencies are included.
  output: 'standalone',
  outputFileTracingRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  // Compression buffers responses; turn it off so server-sent progress events reach the browser as they are produced.
  compress: false,
  // The proxy gives up on a silent upstream after this long; the API sends a keep-alive every 15 s, this is only a safety margin.
  experimental: { proxyTimeout: 120_000 },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${BACKEND_URL}/api/:path*` }];
  },
};

export default config;
