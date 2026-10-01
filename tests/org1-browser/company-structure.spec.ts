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

const FORBIDDEN_TEXT = [/Роль:/, /Организационная команда/, /начальник объекта/i, /На объектах/, /Количество объектов/, /Ведёт объект/, /объектов:/i, /Завершить членство/, /Уволить/];
const expectNoObjectOrTechnicalText = async (page: Page) => {
  const main = page.locator('main');
  for (const re of FORBIDDEN_TEXT) await expect(main.getByText(re)).toHaveCount(0);
};

test('Deputy: leadership once, head/employee hierarchy, no object info, ⋯ menu, change manager with id+version+reason, no object change; mobile', async ({ page }) => {
  const admin = await mockLogin('ADMIN'), deputy = await mockLogin('DEPUTY_DIRECTOR'), pm = await mockLogin('PROJECT_MANAGER');
  const mk = async (name: string, role: string, i: number) => (await api(admin.token, 'POST', 'users', { bitrixUserId: String(900 + i), name, role }, 201)).data;
  const h1 = await mk('Альфа Начальник', 'PTO_HEAD', 1), h2 = await mk('Бета Начальник', 'PTO_HEAD', 2);
  const e1 = await mk('Гамма Инженер', 'PTO', 3);
  const contractors = (await api(pm.token, 'GET', 'contractors')).data;
  const obj = (await api(deputy.token, 'POST', 'objects', { externalCode: `ORG1-${Date.now()}`, name: 'Объект Орг', address: 'Тест, 1', organizationName: 'ООО СЗ', projectManagerId: pm.user.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] }, 201)).data;
  await api(deputy.token, 'POST', 'function-teams/pto/org-members', { memberUserId: e1.id, managerUserId: h1.id }, 201);
  await api(deputy.token, 'POST', `objects/${obj.id}/function-team/pto/lead`, { leadUserId: h2.id }, 201);
  await api(deputy.token, 'POST', 'function-teams/pto/redistribute', { reason: 'Старт', memberAdds: [{ objectId: obj.id, memberUserId: e1.id }] }, 201);
  const objectAxis = async () => { const c = (await api(deputy.token, 'GET', `objects/${obj.id}/function-team/pto`)).data.current; return JSON.stringify({ lead: [c.lead.assignmentId, c.lead.userId, c.lead.version], members: c.members.map((m: any) => [m.assignmentId, m.userId, m.version]) }); };
  const pmBefore = JSON.stringify((await api(deputy.token, 'GET', `objects/${obj.id}`)).data.projectManagerId);
  const axisBefore = await objectAxis();

  await openAs(page, deputy.token, '/company-structure');
  await expect(page.getByRole('heading', { name: 'Структура компании', level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation').getByText('Структура компании')).toBeVisible();

  // Руководство: GD + Deputy, each exactly once on the whole screen.
  const lead = page.getByRole('region', { name: 'Руководство' });
  await expect(lead.getByRole('listitem', { name: 'Александр Волков' })).toContainText('Генеральный директор');
  await expect(lead.getByRole('listitem', { name: 'Виктор Соловьёв' })).toContainText('Заместитель директора');
  await expect(page.locator('main').getByText('Виктор Соловьёв')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Производственный блок', level: 2 })).toBeVisible();

  // Руководители проектов: Project Managers only, no Deputy card, no «Без руководителя».
  const pms = page.getByRole('region', { name: 'Руководители проектов', exact: true });
  await expect(pms.getByRole('listitem', { name: 'Михаил Соколов' })).toContainText('Руководитель проекта');
  await expect(pms.getByText('Заместитель директора')).toHaveCount(0);
  await expect(pms.getByText('Без руководителя')).toHaveCount(0);
  await expect(pms.getByRole('region')).toHaveCount(0);

  // ПТО: head card, employees below it, positions only.
  const pto = page.getByRole('region', { name: 'ПТО', exact: true });
  const alpha = pto.getByRole('region', { name: 'ПТО: Альфа Начальник' });
  await expect(alpha).toContainText('Начальник ПТО');
  await expect(alpha.getByText('Сотрудники', { exact: true })).toBeVisible();
  const gamma = alpha.getByRole('listitem', { name: 'Гамма Инженер' });
  await expect(gamma).toContainText('Инженер ПТО');
  // СК / СДО keep their heads and employees.
  await expect(page.getByRole('region', { name: 'Строительный контроль', exact: true }).getByRole('region', { name: /Татьяна Лебедева/ })).toContainText('Начальник СК');
  await expect(page.getByRole('region', { name: 'СДО', exact: true }).getByRole('region', { name: /Роман Фролов/ })).toContainText('Начальник СДО');
  // «Без руководителя» pseudo-card is gone; a real exception group is titled honestly (only when someone is really unassigned).
  await expect(page.locator('main').getByText(/^Без руководителя$/)).toHaveCount(0);
  await expectNoObjectOrTechnicalText(page);
  await expect(page.locator('main').getByText('Объект Орг')).toHaveCount(0);

  // Actions only behind ⋯.
  await expect(gamma.getByRole('button', { name: 'Сменить руководителя' })).toHaveCount(0);
  await expect(gamma.getByRole('button', { name: 'История изменений' })).toHaveCount(0);
  await gamma.getByRole('button', { name: 'Действия: Гамма Инженер' }).click();
  const items = gamma.getByRole('menuitem');
  await expect(items).toHaveText(['Сменить руководителя', 'История изменений']);
  await expect(page.getByText(/Завершить членство|Уволить|Перевести в другое подразделение/)).toHaveCount(0);

  // Change manager: dialog, mandatory reason, exact id + version in the request.
  await gamma.getByRole('menuitem', { name: 'Сменить руководителя' }).click();
  const dialog = page.getByRole('dialog', { name: 'Сменить руководителя' });
  await expect(dialog).toContainText('Гамма Инженер'); await expect(dialog).toContainText('ПТО'); await expect(dialog).toContainText('Альфа Начальник');
  await dialog.getByLabel('Новый руководитель').selectOption({ label: 'Бета Начальник' });
  const confirm = dialog.getByRole('button', { name: 'Сменить руководителя' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('Причина').fill('   ');
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('Причина').fill('Баланс нагрузки');
  const current = await api(deputy.token, 'GET', 'org-structure');
  const cur = current.data.functions.find((f: any) => f.functionCode === 'PTO').managers.find((m: any) => m.userId === h1.id).orgMembers.find((m: any) => m.userId === e1.id).assignment;
  const reqP = page.waitForRequest((r) => r.url().includes('org-structure/PTO/transfer'));
  await confirm.click();
  const sent = (await reqP).postDataJSON();
  expect(sent).toEqual({ memberUserId: e1.id, managerUserId: h2.id, reason: 'Баланс нагрузки', expectedAssignmentId: cur.assignmentId, expectedVersion: cur.version });
  const beta = pto.getByRole('region', { name: 'ПТО: Бета Начальник' });
  await expect(beta.getByRole('listitem', { name: 'Гамма Инженер' })).toBeVisible();

  // History behind the same menu.
  const gamma2 = beta.getByRole('listitem', { name: 'Гамма Инженер' });
  await gamma2.getByRole('button', { name: 'Действия: Гамма Инженер' }).click();
  await gamma2.getByRole('menuitem', { name: 'История изменений' }).click();
  const hist = gamma2.getByRole('list', { name: 'История изменений: Гамма Инженер' });
  await expect(hist).toContainText('Альфа Начальник'); await expect(hist).toContainText('причина: Баланс нагрузки');

  // No object / PBX-3A / РП change from the org action.
  expect(await objectAxis()).toBe(axisBefore);
  expect(JSON.stringify((await api(deputy.token, 'GET', `objects/${obj.id}`)).data.projectManagerId)).toBe(pmBefore);

  // Responsive: phone width, no page-level horizontal scroll, menu and dialog still usable.
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.getByRole('heading', { name: 'Структура компании', level: 1 })).toBeVisible();
  await noHorizontalScroll(page);
  await page.getByRole('button', { name: 'Действия: Гамма Инженер' }).click();
  await page.getByRole('menuitem', { name: 'Сменить руководителя' }).click();
  await expect(page.getByRole('dialog', { name: 'Сменить руководителя' })).toBeVisible();
  await noHorizontalScroll(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('General Director: full overview, no controls', async ({ page }) => {
  const gd = await mockLogin('GENERAL_DIRECTOR');
  await openAs(page, gd.token, '/company-structure');
  await expect(page.getByRole('heading', { name: 'Структура компании', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Руководство', level: 2 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Руководители проектов', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Действия:/ }).first()).toBeVisible(); // history only
  await page.getByRole('button', { name: /Действия:/ }).first().click();
  await expect(page.getByRole('menuitem')).toHaveText(['История изменений']);
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
  await expect(page.getByText('Показана только ваша команда.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Руководство', level: 2 })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'ПТО', level: 2, exact: true })).toHaveCount(0);
  await expect(page.getByText('Чужой Сметчик')).toHaveCount(0);
  await expect(page.getByText('Чужой Начальник СДО')).toHaveCount(0);
  await expect(page.getByText('Нераспределённый Сметчик')).toHaveCount(0);
  await expect(page.getByText('Свой Сметчик')).toBeVisible();
  await expect(page.getByText('Без руководителя')).toHaveCount(0);
  await expectNoObjectOrTechnicalText(page);
  await page.getByRole('button', { name: 'Действия: Свой Сметчик' }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['История изменений']); // a head never mutates
});

test('Missing department head: section-level notice + real unassigned employees only; no pseudo-card', async ({ page }) => {
  const admin = await mockLogin('ADMIN'), deputy = await mockLogin('DEPUTY_DIRECTOR');
  const head = (await api(admin.token, 'GET', 'admin/users')).data.users.find((u: any) => u.name === 'Татьяна Лебедева');
  await api(admin.token, 'PATCH', `admin/users/${head.id}`, { isActive: false }, 200);
  await openAs(page, deputy.token, '/company-structure');
  const sc = page.getByRole('region', { name: 'Строительный контроль', exact: true });
  await expect(sc.getByText('Руководитель подразделения не назначен')).toBeVisible();
  await expect(sc.getByText('Начальник назначается в разделе «Пользователи и доступ».')).toBeVisible();
  await expect(sc.getByRole('region', { name: 'Строительный контроль: Сотрудники без руководителя' })).toContainText('Елена Крылова');
  await expect(sc.getByRole('button', { name: 'Действия: Елена Крылова' })).toHaveCount(0); // nobody to assign to
  await expect(page.locator('main').getByText(/^Без руководителя$/)).toHaveCount(0);
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
