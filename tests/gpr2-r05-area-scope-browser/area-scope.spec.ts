import { test, expect, type Page, type Route } from '@playwright/test';
import { demoInspections, demoObjects, demoWorks } from '../../apps/frontend/src/screens/demo/fixtures';

/**
 * GPR-2 R05 S2 «Зоны объекта» — browser, INTERCEPTED. The real app runs under Vite (VITE_DATA_PROVIDER=real); every /api/* request is
 * answered by page.route(). NOT a backend end-to-end test: it does not prove the D1 read API or the create route behave this way.
 * An /api/* request the test did not expect is answered 599 and recorded.
 */
const OBJECT_ID = demoObjects[0]!.id;
const OTHER_OBJECT_ID = demoObjects[1]!.id;
const PM = { id: 'u-pm', tenantId: 't-1', name: 'Руководитель Проекта', role: 'PROJECT_MANAGER' };
const DEPUTY = { id: 'u-dd', tenantId: 't-1', name: 'Пётр Никитин', role: 'DEPUTY_DIRECTOR' };
const PTO = { id: 'u-pto', tenantId: 't-1', name: 'Инженер ПТО', role: 'PTO' };
const SNAPSHOT = { objects: demoObjects, works: demoWorks, contractors: [], dependencies: [], inspections: demoInspections };

const area = (id: string, over: Record<string, unknown> = {}) => ({
  id, parentId: null, kind: 'BUILDING', code: id.toUpperCase(), name: `Зона ${id}`, measureQuantity: null, measureUnit: null,
  lifecycle: 'ACTIVE', version: 1, createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z', ...over,
});

interface Recorded { method: string; path: string; search: string; headers: Record<string, string>; body: string | null }
interface Api {
  calls: Recorded[];
  v2: () => Recorded[];
  /** Scripted behaviour of the R05 routes; replaced per test. */
  list: (call: Recorded) => { status: number; body: unknown };
  create: (call: Recorded) => { status: number; body: unknown };
}

async function setup(page: Page, user: typeof PM): Promise<Api> {
  const api: Api = {
    calls: [],
    v2: () => api.calls.filter((c) => c.path.startsWith('/api/v2/')),
    list: () => ({ status: 200, body: { items: [], nextCursor: null } }),
    create: () => ({ status: 200, body: { resultIds: ['new'], appliedVersions: {}, warnings: [] } }),
  };
  await page.addInitScript(() => { window.sessionStorage.setItem('session', 'test-token'); });
  await page.route((url) => url.pathname.startsWith('/api/'), async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const call: Recorded = { method: request.method(), path: url.pathname, search: url.search, headers: request.headers(), body: request.postData() };
    api.calls.push(call);
    let result: { status: number; body: unknown };
    if (call.path === '/api/me') result = { status: 200, body: user };
    else if (call.path === '/api/snapshot') result = { status: 200, body: SNAPSHOT };
    else if (call.path === '/api/health') result = { status: 200, body: { status: 'ok', authMode: 'mock', databaseMode: 'postgres' } };
    else if (/^\/api\/objects\/[^/]+\/schedule$/.test(call.path)) result = { status: 403, body: { statusCode: 403, message: 'forbidden' } };
    else if (call.path.startsWith('/api/v2/') && call.method === 'GET') result = api.list(call);
    else if (call.path.startsWith('/api/v2/') && call.method === 'POST') result = api.create(call);
    else { await route.fulfill({ status: 599, contentType: 'text/plain', body: `unexpected ${call.method} ${call.path}` }); return; }
    await route.fulfill({ status: result.status, contentType: 'application/json', body: JSON.stringify(result.body) });
  });
  return api;
}

const areasUrl = (objectId = OBJECT_ID) => `/app.html/object/${objectId}/finish/areas`;
const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });
const tree = (page: Page) => page.getByRole('list', { name: 'Зоны объекта' });
const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });

