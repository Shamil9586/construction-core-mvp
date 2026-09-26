import { test, expect, type Page, type Request, type Route } from '@playwright/test';
import { demoInspections, demoObjects, demoWorks } from '../../apps/frontend/src/screens/demo/fixtures';

/**
 * F7 — the internal Core application's session bootstrap, rendered.
 *
 * TEST TYPE: browser, INTERCEPTED. playwright.f7.config.ts starts the real
 * Vite dev server with VITE_DATA_PROVIDER=real, so the real, unmodified
 * App/SessionGate/realDataProvider code runs in a real browser. Every
 * `/api/*` request is answered by Playwright's `page.route()` — a real HTTP
 * response, but no backend and no database behind it. This is NOT a backend
 * end-to-end test; the same flows against a real backend and database, served
 * by a real Caddy, are in tests/f7-production/.
 *
 * Any `/api/*` request a test did not expect is answered 599 and recorded,
 * so "no request was made" is asserted, not assumed.
 */

type Responder = (request: Request) => { status: number; body?: unknown };

interface ApiCall {
  method: string;
  path: string;
  authorization: string | null;
  body: string | null;
}

async function mockApi(page: Page, responders: Record<string, Responder>): Promise<ApiCall[]> {
  const calls: ApiCall[] = [];
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route: Route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const key = `${request.method()} ${path}`;
      calls.push({
        method: request.method(),
        path,
        authorization: request.headers()['authorization'] ?? null,
        body: request.postData(),
      });
      const responder = responders[key];
      if (!responder) {
        await route.fulfill({ status: 599, contentType: 'text/plain', body: `unexpected ${key}` });
        return;
      }
      const { status, body } = responder(request);
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body ?? {}) });
    },
  );
  return calls;
}

/** Seeds the tab's session once — a reload after sign-out must not bring it back. */
async function seedSessionOnce(page: Page, token: string): Promise<void> {
  await page.addInitScript((value: string) => {
    if (window.sessionStorage.getItem('__f7_seeded') === null) {
      window.sessionStorage.setItem('session', value);
      window.sessionStorage.setItem('__f7_seeded', '1');
    }
  }, token);
}

const sessionToken = (page: Page) => page.evaluate(() => window.sessionStorage.getItem('session'));

const INTERNAL = { id: 'u-gd', tenantId: 't-1', name: 'Александр Волков', role: 'GENERAL_DIRECTOR' };
const EXTERNAL = { id: 'u-cv', tenantId: 't-1', name: 'Представитель подрядчика', role: 'CONTRACTOR_VIEWER' };

/**
 * The intercepted "server" data deliberately differs from the demo fixtures
 * by name, so a silent fall back to mockDataProvider would be visible.
 */
const SERVER_SNAPSHOT = {
  objects: demoObjects.map((object, index) => ({ ...object, name: `Объект сервера ${index + 1}` })),
  works: demoWorks,
  contractors: [],
  dependencies: [],
  inspections: demoInspections,
};
const FIXTURE_OBJECT_NAME = demoObjects[0].name;

const ok = (body: unknown) => () => ({ status: 200, body });
const health = (authMode: string) => ok({ status: 'ok', authMode, databaseMode: 'postgres' });
const unauthorized = (message: string) => () => ({ status: 401, body: { statusCode: 401, message } });

const main = (page: Page) => page.locator('main');
const sidebar = (page: Page) => page.locator('aside');
const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });

const INTERNAL_ROLE_VALUES = [
  'GENERAL_DIRECTOR',
  'TECHNICAL_DIRECTOR',
  'PROJECT_MANAGER',
  'CONSTRUCTION_CONTROL',
  'PTO',
  'SDO',
  'ADMIN',
  'DEPARTMENT_HEAD',
];

/* --------------------------------------------------------------------- *
 * no session — the sign-in method follows the backend's authMode        *
 * --------------------------------------------------------------------- */

