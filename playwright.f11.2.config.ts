import { defineConfig } from '@playwright/test';

/**
 * F11.2 Dense Tables / Scoped Overflow — responsive regression for the
 * shared DataTable and its real screens (C01, O01, P01, SDO), INTERCEPTED.
 *
 * Same shape as playwright.f8.3.config.ts: the real Vite dev server with
 * `VITE_DATA_PROVIDER=real`, so the real, unmodified App/CompanyRoute/
 * ObjectRoute/PtoRoute/SdoRoute code and the real DataTable/ObjectRow/
 * WorkSummaryRow/P01/SDO row markup run in a real browser. Every `/api/*`
 * request is fulfilled by the spec itself via `page.route()`. No backend, no
 * database.
 *
 * A separate config (not folded into playwright.ds.config.ts) because these
 * specs exercise real screens at real routes with a real snapshot fixture —
 * the same reason F8.2.1/F8.3 each got their own — and because this file
 * varies `viewport` per test, unlike every other config's single fixed size.
 */
export default defineConfig({
  testDir: './tests/f11.2-responsive-tables',
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
