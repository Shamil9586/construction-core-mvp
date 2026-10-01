import { test, expect, type Page } from '@playwright/test';

/**
 * ORG-1 — «Структура компании» in a real browser against a REAL backend (playwright.org1.config.ts).
 * Setup (users, object assignments) goes through the API; the organizational actions under test are done in the UI.
 */
const API = 'http://127.0.0.1:3001';
const KEY = 'org1-browser-key';
const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);

async function api(token: string, method: string, path: string, body?: unknown, expected?: number) {
  const r = await fetch(`${API}/${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data: any = await r.json().catch(() => null);
  if (expected !== undefined) expect(r.status, `${method} ${path}: ${JSON.stringify(data)}`).toBe(expected);
  return { status: r.status, data };
}
async function mockLogin(role: string) {
  const r = await fetch(`${API}/auth/mock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, key: KEY }) });
  const d: any = await r.json();
  return { token: d.token as string, user: d.user };
}
async function openAs(page: Page, token: string, path: string) {
  await page.addInitScript((value: string) => window.sessionStorage.setItem('session', value), token);
  await page.goto(`/app.html${path}`);
}
const noHorizontalScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

test('Deputy: assign, transfer (reason required), end, history, inherited indicator; no object change; mobile has no page scroll', async ({ page }) => {
  const admin = await mockLogin('ADMIN'), deputy = await mockLogin('DEPUTY_DIRECTOR'), pm = await mockLogin('PROJECT_MANAGER');
  const mk = async (name: string, role: string, i: number) => (await api(admin.token, 'POST', 'users', { bitrixUserId: String(900 + i), name, role }, 201)).data;
  const h1 = await mk('Альфа Начальник', 'PTO_HEAD', 1), h2 = await mk('Бета Начальник', 'PTO_HEAD', 2);
  const e1 = await mk('Гамма Инженер', 'PTO', 3), e2 = await mk('Дельта Инженер', 'PTO', 4);
  const contractors = (await api(pm.token, 'GET', 'contractors')).data;
  const obj = (await api(deputy.token, 'POST', 'objects', { externalCode: `ORG1-${Date.now()}`, name: 'Объект Орг', address: 'Тест, 1', organizationName: 'ООО СЗ', projectManagerId: pm.user.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] }, 201)).data;
  await api(deputy.token, 'POST', 'function-teams/pto/org-members', { memberUserId: e1.id, managerUserId: h1.id }, 201);
  await api(deputy.token, 'POST', `objects/${obj.id}/function-team/pto/lead`, { leadUserId: h2.id }, 201);
  await api(deputy.token, 'POST', 'function-teams/pto/redistribute', { reason: 'Старт', memberAdds: [{ objectId: obj.id, memberUserId: e1.id }] }, 201);
  // Object axis only (lead + member assignment ids/users/versions): the derived org-manager label legitimately changes.
  const objectAxis = async () => { const c = (await api(deputy.token, 'GET', `objects/${obj.id}/function-team/pto`)).data.current; return JSON.stringify({ lead: [c.lead.assignmentId, c.lead.userId, c.lead.version], members: c.members.map((m: any) => [m.assignmentId, m.userId, m.version]) }); };
  const objectsBefore = await objectAxis();

  await openAs(page, deputy.token, '/company-structure');
  await expect(page.getByRole('heading', { name: 'Структура компании', level: 1 })).toBeVisible();
  for (const name of ['Руководство', 'ПТО', 'Строительный контроль', 'СДО', 'Руководители проектов']) await expect(page.getByRole('heading', { name, level: 2, exact: true })).toBeVisible();
  await expect(page.getByRole('navigation').getByText('Структура компании')).toBeVisible();

  // «Без руководителя»: assign Delta to Alpha.
  const pto = page.getByRole('region', { name: 'ПТО', exact: true });
  const delta = pto.getByRole('listitem', { name: 'Дельта Инженер' });
  await expect(delta).toContainText('Без руководителя');
  await delta.getByRole('button', { name: 'Назначить руководителя' }).click();
  await delta.getByLabel('Руководитель').selectOption({ label: 'Альфа Начальник' });
  await delta.getByRole('button', { name: 'Назначить', exact: true }).click();
  const alpha = pto.getByRole('region', { name: 'ПТО: Альфа Начальник' });
  await expect(alpha.getByRole('listitem', { name: 'Дельта Инженер' })).toBeVisible();

  // Gamma: under Alpha, works on Бета's object -> valid, labelled, not an error.
  const gamma = alpha.getByRole('listitem', { name: 'Гамма Инженер' });
  await expect(gamma).toContainText('Другая организационная команда');
  await expect(gamma).toContainText('Объект Орг');

  // Transfer needs a reason: the button stays disabled until a real reason is typed.
  await gamma.getByRole('button', { name: 'Перевести к другому руководителю' }).click();
  await gamma.getByLabel('Руководитель').selectOption({ label: 'Бета Начальник' });
  const confirm = gamma.getByRole('button', { name: 'Перевести', exact: true });
  await expect(confirm).toBeDisabled();
  await gamma.getByLabel('Причина (обязательна)').fill('   ');
  await expect(confirm).toBeDisabled();
  await gamma.getByLabel('Причина (обязательна)').fill('Баланс нагрузки');
  await confirm.click();
  const beta = pto.getByRole('region', { name: 'ПТО: Бета Начальник' });
  await expect(beta.getByRole('listitem', { name: 'Гамма Инженер' })).toBeVisible();
  await expect(beta.getByRole('listitem', { name: 'Гамма Инженер' })).not.toContainText('Другая организационная команда');

  // History of Gamma.
  const gamma2 = beta.getByRole('listitem', { name: 'Гамма Инженер' });
  await gamma2.getByRole('button', { name: 'История изменений' }).click();
  const hist = gamma2.getByRole('list', { name: 'История изменений: Гамма Инженер' });
  await expect(hist).toContainText('Альфа Начальник');
  await expect(hist).toContainText('причина: Баланс нагрузки');

  // End: reason required, then the employee is back under «Без руководителя».
  await gamma2.getByRole('button', { name: 'Завершить членство' }).click();
  const endBtn = gamma2.getByRole('button', { name: 'Завершить членство' }).last();
  await expect(endBtn).toBeDisabled();
  await gamma2.getByLabel('Причина (обязательна)').fill('Выход из команды');
  await endBtn.click();
  await expect(pto.getByRole('region', { name: 'ПТО: Без руководителя' }).getByRole('listitem', { name: 'Гамма Инженер' })).toBeVisible();

  // No object change from any org action.
  expect(await objectAxis()).toBe(objectsBefore);

  // Responsive: phone width, cards stack, no page-level horizontal scroll, drawer navigation reaches the screen.
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.getByRole('heading', { name: 'Структура компании', level: 1 })).toBeVisible();
  await noHorizontalScroll(page);
});

