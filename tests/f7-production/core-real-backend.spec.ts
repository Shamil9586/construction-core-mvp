import { test, expect, type Page } from '@playwright/test';

/**
 * F7 — the internal Core application against a REAL backend and database,
 * served production-like.
 *
 * TEST TYPE: production-like local serving + REAL backend/database. The Core
 * bundle is the real `npm run build:core` output (VITE_DATA_PROVIDER=real),
 * served by a real Caddy running infra/Caddyfile, whose `/api/*` proxy
 * reaches the real NestJS backend (AUTH_MODE=mock) on a disposable, migrated
 * and seeded PGlite database. Sessions, 401s and logouts are the backend's
 * own. Nothing is intercepted. (See global-setup.ts.)
 */

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — run this suite through playwright.f7-prod.config.ts`);
  return value;
};
const CORE = () => env('F7_CORE_URL');
const MOCK_KEY = () => env('F7_MOCK_LOGIN_KEY');

const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });
const main = (page: Page) => page.locator('main');
const sidebar = (page: Page) => page.locator('aside');
const sessionToken = (page: Page) => page.evaluate(() => window.sessionStorage.getItem('session'));

interface RealIds {
  objectId: string;
  objectName: string;
  workId: string;
  workName: string;
}

/** Signs in through Core's own test sign-in form (POST /api/auth/mock on the real backend). */
async function signInThroughCore(page: Page, role = 'GENERAL_DIRECTOR'): Promise<void> {
  await expect(h1(page, 'Требуется вход')).toBeVisible();
  await main(page).getByLabel('Роль').selectOption(role);
  await main(page).getByLabel('Тестовый ключ').fill(MOCK_KEY());
  await main(page).getByRole('button', { name: 'Войти' }).click();
}

/** Real ids, read from the real /api/snapshot with the session Core itself established. */
async function realIds(page: Page): Promise<RealIds> {
  return page.evaluate(async () => {
    const token = window.sessionStorage.getItem('session');
    const response = await fetch('/api/snapshot', { headers: { Authorization: `Bearer ${token}` } });
    const snapshot = (await response.json()) as {
      objects: Array<{ id: string; name: string }>;
      works: Array<{ id: string; name: string; objectId: string }>;
    };
    const work = snapshot.works[0];
    const object = snapshot.objects.find((candidate) => candidate.id === work.objectId);
    if (!object) throw new Error('seeded snapshot has a work without its object');
    return { objectId: object.id, objectName: object.name, workId: work.id, workName: work.name };
  });
}

test('signed out: the sign-in state with the test sign-in, because the real backend reports authMode "mock"', async ({ page }) => {
  await page.goto(`${CORE()}/app.html/company`);

  await expect(h1(page, 'Требуется вход')).toBeVisible();
  await expect(main(page).getByRole('heading', { level: 2, name: 'Тестовый вход' })).toBeVisible();
  const values = await main(page)
    .getByLabel('Роль')
    .locator('option')
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  expect(values).not.toContain('CONTRACTOR_VIEWER');
  expect(values).toHaveLength(8);
  await expect(sidebar(page).getByText('Источник данных: сервер', { exact: true })).toBeVisible();
});

test('a wrong key is refused by the real backend and Core stays signed out', async ({ page }) => {
  await page.goto(`${CORE()}/app.html/company`);
  await main(page).getByLabel('Тестовый ключ').fill('definitely-not-the-key');
  await main(page).getByRole('button', { name: 'Войти' }).click();

  await expect(main(page).getByRole('alert')).toHaveText('Неверный тестовый ключ');
  expect(await sessionToken(page)).toBeNull();
});

test('sign-in, then direct open and reload of C01, O01 and W01 on real data — always the Core app', async ({ page }) => {
  await page.goto(`${CORE()}/app.html/company`);
  await signInThroughCore(page);
  await expect(h1(page, 'Портфель объектов')).toBeVisible();
  await expect(sidebar(page).getByText('Генеральный директор', { exact: true })).toBeVisible();
  await expect(sidebar(page).getByText('Источник данных: сервер', { exact: true })).toBeVisible();
  await expect(page.getByText(/демо-данные|F5 ·/)).toHaveCount(0);

  const ids = await realIds(page);
  await expect(page.getByRole('button', { name: ids.objectName })).toBeVisible();

  const cases = [
    { path: '/app.html/company', heading: 'Портфель объектов' },
    { path: `/app.html/object/${ids.objectId}`, heading: ids.objectName },
    { path: `/app.html/object/${ids.objectId}/work/${ids.workId}`, heading: ids.workName },
  ];
  for (const { path, heading } of cases) {
    const opened = await page.goto(CORE() + path);
    expect(await opened?.text(), path).toContain('id="app-root"');
    await expect(h1(page, heading)).toBeVisible();

    const reloaded = await page.reload();
    expect(await reloaded?.text(), `${path} (reload)`).toContain('id="app-root"');
    expect(new URL(page.url()).pathname).toBe(path);
    await expect(h1(page, heading)).toBeVisible();
  }
});

test('unknown Core route and unknown ids render Core states, never the legacy app', async ({ page }) => {
  await page.goto(`${CORE()}/app.html/company`);
  await signInThroughCore(page);
  await expect(h1(page, 'Портфель объектов')).toBeVisible();

  await page.goto(`${CORE()}/app.html/does-not-exist`);
  await expect(main(page).getByText('Страница не найдена', { exact: true })).toBeVisible();
  await page.goto(`${CORE()}/app.html/object/00000000-0000-4000-8000-000000000000`);
  await expect(main(page).getByText('Объект не найден', { exact: true })).toBeVisible();
  await expect(page.getByText('Вход в тестовую среду')).toHaveCount(0);
});

test('logout from Core ends the session in the real backend', async ({ page, request }) => {
  await page.goto(`${CORE()}/app.html/company`);
  await signInThroughCore(page);
  await expect(h1(page, 'Портфель объектов')).toBeVisible();
  const token = await sessionToken(page);
  expect(token).toBeTruthy();

  await sidebar(page).getByRole('button', { name: 'Выйти' }).click();
  await expect(h1(page, 'Вы вышли из системы')).toBeVisible();
  expect(await sessionToken(page)).toBeNull();

  const me = await request.get(`${CORE()}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
  expect(me.status()).toBe(401);
});

