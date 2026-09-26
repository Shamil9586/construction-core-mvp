import { defineConfig } from '@playwright/test';

/**
 * F8.2 — browser regression for P01 (PTO Workspace) and W01's
 * "Исполнительная документация" section, INTERCEPTED (not backend
 * end-to-end).
 *
 * Same shape as playwright.f8.1.config.ts: the real Vite dev server with
 * `VITE_DATA_PROVIDER=real`, so the real App/PtoRoute/WorkRoute code runs;
 * every `/api/*` request is fulfilled by the spec itself via `page.route()`.
 * No backend, no database.
 */
export default defineConfig({
  testDir: './tests/f8.2-browser',
  workers: 1,
  retries: 0,
  timeout: 60000,
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
  webServer: {
    command: 'npm run dev:web',
    url: 'http://127.0.0.1:5173/app.html',
    reuseExistingServer: false,
    timeout: 120000,
    env: { VITE_DATA_PROVIDER: 'real' },
  },
});