test('General Director: full overview, no controls', async ({ page }) => {
  const gd = await mockLogin('GENERAL_DIRECTOR');
  await openAs(page, gd.token, '/company-structure');
  await expect(page.getByRole('heading', { name: 'Структура компании', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Руководство', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Руководители проектов', level: 2 })).toBeVisible();
  await expect(page.getByRole('button', { name: /Назначить руководителя|Перевести к другому|Завершить членство/ })).toHaveCount(0);
});

test('Functional head: own team only; ordinary engineer and РП: denied, no sidebar item, no request', async ({ page }) => {
  const admin = await mockLogin('ADMIN'), deputy = await mockLogin('DEPUTY_DIRECTOR');
  const mk = async (name: string, role: string, i: number) => (await api(admin.token, 'POST', 'users', { bitrixUserId: String(950 + i), name, role }, 201)).data;
  const head = await mockLogin('SDO_HEAD'); // the seeded SDO_HEAD is the signed-in head; their own team is the only one they may see
  const other = await mk('Чужой Начальник СДО', 'SDO_HEAD', 2);
  const mine = await mk('Свой Сметчик', 'SDO', 3), theirs = await mk('Чужой Сметчик', 'SDO', 4), loose = await mk('Нераспределённый Сметчик', 'SDO', 5);
  void loose;
  await api(deputy.token, 'POST', 'org-structure/SDO/assign', { memberUserId: mine.id, managerUserId: head.user.id }, 201);
  await api(deputy.token, 'POST', 'org-structure/SDO/assign', { memberUserId: theirs.id, managerUserId: other.id }, 201);
  await openAs(page, head.token, '/company-structure');
  await expect(page.getByRole('heading', { name: 'Структура компании', level: 1 })).toBeVisible();
  await expect(page.getByText('Показана только ваша организационная команда.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Руководство', level: 2 })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'ПТО', level: 2, exact: true })).toHaveCount(0);
  await expect(page.getByText('Чужой Сметчик')).toHaveCount(0);
  await expect(page.getByText('Чужой Начальник СДО')).toHaveCount(0);
  await expect(page.getByText('Нераспределённый Сметчик')).toHaveCount(0);
  await expect(page.getByText('Свой Сметчик')).toBeVisible();
  await expect(page.getByText('Без руководителя')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Назначить руководителя|Перевести к другому|Завершить членство/ })).toHaveCount(0);
});

for (const role of ['PTO', 'PROJECT_MANAGER', 'SDO', 'CONSTRUCTION_CONTROL']) {
  test(`${role}: «Структура компании» is denied and not in the sidebar`, async ({ page }) => {
    const u = await mockLogin(role);
    const requests: string[] = [];
    page.on('request', (r) => { if (r.url().includes('org-structure')) requests.push(r.url()); });
    await openAs(page, u.token, '/company-structure');
    await expect(page.getByText('Раздел «Структура компании» доступен руководству и начальникам подразделений.')).toBeVisible();
    await expect(page.getByRole('navigation').getByText('Структура компании')).toHaveCount(0);
    expect(requests).toEqual([]);
  });
}