test.describe('no session in the tab', () => {
  test('authMode "mock": explicit sign-in state with the test sign-in; no session or data request', async ({ page }) => {
    const calls = await mockApi(page, { 'GET /api/health': health('mock') });
    await page.goto('/app.html/company');

    await expect(h1(page, 'Требуется вход')).toBeVisible();
    await expect(main(page).getByRole('heading', { level: 2, name: 'Тестовый вход' })).toBeVisible();
    await expect(main(page).getByLabel('Роль')).toBeVisible();
    await expect(main(page).getByLabel('Тестовый ключ')).toBeVisible();
    await expect(main(page).getByRole('button', { name: 'Войти' })).toBeVisible();
    expect(calls.map((call) => call.path)).toEqual(['/api/health']);
  });

  test('the test sign-in offers the internal roles only — never CONTRACTOR_VIEWER («Субподрядчик»)', async ({ page }) => {
    await mockApi(page, { 'GET /api/health': health('mock') });
    await page.goto('/app.html');

    const select = main(page).getByLabel('Роль');
    await expect(select).toBeVisible();
    const values = await select.locator('option').evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value),
    );
    expect(values).toEqual(INTERNAL_ROLE_VALUES);
    await expect(select.locator('option', { hasText: 'Субподрядчик' })).toHaveCount(0);
    await expect(select.locator('option[value="CONTRACTOR_VIEWER"]')).toHaveCount(0);
  });

  test('authMode "bitrix": a launch notice, and no sign-in form of any kind', async ({ page }) => {
    const calls = await mockApi(page, { 'GET /api/health': health('bitrix') });
    await page.goto('/app.html/company');

    await expect(h1(page, 'Требуется вход')).toBeVisible();
    await expect(main(page).getByRole('heading', { level: 2, name: 'Вход через Битрикс24' })).toBeVisible();
    await expect(main(page).getByText(/только через запуск приложения из портала Битрикс24/)).toBeVisible();
    await expect(page.locator('form')).toHaveCount(0);
    await expect(page.locator('select')).toHaveCount(0);
    await expect(page.locator('input')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Войти' })).toHaveCount(0);
    expect(calls.map((call) => call.path)).toEqual(['/api/health']);
  });

  test('any other non-mock authMode: a generic launch notice, still no sign-in form', async ({ page }) => {
    await mockApi(page, { 'GET /api/health': health('oidc') });
    await page.goto('/app.html/company');

    await expect(main(page).getByRole('heading', { level: 2, name: 'Вход через утверждённый запуск' })).toBeVisible();
    await expect(page.locator('form')).toHaveCount(0);
  });

  test('an undeterminable authMode never unlocks the test sign-in; retry re-asks the backend', async ({ page }) => {
    let healthy = false;
    await mockApi(page, {
      'GET /api/health': () =>
        healthy ? { status: 200, body: { status: 'ok', authMode: 'mock' } } : { status: 200, body: { status: 'ok' } },
    });
    await page.goto('/app.html/company');

    await expect(
      main(page).getByText('Не удалось определить способ входа: Неверный ответ сервера: режим входа не указан.'),
    ).toBeVisible();
    await expect(page.locator('form')).toHaveCount(0);

    healthy = true;
    await main(page).getByRole('button', { name: 'Повторить' }).click();
    await expect(main(page).getByRole('heading', { level: 2, name: 'Тестовый вход' })).toBeVisible();
  });
});

/* --------------------------------------------------------------------- *
 * Core test sign-in (existing POST /api/auth/mock)                       *
 * --------------------------------------------------------------------- */

