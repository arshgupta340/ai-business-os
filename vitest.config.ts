import { defineConfig } from 'vitest/config';

// Unit tests for the server and the shared packages.
// apps/web has its own test setup. scripts/spikes are standalone projects.
export default defineConfig({
  test: {
    include: ['apps/server/**/*.test.ts', 'packages/**/*.test.ts'],
    exclude: ['**/node_modules/**', '.worktrees/**'],
  },
});
