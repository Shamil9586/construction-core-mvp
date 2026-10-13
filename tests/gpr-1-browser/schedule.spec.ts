import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';

/**
 * GPR-1 — the Production Schedule in a real browser over a REAL backend (tests/gpr-1-browser/server.ts builds the object through the API):
 *
 *   Object «Тест после удаления ролей»: Штукатурка стен — «1 этаж» 500 м² (RP fact 500, Internal СК 498), «2 этаж» 300 м² (fact 60, five
 *   days behind), «3 этаж» (starts in three days); Окраска потолков — the whole work, 50% and ahead.  Object «Соседний объект»: another РП.
 *
 * Selectors are roles, labels and visible text — not CSS classes. Tests run in order and share the one backend (serial), each leaving the
 * data in a known state for the next.
 */
const API = 'http://127.0.0.1:3001';
const KEY = 'gpr-1-browser-key';
const dt = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const ru = (iso: string) => iso.split('-').reverse().join('.');

test.describe.configure({ mode: 'serial' });

async function mockLogin(role: string) {
  const r = await fetch(`${API}/auth/mock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, key: KEY }) });
  return (await r.json()) as { token: string; user: { id: string; name: string } };
}
async function openAs(page: Page, token: string, path: string) {
  await page.addInitScript((value: string) => window.sessionStorage.setItem('session', value), token);
  await page.goto(`/app.html${path}`);
}
let objectId = '', plasterId = '', ceilingId = '', neighbourId = '';
test.beforeAll(async () => {
  const { token } = await mockLogin('DEPUTY_DIRECTOR');
  const snap = await (await fetch(`${API}/snapshot`, { headers: { Authorization: `Bearer ${token}` } })).json();
  objectId = snap.objects.find((o: any) => o.name === 'Тест после удаления ролей').id;
  neighbourId = snap.objects.find((o: any) => o.name === 'Соседний объект').id;
  plasterId = snap.works.find((w: any) => w.objectId === objectId && w.name === 'Штукатурка стен').id; // the demo seed names its works after work types too
  ceilingId = snap.works.find((w: any) => w.objectId === objectId && w.name === 'Окраска потолков').id;
});

const positions = (page: Page) => page.getByRole('table', { name: /Позиции графика/ });
const rowOf = (page: Page, text: string) => positions(page).getByRole('row').filter({ hasText: text }).first();

test('O01 states the object\'s production conclusion from the schedule, names what is late and leads into the schedule', async ({ page }) => {
  const { token } = await mockLogin('DEPUTY_DIRECTOR');
  await openAs(page, token, `/object/${objectId}`);
  const card = page.locator('div').filter({ has: page.getByRole('heading', { name: 'Состояние графика', level: 2 }) }).last();
  await expect(card.getByText('Есть отставание', { exact: true }).first()).toBeVisible();
  await expect(card.getByText('Отстают позиции графика: 1 из 4.')).toBeVisible();
  await expect(card.getByText('Штукатурка стен · 2 этаж', { exact: false })).toBeVisible();
  await expect(card.getByText('5 дней', { exact: false })).toBeVisible();
  await expect(card.getByText('Итоговый статус графика по объекту не определён')).toHaveCount(0);
  // the accepted overview is not regressed: physical readiness is still its own figure, and no new section heading appears
  await expect(page.getByRole('heading', { name: 'Физическая готовность', level: 2 })).toBeVisible();
  const h2 = await page.evaluate(() => Array.from(document.querySelectorAll('h2')).map((e) => (e.textContent ?? '').trim()));
  expect(h2.slice(0, 2)).toEqual(['Физическая готовность', 'Состояние графика']);
  expect(h2).not.toContain('График производства работ');

  await card.getByRole('button', { name: /График производства работ/ }).click();
  await expect(page).toHaveURL(new RegExp(`/object/${objectId}/schedule$`));
  await expect(page.getByRole('heading', { name: 'График производства работ', level: 1 })).toBeVisible();
});

test('the schedule table: work, zone, executor, planned quantity, dates, actual progress, state, delay — read from the production model', async ({ page }) => {
  const { token } = await mockLogin('DEPUTY_DIRECTOR');
  await openAs(page, token, `/object/${objectId}/schedule`);
  await expect(page.getByRole('heading', { name: 'График производства работ', level: 1 })).toBeVisible();
  await expect(page.getByText('Есть отставание', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Утверждённый график — версия №1')).toBeVisible();

  const table = positions(page);
  await expect(table).toBeVisible();
  // layout guard (desktop width): a date is ONE token — never "23.09.202 / 6" — and the table fits its card without a scroll of its own
  const wrappedDates = await table.evaluate((root) =>
    [...root.querySelectorAll('td[data-label="Начало"], td[data-label="Окончание"], td[data-label="Отставание"]')].filter((cell) => {
      const range = document.createRange();
      range.selectNodeContents(cell);
      return range.getClientRects().length > 1;
    }).length,
  );
  expect(wrappedDates).toBe(0);
  expect(await page.getByRole('region', { name: 'Позиции графика' }).evaluate((region) => region.scrollWidth <= region.clientWidth + 1)).toBe(true);
  const floor1 = rowOf(page, '1 этаж');
  await expect(floor1).toContainText('Штукатурка стен');
  await expect(floor1).toContainText('500 м²');
  await expect(floor1).toContainText(ru(dt(-20)));
  await expect(floor1).toContainText(ru(dt(-10)));
  await expect(floor1).toContainText('Факт РП: 500 м²');
  await expect(floor1).toContainText('Принято СК: 498 м²');
  await expect(floor1.getByText('Выполнено', { exact: true })).toBeVisible();
  await expect(floor1).toContainText('100%');

  const floor2 = rowOf(page, '2 этаж');
  await expect(floor2).toContainText('300 м²');
  await expect(floor2).toContainText('Факт РП: 60 м²');
  await expect(floor2).toContainText('20%');
  await expect(floor2.getByText('Есть отставание', { exact: true })).toBeVisible();
  await expect(floor2).toContainText('5 дней');
  await expect(floor2).toContainText('Выполнение отстаёт от планового графика');

  const floor3 = rowOf(page, '3 этаж');
  await expect(floor3.getByText('Не начато', { exact: true })).toBeVisible();
  await expect(floor3).toContainText('Факт РП: —');

  const ceiling = rowOf(page, 'Окраска потолков');
  await expect(ceiling.getByText('В работе', { exact: true })).toBeVisible();
  await expect(ceiling).toContainText('50%');

  // the calendar's answers for the day (3 started and not finished... counted from the backend)
  await expect(page.getByText('Должно было начаться', { exact: true })).toBeVisible();
  await expect(page.getByText('Должно быть завершено', { exact: true })).toBeVisible();
  // colour never carries meaning alone: every state is also words; no п.п. anywhere; the neighbour's work is not here
  await expect(page.getByText('п.п.')).toHaveCount(0);
  await expect(page.getByText('Окраска фасада')).toHaveCount(0);
  await expect(page.getByText('Соседний объект')).toHaveCount(0);

  // the work name is a real button: keyboard users open the Work card
  await floor1.getByRole('button', { name: 'Штукатурка стен' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/object/${objectId}/work/${plasterId}$`));
});

