import { defineConfig } from 'vitest/config';

// This spike is a standalone project. A local config stops vitest from
// walking up and loading the repo root config.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