test.describe('role gate (presentation only)', () => {
  test('PROJECT_MANAGER: entry on the object page leads to the screen of THAT object', async ({ page }) => {
    const api = await setup(page, PM);
    api.list = () => ({ status: 200, body: { items: [area('a')], nextCursor: null } });
    await page.goto(`/app.html/object/${OBJECT_ID}`);
    await page.getByRole('button', { name: 'Зоны объекта' }).click();
    await expect(page).toHaveURL(new RegExp(`/object/${OBJECT_ID}/finish/areas$`));
    await expect(h1(page, 'Зоны объекта')).toBeVisible();
    await expect(tree(page)).toContainText('Зона a');
    // one-object request scoping: every R05 call names the route object and nothing else
    expect(api.v2().length).toBeGreaterThan(0);
    for (const call of api.v2()) expect(call.path).toBe(`/api/v2/objects/${OBJECT_ID}/area-scopes`);
    expect(api.v2().every((c) => c.headers['authorization'] === 'Bearer test-token')).toBe(true);
    expect(api.calls.some((c) => c.path.includes(OTHER_OBJECT_ID))).toBe(false);
  });

  for (const user of [DEPUTY, PTO]) {
    test(`${user.role}: no entry on the object page; direct URL is blocked and makes NO R05 request`, async ({ page }) => {
      const api = await setup(page, user);
      await page.goto(`/app.html/object/${OBJECT_ID}`);
      await expect(page.locator('main')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Зоны объекта' })).toHaveCount(0);

      await page.goto(areasUrl());
      await expect(h1(page, 'Раздел «Зоны объекта» доступен руководителю проекта.')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Новая зона' })).toHaveCount(0);
      expect(api.v2()).toEqual([]);
    });
  }
});

test.describe('read', () => {
  test('empty tree is an explicit empty state, not an error', async ({ page }) => {
    await setup(page, PM);
    await page.goto(areasUrl());
    await expect(page.getByText('Зон пока нет. Добавьте первую зону ниже.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Новая зона' })).toBeVisible();
  });

  test('pages are followed; the flexible tree shows kind, code, quantity, unit and lifecycle', async ({ page }) => {
    const api = await setup(page, PM);
    api.list = (call) => {
      const cursor = new URLSearchParams(call.search).get('cursor');
      if (cursor === null) return { status: 200, body: { items: [area('b1', { code: 'К1', name: 'Корпус 1' })], nextCursor: 'p2' } };
      if (cursor === 'p2') return { status: 200, body: { items: [area('r1', { parentId: 'b1', kind: 'ROOM', code: '101', name: 'Комната', measureQuantity: '12.5000', measureUnit: 'м²' })], nextCursor: 'p3' } };
      return { status: 200, body: { items: [area('x', { parentId: 'r1', kind: 'ATTIC', code: 'Х', name: 'Неизвестный', lifecycle: 'RETIRED' })], nextCursor: null } };
    };
    await page.goto(areasUrl());
    const room = page.getByRole('listitem').filter({ hasText: 'Комната' }).first();
    await expect(room).toContainText('Помещение');
    await expect(room).toContainText('12,5000 м²');
    await expect(room).toContainText('Действует');
    const unknown = page.getByRole('listitem').filter({ hasText: 'Неизвестный' }).last();
    await expect(unknown).toContainText('Неизвестный вид (ATTIC)');
    await expect(unknown).toContainText('Выведена из работы');
    await expect(page.getByRole('list', { name: 'Вложенные зоны: К1' })).toBeVisible();
    // no edit / delete / retire controls
    await expect(page.getByRole('button', { name: /удалить|изменить|редактировать|вывести/i })).toHaveCount(0);
    const gets = api.v2().filter((c) => c.method === 'GET');
    expect(gets.map((c) => new URLSearchParams(c.search).get('cursor'))).toEqual([null, 'p2', 'p3']);
    expect(gets.every((c) => new URLSearchParams(c.search).get('limit') === '200')).toBe(true);
  });

  test('a repeated cursor fails closed: error, no partial tree', async ({ page }) => {
    const api = await setup(page, PM);
    api.list = () => ({ status: 200, body: { items: [area('a')], nextCursor: 'same' } });
    await page.goto(areasUrl());
    await expect(page.getByRole('alert')).toContainText('повторил курсор');
    await expect(tree(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Повторить загрузку' })).toBeVisible();
  });

  for (const status of [403, 404]) {
    test(`${status} from the server is a generic unavailable state, never an empty tree`, async ({ page }) => {
      const api = await setup(page, PM);
      api.list = () => ({ status, body: { statusCode: status, code: status === 403 ? 'PERMISSION_DENIED' : 'RESOURCE_NOT_FOUND', message: 'internal wording', requestId: 'req-x' } });
      await page.goto(areasUrl());
      await expect(page.getByRole('alert')).toContainText('Раздел «Зоны объекта» недоступен.');
      await expect(page.getByRole('alert')).not.toContainText('internal wording');
      await expect(page.getByText('Зон пока нет')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Новая зона' })).toHaveCount(0);
    });
  }
});

test.describe('create', () => {
  test('root then child: Idempotency-Key present, payload exact, full tree reloaded and the node shown', async ({ page }) => {
    const api = await setup(page, PM);
    const store = [area('seed', { code: 'К1', name: 'Корпус 1' })] as Array<Record<string, unknown>>;
    api.list = () => ({ status: 200, body: { items: store, nextCursor: null } });
    api.create = (call) => {
      const payload = JSON.parse(call.body ?? '{}');
      store.push(area(`n${store.length}`, { ...payload, parentId: payload.parentId ?? null, measureQuantity: payload.measureQuantity ?? null, measureUnit: payload.measureUnit ?? null }));
      return { status: 200, body: { resultIds: [`n${store.length}`], appliedVersions: {}, warnings: [] } };
    };
    await page.goto(areasUrl());
    await expect(tree(page)).toContainText('Корпус 1');

    // root
    await field(page, 'Вид').selectOption('BUILDING');
    await field(page, 'Код').fill('К2');
    await field(page, 'Название').fill('Корпус 2');
    await page.getByRole('button', { name: 'Создать зону' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Зона «К2» создана.' })).toBeVisible();
    await expect(tree(page)).toContainText('Корпус 2');
    let posts = api.v2().filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe(`/api/v2/objects/${OBJECT_ID}/area-scopes`);
    expect(posts[0]!.headers['idempotency-key']).toMatch(/\S{8,}/);
    expect(JSON.parse(posts[0]!.body!)).toEqual({ kind: 'BUILDING', code: 'К2', name: 'Корпус 2' });

    // child, via the row action; quantity decimal comma is sent as a decimal string
    await page.getByRole('button', { name: 'Добавить зону внутрь: К1 Корпус 1' }).click();
    await expect(field(page, 'Родительская зона')).toHaveValue('seed');
    await expect(field(page, 'Код')).toBeFocused();
    await field(page, 'Вид').selectOption('FLOOR');
    await field(page, 'Код').fill('Э1');
    await field(page, 'Название').fill('Этаж 1');
    await field(page, 'Количество (необязательно)').fill('10,5');
    await field(page, 'Единица (необязательно)').selectOption('м²');
    await page.getByRole('button', { name: 'Создать зону' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Зона «Э1» создана.' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Вложенные зоны: К1' })).toContainText('Этаж 1');
    posts = api.v2().filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(JSON.parse(posts[1]!.body!)).toEqual({ parentId: 'seed', kind: 'FLOOR', code: 'Э1', name: 'Этаж 1', measureQuantity: '10.5', measureUnit: 'м²' });
    expect(posts[1]!.headers['idempotency-key']).not.toBe(posts[0]!.headers['idempotency-key']);
    // every create was followed by a full reload of the tree
    expect(api.v2().filter((c) => c.method === 'GET')).toHaveLength(3);
  });

  test('server validation error is shown in Russian; a retry of the SAME payload reuses the key, an edited payload gets a new one', async ({ page }) => {
    const api = await setup(page, PM);
    let attempts = 0;
    api.create = () => {
      attempts += 1;
      if (attempts <= 2) return { status: 422, body: { statusCode: 422, code: 'VALIDATION_FAILED', message: 'Запрос не соответствует контракту', details: { violations: [{ path: 'measureUnit', rule: 'UNIT_MISSING' }] }, requestId: 'req-42' } };
      return { status: 200, body: { resultIds: ['n'], appliedVersions: {}, warnings: [] } };
    };
    await page.goto(areasUrl());
    await field(page, 'Код').fill('К1');
    await field(page, 'Название').fill('Корпус');
    await field(page, 'Количество (необязательно)').fill('5');
    await page.getByRole('button', { name: 'Создать зону' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Запрос не соответствует контракту');
    await expect(alert).toContainText('Единица: укажите единицу вместе с количеством');
    await expect(alert).toContainText('Код обращения: req-42');

    await page.getByRole('button', { name: 'Создать зону' }).click(); // same payload again
    await expect(page.getByRole('alert')).toBeVisible();
    await field(page, 'Название').fill('Корпус А'); // edited payload
    await page.getByRole('button', { name: 'Создать зону' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'создана' })).toBeVisible();

    const keys = api.v2().filter((c) => c.method === 'POST').map((c) => c.headers['idempotency-key']);
    expect(keys).toHaveLength(3);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  test('create-in-progress: the submit is inert and labelled until the server answers', async ({ page }) => {
    const api = await setup(page, PM);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`**/api/v2/objects/${OBJECT_ID}/area-scopes`, async (route) => {
      if (route.request().method() !== 'POST') { await route.fallback(); return; }
      api.calls.push({ method: 'POST', path: new URL(route.request().url()).pathname, search: '', headers: route.request().headers(), body: route.request().postData() });
      await gate;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ resultIds: ['n'], appliedVersions: {}, warnings: [] }) });
    });
    await page.goto(areasUrl());
    await field(page, 'Код').fill('К1');
    await field(page, 'Название').fill('Корпус');
    await page.getByRole('button', { name: 'Создать зону' }).click();
    const busy = page.getByRole('button', { name: 'Создание…' });
    await expect(busy).toBeDisabled();
    await expect(field(page, 'Код')).toBeDisabled();
    release();
    await expect(page.getByRole('status').filter({ hasText: 'создана' })).toBeVisible();
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
});

test.describe('layout', () => {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    test(`${viewport.width}px: tree and form are usable without horizontal overflow`, async ({ page }) => {
      const api = await setup(page, PM);
      api.list = () => ({ status: 200, body: { items: [area('b', { code: 'К1', name: 'Очень длинное название корпуса для проверки переноса строк в узкой колонке' }), area('r', { parentId: 'b', kind: 'ROOM', code: '101', name: 'Комната', measureQuantity: '12.5', measureUnit: 'м²' })], nextCursor: null } });
      await page.setViewportSize(viewport);
      await page.goto(areasUrl());
      await expect(tree(page)).toContainText('Комната');
      await field(page, 'Название').scrollIntoViewIfNeeded();
      await expect(field(page, 'Название')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Создать зону' })).toBeVisible();
      const overflow = await page.evaluate(() => {
        const main = document.querySelector('main');
        return { doc: document.documentElement.scrollWidth - window.innerWidth, main: main ? main.scrollWidth - main.clientWidth : 0 };
      });
      expect(overflow.doc).toBeLessThanOrEqual(1);
      expect(overflow.main).toBeLessThanOrEqual(1);
    });
  }

  test('keyboard: the form is reachable and submittable with Tab / Enter', async ({ page }) => {
    const api = await setup(page, PM);
    await page.goto(areasUrl());
    await field(page, 'Код').focus();
    await page.keyboard.type('К1');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Корпус');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'Зона «К1» создана.' })).toBeVisible();
    expect(api.v2().filter((c) => c.method === 'POST')).toHaveLength(1);
  });
});
