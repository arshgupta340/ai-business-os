import {defineConfig, devices} from '@playwright/test';

/**
 * End-to-end smoke tests in mock mode (NEXT_PUBLIC_MOCK=1). No backend, no
 * real provider. Run with `npm run e2e -w @abos/web`.
 *
 * Locally the tests use the installed Google Chrome, so nothing is
 * downloaded. CI runs `npx playwright install --with-deps chromium` first and
 * uses Playwright's own Chromium.
 */
const PORT = 3118;
const BASE_URL = `http://localhost:${PORT}`;
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './e2e',
  // Compiles every route of the walk once before the tests start.
  globalSetup: './e2e/global-setup.ts',
  // The mock keeps state per page, and the dev server compiles each route on
  // first use. One worker keeps the runs predictable on a shared machine.
  fullyParallel: false,
  workers: 1,
  forbidOnly: isCI,
  retries: 0,
  // A first compile of every route can take a while on a busy machine.
  timeout: 300_000,
  expect: {timeout: 20_000},
  outputDir: './test-results',
  reporter: [['list'], ['html', {outputFolder: './playwright-report', open: 'never'}]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 180_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: {width: 1440, height: 1000},
        ...(isCI ? {} : {channel: 'chrome'}),
      },
    },
  ],
  webServer: {
    command: `npx next dev --port ${PORT}`,
    url: `${BASE_URL}/sign-in`,
    env: {NEXT_PUBLIC_MOCK: '1'},
    reuseExistingServer: !isCI,
    timeout: 240_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
