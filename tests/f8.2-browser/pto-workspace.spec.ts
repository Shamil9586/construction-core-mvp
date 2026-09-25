import { test, expect, type Page } from '@playwright/test';

/**
 * F8.2 PTO / Executive Documentation Foundation — P01 (PTO Workspace) and
 * W01's "Исполнительная документация" section, rendered in a real browser.
 *
 * TEST TYPE: browser, INTERCEPTED — same shape as
 * tests/f8.1-browser/w01-execution.spec.ts: playwright.f8.2.config.ts starts
 * the real Vite dev server with VITE_DATA_PROVIDER=real, so the real,
 * unmodified App/PtoRoute/WorkRoute/screens code runs in a real browser.
 * Every `/api/*` request is answered by Playwright's `page.route()` against
 * a small in-memory fixture this file owns — a real HTTP response, but no
 * backend and no database behind it. The backend's own rules (permissions,
 * object scope, the status/type/storage-provider CHECK constraints) already
 * have real HTTP/PGlite coverage in tests/documentation-foundation.test.ts
 * and tests/f8.2-documentation-http.test.ts; this file's job is only to
 * prove the UI reads the shared snapshot correctly and renders what a user
 * actually sees.
 */

const PM = { id: 'u-pm', tenantId: 't-1', name: 'Пётр Петров', role: 'PROJECT_MANAGER' };

const OBJECT_A = 'object-a';
const OBJECT_B = 'object-b';
const WORK_A = 'work-a';
const WORK_B = 'work-b';
const WORK_C = 'work-c';
const PACKAGE_A = 'package-a';
const PACKAGE_B = 'package-b';

async function mockApi(page: Page, snapshot: unknown): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request();
      const key = `${request.method()} ${new URL(request.url()).pathname}`;
      if (key === 'GET /api/me') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PM) });
        return;
      }
      if (key === 'GET /api/snapshot') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) });
        return;
      }
      await route.fulfill({ status: 599, contentType: 'text/plain', body: `unexpected ${key}` });
    },
  );
}

async function seedSession(page: Page, token: string): Promise<void> {
  await page.addInitScript((value: string) => {
    window.sessionStorage.setItem('session', value);
  }, token);
}

function object(id: string, name: string, externalCode: string) {
  return {
    id,
    tenantId: 't-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    externalCode,
    source: 'core',
    name,
    address: 'Тест, 1',
    customerName: null,
    organizationName: 'ООО СЗ «Гор-Строй»',
    projectManagerId: PM.id,
    startDate: '2026-01-01',
    plannedFinishDate: '2026-12-31',
    actualFinishDate: null,
    status: 'ACTIVE',
    healthStatus: 'GREEN',
    responsible: PM.name,
    contractorIds: ['contractor-1'],
    contractors: ['Подрядчик 1'],
    actualProgress: 0,
    plannedProgress: 0,
  };
}

function work(id: string, objectId: string, name: string) {
  return {
    id,
    tenantId: 't-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    objectId,
    workTypeId: 'work-type-1',
    contractorId: 'contractor-1',
    responsibleUserId: PM.id,
    name,
    unit: 'м²',
    plannedQuantity: '300',
    actualQuantity: '0',
    plannedStartDate: '2026-01-01',
    plannedFinishDate: '2026-03-01',
    actualStartDate: null,
    actualFinishDate: null,
    status: 'ACTIVE',
    categoryId: 'category-1',
    requiresInspection: true,
    requiresMaterials: false,
    contractor: 'Подрядчик 1',
    responsible: PM.name,
    lastReportedAt: null,
    plannedProgress: 0,
    actualProgress: 0,
    variance: null,
    delayDays: 0,
    scheduleStatus: 'GREEN',
    accepted: false,
    docsReady: false,
    blockers: [],
    stale: false,
  };
}

function documentationPackage(
  id: string,
  objectId: string,
  objectWorkId: string,
  status: string,
  responsible: string,
) {
  return {
    id,
    tenantId: 't-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    objectId,
    objectWorkId,
    status,
    responsibleUserId: 'pto-1',
    responsible,
    createdBy: 'pto-1',
  };
}

