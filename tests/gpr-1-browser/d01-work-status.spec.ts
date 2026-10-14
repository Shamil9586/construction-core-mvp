import { test, expect, type Page } from '@playwright/test';

/**
 * GPR-UX-D01 — after a GPR is approved, schedule compliance on O01 / W01 comes from the GPR alone; the physical state («Не начато» /
 * «В работе» / «Выполнено») is shown separately; the legacy `work.scheduleStatus` produces no schedule verdict. Read-only: the contradictions
 * are produced by rewriting the responses the page receives (the backend data stays as the other GPR specs expect it).
 */
const API = 'http://127.0.0.1:3001';
const KEY = 'gpr-1-browser-key';
async function mockLogin(role: string) {
  const r = await fetch(`${API}/auth/mock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, key: KEY }) });
  return (await r.json()) as { token: string };
}
let objectId = '', plasterId = '', ceilingId = '', neighbourId = '';
test.beforeAll(async () => {
  const { token } = await mockLogin('DEPUTY_DIRECTOR');
  const snap = await (await fetch(`${API}/snapshot`, { headers: { Authorization: `Bearer ${token}` } })).json();
  objectId = snap.objects.find((o: any) => o.name === 'Тест после удаления ролей').id;
  neighbourId = snap.objects.find((o: any) => o.name === 'Соседний объект').id;
  plasterId = snap.works.find((w: any) => w.objectId === objectId && w.name === 'Штукатурка стен').id;
  ceilingId = snap.works.find((w: any) => w.objectId === objectId && w.name === 'Окраска потолков').id;
});

/** The legacy verdicts are made to CONTRADICT the GPR: plastering (GPR: delayed) reads GREEN, ceilings (GPR: on schedule) read RED. */
async function contradictLegacy(page: Page, extra: { injectUnscheduled?: boolean; noBaseline?: boolean } = {}) {
  await page.route(/\/api\/snapshot(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const work of body.works) {
      if (work.id === plasterId) Object.assign(work, { scheduleStatus: 'GREEN', delayDays: 0, blockers: [] });
      if (work.id === ceilingId) Object.assign(work, { scheduleStatus: 'RED', delayDays: 40, blockers: ['Нет допуска строительного контроля'] });
    }
    if (extra.injectUnscheduled) {
      const template = body.works.find((w: any) => w.id === ceilingId);
      body.works.push({ ...template, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', name: 'Работа вне графика', scheduleStatus: 'RED', lastReportedAt: null, actualQuantity: '0.0000', actualProgress: null, blockers: [] });
    }
    await route.fulfill({ response, json: body });
  });
  if (extra.noBaseline) {
    await page.route(/\/api\/objects\/[^/]+\/schedule(\?.*)?$/, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      Object.assign(body, { current: null, entries: [], conclusion: { ...body.conclusion, status: 'NO_BASELINE', entryCount: 0, delayedCount: 0 } });
      await route.fulfill({ response, json: body });
    });
  }
}
async function openAs(page: Page, token: string, path: string) {
  await page.addInitScript((value: string) => window.sessionStorage.setItem('session', value), token);
  await page.goto(`/app.html${path}`);
}
const worksTable = (page: Page) => page.getByRole('table', { name: /Работы объекта/ });
const rowOf = (page: Page, name: string) => worksTable(page).getByRole('row').filter({ hasText: name }).first();

test('O01: the GPR decides compliance against contradicting legacy statuses; physical state, blocker and GPR verdict are separate cells', async ({ page }) => {
  await contradictLegacy(page, { injectUnscheduled: true });
  const { token } = await mockLogin('DEPUTY_DIRECTOR');
  await openAs(page, token, `/object/${objectId}`);
  await expect(worksTable(page)).toBeVisible();
  const headers = await worksTable(page).getByRole('columnheader').allInnerTexts();
  expect(headers.map((h) => h.trim().toLowerCase()).filter(Boolean)).toEqual(['работа / исполнитель', 'план', 'факт', 'смр', 'выполнение', 'график']);

  const plaster = rowOf(page, 'Штукатурка стен');
  await expect(plaster.getByRole('cell').nth(4)).toHaveText('В работе'); // physical state
  await expect(plaster.getByRole('cell').nth(5)).toHaveText('Есть отставание'); // the GPR (a zone is late), though legacy says GREEN

  const ceiling = rowOf(page, 'Окраска потолков');
  await expect(ceiling.getByRole('cell').nth(4)).toContainText('В работе');
  await expect(ceiling.getByRole('cell').nth(4)).toContainText('Заблокировано'); // the operational blocker stays visible, beside the state
  await expect(ceiling.getByRole('cell').nth(5)).toHaveText('По графику'); // the GPR, though legacy says RED with 40 delay days

  const unscheduled = rowOf(page, 'Работа вне графика');
  await expect(unscheduled.getByRole('cell').nth(4)).toHaveText('Не начато');
  await expect(unscheduled.getByRole('cell').nth(5)).toHaveText('Не включена в график');
  await expect(unscheduled.getByRole('cell').nth(3)).toHaveText('—'); // nothing reported stays «—» in the SMR column…
  await expect(unscheduled.getByRole('cell').nth(2)).toHaveText('—'); // …and in the fact

  // blockers are listed separately with their reasons; documentary navigation and the schedule door are intact
  await expect(page.getByText('Блокировки в производстве', { exact: true })).toBeVisible();
  await expect(page.getByText('Нет допуска строительного контроля', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /График производства работ/ })).toBeVisible();
});

test('O01: no approved GPR → «График не утверждён» for every work, never «По графику» (legacy RED / GREEN ignored)', async ({ page }) => {
  await contradictLegacy(page, { noBaseline: true });
  const { token } = await mockLogin('DEPUTY_DIRECTOR');
  await openAs(page, token, `/object/${objectId}`);
  await expect(worksTable(page)).toBeVisible();
  for (const name of ['Штукатурка стен', 'Окраска потолков']) await expect(rowOf(page, name).getByRole('cell').nth(5)).toHaveText('График не утверждён');
  await expect(worksTable(page).getByText('По графику')).toHaveCount(0);
  await expect(worksTable(page).getByText('Есть отставание')).toHaveCount(0);
});

test('O01: a schedule that is not offered (unavailable) makes no compliance claim and does not fall back to the legacy status', async ({ page }) => {
  await contradictLegacy(page);
  await page.route(/\/api\/objects\/[^/]+\/schedule(\?.*)?$/, (route) => route.fulfill({ status: 403, json: { message: 'Forbidden' } }));
  const { token } = await mockLogin('DEPUTY_DIRECTOR');
  await openAs(page, token, `/object/${objectId}`);
  await expect(worksTable(page)).toBeVisible();
  await expect(rowOf(page, 'Штукатурка стен').getByRole('cell').nth(5)).toHaveText('График недоступен');
  await expect(rowOf(page, 'Окраска потолков').getByRole('cell').nth(5)).toHaveText('График недоступен');
  await expect(worksTable(page).getByText('По графику')).toHaveCount(0);
  await expect(worksTable(page).getByText('Есть отставание')).toHaveCount(0);
});

test('W01: the header states only the physical state (and the blocker); the one schedule verdict is the GPR section\'s', async ({ page }) => {
  await contradictLegacy(page);
  const { token } = await mockLogin('DEPUTY_DIRECTOR');

  // plastering: legacy GREEN, GPR delayed
  await openAs(page, token, `/object/${objectId}/work/${plasterId}`);
  await expect(page.getByRole('heading', { name: 'График производства работ', level: 2 })).toBeVisible();
  await expect(page.getByText('Выполнение', { exact: true })).toBeVisible(); // the header's caption of the physical state
  await expect(page.getByText('В работе', { exact: true })).toHaveCount(1); // the header badge only: the GPR says «Есть отставание» for this work
  await expect(page.getByText('Есть отставание', { exact: true })).toHaveCount(1); // exactly one schedule verdict on the screen: the GPR section's
  await expect(page.getByText('По графику', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Состояние по графику', { exact: true })).toBeVisible();

  // ceilings: legacy RED + a blocker, GPR on schedule
  await page.goto(`/app.html/object/${objectId}/work/${ceilingId}`);
  await expect(page.getByRole('heading', { name: 'График производства работ', level: 2 })).toBeVisible();
  await expect(page.getByText('Есть отставание', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Заблокировано', { exact: true })).toBeVisible();
  await expect(page.getByText('Причины блокировки', { exact: true })).toBeVisible();
  await expect(page.getByText('Нет допуска строительного контроля', { exact: true })).toBeVisible();
  // the sections W01 keeps are still there
  for (const heading of ['Производство', 'Подтверждение']) await expect(page.getByRole('heading', { name: heading, level: 2 })).toBeVisible();
});

test('switching from one object straight to another never paints the first object\'s schedule verdicts on the second', async ({ page }) => {
  const { token } = await mockLogin('DEPUTY_DIRECTOR');
  await openAs(page, token, `/object/${objectId}`);
  await expect(rowOf(page, 'Штукатурка стен').getByRole('cell').nth(5)).toHaveText('Есть отставание');
  await page.route(new RegExp(`/api/objects/${neighbourId}/schedule(\\?.*)?$`), async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800)); // the new object's schedule arrives late
    await route.continue();
  });
  await page.evaluate((id) => { window.history.pushState({}, '', `/app.html/object/${id}`); window.dispatchEvent(new PopStateEvent('popstate')); }, neighbourId);
  await expect(page.getByRole('heading', { name: 'Соседний объект', level: 1 })).toBeVisible();
  const neighbourRow = rowOf(page, 'Окраска фасада');
  await expect(neighbourRow).toBeVisible();
  await expect(neighbourRow.getByRole('cell').nth(5)).toHaveText('Загрузка графика…');
  await expect(worksTable(page).getByText('Штукатурка стен')).toHaveCount(0);
  await expect(neighbourRow.getByRole('cell').nth(5)).not.toHaveText('Загрузка графика…');
});
