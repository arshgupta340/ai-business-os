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

// This app has no API routes. It calls the server at NEXT_PUBLIC_API_URL.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // packages/contracts ships TypeScript source with no build step.
  transpilePackages: ['@abos/contracts'],
  // The repo root, so Next does not pick up a lockfile outside the repo.
  outputFileTracingRoot: path.join(__dirname, '..', '..'),
  async headers() {
    return [{source: '/:path*', headers: SECURITY_HEADERS}];
  },
};

export default nextConfig;