test.describe('Core test sign-in', () => {
  test('a valid sign-in stores the existing session artifact and loads server data with it', async ({ page }) => {
    const calls = await mockApi(page, {
      'GET /api/health': health('mock'),
      'POST /api/auth/mock': () => ({ status: 201, body: { token: 'granted-token', user: INTERNAL } }),
      'GET /api/snapshot': ok(SERVER_SNAPSHOT),
    });
    await page.goto('/app.html/company');

    await main(page).getByLabel('Роль').selectOption('CONSTRUCTION_CONTROL');
    await main(page).getByLabel('Тестовый ключ').fill('test-key');
    await main(page).getByRole('button', { name: 'Войти' }).click();

    await expect(h1(page, 'Портфель объектов')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Объект сервера 1' })).toBeVisible();
    expect(await sessionToken(page)).toBe('granted-token');

    const signIn = calls.find((call) => call.path === '/api/auth/mock');
    expect(JSON.parse(signIn?.body ?? '{}')).toEqual({ role: 'CONSTRUCTION_CONTROL', key: 'test-key' });
    const snapshot = calls.find((call) => call.path === '/api/snapshot');
    expect(snapshot?.authorization).toBe('Bearer granted-token');
  });

  test('a rejected key stays in the sign-in state with the backend reason; nothing stored, no data request', async ({ page }) => {
    const calls = await mockApi(page, {
      'GET /api/health': health('mock'),
      'POST /api/auth/mock': unauthorized('Неверный тестовый ключ'),
    });
    await page.goto('/app.html/company');

    await main(page).getByLabel('Тестовый ключ').fill('wrong');
    await main(page).getByRole('button', { name: 'Войти' }).click();

    await expect(main(page).getByRole('alert')).toHaveText('Неверный тестовый ключ');
    await expect(h1(page, 'Требуется вход')).toBeVisible();
    expect(await sessionToken(page)).toBeNull();
    expect(calls.some((call) => call.path === '/api/snapshot')).toBe(false);
  });

  test('if the backend ever grants a CONTRACTOR_VIEWER session, Core still presents it as unavailable', async ({ page }) => {
    const calls = await mockApi(page, {
      'GET /api/health': health('mock'),
      'POST /api/auth/mock': () => ({ status: 201, body: { token: 'external-token', user: EXTERNAL } }),
    });
    await page.goto('/app.html/company');

    await main(page).getByLabel('Тестовый ключ').fill('test-key');
    await main(page).getByRole('button', { name: 'Войти' }).click();

    await expect(h1(page, 'Внутреннее приложение недоступно')).toBeVisible();
    expect(calls.some((call) => call.path === '/api/snapshot')).toBe(false);
  });

  test('a deep link opened while signed out lands on that screen after sign-in', async ({ page }) => {
    await mockApi(page, {
      'GET /api/health': health('mock'),
      'POST /api/auth/mock': () => ({ status: 201, body: { token: 'granted-token', user: INTERNAL } }),
      'GET /api/snapshot': ok(SERVER_SNAPSHOT),
    });
    await page.goto('/app.html/object/demo-object-1/work/demo-work-1-1');
    await expect(h1(page, 'Требуется вход')).toBeVisible();

    await main(page).getByLabel('Тестовый ключ').fill('test-key');
    await main(page).getByRole('button', { name: 'Войти' }).click();

    await expect(page).toHaveURL(/\/app\.html\/object\/demo-object-1\/work\/demo-work-1-1$/);
    await expect(h1(page, 'Отделка фасада')).toBeVisible();
  });
});

/* --------------------------------------------------------------------- *
 * an existing session (legacy entry, Bitrix launch, or an earlier Core  *
 * sign-in) — validated through the existing GET /api/me                  *
 * --------------------------------------------------------------------- */

test.describe('existing session', () => {
  test('valid internal session: Core loads, and the footer states the real source, the user and the way out', async ({ page }) => {
    await seedSessionOnce(page, 'existing-token');
    const calls = await mockApi(page, {
      'GET /api/me': ok(INTERNAL),
      'GET /api/snapshot': ok(SERVER_SNAPSHOT),
    });
    await page.goto('/app.html/company');

    await expect(h1(page, 'Портфель объектов')).toBeVisible();
    expect(calls.find((call) => call.path === '/api/me')?.authorization).toBe('Bearer existing-token');
    expect(calls.some((call) => call.path === '/api/health')).toBe(false);

    await expect(sidebar(page).getByText('Источник данных: сервер', { exact: true })).toBeVisible();
    await expect(sidebar(page).getByText('Александр Волков', { exact: true })).toBeVisible();
    await expect(sidebar(page).getByText('Генеральный директор', { exact: true })).toBeVisible();
    await expect(sidebar(page).getByRole('button', { name: 'Выйти' })).toBeVisible();
    await expect(page.getByText(/демо-данные|F5 ·/)).toHaveCount(0);
  });

  test('expired/invalid session (/api/me 401): explicit expired state, dead token removed, no data request', async ({ page }) => {
    await seedSessionOnce(page, 'expired-token');
    const calls = await mockApi(page, {
      'GET /api/me': unauthorized('Сессия истекла'),
      'GET /api/health': health('mock'),
    });
    await page.goto('/app.html/object/demo-object-1');

    await expect(h1(page, 'Сессия истекла')).toBeVisible();
    await expect(page.getByText(/Не удалось загрузить данные/)).toHaveCount(0);
    await expect(main(page).getByRole('heading', { level: 2, name: 'Тестовый вход' })).toBeVisible();
    expect(await sessionToken(page)).toBeNull();
    expect(calls.some((call) => call.path === '/api/snapshot')).toBe(false);
  });

  test('a failed session check (5xx) is its own state — not signed out, token kept — and retry recovers', async ({ page }) => {
    await seedSessionOnce(page, 'kept-token');
    let meStatus = 502;
    await mockApi(page, {
      'GET /api/me': () => (meStatus === 200 ? { status: 200, body: INTERNAL } : { status: meStatus, body: {} }),
      'GET /api/snapshot': ok(SERVER_SNAPSHOT),
    });
    await page.goto('/app.html/company');

    await expect(h1(page, 'Не удалось проверить сессию')).toBeVisible();
    await expect(main(page).getByRole('alert')).toHaveText('Причина: HTTP 502');
    expect(await sessionToken(page)).toBe('kept-token');

    meStatus = 200;
    await main(page).getByRole('button', { name: 'Повторить' }).click();
    await expect(h1(page, 'Портфель объектов')).toBeVisible();
  });

  test('CONTRACTOR_VIEWER session: explicit unavailable state, no data requested, sign-out ends it', async ({ page }) => {
    await seedSessionOnce(page, 'external-token');
    const calls = await mockApi(page, {
      'GET /api/me': ok(EXTERNAL),
      'POST /api/auth/logout': () => ({ status: 201, body: { loggedOut: true } }),
      'GET /api/health': health('mock'),
    });
    await page.goto('/app.html/company');

    await expect(h1(page, 'Внутреннее приложение недоступно')).toBeVisible();
    await expect(main(page).getByText(/принадлежит внешнему участнику/)).toBeVisible();
    await expect(h1(page, 'Портфель объектов')).toHaveCount(0);
    expect(calls.some((call) => call.path === '/api/snapshot')).toBe(false);

    await main(page).getByRole('button', { name: 'Выйти' }).click();
    await expect(h1(page, 'Вы вышли из системы')).toBeVisible();
    expect(calls.find((call) => call.path === '/api/auth/logout')?.authorization).toBe('Bearer external-token');
    expect(await sessionToken(page)).toBeNull();
  });

  test('a role Core does not recognise is unavailable too — an unknown role is never treated as internal', async ({ page }) => {
    await seedSessionOnce(page, 'odd-token');
    const calls = await mockApi(page, { 'GET /api/me': ok({ ...INTERNAL, role: 'SOME_FUTURE_ROLE' }) });
    await page.goto('/app.html/company');

    await expect(h1(page, 'Внутреннее приложение недоступно')).toBeVisible();
    await expect(main(page).getByText('Роль этой учётной записи не поддерживается внутренним приложением.')).toBeVisible();
    expect(calls.some((call) => call.path === '/api/snapshot')).toBe(false);
  });
});

/* --------------------------------------------------------------------- *
 * auth failure vs data failure                                           *
 * --------------------------------------------------------------------- */

test.describe('an authentication failure is not a data failure', () => {
  test('/api/snapshot 401 after a valid session check: expired state, not «Не удалось загрузить данные»', async ({ page }) => {
    await seedSessionOnce(page, 'soon-dead-token');
    await mockApi(page, {
      'GET /api/me': ok(INTERNAL),
      'GET /api/snapshot': unauthorized('Сессия истекла'),
      'GET /api/health': health('mock'),
    });
    await page.goto('/app.html/company');

    await expect(h1(page, 'Сессия истекла')).toBeVisible();
    await expect(page.getByText(/Не удалось загрузить данные/)).toHaveCount(0);
    expect(await sessionToken(page)).toBeNull();
  });

  test('/api/snapshot 502 is a data failure: RouteError, the session stays, no fixtures appear', async ({ page }) => {
    await seedSessionOnce(page, 'good-token');
    await mockApi(page, {
      'GET /api/me': ok(INTERNAL),
      'GET /api/snapshot': () => ({ status: 502, body: {} }),
    });
    await page.goto('/app.html/company');

    await expect(main(page).getByText('Не удалось загрузить данные: HTTP 502')).toBeVisible();
    await expect(h1(page, 'Сессия истекла')).toHaveCount(0);
    await expect(sidebar(page).getByText('Александр Волков', { exact: true })).toBeVisible();
    expect(await sessionToken(page)).toBe('good-token');
    await expect(page.getByText(FIXTURE_OBJECT_NAME)).toHaveCount(0);
  });

  test('no real→mock fallback anywhere: a failing session check never renders fixture data', async ({ page }) => {
    await seedSessionOnce(page, 'any-token');
    await mockApi(page, { 'GET /api/me': () => ({ status: 500, body: {} }) });
    await page.goto('/app.html/company');

    await expect(h1(page, 'Не удалось проверить сессию')).toBeVisible();
    await expect(page.getByText(FIXTURE_OBJECT_NAME)).toHaveCount(0);
    await expect(h1(page, 'Портфель объектов')).toHaveCount(0);
  });
});

/* --------------------------------------------------------------------- *
 * logout (existing POST /api/auth/logout)                                *
 * --------------------------------------------------------------------- */

test.describe('logout', () => {
  test('«Выйти» ends the session on the server, clears the tab, and removes the data from screen', async ({ page }) => {
    await seedSessionOnce(page, 'live-token');
    const calls = await mockApi(page, {
      'GET /api/me': ok(INTERNAL),
      'GET /api/snapshot': ok(SERVER_SNAPSHOT),
      'POST /api/auth/logout': () => ({ status: 201, body: { loggedOut: true } }),
      'GET /api/health': health('mock'),
    });
    await page.goto('/app.html/company');
    await expect(page.getByRole('button', { name: 'Объект сервера 1' })).toBeVisible();

    await sidebar(page).getByRole('button', { name: 'Выйти' }).click();

    await expect(h1(page, 'Вы вышли из системы')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Объект сервера 1' })).toHaveCount(0);
    expect(calls.find((call) => call.path === '/api/auth/logout')?.authorization).toBe('Bearer live-token');
    expect(await sessionToken(page)).toBeNull();

    const before = calls.length;
    await page.reload();
    await expect(h1(page, 'Требуется вход')).toBeVisible();
    expect(calls.slice(before).some((call) => call.path === '/api/me' || call.path === '/api/snapshot')).toBe(false);
  });

  test('a 401 on logout (session already gone) is treated as signed out', async ({ page }) => {
    await seedSessionOnce(page, 'stale-token');
    await mockApi(page, {
      'GET /api/me': ok(INTERNAL),
      'GET /api/snapshot': ok(SERVER_SNAPSHOT),
      'POST /api/auth/logout': unauthorized('Сессия истекла'),
      'GET /api/health': health('mock'),
    });
    await page.goto('/app.html/company');
    await sidebar(page).getByRole('button', { name: 'Выйти' }).click();

    await expect(h1(page, 'Вы вышли из системы')).toBeVisible();
    expect(await sessionToken(page)).toBeNull();
  });

  test('a logout the server could not complete is reported, and the session is kept', async ({ page }) => {
    await seedSessionOnce(page, 'live-token');
    await mockApi(page, {
      'GET /api/me': ok(INTERNAL),
      'GET /api/snapshot': ok(SERVER_SNAPSHOT),
      'POST /api/auth/logout': () => ({ status: 500, body: {} }),
    });
    await page.goto('/app.html/company');
    await sidebar(page).getByRole('button', { name: 'Выйти' }).click();

    await expect(sidebar(page).getByRole('alert')).toHaveText('Не удалось выйти: HTTP 500');
    await expect(h1(page, 'Портфель объектов')).toBeVisible();
    expect(await sessionToken(page)).toBe('live-token');
  });
});
