import { test, expect, type Page, type Request, type Route } from '@playwright/test';

/**
 * F8.1 (Phase 4) — W01's three minimal operational actions, rendered in a
 * real browser.
 *
 * TEST TYPE: browser, INTERCEPTED — same shape as
 * tests/f7-browser/core-session.spec.ts: playwright.f8.1.config.ts starts
 * the real Vite dev server with VITE_DATA_PROVIDER=real, so the real,
 * unmodified App/WorkRoute/ExecutionSection/executionUnitsApi code runs in a
 * real browser. Every `/api/*` request is answered by Playwright's
 * `page.route()` against a small in-memory fake state this file owns — a
 * real HTTP response, but no backend and no database behind it. The
 * corresponding backend behaviour (D4's sum bound, the freeze/full-volume
 * guards, the shared accepted aggregate) already has real HTTP/PGlite
 * coverage in tests/f8.1-*.test.ts and tests/execution-units.test.ts; this
 * file's job is only to prove the UI wires those endpoints correctly and
 * updates what the user sees, not to re-prove backend business rules.
 *
 * Not shared with core-session.spec.ts on purpose — every existing spec file
 * in this repository owns its own small helpers rather than importing
 * another spec.
 */

type Responder = (request: Request) => { status: number; body?: unknown };

async function mockApi(page: Page, responders: Record<string, Responder>): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route: Route) => {
      const request = route.request();
      const key = `${request.method()} ${new URL(request.url()).pathname}`;
      const responder = responders[key];
      if (!responder) {
        await route.fulfill({ status: 599, contentType: 'text/plain', body: `unexpected ${key}` });
        return;
      }
      const { status, body } = responder(request);
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body ?? {}) });
    },
  );
}

async function seedSession(page: Page, token: string): Promise<void> {
  await page.addInitScript((value: string) => {
    window.sessionStorage.setItem('session', value);
  }, token);
}

const PM = { id: 'u-pm', tenantId: 't-1', name: 'Пётр Петров', role: 'PROJECT_MANAGER' };

const OBJECT_ID = 'object-1';
const WORK_ID = 'work-1';
const UNIT_ID = 'unit-1';

// A tiny valid 1x1 PNG, reused across the test suite (backend tests use the
// same fixture) — the attachment endpoint's real counterpart sniffs magic
// bytes, so this stays byte-real even though this spec's /api/attachments is
// a fake.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=';

interface FakePortion {
  id: string;
  executionUnitId: string;
  label: string;
  plannedQuantity: string;
  rpFactQuantity: string | null;
  internalScAccepted: boolean;
  internalScConfirmedQuantity: string | null;
  customerScAccepted: boolean;
  customerScConfirmedQuantity: string | null;
  version: number;
}

interface FakeInspection {
  id: string;
  objectId: string;
  objectWorkId: string;
  portionId: string;
  inspectionType: string;
  status: string;
  version: number;
  requestedBy: string;
  requestedAt: string;
  inspectorId: string | null;
  inspectionDate: string | null;
  decision: string | null;
  comment: string | null;
  acceptedAt: string | null;
}

function buildSnapshot(state: { portions: FakePortion[]; inspections: FakeInspection[] }) {
  return {
    objects: [
      {
        id: OBJECT_ID,
        tenantId: 't-1',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        version: 1,
        externalCode: 'F81-BROWSER',
        source: 'core',
        name: 'Тестовый объект F8.1',
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
      },
    ],
    works: [
      {
        id: WORK_ID,
        tenantId: 't-1',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        version: 1,
        objectId: OBJECT_ID,
        workTypeId: 'work-type-1',
        contractorId: 'contractor-1',
        responsibleUserId: PM.id,
        name: 'Штукатурка стен',
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
        accepted: state.portions.length > 0 && state.portions.every((p) => p.internalScAccepted),
        docsReady: false,
        blockers: [],
        stale: false,
        customerScAccepted: state.portions.length > 0 ? state.portions.every((p) => p.customerScAccepted) : null,
      },
    ],
    contractors: [],
    dependencies: [],
    inspections: state.inspections,
    executionUnits: [
      {
        id: UNIT_ID,
        tenantId: 't-1',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        version: 1,
        objectWorkId: WORK_ID,
        workTypeId: 'work-type-1',
        finishTypeId: null,
        executionConditions: null,
        location: '1 этаж',
        contractorId: 'contractor-1',
        unit: 'м²',
        plannedQuantity: '300',
        actualQuantity: state.portions.reduce((sum, p) => sum + Number(p.rpFactQuantity ?? 0), 0).toFixed(4),
        internalScStatus: (() => {
          const acceptedSum = state.portions.filter((p) => p.internalScAccepted).reduce((sum, p) => sum + Number(p.plannedQuantity), 0);
          return acceptedSum <= 0 ? 'NONE' : acceptedSum >= 300 ? 'COMPLETE' : 'PARTIAL';
        })(),
        customerScStatus: 'NONE',
      },
    ],
    executionUnitLayers: [],
    portions: state.portions,
    portionConfirmations: [],
  };
}

