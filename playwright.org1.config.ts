import { defineConfig } from '@playwright/test';

/**
 * ORG-1 — browser scenario over a REAL backend (not intercepted): tests/org1-browser/server.ts starts
 * the API on PGlite with the demo seed and mock auth; Vite serves the Core app with the real data provider.
 */
export default defineConfig({
  testDir: './tests/org1-browser',
  workers: 1,
  retries: 0,
  timeout: 120000,
  expect: { timeout: 10000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1440, height: 1000 },
    locale: 'ru-RU',
    timezoneId: 'UTC',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH },
  },
  webServer: [
    { command: 'node --import tsx tests/org1-browser/server.ts', url: 'http://127.0.0.1:3001/health', reuseExistingServer: false, timeout: 120000 },
    { command: 'npm run dev:web', url: 'http://127.0.0.1:5173/app.html', reuseExistingServer: false, timeout: 120000, env: { VITE_DATA_PROVIDER: 'real' } },
  ],
});
