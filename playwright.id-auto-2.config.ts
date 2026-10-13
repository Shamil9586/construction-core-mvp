import { defineConfig } from '@playwright/test';

/**
 * ID-AUTO-2 — the Object «Реестр ИД» in a real browser over a REAL backend (not intercepted).
 * tests/id-auto-2-browser/server.ts prepares a PILOT-W01-shaped Object and per-role session tokens.
 */
export default defineConfig({
  testDir: './tests/id-auto-2-browser',
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
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH },
  },
  webServer: [
    { command: 'node --import tsx tests/id-auto-2-browser/server.ts', url: 'http://localhost:3002/scenario', reuseExistingServer: false, timeout: 180000 },
    { command: 'npm run dev:web', url: 'http://127.0.0.1:5173/app.html', reuseExistingServer: false, timeout: 120000, env: { VITE_DATA_PROVIDER: 'real' } },
  ],
});
