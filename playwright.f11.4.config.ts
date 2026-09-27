import { defineConfig } from '@playwright/test';

/**
 * F11.4 States + Accessibility — regression for loading/error/not-found
 * route states, heading semantics, route-change focus management, the P01
 * attention indicator and the Breadcrumb target size, INTERCEPTED.
 *
 * Same shape as playwright.f11.3.config.ts: the real Vite dev server with
 * `VITE_DATA_PROVIDER=real`, so the real, unmodified route containers and
 * screens run in a real browser. Every `/api/*` request is answered by
 * `page.route()` against the fixture below — no backend, no database. A
 * separate config because these specs also intercept `/api/snapshot` with
 * deliberate delays and failures to reach the Loading/Error states, which no
 * other F11.x config needs to do.
 */
export default defineConfig({
  testDir: './tests/f11.4-states-accessibility',
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
