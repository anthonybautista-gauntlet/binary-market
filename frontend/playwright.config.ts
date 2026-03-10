import { defineConfig, devices } from '@playwright/test';

/**
 * Meridian E2E test configuration.
 *
 * Approach: hybrid
 *  - Static/UI tests:     Playwright route interception mocks Pyth Hermes + blockchain RPC.
 *                         No running blockchain required.
 *  - Transaction tests:   Use a wagmi mock connector injected via addInitScript,
 *                         intercepting JSON-RPC at the network layer.
 *
 * Run the full suite:
 *   npx playwright test
 *
 * Run a single file verbosely:
 *   npx playwright test e2e/trade.spec.ts --headed
 *
 * Tests expect the frontend dev server to already be running on the configured base URL.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],

  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Suppress console errors from unhandled wagmi connection attempts in tests
    ignoreHTTPSErrors: true,
  },

  projects: [
    {
      name: 'chromium',
      testIgnore: /.*\.setup\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],

});