test('a token the backend does not know: explicit expired state, not a data error', async ({ page }) => {
  await page.addInitScript(() => window.sessionStorage.setItem('session', 'not-a-real-session-token'));
  await page.goto(`${CORE()}/app.html/company`);

  await expect(h1(page, 'Сессия истекла')).toBeVisible();
  await expect(page.getByText(/Не удалось загрузить данные/)).toHaveCount(0);
});

test('session loss: a session ended elsewhere is detected on the next load as expired', async ({ page, request }) => {
  await page.goto(`${CORE()}/app.html/company`);
  await signInThroughCore(page);
  await expect(h1(page, 'Портфель объектов')).toBeVisible();
  const token = await sessionToken(page);

  const logout = await request.post(`${CORE()}/api/auth/logout`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {},
  });
  expect(logout.status()).toBe(201);

  await page.reload();
  await expect(h1(page, 'Сессия истекла')).toBeVisible();
  expect(await sessionToken(page)).toBeNull();
});

test('an existing CONTRACTOR_VIEWER session gets the unavailable state and no data', async ({ page, request }) => {
  // The legacy entry can still create this session (its role picker offers
  // «Субподрядчик»); the same existing endpoint is called here directly.
  const grant = await request.post(`${CORE()}/api/auth/mock`, { data: { role: 'CONTRACTOR_VIEWER', key: MOCK_KEY() } });
  expect(grant.status()).toBe(201);
  const { token } = (await grant.json()) as { token: string };

  const snapshotRequests: string[] = [];
  page.on('request', (request_) => {
    if (new URL(request_.url()).pathname === '/api/snapshot') snapshotRequests.push(request_.url());
  });
  await page.addInitScript((value: string) => window.sessionStorage.setItem('session', value), token);
  await page.goto(`${CORE()}/app.html/company`);

  await expect(h1(page, 'Внутреннее приложение недоступно')).toBeVisible();
  await expect(h1(page, 'Портфель объектов')).toHaveCount(0);
  expect(snapshotRequests).toEqual([]);
});
