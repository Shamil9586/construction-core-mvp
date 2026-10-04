import { defineConfig } from '@playwright/test';

/**
 * ID-AUTO-1 — browser scenario over a REAL backend (not intercepted), with the app embedded in a CROSS-ORIGIN iframe the way the
 * Bitrix24 portal embeds it. tests/id-auto-1-browser/server.ts prepares the data and the "portal" page.
 */
export default defineConfig({
  testDir: './tests/id-auto-1-browser',
  workers: 1,
  retries: 0,
  timeout: 120000,
  expect: { timeout: 15000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1440, height: 1000 },
    locale: 'ru-RU',
    timezoneId: 'UTC',
    acceptDownloads: true,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH },
  },
  webServer: [
    { command: 'node --import tsx tests/id-auto-1-browser/server.ts', url: 'http://localhost:3002/scenario', reuseExistingServer: false, timeout: 180000 },
    { command: 'npm run dev:web', url: 'http://127.0.0.1:5173/app.html', reuseExistingServer: false, timeout: 120000, env: { VITE_DATA_PROVIDER: 'real' } },
  ],
});
