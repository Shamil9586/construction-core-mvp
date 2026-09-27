import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * F11.5 Final Responsive Regression Matrix — the closing, system-level
 * integration layer over F11.1-F11.4.
 *
 * TEST TYPE: browser, INTERCEPTED — same shape as
 * tests/f11.4-states-accessibility/audit.spec.ts: the real Vite dev server
 * with VITE_DATA_PROVIDER=real, so the real, unmodified route containers and
 * screens run in a real browser. Every `/api/*` request is answered by
 * `page.route()` against the fixture below — no backend, no database.
 *
 * Deliberately thin relative to F11.1-F11.4's own specs, which already own
 * their detailed claims and are re-run as their own suites, not duplicated
 * here: drawer interaction (F11.1, tests/design-system/shell.spec.ts),
 * per-word wrapping (F11.2-01, tests/f11.2-responsive-tables), non-table
 * card overflow (F11.3, tests/f11.3-non-table-responsive), aria-live/route
 * focus/heading semantics (F11.4, tests/f11.4-states-accessibility). This
 * suite asserts the system-level properties no single earlier slice checked
 * across the whole required screen set at once — document/main overflow at
 * every required screen x viewport, shell mode, primary-heading and
 * primary-action reachability — plus the one confirmed F11.5 finding,
 * F11.5-01 below.
 */

const PTO = { id: 'u-pto', tenantId: 't-1', name: 'Ольга Морозова', role: 'PTO' };
const SDO_USER = { id: 'u-sdo', tenantId: 't-1', name: 'Андрей Зайцев', role: 'SDO' };

const LONG_OBJECT_NAME =
  'ЖК «Северный луч», Корпус 3 — вторая очередь строительства, подземная автостоянка';
const CLEAN_OBJECT_NAME = 'ЖК «Заречный», Корпус 1';
const LONG_WORK_NAME =
  'Устройство монолитного железобетонного перекрытия толщиной 200мм на отметке -3.300 (подземная автостоянка, секция 2)';

function versioned<T extends Record<string, unknown>>(id: string, extra: T) {
  return {
    id,
    tenantId: 't-1',
    createdAt: '2026-01-10T09:00:00.000Z',
    updatedAt: '2026-06-01T09:00:00.000Z',
    version: 1,
    ...extra,
  };
}

const objects = [
  versioned('obj-1', {
    externalCode: 'CC-024', source: 'MANUAL', name: LONG_OBJECT_NAME,
    address: 'г. Москва, ул. Строителей, д. 12, корп. 3, стр. 1',
    customerName: 'ООО «Заказчик-Инвест»', organizationName: 'ООО СЗ «Гор-Строй»',
    projectManagerId: 'u-pm', startDate: '2025-03-01', plannedFinishDate: '2026-12-31',
    actualFinishDate: null, status: 'ACTIVE', healthStatus: 'YELLOW',
    responsible: 'Пётр Петров', contractorIds: [], contractors: ['ООО «СтройМонтаж»'],
    actualProgress: 46, plannedProgress: 61,
  }),
  versioned('obj-2', {
    externalCode: 'CC-031', source: 'MANUAL', name: CLEAN_OBJECT_NAME,
    address: 'г. Москва, ул. Речная, д. 4',
    customerName: 'ООО «Заказчик-Инвест»', organizationName: 'ООО СЗ «Гор-Строй»',
    projectManagerId: 'u-pm', startDate: '2025-06-01', plannedFinishDate: '2026-09-30',
    actualFinishDate: null, status: 'ACTIVE', healthStatus: 'GRAY',
    responsible: 'Сергей Волков', contractorIds: [], contractors: ['ООО «СтройМонтаж»'],
    actualProgress: 72, plannedProgress: 70,
  }),
];