function buildSnapshot() {
  return {
    objects: [object(OBJECT_A, 'Школа на 550 мест', 'DEMO-A'), object(OBJECT_B, 'Поликлиника № 4', 'DEMO-B')],
    works: [work(WORK_A, OBJECT_A, 'Штукатурка стен'), work(WORK_B, OBJECT_B, 'Кладка стен'), work(WORK_C, OBJECT_A, 'Устройство кровли')],
    contractors: [],
    dependencies: [],
    // validateSnapshot() requires this array unconditionally for the
    // internal-provider path (CONTRACTOR_VIEWER is the only role that omits
    // it), independent of whether any of these fixture works have ever had
    // an inspection.
    inspections: [],
    documentationPackages: [
      documentationPackage(PACKAGE_A, OBJECT_A, WORK_A, 'PREPARING', 'Ольга Морозова'),
      documentationPackage(PACKAGE_B, OBJECT_B, WORK_B, 'RETURNED', 'Иван Петров'),
    ],
    documentationPackagePortions: [{ documentationPackageId: PACKAGE_A, quantityPortionId: 'portion-1' }],
  };
}

test('P01: lists every package with its work, object, status and responsible PTO, and filters by object', async ({
  page,
}) => {
  await seedSession(page, 'f8-2-browser-token');
  await mockApi(page, buildSnapshot());

  await page.goto('/app.html/pto');
  await expect(page.getByRole('heading', { level: 1, name: 'Исполнительная документация' })).toBeVisible();

  const table = page.locator('table', { hasText: 'Пакеты исполнительной документации' });
  await expect(table).toBeVisible();

  const rowA = table.locator('tr', { hasText: 'Штукатурка стен' });
  await expect(rowA).toBeVisible();
  await expect(rowA).toContainText('Школа на 550 мест');
  await expect(rowA).toContainText('В подготовке');
  await expect(rowA).toContainText('Ольга Морозова');
  await expect(rowA).toContainText('1');

  const rowB = table.locator('tr', { hasText: 'Кладка стен' });
  await expect(rowB).toBeVisible();
  await expect(rowB).toContainText('Поликлиника № 4');
  await expect(rowB).toContainText('Возвращено заказчиком');

  // --- filter by object: only the selected object's package remains ---
  await page.getByLabel('Объект').selectOption({ label: 'Школа на 550 мест' });
  await expect(table.locator('tr', { hasText: 'Штукатурка стен' })).toBeVisible();
  await expect(table.locator('tr', { hasText: 'Кладка стен' })).toHaveCount(0);

  await page.getByLabel('Объект').selectOption({ label: 'Все объекты' });
  await expect(table.locator('tr', { hasText: 'Кладка стен' })).toBeVisible();
});

test('W01: the "Исполнительная документация" section shows the package covering this work — status, responsible PTO and covered portions', async ({
  page,
}) => {
  await seedSession(page, 'f8-2-browser-token-w01-with-package');
  await mockApi(page, buildSnapshot());

  await page.goto(`/app.html/object/${OBJECT_A}/work/${WORK_A}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Штукатурка стен' })).toBeVisible();

  const section = page.locator('section', { hasText: 'Исполнительная документация' });
  await expect(section).toBeVisible();
  await expect(section.getByText('В подготовке')).toBeVisible();
  await expect(section.getByText('Ольга Морозова')).toBeVisible();
  await expect(section.getByText('Пакет исполнительной документации ещё не создан')).toHaveCount(0);
});

test('W01: a work with no Documentation Package shows the explicit empty state, not a missing section', async ({
  page,
}) => {
  await seedSession(page, 'f8-2-browser-token-w01-no-package');
  await mockApi(page, buildSnapshot());

  // WORK_C has no documentation package anywhere in the fixture.
  await page.goto(`/app.html/object/${OBJECT_A}/work/${WORK_C}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Устройство кровли' })).toBeVisible();

  const section = page.locator('section', { hasText: 'Исполнительная документация' });
  await expect(section).toBeVisible();
  await expect(section.getByText('Пакет исполнительной документации ещё не создан')).toBeVisible();
});
