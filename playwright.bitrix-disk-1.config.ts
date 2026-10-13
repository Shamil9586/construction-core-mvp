import { defineConfig } from '@playwright/test';

/**
 * BITRIX-DISK-1 — the unmodified ID-AUTO-1 embedded-iframe spec, run against a backend whose new files live in the sandboxed Bitrix Disk
 * (tests/bitrix-disk-1-browser/server.ts), plus tests/bitrix-disk-1-browser/disk-backed.spec.ts. No Bitrix contact.
 */
export default defineConfig({
  testDir: './tests',
  testMatch: ['id-auto-1-browser/aosr-embedded.spec.ts', 'bitrix-disk-1-browser/*.spec.ts'],
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
    { command: 'node --import tsx tests/bitrix-disk-1-browser/server.ts', url: 'http://localhost:3002/scenario', reuseExistingServer: false, timeout: 180000 },
    { command: 'npm run dev:web', url: 'http://127.0.0.1:5173/app.html', reuseExistingServer: false, timeout: 120000, env: { VITE_DATA_PROVIDER: 'real' } },
  ],
});
