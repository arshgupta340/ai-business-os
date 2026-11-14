import path from 'node:path';
import {defineConfig} from 'vitest/config';

// Default environment is node. A component test opts into the DOM with a
// first-line comment: // @vitest-environment jsdom
export default defineConfig({
  resolve: {
    alias: {'@': path.resolve(import.meta.dirname)},
  },
  oxc: {jsx: {runtime: 'automatic'}},
  test: {
    environment: 'node',
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['node_modules/**', '.next/**', 'e2e/**'],
    setupFiles: ['./vitest.setup.ts'],
    // Generous on purpose: these tests drive real components against the mock
    // API, and a loaded machine can be several times slower than CI.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
