import { test, expect, type Page } from '@playwright/test';

/**
 * PBX-3A — the Kuznetsov → Smirnov / Ivanov scenario, rendered in a real browser against a REAL backend
 * (playwright.pbx3a.config.ts). Setup (users, objects, initial assignments) goes through the API as the
 * seeded roles; the two Deputy Director redistributions — the point of this gate — are performed in the UI.
 *
 * Smirnov = the seeded PTO_HEAD. Kuznetsov, Ivanov and the four engineers are created here.
 */
const API = 'http://127.0.0.1:3001';
const KEY = 'pbx3a-browser-key';
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

test('Deputy redistributes Kuznetsov\'s team in the UI; lead swap keeps members, Akhmetov/Orlov swap is one operation', async ({ page }) => {
  const admin = await mockLogin('ADMIN'), deputy = await mockLogin('DEPUTY_DIRECTOR'), td = await mockLogin('TECHNICAL_DIRECTOR'), pm = await mockLogin('PROJECT_MANAGER'), head = await mockLogin('PTO_HEAD');
  const smirnov = head.user;
  const mk = async (name: string, role: string, i: number) => (await api(admin.token, 'POST', 'users', { bitrixUserId: String(700 + i), name, role }, 201)).data;
  const kuznetsov = await mk('Кузнецов Игорь', 'PTO_HEAD', 1), ivanov = await mk('Иванов Олег', 'PTO_HEAD', 2);
  const petrov = await mk('Петров Пётр', 'PTO', 3), sidorov = await mk('Сидоров Семён', 'PTO', 4), akhmetov = await mk('Ахметов Ахмет', 'PTO', 5), orlov = await mk('Орлов Олег', 'PTO', 6);
  const dict = (await api(pm.token, 'GET', 'dictionaries')).data, contractors = (await api(pm.token, 'GET', 'contractors')).data;
  const mkObject = async (name: string) => (await api(td.token, 'POST', 'objects', { externalCode: `PBX3A-${name}-${Date.now()}`, name, address: 'Тест, 1', organizationName: 'ООО СЗ', projectManagerId: pm.user.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] }, 201)).data;
  const obj3 = await mkObject('Объект-3'), obj4 = await mkObject('Объект-4');
  void dict;

  for (const m of [petrov, sidorov, akhmetov, orlov]) await api(deputy.token, 'POST', 'function-teams/pto/org-members', { memberUserId: m.id, managerUserId: kuznetsov.id }, 201);
  await api(deputy.token, 'POST', `objects/${obj3.id}/function-team/pto/lead`, { leadUserId: kuznetsov.id }, 201);
  await api(deputy.token, 'POST', `objects/${obj4.id}/function-team/pto/lead`, { leadUserId: kuznetsov.id }, 201);
  await api(deputy.token, 'POST', 'function-teams/pto/redistribute', { reason: 'Начальная расстановка', memberAdds: [{ objectId: obj3.id, memberUserId: petrov.id }, { objectId: obj3.id, memberUserId: sidorov.id }, { objectId: obj3.id, memberUserId: akhmetov.id }, { objectId: obj4.id, memberUserId: orlov.id }] }, 201);
  // Kuznetsov leaves the company.
  await api(admin.token, 'PATCH', `admin/users/${kuznetsov.id}`, { isActive: false }, 200);

  await openAs(page, deputy.token, '/teams');
  await expect(page.getByRole('heading', { name: 'Команды и объекты', level: 1 })).toBeVisible();
  // Unresolved: former team (4) + two led objects (2) surfaced, nothing auto-assigned.
  const unresolved = page.getByRole('region', { name: 'Требуют перераспределения' });
  await expect(unresolved).toContainText('Требуют перераспределения (6)');
  await expect(unresolved).toContainText('Петров Пётр');

  // Row of the «Команды ПТО на объектах» table only (the handover table also mentions the object).
  const teamRow = (objectName: string) => page.locator('table').filter({ has: page.getByRole('columnheader', { name: 'Инженеры ПТО объекта' }) }).getByRole('row').filter({ hasText: objectName });
  const pick = async (label: string, option: string) => page.getByLabel(label, { exact: true }).selectOption({ label: option });
  const addStep = () => page.getByRole('button', { name: 'Добавить шаг' }).click();
  const apply = async (reason: string) => {
    await page.getByLabel('Причина перераспределения').fill(reason);
    await page.getByRole('button', { name: 'Применить перераспределение' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Перераспределение выполнено' })).toBeVisible();
  };

  // ---- Redistribution 1: lead replacement ALONE (Object 3 -> Smirnov, Object 4 -> Ivanov) ----
  await page.getByRole('button', { name: 'Перераспределить', exact: true }).click();
  await pick('Действие', 'Назначить начальника объекта');
  await pick('Объект', 'Объект-3'); await pick('Начальник ПТО', smirnov.name); await addStep();
  await pick('Действие', 'Назначить начальника объекта');
  await pick('Объект', 'Объект-4'); await pick('Начальник ПТО', 'Иванов Олег'); await addStep();
  await expect(page.getByRole('list', { name: 'Шаги перераспределения' }).getByRole('listitem')).toHaveCount(2);
  await apply('Увольнение Кузнецова');
  await expect(teamRow('Объект-3')).toContainText(smirnov.name);
  for (const n of ['Петров Пётр', 'Сидоров Семён', 'Ахметов Ахмет']) await expect(teamRow('Объект-3')).toContainText(n);
  await expect(teamRow('Объект-4')).toContainText('Иванов Олег');
  await expect(teamRow('Объект-4')).toContainText('Орлов Олег');
  // inherited members are annotated, not flagged as an error
  await expect(teamRow('Объект-3')).toContainText('из команды: Кузнецов Игорь');

  // ---- Redistribution 2: Ivanov wants Akhmetov instead of Orlov — ONE command ----
  await page.getByRole('button', { name: 'Перераспределить', exact: true }).click();
  await pick('Действие', 'Перевести инженера в команду начальника'); await pick('Инженер', 'Ахметов Ахмет'); await pick('Начальник ПТО', 'Иванов Олег'); await addStep();
  await pick('Действие', 'Перевести инженера в команду начальника'); await pick('Инженер', 'Орлов Олег'); await pick('Начальник ПТО', smirnov.name); await addStep();
  await pick('Действие', 'Снять инженера с объекта'); await pick('Объект', 'Объект-3'); await pick('Инженер', 'Ахметов Ахмет'); await addStep();
  await pick('Действие', 'Добавить инженера на объект'); await pick('Объект', 'Объект-4'); await pick('Инженер', 'Ахметов Ахмет'); await addStep();
  await pick('Действие', 'Снять инженера с объекта'); await pick('Объект', 'Объект-4'); await pick('Инженер', 'Орлов Олег'); await addStep();
  await pick('Действие', 'Добавить инженера на объект'); await pick('Объект', 'Объект-3'); await pick('Инженер', 'Орлов Олег'); await addStep();
  await pick('Действие', 'Зафиксировать передачу дел'); await pick('Объект', 'Объект-3'); await pick('Кто передаёт', 'Ахметов Ахмет'); await pick('Кто принимает', 'Орлов Олег'); await addStep();
  await pick('Действие', 'Зафиксировать передачу дел'); await pick('Объект', 'Объект-4'); await pick('Кто передаёт', 'Орлов Олег'); await pick('Кто принимает', 'Ахметов Ахмет'); await addStep();
  await expect(page.getByRole('list', { name: 'Шаги перераспределения' }).getByRole('listitem')).toHaveCount(8);
  await apply('Иванову нужен Ахметов вместо Орлова');

  const obj3Row = teamRow('Объект-3'), obj4Row = teamRow('Объект-4');
  await expect(obj3Row).toContainText('Орлов Олег'); await expect(obj3Row).toContainText('Петров Пётр'); await expect(obj3Row).toContainText('Сидоров Семён');
  await expect(obj3Row).not.toContainText('Ахметов Ахмет');
  await expect(obj4Row).toContainText('Ахметов Ахмет'); await expect(obj4Row).not.toContainText('Орлов Олег');
  await expect(page.getByRole('row').filter({ hasText: 'Ахметов Ахмет → Орлов Олег' })).toContainText('Ожидает подтверждения');
  await expect(page.getByRole('row').filter({ hasText: 'Орлов Олег → Ахметов Ахмет' })).toBeVisible();

  // Object screen: PTO block shows the current team and keeps history separate.
  const object3Team = (await api(deputy.token, 'GET', `objects/${obj3.id}/function-team/pto`, undefined, 200)).data;
  await page.goto(`/app.html/object/${obj3.id}`);
  const block = page.getByRole('region', { name: 'ПТО объекта' });
  await expect(block).toContainText(smirnov.name);
  await expect(block).toContainText('Орлов Олег');
  await expect(block).not.toContainText('Ахметов Ахмет');
  await block.getByRole('button', { name: 'История назначений' }).click();
  await expect(block.getByLabel('История назначений ПТО')).toContainText('Ахметов Ахмет');
  expect(object3Team.history.members.some((m: any) => m.name === 'Ахметов Ахмет')).toBe(true);

  // Smirnov's own view: «Моя команда ПТО» / «Команда объекта».
  const smirnovPage = await page.context().newPage();
  await openAs(smirnovPage, head.token, '/my-team');
  await expect(smirnovPage.getByRole('heading', { name: 'Моя команда ПТО', level: 1 })).toBeVisible();
  const own = smirnovPage.locator('section[aria-label="Моя команда ПТО"]');
  await expect(own).toContainText('Орлов Олег');
  await expect(own).not.toContainText('Ахметов Ахмет');
  const objectTeam = smirnovPage.getByRole('region', { name: 'Команда объекта: Объект-3' });
  await expect(objectTeam).toContainText('Петров Пётр');
  // Akhmetov is not offered in the add list; an unauthorized control is simply absent for Object 4.
  await expect(objectTeam.getByLabel('Добавить из моей команды').locator('option', { hasText: 'Ахметов Ахмет' })).toHaveCount(0);
  await expect(smirnovPage.getByRole('region', { name: 'Команда объекта: Объект-4' })).toHaveCount(0);
  // Remove an inherited engineer (Petrov's org manager is still Smirnov here? he moved — still valid to remove).
  await objectTeam.getByRole('button', { name: /Снять с объекта: Сидоров Семён/ }).click();
  await expect(smirnovPage.getByRole('status').filter({ hasText: 'Инженер снят с объекта' })).toBeVisible();
  await expect(objectTeam).not.toContainText('Сидоров Семён');
  // Backend also refuses what the UI never offers.
  expect((await api(head.token, 'POST', `objects/${obj3.id}/function-team/pto/members`, { memberUserId: akhmetov.id })).status).toBe(403);
  expect((await api(head.token, 'POST', `objects/${obj4.id}/function-team/pto/members`, { memberUserId: orlov.id })).status).toBe(403);
  // A PTO_HEAD has no Deputy surface.
  await smirnovPage.goto('/app.html/teams');
  await expect(smirnovPage.getByText('доступен руководству')).toBeVisible();
  await expect(smirnovPage.getByRole('button', { name: 'Перераспределить' })).toHaveCount(0);
});
