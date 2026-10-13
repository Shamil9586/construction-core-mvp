import { test, expect, type Page } from '@playwright/test';

/**
 * Integration overlap (GPR-1 x ID-AUTO-2): O01 and W01 carry BOTH the production-schedule door and the «Реестр ИД» door for a role that has both,
 * each leading to its own screen, and the physical-readiness figure stays independent of documentary readiness.
 */
const API = 'http://127.0.0.1:3001';
const KEY = 'gpr-1-browser-key';
async function mockLogin(role: string) {
  const r = await fetch(`${API}/auth/mock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, key: KEY }) });
  return (await r.json()) as { token: string };
}
async function openAs(page: Page, token: string, path: string) {
  await page.addInitScript((value: string) => window.sessionStorage.setItem('session', value), token);
  await page.goto(`/app.html${path}`);
}

test('O01 and W01 show the schedule and the registry entry points side by side; both lead to their own screens', async ({ page }) => {
  const { token } = await mockLogin('ADMIN');
  const snap = await (await fetch(`${API}/snapshot`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const objectId = snap.objects.find((o: any) => o.name === 'Тест после удаления ролей').id;
  const workId = snap.works.find((w: any) => w.objectId === objectId && w.name === 'Штукатурка стен').id;

  await openAs(page, token, `/object/${objectId}`);
  await expect(page.getByRole('heading', { name: 'Физическая готовность', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Состояние графика', level: 2 })).toBeVisible();
  await expect(page.getByRole('button', { name: /График производства работ/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Реестр ИД объекта' })).toBeVisible();
  await page.getByRole('button', { name: 'Реестр ИД объекта' }).click();
  await expect(page).toHaveURL(new RegExp(`/object/${objectId}/documentation$`));

  await page.goto(`/app.html/object/${objectId}/work/${workId}`);
  await expect(page.getByRole('button', { name: /График производства работ/ }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Открыть в реестре ИД' })).toBeVisible();
  await page.getByRole('button', { name: /График производства работ/ }).first().click();
  await expect(page).toHaveURL(new RegExp(`/object/${objectId}/schedule$`));
});
