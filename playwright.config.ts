import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', workers: 1, retries: 0, timeout: 180000,
  expect: { timeout: 15000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: process.env.E2E_BASE_URL || process.env.BROWSER_BASE_URL || 'http://localhost:5173', viewport: { width: 1440, height: 1000 }, locale: 'ru-RU', timezoneId: 'UTC', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
