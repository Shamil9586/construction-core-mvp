import { defineConfig } from '@playwright/test';

/**
 * GPR-2 R05 S2 «Зоны объекта» — browser checks, INTERCEPTED (not backend end-to-end).
 *
 * Same shape as playwright.f7.config.ts: the real Vite dev server with `VITE_DATA_PROVIDER=real`, so the real App / SessionGate /
 * realDataProvider / AreaScope code runs in a real browser; every `/api/*` request is fulfilled by the spec via `page.route()`.
 * No backend, no database. These tests therefore do NOT prove real backend integration of the D1 read API or the create route.
 * No acceptance profile is registered for this config; it is run by hand with `npx playwright test --config <this file>`.
 */
export default defineConfig({
  testDir: './tests/gpr2-r05-area-scope-browser',
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