test('W01: the work shows its own schedule summary and a clear path to the object\'s schedule — without duplicating the table', async ({ page }) => {
  const { token } = await mockLogin('DEPUTY_DIRECTOR');
  await openAs(page, token, `/object/${objectId}/work/${plasterId}`);
  await expect(page.getByRole('heading', { name: 'График производства работ', level: 2 })).toBeVisible();
  const section = page.locator('section').filter({ has: page.getByText('Плановое начало по графику') });
  await expect(section.getByText(ru(dt(-20)))).toBeVisible();
  await expect(section.getByText(ru(dt(13)))).toBeVisible();
  await expect(section.getByText('Есть отставание', { exact: true })).toBeVisible();
  await expect(section.getByText('5 дней')).toBeVisible();
  await expect(section.getByText('Позиций в графике')).toBeVisible();
  await expect(section.getByRole('table')).toHaveCount(0);
  // the existing sections are intact
  await expect(page.getByRole('heading', { name: 'Готовность выполнения', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Единицы исполнения и участки', level: 2 })).toBeVisible();

  await section.getByRole('button', { name: /График производства работ объекта/ }).click();
  await expect(page).toHaveURL(new RegExp(`/object/${objectId}/schedule$`));

  // the whole work, planned as a whole
  await page.goto(`/app.html/object/${objectId}/work/${ceilingId}`);
  const whole = page.locator('section').filter({ has: page.getByText('Плановое начало по графику') });
  await expect(whole.getByText('В работе', { exact: true })).toBeVisible();
  await expect(whole.getByText('Отставание', { exact: true })).toHaveCount(0);
});

test('read-only roles see the schedule and nothing to change; a РП of another object does not even see this object', async ({ page, browser }) => {
  const gd = await mockLogin('GENERAL_DIRECTOR');
  await openAs(page, gd.token, `/object/${objectId}/schedule`);
  await expect(positions(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Внести корректировку' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Указать причину' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Утвердить/ })).toHaveCount(0);

  const sk = await mockLogin('CONSTRUCTION_CONTROL');
  const skContext = await browser.newContext();
  const skPage = await skContext.newPage();
  await openAs(skPage, sk.token, `/object/${objectId}/schedule`);
  await expect(positions(skPage)).toBeVisible();
  await expect(skPage.getByRole('button', { name: 'Внести корректировку' })).toHaveCount(0);
  await skContext.close();

  // another object's schedule, through the URL, as the seeded РП (who is not its project manager)
  const pm = await mockLogin('PROJECT_MANAGER');
  const pmContext = await browser.newContext();
  const pmPage = await pmContext.newPage();
  await openAs(pmPage, pm.token, `/object/${neighbourId}/schedule`);
  await expect(pmPage.getByRole('heading', { name: 'Объект не найден', level: 1 })).toBeVisible();
  await expect(pmPage.getByText('Окраска фасада')).toHaveCount(0);
  await pmContext.close();
});

test('narrow screens: the schedule stays readable as labelled cards, no sideways page scroll', async ({ page }) => {
  const { token } = await mockLogin('DEPUTY_DIRECTOR');
  await page.setViewportSize({ width: 360, height: 780 });
  await openAs(page, token, `/object/${objectId}/schedule`);
  await expect(page.getByRole('heading', { name: 'График производства работ', level: 1 })).toBeVisible();
  const floor2 = rowOf(page, '2 этаж');
  await floor2.scrollIntoViewIfNeeded();
  await expect(floor2.getByText('Есть отставание', { exact: true })).toBeVisible();
  await expect(floor2).toContainText('Факт РП: 60 м²');
  await expect(floor2).toContainText('5 дней');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('the РП records WHY the zone is late: category, comment, the contractor concerned — with who and when; O01 then names the cause', async ({ page }) => {
  const pm = await mockLogin('PROJECT_MANAGER');
  await openAs(page, pm.token, `/object/${objectId}/schedule`);
  await expect(page.getByText('Причина отставания не указана.')).toBeVisible();
  await page.getByRole('button', { name: 'Указать причину' }).click();
  const form = page.getByRole('form', { name: 'Указать причину отставания' });
  await form.getByRole('button', { name: 'Записать причину' }).click();
  await expect(form.getByRole('alert')).toHaveText('Выберите причину');
  await form.getByLabel('Причина', { exact: true }).selectOption({ label: 'Материалы' });
  await form.getByRole('button', { name: 'Записать причину' }).click();
  await expect(form.getByRole('alert')).toHaveText('Опишите причину отставания');
  await form.getByLabel('Описание').fill('Штукатурная смесь не доставлена на объект');
  await expect(form.getByLabel('Ответственный (необязательно)')).toBeEnabled();
  await form.getByLabel('Ответственный (необязательно)').selectOption({ index: 1 });
  await form.getByRole('button', { name: 'Записать причину' }).click();

  const reasons = page.getByRole('list').filter({ hasText: 'Штукатурная смесь не доставлена на объект' });
  await expect(reasons).toBeVisible();
  await expect(reasons).toContainText('Материалы');
  await expect(reasons).toContainText('Открыта');
  await expect(reasons).toContainText(`Записал: ${pm.user.name}`);
  await expect(reasons).toContainText('На момент записи отставание — 5 дней');
  await expect(rowOf(page, '2 этаж')).toContainText('Причин указано: 1');

  // a completed zone takes no reason: there is nothing to explain, and no control offers it — only the delayed zone does
  await expect(rowOf(page, '1 этаж').getByText('Выполнено', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Указать причину' })).toHaveCount(1);

  await page.goto(`/app.html/object/${objectId}`);
  await expect(page.getByText('Причины: Материалы')).toBeVisible();

  // the CEO sees the reason, with its provenance, and cannot add or close one
  const gd = await mockLogin('GENERAL_DIRECTOR');
  const gdContext = await page.context().browser()!.newContext();
  const gdPage = await gdContext.newPage();
  await openAs(gdPage, gd.token, `/object/${objectId}/schedule`);
  await expect(gdPage.getByText('Штукатурная смесь не доставлена на объект')).toBeVisible();
  await expect(gdPage.getByText(`Записал: ${pm.user.name}`)).toBeVisible();
  await expect(gdPage.getByRole('button', { name: 'Указать причину' })).toHaveCount(0);
  await expect(gdPage.getByRole('button', { name: 'Закрыть причину' })).toHaveCount(0);
  await gdContext.close();
});

test('a correction: the РП prepares a draft, the approved dates keep measuring until the deputy approves with a reason; history keeps both versions', async ({ page, browser }) => {
  const pm = await mockLogin('PROJECT_MANAGER');
  await openAs(page, pm.token, `/object/${objectId}/schedule`);
  await page.getByRole('button', { name: 'Внести корректировку' }).click();
  await expect(page.getByRole('heading', { name: 'Черновик графика — версия №2', level: 2 })).toBeVisible();
  await expect(page.getByText('Корректировка утверждённого графика (версия №1)')).toBeVisible();
  // while the correction is a draft, plan-versus-fact still measures against the approved dates
  await expect(rowOf(page, '2 этаж')).toContainText('5 дней');

  const newFinish = dt(13);
  const edit = page.getByRole('form', { name: 'Изменить: Штукатурка стен · 2 этаж' });
  await edit.getByLabel('Окончание').fill(newFinish);
  await edit.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Изменено', { exact: true })).toBeVisible();
  await expect(page.getByText(`Утверждено: ${ru(dt(-8))} — ${ru(dt(6))}`)).toBeVisible();
  await expect(page.getByText(`Окончание: ${ru(dt(6))} → ${ru(newFinish)}`)).toBeVisible();
  // the РП prepares; management approves
  await expect(page.getByRole('button', { name: /Утвердить/ })).toHaveCount(0);
  // the quantity, zone and executor are not editable here: only dates, order and "follows"
  await expect(edit.getByLabel('Объём')).toHaveCount(0);
  await expect(edit.getByLabel('Исполнитель')).toHaveCount(0);

  // the deputy reads the same draft, sees exactly what would change, and must give a reason
  const deputy = await mockLogin('DEPUTY_DIRECTOR');
  const ctx = await browser.newContext();
  const dp = await ctx.newPage();
  await openAs(dp, deputy.token, `/object/${objectId}/schedule`);
  await expect(dp.getByText('Что изменится относительно утверждённого графика')).toBeVisible();
  await expect(dp.getByText(`Окончание: ${ru(dt(6))} → ${ru(newFinish)}`).first()).toBeVisible();
  const approve = dp.getByRole('form', { name: 'Утвердить корректировку' });
  await approve.getByRole('button', { name: 'Утвердить корректировку' }).click();
  await expect(approve.getByRole('alert')).toHaveText('Укажите причину корректировки');
  await approve.getByLabel('Причина корректировки').fill('Поставка смеси сдвинута на неделю');
  await approve.getByRole('button', { name: 'Утвердить корректировку' }).click();

  await expect(dp.getByText('Утверждённый график — версия №2')).toBeVisible();
  await expect(dp.getByText('Причина корректировки: Поставка смеси сдвинута на неделю').first()).toBeVisible();
  await expect(dp.getByRole('heading', { name: /Черновик графика/ })).toHaveCount(0);
  const floor2 = rowOf(dp, '2 этаж');
  await expect(floor2).toContainText(ru(newFinish));
  await expect(floor2).toContainText('Относительно первого графика: окончание +7 дн.');
  await expect(floor2).toContainText('3 дня'); // the same fact against the corrected dates — and the correction is visible on the row

  // history: the replaced version is kept, with its dates, approver and what the correction changed
  await dp.getByText('Версия №2 — Действует').click();
  await expect(dp.getByText(`Окончание: ${ru(dt(6))} → ${ru(newFinish)}`).first()).toBeVisible();
  await expect(dp.getByText('Версия №1 — Заменена версией №2')).toBeVisible();
  await ctx.close();
});

test('an explanation of a delay that has since been overcome can still be closed: the zone caught up, and the open reason is not stuck for good', async ({ page }) => {
  // zone 2 catches up: the RP reports the whole 300 м²
  const pm = await mockLogin('PROJECT_MANAGER');
  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${pm.token}` };
  const snapshot = await (await fetch(`${API}/snapshot`, { headers: auth })).json();
  const unit = snapshot.executionUnits.find((u: any) => u.objectWorkId === plasterId && u.location === '2 этаж');
  const portion = snapshot.portions.find((p: any) => p.executionUnitId === unit.id);
  const reported = await fetch(`${API}/portions/${portion.id}/fact`, { method: 'POST', headers: auth, body: JSON.stringify({ quantity: 300, version: portion.version, comment: 'Факт РП' }) });
  expect(reported.status).toBe(201);

  await openAs(page, pm.token, `/object/${objectId}/schedule`);
  await expect(rowOf(page, '2 этаж').getByText('Выполнено', { exact: true })).toBeVisible();
  // the form for a NEW reason went with the delay ...
  await expect(page.getByRole('button', { name: 'Указать причину' })).toHaveCount(0);
  // ... the old explanation is still listed, still open, and can be closed
  const reasons = page.getByRole('list').filter({ hasText: 'Штукатурная смесь не доставлена на объект' });
  await expect(reasons).toContainText('Открыта');
  await expect(rowOf(page, '2 этаж')).toContainText('Причин указано: 1');
  await reasons.getByRole('button', { name: 'Закрыть причину' }).click();
  const form = page.getByRole('form', { name: /Закрыть причину/ });
  await form.getByLabel('Что изменилось (необязательно)').fill('Участок выполнен');
  await form.getByRole('button', { name: 'Закрыть причину' }).click();
  await expect(reasons).toContainText('Закрыта');
  await expect(reasons).toContainText('Участок выполнен');
  await expect(rowOf(page, '2 этаж')).not.toContainText('Причин указано');
  await expect(page.getByRole('button', { name: 'Закрыть причину' })).toHaveCount(0);
});

test('W01 for a PTO engineer who holds only this work\'s handoff: the work\'s schedule summary, and no door into an object plan that is shut to them', async ({ page }) => {
  const handoff = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'gpr-1-browser-handoff.json'), 'utf8')) as { token: string; objectId: string; workId: string };
  await openAs(page, handoff.token, `/object/${handoff.objectId}/work/${handoff.workId}`);
  await expect(page.getByRole('heading', { name: 'График производства работ', level: 2 })).toBeVisible();
  const section = page.locator('section').filter({ has: page.getByText('Плановое начало по графику') });
  await expect(section.getByText(ru(dt(-2)))).toBeVisible();
  await expect(section.getByText(ru(dt(10)))).toBeVisible();
  // the object's schedule is not theirs to open (403), so W01 does not offer a button that ends on an error page
  await expect(page.getByRole('button', { name: /График производства работ объекта/ })).toHaveCount(0);
  await page.goto(`/app.html/object/${handoff.objectId}/schedule`);
  await expect(page.getByText('График производства работ недоступен для вашей роли или для этого объекта')).toBeVisible();
});

test('stepping from one object straight to another never paints the first object\'s plan under the second: loading until the new schedule arrives', async ({ page }) => {
  const deputy = await mockLogin('DEPUTY_DIRECTOR');
  // the neighbour's schedule answers slowly, so the in-between state can be observed
  await page.route(`**/api/objects/${neighbourId}/schedule*`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.continue();
  });
  await openAs(page, deputy.token, `/object/${objectId}/schedule`);
  await expect(positions(page)).toBeVisible();
  await expect(page.getByText('Штукатурка стен').first()).toBeVisible();

  // history reuses the SAME route element when only the object id changes (a jump in the browser's history list does exactly this)
  await page.evaluate((to) => {
    window.history.pushState(null, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, `/app.html/object/${neighbourId}/schedule`);
  await expect(page).toHaveURL(new RegExp(`/object/${neighbourId}/schedule$`));
  await page.waitForTimeout(800);
  // a point-in-time look while the neighbour's schedule is still on its way — not an auto-retrying assertion, which would wait the stale
  // screen out and pass anyway: nothing of the first object may be on screen now
  expect(await page.getByText('Штукатурка стен').count(), 'the first object\'s plan under the second object\'s address').toBe(0);
  expect(await page.getByText('Тест после удаления ролей').count(), 'the first object\'s name under the second object\'s address').toBe(0);
  // ... and then the neighbour's own plan
  await expect(page.getByText('Окраска фасада').first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('Штукатурка стен')).toHaveCount(0);
});
