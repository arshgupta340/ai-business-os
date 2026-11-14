import { defineConfig } from 'vitest/config';

// Unit tests for the server and the shared packages.
// apps/web has its own test setup. scripts/spikes are standalone projects.
export default defineConfig({
  test: {
    include: ['apps/server/**/*.test.ts', 'packages/**/*.test.ts'],
    exclude: ['**/node_modules/**', '.worktrees/**'],
    // Each database test file runs its own in-process Postgres. On Windows, forking one worker per
    // core intermittently fails with "spawn UNKNOWN"; a bounded pool is stable.
    maxWorkers: 6,
  },
});
