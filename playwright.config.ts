import { defineConfig } from '@playwright/test';
/**
 * Rate limit for the browser gate.
 *
 * Every request of the suite reaches the backend through one Vite dev-proxy /
 * reverse-proxy address, so the whole run shares a single express-rate-limit
 * bucket. The production default (300 requests / 60s, apps/backend/src/main.ts)
 * is crossed by a full suite run, and the limiter then answers 429 at whatever
 * request happens to be in flight. The E2E environment raises the limit
 * explicitly; the production default is deliberately left untouched.
 */
export const E2E_RATE_LIMIT_MAX = '2000';
export const E2E_AUTH_RATE_LIMIT_MAX = '200';
const externalBaseURL = process.env.E2E_BASE_URL || process.env.BROWSER_BASE_URL;
export default defineConfig({
  testDir: './tests/browser', workers: 1, retries: 0, timeout: 180000,
  expect: { timeout: 15000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: externalBaseURL || 'http://localhost:5173', viewport: { width: 1440, height: 1000 }, locale: 'ru-RU', timezoneId: 'UTC', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  // Against an external deployment the servers are not ours to start, and the
  // rate limit is that environment's configuration.
  webServer: externalBaseURL ? undefined : [
    { command: 'node --import tsx apps/backend/src/main.ts', url: 'http://127.0.0.1:3001/health', reuseExistingServer: false, timeout: 120000, stdout: 'pipe', env: { RATE_LIMIT_MAX: E2E_RATE_LIMIT_MAX, AUTH_RATE_LIMIT_MAX: E2E_AUTH_RATE_LIMIT_MAX } },
    { command: 'npm run dev:web', url: 'http://127.0.0.1:5173', reuseExistingServer: false, timeout: 120000 },
  ],
});