const workBase = { contractorId: 'c-1', responsibleUserId: 'u-pm', requiresInspection: true, requiresMaterials: true, contractor: 'ООО «СтройМонтаж»', responsible: 'Пётр Петров', docsReady: false };
const works = [
  versioned('work-1', { ...workBase, objectId: 'obj-1', workTypeId: 'wt-1', name: 'Армирование фундаментной плиты', unit: 'т', plannedQuantity: '120.0000', actualQuantity: '96.0000', plannedStartDate: '2025-04-01', plannedFinishDate: '2025-07-01', actualStartDate: '2025-04-03', actualFinishDate: null, status: 'ACTIVE', categoryId: 'cat-1', lastReportedAt: '2026-06-01T09:00:00.000Z', plannedProgress: 80, actualProgress: 80, variance: 0, delayDays: 0, scheduleStatus: 'GREEN', accepted: true, blockers: [], stale: false }),
  versioned('work-2', { ...workBase, objectId: 'obj-1', workTypeId: 'wt-3', name: LONG_WORK_NAME, unit: 'м³', plannedQuantity: '340.0000', actualQuantity: '180.0000', plannedStartDate: '2025-02-01', plannedFinishDate: '2025-05-01', actualStartDate: '2025-02-02', actualFinishDate: null, status: 'ACTIVE', categoryId: 'cat-1', lastReportedAt: '2025-04-28T09:00:00.000Z', plannedProgress: 100, actualProgress: 53, variance: -47, delayDays: 8, scheduleStatus: 'RED', accepted: false, blockers: ['Не подтверждена поставка материала — арматура А500С диаметром 16мм'], stale: false }),
  versioned('work-4', { ...workBase, objectId: 'obj-2', workTypeId: 'wt-1', name: 'Кладка наружных стен', unit: 'м³', plannedQuantity: '90.0000', actualQuantity: '65.0000', plannedStartDate: '2025-07-01', plannedFinishDate: '2025-10-01', actualStartDate: '2025-07-02', actualFinishDate: null, status: 'ACTIVE', categoryId: 'cat-1', lastReportedAt: '2026-06-01T09:00:00.000Z', plannedProgress: 72, actualProgress: 72, variance: 0, delayDays: 0, scheduleStatus: 'GREEN', accepted: true, blockers: [], stale: false }),
];

const pkg1 = versioned('pkg-1', { objectId: 'obj-1', objectWorkId: 'work-2', status: 'PREPARING', responsibleUserId: 'u-pto', responsible: 'Ольга Морозова', createdBy: 'u-pto' });
const pkg2 = versioned('pkg-2', { objectId: 'obj-1', objectWorkId: 'work-1', status: 'PREPARING', responsibleUserId: 'u-pto', responsible: 'Ольга Морозова', createdBy: 'u-pto' });

const documentationAttentionQueue = [
  { objectId: 'obj-1', objectName: LONG_OBJECT_NAME, objectWorkId: 'work-2', workName: LONG_WORK_NAME, level: 'RED' as const, reason: 'Работа завершена более 30 дней назад, пакет не создан ответственным ПТО', responsible: 'Ольга Морозова', packageId: 'pkg-1' },
];

const sdoCase = versioned('case-1', {
  objectId: 'obj-1', objectName: LONG_OBJECT_NAME, objectWorkId: 'work-2', workName: LONG_WORK_NAME,
  documentationPackageId: 'pkg-1', documentationPackageStatus: 'PREPARING', coveredQuantityPortionIds: [],
  status: 'ON_RECONCILIATION', packageLocked: true, responsibleUserId: 'u-sdo', responsible: 'Андрей Зайцев',
  totalAmount: '12450000.5000', createdBy: 'u-pto', closedAt: null, attention: 'RED',
});

const sdoPackageReadiness = [
  { documentationPackageId: 'pkg-2', objectId: 'obj-1', objectName: LONG_OBJECT_NAME, objectWorkId: 'work-1', workName: 'Армирование фундаментной плиты', documentationPackageStatus: 'PREPARING', responsible: 'Ольга Морозова', ready: true, missingReasons: [], sdoClosingCaseId: null, packageLocked: false, handoffPending: false },
];

