import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * PBX-2 — «Пользователи и доступ» (/admin/users), rendered.
 * TEST TYPE: browser, INTERCEPTED (see playwright.pbx2.config.ts). The fake API
 * below mimics the backend contract only; the real rules (last-ADMIN, session
 * deletion, audit, tenant scoping) are proven in tests/pbx2-*.test.ts.
 */

const ADMIN = { id: 'u-admin', tenantId: 't-1', name: 'Админов Админ', role: 'ADMIN' };
const PTO = { id: 'u-pto', tenantId: 't-1', name: 'Ольга Морозова', role: 'PTO' };

interface CoreUser { id: string; name: string; role: string; bitrixUserId: string; isActive: boolean; version: number }
interface State {
  core: CoreUser[];
  employees: any[];
  directoryError: boolean;
  departmentsError: boolean;
  usersError: boolean;
  mutationError: string | null;
  calls: { method: string; path: string; body: any }[];
}

const emp = (ID: string, LAST_NAME: string, NAME: string, extra: any = {}) => ({ ID, NAME, LAST_NAME, ACTIVE: true, WORK_POSITION: null, UF_DEPARTMENT: [], ...extra });

function makeState(): State {
  return {
    core: [
      { id: 'c-admin', name: 'Админов Админ', role: 'ADMIN', bitrixUserId: '1', isActive: true, version: 1 },
      { id: 'c-td', name: 'Никитин Пётр', role: 'DEPUTY_DIRECTOR', bitrixUserId: '2', isActive: true, version: 1 },
      { id: 'c-off', name: 'Зайцев Андрей', role: 'SDO', bitrixUserId: '3', isActive: false, version: 1 },
      { id: 'c-dh', name: 'Громов Николай', role: 'PTO_HEAD', bitrixUserId: '6', isActive: true, version: 1 },
    ],
    employees: [
      emp('1', 'Админов', 'Админ', { WORK_POSITION: 'Системный администратор', UF_DEPARTMENT: [5] }),
      emp('2', 'Никитин', 'Пётр', { WORK_POSITION: 'Технический директор', UF_DEPARTMENT: [5] }),
      emp('3', 'Зайцев', 'Андрей', { UF_DEPARTMENT: [6] }),
      emp('4', 'Петрова', 'Ирина', { WORK_POSITION: 'Генеральный директор', UF_DEPARTMENT: [5] }),
      emp('5', 'Уволенный', 'Сергей', { ACTIVE: false, WORK_POSITION: 'Директор', UF_DEPARTMENT: [6] }),
      emp('6', 'Громов', 'Николай', { WORK_POSITION: 'Начальник отдела', UF_DEPARTMENT: [6] }),
    ],
    directoryError: false,
    departmentsError: false,
    usersError: false,
    mutationError: null,
    calls: [],
  };
}

async function setup(page: Page, state: State, actor = ADMIN) {
  await page.addInitScript(() => window.sessionStorage.setItem('session', 'pbx2-token'));
  await page.route((url) => url.pathname.startsWith('/api/'), async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postData() ? JSON.parse(request.postData()!) : undefined;
    state.calls.push({ method, path, body });
    const json = (status: number, data: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (method === 'GET' && path === '/api/health') return json(200, { status: 'ok', authMode: 'bitrix', databaseMode: 'postgres' });
    if (method === 'GET' && path === '/api/me') return json(200, actor);
    if (method === 'GET' && path === '/api/snapshot') return json(200, { objects: [], works: [], contractors: [], dependencies: [], inspections: [] });
    if (method === 'GET' && path === '/api/admin/users') return state.usersError ? json(500, { message: 'Внутренняя ошибка' }) : json(200, { users: state.core });
    if (method === 'GET' && path === '/api/bitrix/directory/users')
      return state.directoryError ? json(400, { statusCode: 400, message: 'Bitrix REST request failed: insufficient_scope' }) : json(200, { users: state.employees, count: state.employees.length, truncated: false });
    if (method === 'GET' && path === '/api/bitrix/directory/departments')
      return state.departmentsError ? json(400, { message: 'scope' }) : json(200, { departments: [{ ID: '5', NAME: 'Дирекция' }, { ID: '6', NAME: 'Производство' }], count: 2, truncated: false });
    if (path.startsWith('/api/admin/users') && (method === 'POST' || method === 'PATCH')) {
      if (state.mutationError) return json(409, { message: state.mutationError });
      if (method === 'POST') {
        const e = state.employees.find((x) => x.ID === body.bitrixUserId)!;
        const u: CoreUser = { id: 'c-' + body.bitrixUserId, name: `${e.LAST_NAME} ${e.NAME}`, role: body.role, bitrixUserId: body.bitrixUserId, isActive: true, version: 1 };
        state.core.push(u);
        return json(201, u);
      }
      const u = state.core.find((x) => x.id === path.split('/').pop())!;
      if (body.role) u.role = body.role;
      if (typeof body.isActive === 'boolean') u.isActive = body.isActive;
      return json(200, u);
    }
    return route.fulfill({ status: 599, contentType: 'text/plain', body: `unexpected ${method} ${path}` });
  });
}

