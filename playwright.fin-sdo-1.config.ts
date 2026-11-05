import { defineConfig } from '@playwright/test';

/**
 * FIN-SDO-1 rendered frontend acceptance SMOKE — intercepted HTTP only.
 * Actual PostgreSQL/HTTP security evidence is in FIN native CI.
 * No LIVE, no production DB, no false claim that mocks prove SQL constraints.
 */
export default defineConfig({
  testDir: './tests/fin-sdo-1-browser',
  testMatch: '**/*.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 60000,
  expect: { timeout: 10000 },
  outputDir: 'test-results/fin-sdo-1-browser',
  reporter: [['list'], ['json', { outputFile: 'test-results/fin-sdo-1-browser/results.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1440, height: 1000 },
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH },
  },
  webServer: {
    command: 'npm run dev:web',
    url: 'http://127.0.0.1:5173/app.html',
    reuseExistingServer: false,
    timeout: 120000,
    env: { VITE_DATA_PROVIDER: 'real', VITE_FIN_SDO_1: 'enabled' },
  },
});
