import { defineConfig } from '@playwright/test';

/**
 * Browser checks for the design-system components.
 *
 * Separate from `playwright.config.ts` on purpose. The product suite starts the
 * API and drives real workflows, and it carries pre-existing failures recorded in
 * docs/status.md. These specs render an isolated preview page, touch no backend
 * and share no state with it, so keeping them in their own config means a
 * component result is never confused with a product-suite result — and a red
 * product suite never hides a red component.
 *
 * Only the Vite dev server is started. No database, no API, no rate limiter.
 */
export default defineConfig({
  testDir: './tests/design-system',
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
    url: 'http://127.0.0.1:5173/preview.html',
    reuseExistingServer: true,
    timeout: 120000,
  },
});