const snapshot = {
  objects,
  works,
  contractors: [],
  dependencies: [],
  inspections: [],
  executionUnits: [],
  portions: [],
  documentationPackages: [pkg1, pkg2],
  documentationPackagePortions: [],
  documentationDocuments: [],
  documentationVersions: [],
  documentationStatusHistory: [],
  documentationAttentionQueue,
  documentationCustomerAcceptances: [],
  sdoPackageReadiness,
  sdoClosingCases: [sdoCase],
  sdoClosingStatusHistory: [],
  sdoClosingHandoffHistory: [],
  sdoClosingAmountHistory: [],
  sdoClosingPortionAllocations: [],
  sdoClosingPortionAllocationHistory: [],
};

async function fulfillApi(route: Route, actor: typeof PTO | typeof SDO_USER): Promise<void> {
  const url = route.request().url();
  const json = (body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.includes('/api/me')) return json(actor);
  if (url.includes('/api/snapshot')) return json(snapshot);
  return json([], 200);
}

async function openScreen(page: Page, actor: typeof PTO | typeof SDO_USER, path: string): Promise<void> {
  await page.addInitScript((value: string) => {
    window.sessionStorage.setItem('session', value);
  }, `token-${actor.role}`);
  await page.route('**/api/**', (route) => fulfillApi(route, actor));
  await page.goto(path, { waitUntil: 'networkidle' });
}

const WIDTHS = [1440, 1280, 1024, 768, 390, 375];

const SCREENS: Array<{ name: string; actor: typeof PTO | typeof SDO_USER; path: string; heading: string }> = [
  { name: 'C01', actor: PTO, path: '/app.html/company', heading: 'Портфель объектов' },
  { name: 'O01', actor: PTO, path: '/app.html/object/obj-1', heading: LONG_OBJECT_NAME },
  { name: 'W01', actor: PTO, path: '/app.html/object/obj-1/work/work-2', heading: LONG_WORK_NAME },
  { name: 'P01', actor: PTO, path: '/app.html/pto', heading: 'Операции ПТО' },
  { name: 'SDO', actor: SDO_USER, path: '/app.html/sdo', heading: 'Рабочая область СДО' },
];

async function overflowMetrics(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const main = document.getElementById('cc-main-content');
    return {
      doc: { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth },
      main: main ? { scrollWidth: main.scrollWidth, clientWidth: main.clientWidth } : null,
    };
  });
}

test.describe('F11.5 — document/main overflow matrix (F11-06)', () => {
  for (const screen of SCREENS) {
    for (const width of WIDTHS) {
      test(`${screen.name} @ ${width}px: no unintended document or main horizontal overflow`, async ({ page }) => {
        await page.setViewportSize({ width, height: width <= 500 ? 900 : 1000 });
        await openScreen(page, screen.actor, screen.path);

        const metrics = await overflowMetrics(page);
        // A few px of slack absorbs sub-pixel layout rounding, not a real
        // overflow — matches the tolerance F11.2's own C01 test already
        // established (tests/f11.2-responsive-tables/dense-tables.spec.ts).
        expect(metrics.doc.scrollWidth - metrics.doc.clientWidth).toBeLessThan(4);
        if (metrics.main) {
          expect(metrics.main.scrollWidth - metrics.main.clientWidth).toBeLessThan(4);
        }

        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      });
    }
  }
});

test.describe('F11.5 — shell mode holds across the full screen set (F11.1 regression)', () => {
  for (const screen of SCREENS) {
    test(`${screen.name} @ 768px: full sidebar, no drawer trigger`, async ({ page }) => {
      await page.setViewportSize({ width: 768, height: 1000 });
      await openScreen(page, screen.actor, screen.path);
      await expect(page.getByRole('navigation', { name: 'Основная навигация' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Открыть меню навигации' })).toBeHidden();
    });

    test(`${screen.name} @ 390px: off-canvas drawer, sidebar not permanently occupying the viewport`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 900 });
      await openScreen(page, screen.actor, screen.path);
      await expect(page.getByRole('button', { name: 'Открыть меню навигации' })).toBeVisible();
      // The permanent nav landmark is off-canvas, not merely narrow — it must
      // not be reachable as a normal, always-visible part of the layout.
      await expect(page.getByRole('navigation', { name: 'Основная навигация' })).toBeHidden();
    });
  }
});

