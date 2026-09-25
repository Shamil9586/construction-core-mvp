import { defineConfig } from '@playwright/test';

/**
 * F7 — production-like local serving, with a real backend and database.
 *
 * No webServer: tests/f7-production/global-setup.ts builds with the
 * repository's own commands, starts the real backend on disposable PGlite
 * databases, and serves every build through a real Caddy running
 * infra/Caddyfile. Requires a Caddy v2 binary (CADDY_BIN, or `caddy` on PATH);
 * without one the suite fails with an explanation rather than skipping.
 * Nothing here deploys anything.
 */
export default defineConfig({
  testDir: './tests/f7-production',
  globalSetup: './tests/f7-production/global-setup.ts',
  workers: 1,
  retries: 0,
  timeout: 90000,
  expect: { timeout: 15000 },
  reporter: [['list']],
  use: {
    viewport: { width: 1440, height: 1000 },
    locale: 'ru-RU',
    timezoneId: 'UTC',
    screenshot: 'only-on-failure',
  },
});
