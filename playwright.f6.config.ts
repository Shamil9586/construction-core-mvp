import { defineConfig } from '@playwright/test';

/**
 * F6 — browser regression for the real-provider data boundary.
 *
 * Separate from both `playwright.config.ts` (starts a real backend, drives
 * the legacy app) and `playwright.ds.config.ts` (Vite only, always mock
 * provider). This config's one job is to start the Vite dev server with
 * `VITE_DATA_PROVIDER=real` — `selectDataProvider` only reads that once, at
 * module load, so the F5/F6 app (`/app.html`) needs its own dev-server
 * process with the var actually set to exercise `realDataProvider` at all.
 *
 * No backend, no database: the specs under tests/f6-browser/ intercept
 * `/api/snapshot` (and, where a session is needed, seed `sessionStorage`
 * directly) via Playwright's own `page.route()`/`addInitScript` — a real
 * HTTP response for that one request, not a page-script fetch monkey-patch,
 * but not a real backend either. Every such spec says so explicitly.
 */
export default defineConfig({
  testDir: './tests/f6-browser',
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