test.describe('F11.5 — primary heading and primary action stay reachable at 375px', () => {
  test('C01: the portfolio\'s own primary action opens an object', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await openScreen(page, PTO, '/app.html/company');
    const action = page.getByRole('button', { name: new RegExp(CLEAN_OBJECT_NAME.split(',')[0]) });
    await action.scrollIntoViewIfNeeded();
    await expect(action).toBeVisible();
    await action.click();
    await expect(page).toHaveURL(/\/object\/obj-2$/);
  });

  test('P01: the attention queue\'s primary action is reachable', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await openScreen(page, PTO, '/app.html/pto');
    // `exact: true` matters here: a plain-string name match is a substring
    // match by default, and "Открыть меню навигации" (the drawer trigger)
    // contains "Открыть" too — without it this could silently pass by
    // finding the drawer trigger instead of a real row action.
    const action = page.getByRole('button', { name: 'Открыть', exact: true }).first();
    await action.scrollIntoViewIfNeeded();
    await expect(action).toBeVisible();
    await expect(action).toBeEnabled();
  });

  test('SDO: the active case\'s primary action is reachable', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await openScreen(page, SDO_USER, '/app.html/sdo');
    const action = page.getByRole('button', { name: 'Открыть', exact: true });
    await action.scrollIntoViewIfNeeded();
    await expect(action).toBeVisible();
  });
});

test.describe('F11.5-01 — a table\'s own horizontal scroll never partially clips an atomic value', () => {
  // F11.5 finding: ObjectRow's "СМР" percentage (`TableRow.module.css`
  // `.smr`) was right-aligned within its 120px column via
  // `align-items: flex-end`, hugging the edge of the column farthest from
  // the always-partially-visible fill column. At the exact viewport range
  // where C01's portfolio table needs horizontal scroll but the smr column
  // is only partly within the still-unscrolled (scrollLeft: 0) visible
  // window — reproducible at 375/390px with this fixture's long object name
  // forcing the fill column to its floor — the browser's own overflow
  // clipping bisects the right-aligned "46%" text, visually rendering it as
  // "4": a complete, plausible, but wrong figure, not recognisably a
  // truncation. This is worse than an ordinary long name/word wrapping off
  // the visible edge (F11.2/F11.3, already accepted): a cut-off word still
  // reads as cut off, but a cut-off percentage reads as a different,
  // confidently wrong physical-readiness figure — the one number on this
  // screen the frozen contract calls out as "factual СМР execution only".
  test('C01: the СМР percentage is fully visible, never straddling the portfolio table\'s scroll edge', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await openScreen(page, PTO, '/app.html/company');

    const region = page.getByRole('region', { name: 'Объекты компании' });
    const regionBox = (await region.boundingBox())!;

    const percent = page.getByText('46%', { exact: true });
    await expect(percent).toBeVisible();
    const percentBox = (await percent.boundingBox())!;

    // Fully inside the scroll region's own visible (clipped) box — not just
    // "some pixels of it happen to paint". A half-pixel slack absorbs
    // sub-pixel layout rounding only.
    expect(percentBox.x).toBeGreaterThanOrEqual(regionBox.x - 0.5);
    expect(percentBox.x + percentBox.width).toBeLessThanOrEqual(regionBox.x + regionBox.width + 0.5);
  });

  test('C01 @ 390px: the second row\'s СМР percentage is also fully visible', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await openScreen(page, PTO, '/app.html/company');

    const region = page.getByRole('region', { name: 'Объекты компании' });
    const regionBox = (await region.boundingBox())!;

    const percent = page.getByText('72%', { exact: true });
    await expect(percent).toBeVisible();
    const percentBox = (await percent.boundingBox())!;

    expect(percentBox.x).toBeGreaterThanOrEqual(regionBox.x - 0.5);
    expect(percentBox.x + percentBox.width).toBeLessThanOrEqual(regionBox.x + regionBox.width + 0.5);
  });
});
