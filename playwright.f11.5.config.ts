import { defineConfig } from '@playwright/test';

/**
 * F11.5 Final Responsive Regression Matrix — the closing, system-level
 * integration layer over F11.1-F11.4, INTERCEPTED.
 *
 * Same shape as playwright.f11.2/3/4.config.ts: the real Vite dev server
 * with `VITE_DATA_PROVIDER=real`, so the real, unmodified route containers
 * and screens run in a real browser against a snapshot fixture served via
 * `page.route()`. No backend, no database.
 *
 * Deliberately thin relative to F11.1-F11.4's own specs, which already own
 * their detailed claims (drawer interaction, per-word wrapping, aria-live,
 * route focus). This suite instead asserts what no single earlier slice
 * checked across the whole screen set at once: document/main overflow at
 * every required screen x viewport, shell mode, primary-heading and
 * primary-action reachability, and the one confirmed F11.5 finding
 * (F11.5-01 — see matrix.spec.ts).
 */
export default defineConfig({
  testDir: './tests/f11.5-final-regression',
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