const openTab = (page: Page, name: string) => page.getByRole('tab', { name: new RegExp('^' + name) }).click();
// The open action panel (its «Роль в Core» select is distinct from the registry filter of the same name).
const panelOf = (page: Page) => page.getByRole('group', { name: /^Действие:/ });
// ⋯ menu: every row action lives behind one compact «Действия: <ФИО>» trigger.
const act = async (page: Page, who: string, item: string | RegExp) => {
  await page.getByRole('button', { name: `Действия: ${who}` }).click();
  await page.getByRole('menuitem', { name: item }).click();
};
const rowOf = (page: Page, name: string) => page.locator('tr', { hasText: name }).first();
const sidebar = (page: Page) => page.locator('aside');

test.describe('access', () => {
  test('ADMIN sees the navigation entry and the screen', async ({ page }) => {
    await setup(page, makeState());
    await page.goto('/app.html/company');
    await sidebar(page).getByRole('button', { name: 'Пользователи и доступ' }).or(sidebar(page).getByRole('link', { name: 'Пользователи и доступ' })).click();
    await expect(page).toHaveURL(/\/app\.html\/admin\/users$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Пользователи и доступ' })).toBeVisible();
  });

  test('non-ADMIN has no navigation entry, is denied on direct navigation and makes no admin request', async ({ page }) => {
    const state = makeState();
    await setup(page, state, PTO);
    await page.goto('/app.html/admin/users');
    await expect(page.getByText('доступен только администратору')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Сотрудники и доступ' })).toHaveCount(0);
    await expect(sidebar(page).getByText('Пользователи и доступ')).toHaveCount(0);
    expect(state.calls.filter((c) => c.path.includes('/admin/') || c.path.includes('/bitrix/'))).toEqual([]);
  });
});

test.describe('registry authorization', () => {
  test('DEPUTY_DIRECTOR has no Users & Access entry, is denied on direct navigation and makes no admin request', async ({ page }) => {
    const state = makeState();
    await setup(page, state, { id: 'u-dep', tenantId: 't-1', name: 'Заместитель', role: 'DEPUTY_DIRECTOR' });
    await page.goto('/app.html/admin/users');
    await expect(page.getByText('доступен только администратору')).toBeVisible();
    await expect(sidebar(page).getByText('Пользователи и доступ')).toHaveCount(0);
    await expect(page.getByRole('searchbox')).toHaveCount(0);
    expect(state.calls.filter((c) => c.path.includes('/admin/') || c.path.includes('/bitrix/'))).toEqual([]);
  });
});

test.describe('department-head sessions mirror their department role in the shell', () => {
  const head = (role: string) => ({ id: 'u-h', tenantId: 't-1', name: 'Начальник', role });
  for (const [role, visible, hidden, roleLabel] of [
    ['PTO_HEAD', 'ПТО', 'СДО', 'Начальник ПТО'],
    ['SDO_HEAD', 'СДО', 'ПТО', 'Начальник СДО'],
  ] as const) {
    test(`${role}: sees the «${visible}» workspace entry, not «${hidden}», never the administration entry`, async ({ page }) => {
      const state = makeState();
      await setup(page, state, head(role));
      await page.goto('/app.html/company');
      await expect(sidebar(page).getByText('Портфель')).toBeVisible();
      await expect(sidebar(page).getByRole('button', { name: visible, exact: true })).toBeVisible();
      await expect(sidebar(page).getByRole('button', { name: hidden, exact: true })).toHaveCount(0);
      await expect(sidebar(page).getByText('Пользователи и доступ')).toHaveCount(0);
      await expect(sidebar(page).getByText(roleLabel)).toBeVisible();
      await page.goto('/app.html/admin/users');
      await expect(page.getByText('доступен только администратору')).toBeVisible();
    });
  }
  test('CONSTRUCTION_CONTROL_HEAD sees neither ПТО, СДО nor the administration entry', async ({ page }) => {
    await setup(page, makeState(), head('CONSTRUCTION_CONTROL_HEAD'));
    await page.goto('/app.html/company');
    await expect(sidebar(page).getByText('Портфель')).toBeVisible();
    for (const name of ['ПТО', 'СДО', 'Пользователи и доступ']) await expect(sidebar(page).getByRole('button', { name, exact: true })).toHaveCount(0);
    await expect(sidebar(page).getByText('Начальник СК')).toBeVisible();
  });
});

test.describe('employee list', () => {
  test('shows Bitrix employees with Core status, role, position and department as context; no raw enum names', async ({ page }) => {
    await setup(page, makeState());
    await page.goto('/app.html/admin/users');
    await expect(rowOf(page, 'Админов Админ')).toContainText('Активен в Core');
    await expect(rowOf(page, 'Админов Админ')).toContainText('Администратор');
    // Bitrix position / department are not part of this Core registry
    await expect(page.locator('main')).not.toContainText('Системный администратор');
    await expect(page.locator('main')).not.toContainText('Дирекция');
    await expect(rowOf(page, 'Админов Админ')).toContainText('ID Bitrix24: 1');
    await expect(rowOf(page, 'Зайцев Андрей')).toContainText('Доступ отключён');
    // a director title in Bitrix grants nothing: the employee is simply not in Core (own tab)
    await expect(rowOf(page, 'Петрова Ирина')).toHaveCount(0);
    await openTab(page, 'Не добавлены в Core');
    await expect(rowOf(page, 'Петрова Ирина')).toContainText('Активен в Bitrix24');
    await expect(page.locator('main')).not.toContainText('Генеральный директор');
    for (const raw of ['TECHNICAL_DIRECTOR', 'DEPARTMENT_HEAD', 'DEPUTY_DIRECTOR', 'GENERAL_DIRECTOR', 'PTO_HEAD', 'SDO_HEAD', 'CONSTRUCTION_CONTROL', 'ADMIN_USERS']) await expect(page.locator('main')).not.toContainText(raw);
    // the Core role of an existing SDO user reads as a role label, not as the department name
    await openTab(page, 'В Core');
    await expect(rowOf(page, 'Зайцев Андрей')).toContainText('Инженер-сметчик');
  });

  test('Bitrix-inactive employee carries a visible warning and is not silently changed', async ({ page }) => {
    const state = makeState();
    await setup(page, state);
    await page.goto('/app.html/admin/users');
    await openTab(page, 'Неактивны в Bitrix24');
    await expect(rowOf(page, 'Уволенный Сергей')).toContainText('Неактивен в Bitrix24');
    await expect(rowOf(page, 'Уволенный Сергей')).toContainText('Нет в Core');
    await expect(rowOf(page, 'Петрова Ирина')).toHaveCount(0);
    expect(state.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  test('directory error is explicit — not an empty-success list — and Core users stay visible', async ({ page }) => {
    const state = makeState();
    state.directoryError = true;
    await setup(page, state);
    await page.goto('/app.html/admin/users');
    const alert = page.getByRole('alert').filter({ hasText: 'Не удалось загрузить сотрудников из Bitrix24' });
    await expect(alert).toBeVisible();
    await expect(page.getByText('Все активные сотрудники Bitrix24 уже добавлены в Core')).toHaveCount(0);
    await expect(rowOf(page, 'Админов Админ')).toContainText('Активен в Core');
    await expect(page.getByRole('button', { name: /Добавить в Core/ })).toHaveCount(0);
    // retry re-reads
    state.directoryError = false;
    await alert.getByRole('button', { name: 'Повторить' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Bitrix24' })).toHaveCount(0);
    await openTab(page, 'Не добавлены в Core');
    await expect(rowOf(page, 'Петрова Ирина')).toContainText('Активен в Bitrix24');
  });

  test('empty Bitrix directory with no Core users is a clear empty state, distinct from an error', async ({ page }) => {
    const state = makeState();
    state.employees = [];
    state.core = [];
    await setup(page, state);
    await page.goto('/app.html/admin/users');
    await expect(page.getByText('В Core пока нет пользователей')).toBeVisible();
    await openTab(page, 'Не добавлены в Core');
    await expect(page.getByText('Все активные сотрудники Bitrix24 уже добавлены в Core')).toBeVisible();
    await openTab(page, 'Неактивны в Bitrix24');
    await expect(page.getByText('Неактивных пользователей Bitrix24 нет')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('the registry never reads Bitrix departments and renders no position / department; Bitrix directory contract unchanged', async ({ page }) => {
    const state = makeState();
    state.departmentsError = true; // would have produced a notice before: now it cannot matter
    await setup(page, state);
    await page.goto('/app.html/admin/users');
    await expect(rowOf(page, 'Админов Админ')).toBeVisible();
    await expect(page.getByText('Названия подразделений недоступны')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(state.calls.filter((c) => c.path.includes('/bitrix/directory/departments'))).toEqual([]);
    expect(state.calls.filter((c) => c.path.includes('/bitrix/')).map((c) => c.path)).toEqual(['/api/bitrix/directory/users']);
    for (const tab of ['В Core', 'Не добавлены в Core', 'Неактивны в Bitrix24']) {
      await openTab(page, tab);
      const text = await page.locator('main').innerText();
      for (const stale of ['Системный администратор', 'Технический директор', 'Начальник отдела', 'Дирекция', 'Производство', 'Подразделение', 'Должность']) expect(text, `${tab}: ${stale}`).not.toContain(stale);
    }
  });

  test('a failed Core read is shown as an error, never as an empty table', async ({ page }) => {
    const state = makeState();
    state.usersError = true;
    await setup(page, state);
    await page.goto('/app.html/admin/users');
    await expect(page.getByRole('alert').filter({ hasText: 'Не удалось загрузить пользователей Core' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Добавить в Core/ })).toHaveCount(0);
  });
});

test.describe('mutations', () => {
  test('add to Core: the role is chosen explicitly, never pre-filled; only identity and role are sent', async ({ page }) => {
    const state = makeState();
    await setup(page, state);
    await page.goto('/app.html/admin/users');
    await openTab(page, 'Не добавлены в Core');
    await act(page, 'Петрова Ирина', 'Добавить в Core');
    const select = panelOf(page).getByLabel('Роль в Core');
    await expect(select).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Добавить', exact: true })).toBeDisabled();
    const options = await select.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(options).toEqual(['', 'GENERAL_DIRECTOR', 'DEPUTY_DIRECTOR', 'PROJECT_MANAGER', 'CONSTRUCTION_CONTROL', 'CONSTRUCTION_CONTROL_HEAD', 'PTO', 'PTO_HEAD', 'SDO', 'SDO_HEAD', 'ADMIN']);
    const labels = await select.locator('option').evaluateAll((os) => os.map((o) => o.textContent));
    expect(labels).toEqual(['Выберите роль', 'Генеральный директор', 'Заместитель директора', 'Руководитель проекта', 'Строительный контроль', 'Начальник СК', 'Инженер ПТО', 'Начальник ПТО', 'Инженер-сметчик', 'Начальник СДО', 'Администратор']);
    await select.selectOption('DEPUTY_DIRECTOR');
    await page.getByRole('button', { name: 'Добавить', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'добавлен в Core с ролью «Заместитель директора»' })).toBeVisible();
    await openTab(page, 'В Core');
    await expect(rowOf(page, 'Петрова Ирина')).toContainText('Активен в Core');
    await expect(rowOf(page, 'Петрова Ирина')).toContainText('Заместитель директора');
    expect(state.calls.find((c) => c.method === 'POST')!.body).toEqual({ bitrixUserId: '4', role: 'DEPUTY_DIRECTOR' });
  });

  test('the department-head roles can be assigned, and are shown with their Russian labels', async ({ page }) => {
    const state = makeState();
    await setup(page, state);
    await page.goto('/app.html/admin/users');
    for (const [role, label] of [['PTO_HEAD', 'Начальник ПТО'], ['CONSTRUCTION_CONTROL_HEAD', 'Начальник СК'], ['SDO_HEAD', 'Начальник СДО']] as const) {
      await act(page, 'Зайцев Андрей', 'Изменить роль');
      const select = panelOf(page).getByLabel(/Роль в Core|Другая роль/);
      await select.selectOption(role);
      await page.getByRole('button', { name: /^(Сохранить роль|Включить доступ)$/ }).click();
      await expect(rowOf(page, 'Зайцев Андрей')).toContainText(label);
      expect(state.calls.filter((c) => c.method === 'PATCH').pop()!.body.role).toBe(role);
    }
  });

  test('role change; removed TECHNICAL_DIRECTOR / DEPARTMENT_HEAD are never selectable or labelled', async ({ page }) => {
    const state = makeState();
    await setup(page, state);
    await page.goto('/app.html/admin/users');
    await expect(rowOf(page, 'Никитин Пётр')).toContainText('Заместитель директора');
    await expect(rowOf(page, 'Громов Николай')).toContainText('Начальник ПТО');
    await act(page, 'Никитин Пётр', 'Изменить роль');
    const select = panelOf(page).getByLabel('Роль в Core');
    for (const removed of ['TECHNICAL_DIRECTOR', 'DEPARTMENT_HEAD', 'CONTRACTOR_VIEWER']) await expect(select.locator(`option[value="${removed}"]`)).toHaveCount(0);
    for (const label of ['Технический директор', 'Руководитель направления']) await expect(select.locator('option', { hasText: label })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Сохранить роль' })).toBeDisabled();
    await select.selectOption('PROJECT_MANAGER');
    await page.getByRole('button', { name: 'Сохранить роль' }).click();
    await expect(rowOf(page, 'Никитин Пётр')).toContainText('Руководитель проекта');
    expect(state.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ role: 'PROJECT_MANAGER' });
  });

  test('deactivate then reactivate restores the same role; both explain the session consequence', async ({ page }) => {
    const state = makeState();
    await setup(page, state);
    await page.goto('/app.html/admin/users');
    await openTab(page, 'Не добавлены в Core');
    await act(page, 'Петрова Ирина', 'Добавить в Core');
    await panelOf(page).getByLabel('Роль в Core').selectOption('PTO');
    await page.getByRole('button', { name: 'Добавить', exact: true }).click();
    await openTab(page, 'В Core');
    await expect(rowOf(page, 'Петрова Ирина')).toContainText('Активен в Core');

    await act(page, 'Петрова Ирина', 'Отключить доступ');
    await expect(page.getByText('все активные сессии сотрудника завершены')).toBeVisible();
    await expect(page.getByText('Учётная запись в Bitrix24 не изменяется')).toBeVisible();
    await page.getByRole('button', { name: 'Отключить доступ', exact: true }).click();
    await expect(rowOf(page, 'Петрова Ирина')).toContainText('Доступ отключён');
    expect(state.calls.filter((c) => c.method === 'PATCH').pop()!.body).toEqual({ isActive: false });

    await act(page, 'Петрова Ирина', 'Включить доступ');
    await expect(page.getByText('потребуется новый вход через Bitrix24')).toBeVisible();
    await page.getByRole('button', { name: 'Включить доступ', exact: true }).click();
    await expect(rowOf(page, 'Петрова Ирина')).toContainText('Активен в Core');
    await expect(rowOf(page, 'Петрова Ирина')).toContainText('ПТО');
    expect(state.calls.filter((c) => c.method === 'PATCH').pop()!.body).toEqual({ isActive: true });
  });

  test('reactivation may explicitly choose another allowed role', async ({ page }) => {
    const state = makeState();
    await setup(page, state);
    await page.goto('/app.html/admin/users');
    await act(page, 'Зайцев Андрей', 'Включить доступ');
    await panelOf(page).getByLabel('Другая роль (необязательно)').selectOption('PROJECT_MANAGER');
    await page.getByRole('button', { name: 'Включить доступ', exact: true }).click();
    await expect(rowOf(page, 'Зайцев Андрей')).toContainText('Руководитель проекта');
    expect(state.calls.filter((c) => c.method === 'PATCH').pop()!.body).toEqual({ isActive: true, role: 'PROJECT_MANAGER' });
  });

  test('a Core mutation error is shown as an alert, the panel stays open and nothing changes', async ({ page }) => {
    const state = makeState();
    state.mutationError = 'Нельзя оставить организацию без активного администратора';
    await setup(page, state);
    await page.goto('/app.html/admin/users');
    await act(page, 'Админов Админ', 'Отключить доступ');
    await page.getByRole('button', { name: 'Отключить доступ', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'без активного администратора' })).toBeVisible();
    await expect(rowOf(page, 'Админов Админ')).toContainText('Активен в Core');
    await expect(page.getByRole('button', { name: 'Отключить доступ', exact: true })).toBeVisible();
  });
});

test.describe('registry: tabs, search, role filter, sorting, ⋯ menu', () => {
  function rich(): State {
    const state = makeState();
    state.core[0] = { ...state.core[0], email: 'admin@example.org' } as any;
    state.core[1] = { ...state.core[1], email: 'nikitin@corp.example' } as any;
    state.core.push({ id: 'c-bel', name: 'Беляев Олег', role: 'PTO', bitrixUserId: '7', isActive: true, version: 1, email: 'belyaev@corp.example' } as any);
    state.employees.push(
      emp('7', 'Беляев', 'Олег', { ACTIVE: false, WORK_POSITION: 'Инженер ПТО', UF_DEPARTMENT: [6] }),
      emp('8', 'Ёлкина', 'Дарья', { WORK_POSITION: 'Инженер', UF_DEPARTMENT: [6] }),
    );
    return state;
  }
  const search = (page: Page) => page.getByPlaceholder('Поиск по ФИО или e-mail', { exact: true });
  const names = async (page: Page) => (await page.locator('main tbody tr td:first-child').allInnerTexts()).map((t) => t.split('\n')[0]!.trim());
  const open = async (page: Page, state: State) => { await setup(page, state); await page.goto('/app.html/admin/users'); await expect(search(page)).toBeVisible(); };

  test('Core-centric layout: exact columns per tab, no Должность / Подразделение anywhere, exact search placeholder', async ({ page }) => {
    await open(page, rich());
    await expect(search(page)).toHaveAttribute('placeholder', 'Поиск по ФИО или e-mail');
    // header text is upper-cased by the table's CSS; compare case-insensitively
    const headers = async () => (await page.locator('main thead th').allInnerTexts()).map((t) => t.trim().toLowerCase());
    expect(await headers()).toEqual(['сотрудник', 'роль в core', 'статус', 'действия']);
    await openTab(page, 'Не добавлены в Core');
    expect(await headers()).toEqual(['сотрудник', 'статус bitrix24', 'действия']);
    await openTab(page, 'Неактивны в Bitrix24');
    expect(await headers()).toEqual(['сотрудник', 'состояние core', 'статус bitrix24', 'действия']);
    for (const label of ['Подразделение', 'Должность']) {
      await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);       // no filter
      await expect(page.locator('main').getByText(label, { exact: true })).toHaveCount(0); // no column / label
    }
    await expect(page.locator('#registry-sort option', { hasText: /Подразделение|Должность/ })).toHaveCount(0);
  });

  test('tabs with counts keep their semantics; inactive Core users show both states', async ({ page }) => {
    await open(page, rich());
    await expect(page.getByRole('tab', { name: 'В Core (5)' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Не добавлены в Core (2)' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Неактивны в Bitrix24 (2)' })).toBeVisible();
    expect(await names(page)).toEqual(['Админов Админ', 'Беляев Олег', 'Громов Николай', 'Зайцев Андрей', 'Никитин Пётр']);
    await openTab(page, 'Не добавлены в Core');
    expect(await names(page)).toEqual(['Ёлкина Дарья', 'Петрова Ирина']); // Russian collation: Ё right after Е
    await openTab(page, 'Неактивны в Bitrix24');
    await expect(rowOf(page, 'Беляев Олег')).toContainText('Есть в Core');
    await expect(rowOf(page, 'Беляев Олег')).toContainText('Неактивен в Bitrix24');
    await expect(rowOf(page, 'Уволенный Сергей')).toContainText('Нет в Core');
    await expect(rowOf(page, 'Уволенный Сергей').getByRole('button')).toHaveCount(0); // no menu: no valid action
    await openTab(page, 'В Core');
    await expect(rowOf(page, 'Беляев Олег')).toContainText('Сотрудник неактивен в Bitrix24');
  });

  test('search: ФИО and Core-held e-mail only (case-insensitive, partial, ё≡е); position and department no longer match', async ({ page }) => {
    await open(page, rich());
    const check = async (text: string, expected: string[]) => { await search(page).fill(text); expect(await names(page), text).toEqual(expected); };
    await check('гром', ['Громов Николай']);
    await check('ЗАЙЦЕВ андр', ['Зайцев Андрей']);
    await check('nikitin@corp', ['Никитин Пётр']);
    await check('NIKITIN@CORP.EXAMPLE', ['Никитин Пётр']);
    await search(page).fill('системный'); await expect(page.getByText('Сотрудники не найдены')).toBeVisible();
    await search(page).fill('дирекц'); await expect(page.getByText('Сотрудники не найдены')).toBeVisible();
    await search(page).fill('технический'); await expect(page.getByText('Сотрудники не найдены')).toBeVisible();
    await check('', ['Админов Админ', 'Беляев Олег', 'Громов Николай', 'Зайцев Андрей', 'Никитин Пётр']);
    await search(page).fill('елкина');
    await openTab(page, 'Не добавлены в Core');
    await expect(search(page)).toHaveValue('елкина');
    expect(await names(page)).toEqual(['Ёлкина Дарья']);
    await search(page).fill('генеральный'); await expect(page.getByText('Сотрудники не найдены')).toBeVisible(); // Bitrix position of Петрова: not searchable
  });

  test('the Core-role filter is the only filter; off for «Не добавлены»; reset; sorting А–Я / Я–А / роль; combination', async ({ page }) => {
    await open(page, rich());
    const role = page.getByLabel('Роль в Core', { exact: true });
    const sort = page.getByLabel('Сортировка');
    await role.selectOption('Начальник ПТО');
    expect(await names(page)).toEqual(['Громов Николай']);
    await page.getByRole('button', { name: 'Сбросить фильтры' }).click();
    expect(await names(page)).toHaveLength(5);
    await expect(page.getByRole('button', { name: 'Сбросить фильтры' })).toHaveCount(0);
    expect(await role.locator('option').allInnerTexts()).toEqual(expect.arrayContaining(['Все', 'Администратор', 'Начальник ПТО', 'Инженер ПТО', 'Заместитель директора', 'Инженер-сметчик']));
    await sort.selectOption({ label: 'ФИО: Я–А' });
    expect(await names(page)).toEqual(['Никитин Пётр', 'Зайцев Андрей', 'Громов Николай', 'Беляев Олег', 'Админов Админ']);
    await sort.selectOption({ label: 'ФИО: А–Я' });
    expect((await names(page))[0]).toBe('Админов Админ');
    await sort.selectOption({ label: 'Роль в Core' });
    const byRole = await names(page); expect(byRole[0]).toBe('Админов Админ'); expect(byRole[1]).toBe('Никитин Пётр'); expect(byRole[4]).toBe('Громов Николай');
    expect(await sort.locator('option').allInnerTexts()).toEqual(['ФИО: А–Я', 'ФИО: Я–А', 'Роль в Core']);
    // search + role filter + sort combined
    await sort.selectOption({ label: 'ФИО: Я–А' });
    await role.selectOption('Инженер ПТО');
    await search(page).fill('олег');
    expect(await names(page)).toEqual(['Беляев Олег']);
    await openTab(page, 'Не добавлены в Core');
    await expect(role).toBeDisabled();
    expect(await sort.locator('option').allInnerTexts()).toEqual(['ФИО: А–Я', 'ФИО: Я–А']);
    await openTab(page, 'Неактивны в Bitrix24');
    await expect(role).toBeEnabled(); // rows that have a Core record can be filtered by role
    await role.selectOption('Инженер ПТО');
    expect(await names(page)).toEqual(['Беляев Олег']);
  });

  test('empty states are explained', async ({ page }) => {
    const state = rich();
    state.core = []; state.employees = state.employees.filter((e) => e.ACTIVE === false);
    await open(page, state);
    await expect(page.getByText('В Core пока нет пользователей')).toBeVisible();
    await openTab(page, 'Не добавлены в Core');
    await expect(page.getByText('Все активные сотрудники Bitrix24 уже добавлены в Core')).toBeVisible();
    await openTab(page, 'Неактивны в Bitrix24');
    await search(page).fill('несуществующий');
    await expect(page.getByText('Сотрудники не найдены')).toBeVisible();
    await search(page).fill('');
    await expect(rowOf(page, 'Беляев Олег')).toContainText('Нет в Core');
  });

  test('⋯ menu: no persistent action buttons; items per state; Escape and outside click close it; no menu without a valid action', async ({ page }) => {
    await open(page, rich());
    for (const label of ['Изменить роль', 'Отключить доступ', 'Включить доступ', 'Добавить в Core']) await expect(page.getByRole('button', { name: new RegExp('^' + label) })).toHaveCount(0);
    const menu = (who: string) => page.getByRole('menu', { name: `Действия: ${who}` });
    const items = async (who: string) => { await page.getByRole('button', { name: `Действия: ${who}` }).click(); const t = await menu(who).getByRole('menuitem').allInnerTexts(); return t; };
    expect(await items('Никитин Пётр')).toEqual(['Изменить роль', 'Отключить доступ']);   // active Core user
    await page.keyboard.press('Escape'); await expect(menu('Никитин Пётр')).toHaveCount(0);
    expect(await items('Зайцев Андрей')).toEqual(['Изменить роль', 'Включить доступ']);  // disabled Core user
    await page.mouse.click(5, 5); await expect(menu('Зайцев Андрей')).toHaveCount(0);   // outside click
    await expect(page.getByRole('button', { name: 'Действия: Беляев Олег' })).toBeVisible();
    await openTab(page, 'Не добавлены в Core');
    expect(await items('Петрова Ирина')).toEqual(['Добавить в Core']);                 // active Bitrix-only employee
    await page.keyboard.press('Escape');
    await openTab(page, 'Неактивны в Bitrix24');
    await expect(page.getByRole('button', { name: 'Действия: Уволенный Сергей' })).toHaveCount(0); // inactive, not in Core: nothing valid
    // the menu is not clipped by the table viewport and every trigger is a real 44px target
    const box = await page.getByRole('button', { name: 'Действия: Беляев Олег' }).boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test('ADMIN-CORE-R01: at most one ⋯ menu is open — keyboard, mouse, toggle and action selection', async ({ page }) => {
    await open(page, rich());
    const menus = page.getByRole('menu');
    const trigger = (who: string) => page.getByRole('button', { name: `Действия: ${who}` });
    const focusedLabel = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '');

    // The exact reviewed sequence: focus first ⋯, Enter, Tab through its menu to another row's ⋯, Enter.
    await trigger('Админов Админ').focus();
    await page.keyboard.press('Enter');
    await expect(menus).toHaveCount(1);
    await expect(page.getByRole('menu', { name: 'Действия: Админов Админ' })).toBeVisible();
    for (let i = 0; i < 6 && (await focusedLabel()) !== 'Действия: Беляев Олег'; i++) await page.keyboard.press('Tab');
    expect(await focusedLabel()).toBe('Действия: Беляев Олег');
    await page.keyboard.press('Enter');
    await expect(menus).toHaveCount(1);
    await expect(page.getByRole('menu', { name: 'Действия: Беляев Олег' })).toBeVisible();
    await expect(page.getByRole('menu', { name: 'Действия: Админов Админ' })).toHaveCount(0);
    await expect(trigger('Админов Админ')).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger('Беляев Олег')).toHaveAttribute('aria-expanded', 'true');

    // Keyboard again, going back to the first row: still exactly one.
    await trigger('Админов Админ').focus();
    await page.keyboard.press('Enter');
    await expect(menus).toHaveCount(1);
    await expect(page.getByRole('menu', { name: 'Действия: Админов Админ' })).toBeVisible();

    // Toggle: activating the open trigger closes its menu; Escape closes the open one.
    await page.keyboard.press('Escape');
    await expect(menus).toHaveCount(0);
    await trigger('Громов Николай').click();
    await trigger('Громов Николай').click();
    await expect(menus).toHaveCount(0);

    // Mouse A → B.
    await trigger('Никитин Пётр').click();
    await expect(menus).toHaveCount(1);
    await trigger('Зайцев Андрей').click();
    await expect(menus).toHaveCount(1);
    await expect(page.getByRole('menu', { name: 'Действия: Зайцев Андрей' })).toBeVisible();

    // Selecting an action closes the menu and opens the existing workflow; changing tab/search also leaves no menu behind.
    await page.getByRole('menuitem', { name: 'Включить доступ' }).click();
    await expect(menus).toHaveCount(0);
    await expect(panelOf(page).getByLabel('Другая роль (необязательно)')).toBeVisible();
    await trigger('Никитин Пётр').click();
    await expect(menus).toHaveCount(1);
    await search(page).fill('никитин');
    await expect(menus).toHaveCount(0);
  });

  test('no UUIDs or raw enum names anywhere; existing actions still work through the menu', async ({ page }) => {
    const state = rich();
    await open(page, state);
    for (const tab of ['В Core', 'Не добавлены в Core', 'Неактивны в Bitrix24']) {
      await openTab(page, tab);
      const text = await page.locator('main').innerText();
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}/);
      expect(text).not.toMatch(/\b(PTO_HEAD|SDO_HEAD|DEPUTY_DIRECTOR|GENERAL_DIRECTOR|CONSTRUCTION_CONTROL|PROJECT_MANAGER|ADMIN_USERS|NotInCore|isActive)\b/);
    }
    await openTab(page, 'В Core');
    await act(page, 'Никитин Пётр', 'Отключить доступ');
    await page.getByRole('button', { name: 'Отключить доступ', exact: true }).click();
    await expect(rowOf(page, 'Никитин Пётр')).toContainText('Доступ отключён');
    expect(state.calls.filter((c) => c.method === 'PATCH').pop()!.body).toEqual({ isActive: false });
  });

  test('responsive: no page-level horizontal overflow; narrow width shows compact cards with search, filter, menu and panel usable', async ({ page }) => {
    await open(page, rich());
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    for (const w of [1280, 1024, 768]) { await page.setViewportSize({ width: w, height: 900 }); expect(await overflow(), String(w)).toBeLessThanOrEqual(0); }
    for (const w of [390, 320]) {
      await page.setViewportSize({ width: w, height: 800 });
      const list = page.getByRole('list', { name: 'Сотрудники' });
      await expect(list).toBeVisible();
      await expect(page.locator('main table')).toHaveCount(0);
      expect(await overflow(), String(w)).toBeLessThanOrEqual(0);
      await expect(page.locator('main')).not.toContainText('Системный администратор');
      await search(page).fill('никитин');
      await expect(list.getByRole('listitem')).toHaveCount(1);
      await act(page, 'Никитин Пётр', 'Изменить роль');
      await expect(panelOf(page).getByLabel('Роль в Core')).toBeVisible();
      expect(await overflow(), `${w} panel`).toBeLessThanOrEqual(0);
      await page.getByRole('button', { name: 'Отмена' }).click();
      await search(page).fill('');
    }
    await openTab(page, 'Не добавлены в Core');
    await act(page, 'Петрова Ирина', 'Добавить в Core');
    await expect(panelOf(page).getByLabel('Роль в Core')).toBeVisible();
  });
});
