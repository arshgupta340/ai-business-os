import path from 'node:path';
import type {NextConfig} from 'next';

// This app has no API routes. It calls the server at NEXT_PUBLIC_API_URL.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The repo root, so Next does not pick up a lockfile outside the repo.
  outputFileTracingRoot: path.join(__dirname, '..', '..'),
};

export default nextConfig;