test('F8.1 golden path: add a portion, enter RP fact, request and register an Internal SC decision', async ({
  page,
}) => {
  const state: { portions: FakePortion[]; inspections: FakeInspection[] } = { portions: [], inspections: [] };
  let portionCounter = 0;
  let inspectionCounter = 0;

  await seedSession(page, 'f8-1-browser-token');
  await mockApi(page, {
    'GET /api/me': () => ({ status: 200, body: PM }),
    'GET /api/snapshot': () => ({ status: 200, body: buildSnapshot(state) }),

    [`POST /api/execution-units/${UNIT_ID}/portions`]: (request) => {
      const body = request.postDataJSON() as { label: string; plannedQuantity: number };
      portionCounter += 1;
      const portion: FakePortion = {
        id: `portion-${portionCounter}`,
        executionUnitId: UNIT_ID,
        label: body.label,
        plannedQuantity: String(body.plannedQuantity),
        rpFactQuantity: null,
        internalScAccepted: false,
        internalScConfirmedQuantity: null,
        customerScAccepted: false,
        customerScConfirmedQuantity: null,
        version: 1,
      };
      state.portions.push(portion);
      return { status: 201, body: portion };
    },

    'POST /api/portions/portion-1/fact': (request) => {
      const body = request.postDataJSON() as { quantity: number };
      const portion = state.portions.find((p) => p.id === 'portion-1')!;
      portion.rpFactQuantity = String(body.quantity);
      portion.version += 1;
      return { status: 201, body: { id: 'confirmation-1', portionId: portion.id, source: 'RP_FACT' } };
    },

    'POST /api/portions/portion-1/inspection-request': () => {
      const portion = state.portions.find((p) => p.id === 'portion-1')!;
      portion.version += 1;
      inspectionCounter += 1;
      const inspection: FakeInspection = {
        id: `inspection-${inspectionCounter}`,
        objectId: OBJECT_ID,
        objectWorkId: WORK_ID,
        portionId: portion.id,
        inspectionType: 'INTERNAL_SC',
        status: 'WAITING',
        version: 1,
        requestedBy: PM.id,
        requestedAt: new Date().toISOString(),
        inspectorId: null,
        inspectionDate: null,
        decision: null,
        comment: null,
        acceptedAt: null,
      };
      state.inspections.push(inspection);
      return { status: 201, body: inspection };
    },

    'POST /api/attachments': () => ({
      status: 201,
      body: { id: 'attachment-1', fileName: 'photo.png', mimeType: 'image/png' },
    }),

    'POST /api/inspections/inspection-1/photos': () => ({ status: 201, body: { id: 'photo-1' } }),

    'POST /api/inspections/inspection-1/accept': () => {
      const inspection = state.inspections.find((i) => i.id === 'inspection-1')!;
      inspection.status = 'ACCEPTED';
      const portion = state.portions.find((p) => p.id === inspection.portionId)!;
      portion.internalScAccepted = true;
      portion.internalScConfirmedQuantity = portion.rpFactQuantity;
      portion.version += 1;
      return { status: 201, body: inspection };
    },
  });

  await page.goto(`/app.html/object/${OBJECT_ID}/work/${WORK_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Штукатурка стен' })).toBeVisible();

  const section = page.locator('section', { hasText: 'Единицы исполнения и участки' });
  await expect(section).toBeVisible();
  await expect(section.getByText('Участки ещё не выделены')).toBeVisible();

  // --- 1. Portions management: create a portion ---
  await section.getByLabel('Название нового участка').fill('Секция A');
  await section.getByLabel('Плановый объём нового участка').fill('300');
  await section.getByRole('button', { name: 'Добавить участок' }).click();

  const portionRow = section.getByText('Секция A', { exact: true }).locator('..').locator('..');
  await expect(portionRow.getByText('Не предъявлено')).toBeVisible();

  // --- 2. RP enters fact ---
  await expect(portionRow.getByLabel('Факт по участку Секция A')).toBeVisible();
  await portionRow.getByLabel('Факт по участку Секция A').fill('300');
  await portionRow.getByLabel('Комментарий к факту по участку Секция A').fill('Полный объём выполнен');
  await portionRow.getByRole('button', { name: 'Сохранить факт' }).click();

  await expect(portionRow.getByRole('button', { name: 'Предъявить на СК' })).toBeVisible();
  await portionRow.getByRole('button', { name: 'Предъявить на СК' }).click();

  await expect(portionRow.getByText('На проверке')).toBeVisible();

  // --- 3. Internal SC decision registration ---
  await portionRow
    .getByLabel('Фотофиксация проверки участка Секция A')
    .setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(PNG_BASE64, 'base64') });
  await portionRow.getByLabel('Комментарий к решению по участку Секция A').fill('Секция принята');
  await portionRow.getByRole('button', { name: 'Принять' }).click();

  await expect(portionRow.getByText('Принято СК')).toBeVisible();
  await expect(portionRow.getByRole('button', { name: 'Принять' })).toHaveCount(0);
  await expect(portionRow.getByRole('button', { name: 'Предъявить на СК' })).toHaveCount(0);

  expect(state.portions).toHaveLength(1);
  expect(state.portions[0]!.internalScAccepted).toBe(true);
  expect(state.inspections).toHaveLength(1);
  expect(state.inspections[0]!.status).toBe('ACCEPTED');
});

// The mock/demo runtime (`App.tsx`'s `MOCK_RUNTIME`, `session: null`) never
// reaches `/api/*` at all — `mockDataProvider` returns fixtures in memory —
// and this config's dev server is started once with `VITE_DATA_PROVIDER=real`
// for every test here, so that branch cannot be reached from this file.
// `npm run test:ds` already renders W01 (via `preview/Gallery.tsx`) under the
// mock provider and is part of this phase's own verification gates; that is
// the real coverage that `ExecutionSection` renders safely with `actions`
// left undefined, not a second, incompatible test here.
