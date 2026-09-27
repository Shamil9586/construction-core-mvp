import { defineConfig } from '@playwright/test';

/**
 * F11.3 Non-Table Responsive Consistency — responsive regression for the
 * non-table content C01/O01/W01 render outside DataTable (the Attention
 * Card, execution-unit/portion cards, PageHeader, Breadcrumb), INTERCEPTED.
 *
 * Same shape as playwright.f11.2.config.ts: the real Vite dev server with
 * `VITE_DATA_PROVIDER=real`, so the real, unmodified route/screen code runs
 * in a real browser against a snapshot fixture served via `page.route()`. No
 * backend, no database.
 *
 * A separate config, not folded into playwright.f11.2.config.ts, because
 * F11.2's fixture and specs are scoped to DataTable/dense tables — this
 * slice is explicitly about everything else on the same screens, and a
 * screen's own DataTable regions are deliberately excluded from what these
 * specs check (F11.2's scoped scroll is accepted, not an F11.3 concern).
 */
export default defineConfig({
  testDir: './tests/f11.3-non-table-responsive',
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
