import { test, expect } from '@playwright/test';

/**
 * F7 — runtime-mode wording under the mock data source.
 *
 * TEST TYPE: browser, dev server, no backend. playwright.ds.config.ts starts
 * Vite without VITE_DATA_PROVIDER, so the application runs on the explicit
 * dev-server default: the built-in demo fixtures (F6-01). Before F7 its
 * footer read «F5 · типизированные демо-данные» in every mode, including over
 * real server data; it now states the source the build actually uses. The
 * real-source wording is asserted in tests/f7-browser/ and
 * tests/f7-production/.
 */

test('mock data source: the footer says the data is built-in demo data, with no phase label', async ({ page }) => {
  await page.goto('/app.html/company');

  const aside = page.locator('aside');
  await expect(aside.getByText('Источник данных: встроенные демо-данные', { exact: true })).toBeVisible();
  await expect(page.getByText(/F5 ·/)).toHaveCount(0);
  await expect(aside.getByText('Источник данных: сервер', { exact: true })).toHaveCount(0);
});

test('mock data source: no session, no sign-in and no backend request of any kind', async ({ page }) => {
  const apiRequests: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/')) apiRequests.push(path);
  });

  await page.goto('/app.html/company');
  await expect(page.getByRole('heading', { level: 1, name: 'Портфель объектов' })).toBeVisible();

  await expect(page.getByRole('heading', { level: 1, name: 'Требуется вход' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Выйти' })).toHaveCount(0);
  expect(apiRequests).toEqual([]);
});
