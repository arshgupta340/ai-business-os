import path from 'node:path';
import type {NextConfig} from 'next';

/**
 * Sent on every route. frame-ancestors and X-Frame-Options stop another site
 * from framing the dashboard (and its Approve button). This is not a full
 * content security policy: only frame-ancestors is set, because script and
 * connect rules would need testing against Supabase, the API host and Astryx.
 */
const SECURITY_HEADERS = [
  {key: 'Content-Security-Policy', value: "frame-ancestors 'none'"},
  {key: 'X-Frame-Options', value: 'DENY'},
  {key: 'X-Content-Type-Options', value: 'nosniff'},
  {key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin'},
];

// STATIC_EXPORT=1 builds the public click-through for GitHub Pages: plain files in
// `out/`, served under NEXT_PUBLIC_BASE_PATH (the repo path, /ai-business-os). It is
// mock mode only, because a static site has no server to call. GitHub Pages cannot
// send the security headers, so they are left out of that build.
const STATIC_EXPORT = process.env.STATIC_EXPORT === '1';
if (STATIC_EXPORT && process.env.NEXT_PUBLIC_MOCK !== '1') {
  throw new Error('STATIC_EXPORT=1 needs NEXT_PUBLIC_MOCK=1: the static site has no server to call.');
}
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

// This app has no API routes. It calls the server at NEXT_PUBLIC_API_URL.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // No Next.js badge in the corner of the screen while running `next dev`. The demo is presented from a dev server.
  devIndicators: false,
  // packages/contracts ships TypeScript source with no build step.
  transpilePackages: ['@abos/contracts'],
  // The repo root, so Next does not pick up a lockfile outside the repo.
  outputFileTracingRoot: path.join(__dirname, '..', '..'),
  ...(STATIC_EXPORT
    ? {output: 'export' as const, trailingSlash: true, basePath: BASE_PATH || undefined, images: {unoptimized: true}}
    : {
        async headers() {
          return [{source: '/:path*', headers: SECURITY_HEADERS}];
        },
      }),
};

export default nextConfig;
