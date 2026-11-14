import { defineConfig } from 'vitest/config';

// Unit tests for the server and the shared packages.
// apps/web has its own test setup. scripts/spikes are standalone projects.
export default defineConfig({
  test: {
    include: ['apps/server/**/*.test.ts', 'packages/**/*.test.ts'],
    exclude: ['**/node_modules/**', '.worktrees/**'],
    // Each database test file runs its own in-process Postgres. On Windows, forking one worker per
    // core intermittently fails with "spawn UNKNOWN"; a bounded pool is stable.
    // The CI runner has two cores: fewer workers and longer limits, or database setup
    // (six migrations per in-process Postgres) times out under contention.
    maxWorkers: process.env.CI ? 2 : 6,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
