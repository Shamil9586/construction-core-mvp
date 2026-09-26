import { test, expect, type Page } from '@playwright/test';

/**
 * F7 — Bitrix (non-mock) auth mode, and build configuration failures.
 *
 * TEST TYPE: production-like local serving + REAL backend/database.
 *   - F7_BITRIX_URL: the real `npm run build:core` output behind a real Caddy
 *     whose /api/* reaches a real backend started with AUTH_MODE=bitrix.
 *   - F7_UNCONFIGURED_URL / F7_INVALID_URL: Core bundles built around the
 *     build:core guard (build-core-without-guard.mjs) with VITE_DATA_PROVIDER
 *     unset / "staging", served the same way — proving the runtime itself
 *     fails visibly and safely, not only the build command.
 */

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — run this suite through playwright.f7-prod.config.ts`);
  return value;
};

const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });

test.describe('backend in Bitrix24 mode (AUTH_MODE=bitrix)', () => {
  test('Core shows the launch notice and offers no sign-in of any kind', async ({ page, request }) => {
    const health = await request.get(`${env('F7_BITRIX_URL')}/api/health`);
    expect(await health.json()).toMatchObject({ authMode: 'bitrix' });

    await page.goto(`${env('F7_BITRIX_URL')}/app.html/company`);
    await expect(h1(page, 'Требуется вход')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Вход через Битрикс24' })).toBeVisible();
    await expect(page.locator('form')).toHaveCount(0);
    await expect(page.locator('select')).toHaveCount(0);
    await expect(page.locator('input')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Войти' })).toHaveCount(0);
  });

  test('the backend itself still refuses mock sign-in in this mode (Core hiding the form is not the barrier)', async ({ request }) => {
    const response = await request.post(`${env('F7_BITRIX_URL')}/api/auth/mock`, {
      data: { role: 'GENERAL_DIRECTOR', key: 'anything' },
    });
    expect(response.status()).toBe(401);
  });
});

const CONFIG_CASES = [
  { label: 'VITE_DATA_PROVIDER unset', url: 'F7_UNCONFIGURED_URL', reason: 'VITE_DATA_PROVIDER is not set' },
  { label: 'VITE_DATA_PROVIDER="staging"', url: 'F7_INVALID_URL', reason: 'Unknown VITE_DATA_PROVIDER value: "staging"' },
];

for (const { label, url, reason } of CONFIG_CASES) {
  test(`${label}: a visible configuration error — not a blank page, no request, no demo data`, async ({ page }) => {
    const apiRequests: string[] = [];
    const pageErrors: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/')) apiRequests.push(path);
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto(`${env(url)}/app.html/company`);

    await expect(h1(page, 'Приложение не настроено')).toBeVisible();
    await expect(page.getByText(reason)).toBeVisible();
    await expect(page.locator('aside').getByText('Источник данных: не настроен', { exact: true })).toBeVisible();
    await expect(page.getByText('Жилой комплекс «Полесье»')).toHaveCount(0);
    expect(apiRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}
