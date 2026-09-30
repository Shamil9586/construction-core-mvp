import { defineConfig } from '@playwright/test';

/**
 * PBX-2 — browser regression for «Пользователи и доступ» (/admin/users),
 * INTERCEPTED (not backend end-to-end): real Vite dev server with
 * VITE_DATA_PROVIDER=real, every /api/* request fulfilled by the spec itself.
 * Backend behaviour is covered by tests/pbx2-*.test.ts.
 */
export default defineConfig({
  testDir: './tests/pbx2-browser',
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
