import { defineConfig } from '@playwright/test';

/**
 * F7 — browser regression for the internal Core session bootstrap,
 * INTERCEPTED (not backend end-to-end).
 *
 * Same shape as playwright.f6.config.ts: the real Vite dev server with
 * `VITE_DATA_PROVIDER=real`, so the real App/SessionGate/realDataProvider code
 * runs; every `/api/*` request is fulfilled by the spec itself via
 * `page.route()`. No backend, no database. Production-like serving and a real
 * backend are covered separately by playwright.f7-prod.config.ts.
 */
export default defineConfig({
  testDir: './tests/f7-browser',
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
  },
  webServer: {
    command: 'npm run dev:web',
    url: 'http://127.0.0.1:5173/app.html',
    reuseExistingServer: false,
    timeout: 120000,
    env: { VITE_DATA_PROVIDER: 'real' },
  },
});
