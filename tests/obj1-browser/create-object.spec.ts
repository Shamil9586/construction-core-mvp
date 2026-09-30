import { test, expect, type Page } from '@playwright/test';

/**
 * OBJ-1 — ONE scenario over a REAL backend with the empty-tenant shape (zero objects, zero contractors):
 * PROJECT_MANAGER sees no control → DEPUTY_DIRECTOR creates LIVE-PBX3A-001 without contractors → it appears
 * in C01 without a reload → opens → is listed in «Команды и объекты» → duplicate code shows a conflict →
 * the same form is usable at narrow mobile width (no horizontal overflow).
 */
const API = 'http://127.0.0.1:3001';
const KEY = 'obj1-browser-key';

async function mockLogin(role: string) {
  const r = await fetch(`${API}/auth/mock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, key: KEY }) });
  return (await r.json()) as { token: string };
}
async function openAs(page: Page, token: string, path: string) {
  await page.addInitScript((value: string) => window.sessionStorage.setItem('session', value), token);
  await page.goto(`/app.html${path}`);
}
const dates = async (page: Page) => {
  await page.getByLabel('Дата начала').fill('2026-01-01');
  await page.getByLabel('Плановая дата завершения').fill('2026-03-01');
};
const fillCommon = async (page: Page, code: string, name: string) => {
  await page.getByLabel('Код объекта / УКО').fill(code);
  await page.getByLabel('Наименование объекта').fill(name);
  await page.getByLabel('Адрес').fill('г. Тест, ул. Проверочная, 1');
  await page.getByLabel('Организация').fill('ООО СЗ «Гор-Строй»');
  await page.getByLabel('РП', { exact: true }).selectOption({ index: 1 });
  await dates(page);
  await page.getByLabel('Стоимость объекта').fill('0.00');
};

test('empty portfolio → deputy creates object → appears → opens → visible in «Команды и объекты»; duplicate → conflict; mobile usable', async ({ page, browser }) => {
  const pm = await mockLogin('PROJECT_MANAGER');
  const pmContext = await browser.newContext();
  const pmPage = await pmContext.newPage();
  await openAs(pmPage, pm.token, '/company');
  await expect(pmPage.getByRole('heading', { name: 'Портфель объектов', level: 1 })).toBeVisible();
  await expect(pmPage.getByRole('button', { name: 'Добавить объект' })).toHaveCount(0);
  await pmContext.close();

  const deputy = await mockLogin('DEPUTY_DIRECTOR');
  await openAs(page, deputy.token, '/company');
  await expect(page.getByText('Объектов нет')).toBeVisible();
  await page.getByRole('button', { name: 'Добавить объект' }).click();
  const form = page.getByRole('region', { name: 'Новый объект' });
  await expect(form.getByText('Подрядчики пока не заведены. Их можно назначить позже.')).toBeVisible();

  // field validation
  await form.getByRole('button', { name: 'Создать объект' }).click();
  await expect(form.getByRole('alert').filter({ hasText: 'Выберите РП' })).toBeVisible();

  await fillCommon(page, 'LIVE-PBX3A-001', 'LIVE TEST — PBX-3A');
  await form.getByRole('button', { name: 'Создать объект' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'создан' })).toContainText('LIVE TEST — PBX-3A');
  await expect(page.getByRole('button', { name: 'Открыть объект' }).first()).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'LIVE TEST — PBX-3A' })).toBeVisible();

  // open it
  await page.getByRole('button', { name: 'Открыть объект' }).first().click();
  await expect(page).toHaveURL(/\/object\//);
  await expect(page.getByText('LIVE TEST — PBX-3A').first()).toBeVisible();

  // selectable/visible in «Команды и объекты»
  await page.goto('/app.html/teams');
  await expect(page.getByRole('heading', { name: 'Команды и объекты', level: 1 })).toBeVisible();
  await expect(page.getByText('LIVE TEST — PBX-3A').first()).toBeVisible();

  // duplicate code → clear conflict, no second object
  await page.goto('/app.html/company');
  await page.getByRole('button', { name: 'Добавить объект' }).click();
  await fillCommon(page, 'LIVE-PBX3A-001', 'Дубликат');
  await page.getByRole('button', { name: 'Создать объект' }).click();
  await expect(page.getByText('Объект с таким кодом уже существует.')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Дубликат' })).toHaveCount(0);

  // narrow mobile width: form stays usable, no horizontal page scroll
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/app.html/company');
  await page.getByRole('button', { name: 'Добавить объект' }).click();
  await expect(page.getByLabel('Код объекта / УКО')).toBeVisible();
  await page.getByLabel('Стоимость объекта').scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Создать объект' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
