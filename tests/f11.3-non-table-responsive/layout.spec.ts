import { test, expect, type Page, type Locator, type Route } from '@playwright/test';

/**
 * F11.3 Non-Table Responsive Consistency — regression for the non-table
 * content C01/O01/W01 render outside DataTable: the C01 Attention Card, W01's
 * execution-unit/portion cards, and the shared PageHeader/Breadcrumb.
 *
 * TEST TYPE: browser, INTERCEPTED — same shape as
 * tests/f11.2-responsive-tables/dense-tables.spec.ts: the real Vite dev
 * server with VITE_DATA_PROVIDER=real, so the real, unmodified route
 * containers and screens run in a real browser. Every `/api/*` request is
 * answered by `page.route()` against the fixture below — no backend, no
 * database.
 *
 * Fixture names are realistic-length Russian construction content, same
 * convention as F11.2 — a short label collapses exactly the defects this
 * slice exists to catch.
 */

const PTO = { id: 'u-pto', tenantId: 't-1', name: 'Ольга Морозова', role: 'PTO' };

const LONG_OBJECT_NAME =
  'ЖК «Северный луч», Корпус 3 — вторая очередь строительства, подземная автостоянка';
const LONG_WORK_NAME =
  'Устройство монолитного железобетонного перекрытия толщиной 200мм на отметке -3.300 (подземная автостоянка, секция 2)';
const LONG_ATTENTION_MESSAGE = 'Есть технологическая блокировка производства работ';
const LONG_BLOCKER_1 =
  'Не подтверждена поставка материала — арматура А500С диаметром 16мм, ожидается от поставщика ООО «МеталлСнаб» не ранее 15 числа';
const LONG_BLOCKER_2 =
  'Отсутствует допуск к работам на высоте у бригады подрядчика — истёк срок действия удостоверения, требуется переаттестация';
const LONG_LOCATION =
  'Подземная автостоянка, секция 2, ось 12-18, отметка -3.300, зона примыкания к пандусу';
const LONG_PORTION_LABEL =
  'Захватка №4 — участок примыкания к деформационному шву между осями 14 и 15';

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
    externalCode: 'CC-024',
    source: 'MANUAL',
    name: LONG_OBJECT_NAME,
    address: 'г. Москва, ул. Строителей, д. 12, корп. 3, стр. 1',
    customerName: 'ООО «Заказчик-Инвест»',
    organizationName: 'ООО СЗ «Гор-Строй»',
    projectManagerId: 'u-pm',
    startDate: '2025-03-01',
    plannedFinishDate: '2026-12-31',
    actualFinishDate: null,
    status: 'ACTIVE',
    healthStatus: 'YELLOW',
    responsible: 'Пётр Петров',
    contractorIds: [],
    contractors: ['ООО «СтройМонтаж»'],
    actualProgress: 46,
    plannedProgress: 61,
  }),
];

const works = [
  versioned('work-2', {
    objectId: 'obj-1',
    workTypeId: 'wt-3',
    contractorId: 'c-1',
    responsibleUserId: 'u-pm',
    name: LONG_WORK_NAME,
    unit: 'м³',
    plannedQuantity: '340.0000',
    actualQuantity: '180.0000',
    plannedStartDate: '2025-02-01',
    plannedFinishDate: '2025-05-01',
    actualStartDate: '2025-02-02',
    actualFinishDate: null,
    status: 'ACTIVE',
    categoryId: 'cat-1',
    requiresInspection: true,
    requiresMaterials: true,
    contractor: 'ООО «СтройМонтаж»',
    responsible: 'Пётр Петров',
    lastReportedAt: '2025-04-28T09:00:00.000Z',
    plannedProgress: 100,
    actualProgress: 53,
    variance: -47,
    delayDays: 8,
    scheduleStatus: 'RED',
    accepted: false,
    docsReady: false,
    blockers: [LONG_BLOCKER_1, LONG_BLOCKER_2],
    stale: false,
  }),
];

const executionUnits = [
  {
    id: 'unit-1',
    tenantId: 't-1',
    version: 1,
    objectWorkId: 'work-2',
    workTypeId: 'wt-3',
    finishTypeId: null,
    executionConditions: null,
    location: LONG_LOCATION,
    contractorId: 'c-1',
    unit: 'м³',
    plannedQuantity: '340.0000',
    actualQuantity: '180.0000',
    internalScStatus: 'PARTIAL',
    customerScStatus: 'NONE',
  },
];

const portions = [
  {
    id: 'portion-1',
    tenantId: 't-1',
    version: 1,
    executionUnitId: 'unit-1',
    label: LONG_PORTION_LABEL,
    plannedQuantity: '120.0000',
    rpFactQuantity: '80.0000',
    internalScAccepted: false,
    internalScConfirmedQuantity: null,
    customerScAccepted: false,
    customerScConfirmedQuantity: null,
  },
];

const inspections = [
  {
    id: 'insp-1',
    tenantId: 't-1',
    version: 1,
    objectId: 'obj-1',
    objectWorkId: 'work-2',
    requestedBy: 'u-pm',
    requestedAt: '2026-04-01T09:00:00.000Z',
    inspectorId: null,
    status: 'WAITING',
    inspectionDate: null,
    decision: null,
    comment: null,
    acceptedAt: null,
    portionId: null,
    inspectionType: 'INTERNAL_SC',
  },
];

const documentationPackages = [
  versioned('pkg-1', {
    objectId: 'obj-1',
    objectWorkId: 'work-2',
    status: 'PREPARING',
    responsibleUserId: 'u-pto',
    responsible: 'Ольга Морозова',
    createdBy: 'u-pto',
  }),
];

const documentationAttentionQueue = [
  {
    objectId: 'obj-1',
    objectName: LONG_OBJECT_NAME,
    objectWorkId: 'work-2',
    workName: LONG_WORK_NAME,
    level: 'RED' as const,
    reason: LONG_ATTENTION_MESSAGE,
    responsible: 'Ольга Морозова',
    packageId: 'pkg-1',
  },
];

const snapshot = {
  objects,
  works,
  contractors: [],
  dependencies: [],
  inspections,
  executionUnits,
  portions,
  documentationPackages,
  documentationPackagePortions: [{ documentationPackageId: 'pkg-1', quantityPortionId: 'portion-1' }],
  documentationDocuments: [],
  documentationVersions: [],
  documentationStatusHistory: [],
  documentationAttentionQueue,
  documentationCustomerAcceptances: [],
  sdoPackageReadiness: [],
  sdoClosingCases: [],
  sdoClosingStatusHistory: [],
  sdoClosingHandoffHistory: [],
  sdoClosingAmountHistory: [],
  sdoClosingPortionAllocations: [],
  sdoClosingPortionAllocationHistory: [],
};

async function fulfillApi(route: Route): Promise<void> {
  const url = route.request().url();
  const json = (body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  if (url.includes('/api/me')) return json(PTO);
  if (url.includes('/api/snapshot')) return json(snapshot);
  return json([], 200);
}

async function openScreen(page: Page, path: string): Promise<void> {
  await page.addInitScript((value: string) => {
    window.sessionStorage.setItem('session', value);
  }, `token-${PTO.role}`);
  await page.route('**/api/**', (route) => fulfillApi(route));
  await page.goto(path, { waitUntil: 'networkidle' });
}

/** True if two axis-aligned boxes actually intersect, not merely sit close. */
function boxesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  const xOverlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const yOverlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return xOverlap > 0 && yOverlap > 0;
}

/**
 * F11.3 — the same intra-word-split detector F11.2-01 introduced
 * (tests/f11.2-responsive-tables/dense-tables.spec.ts): a DOM Range over
 * exactly one ordinary word reports how many rendered lines it lands on. A
 * word that stayed whole is on exactly one.
 */
async function wordLineCounts(
  root: Locator,
  words: string[],
): Promise<Array<{ word: string; lines: number }>> {
  return root.evaluate((rootEl, targetWords: string[]) => {
    const found: Array<{ word: string; lines: number }> = [];
    for (const word of targetWords) {
      const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? '';
        for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + word.length)) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + word.length);
          const lineTops = new Set(
            Array.from(range.getClientRects())
              .filter((rect) => rect.width > 0)
              .map((rect) => Math.round(rect.top)),
          );
          found.push({ word, lines: lineTops.size });
        }
      }
    }
    return found;
  }, words);
}

function ordinaryWords(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/\s+/)
        .map((token) => token.replace(/[^\p{L}]/gu, ''))
        .filter((word) => word.length >= 6),
    ),
  );
}

async function assertWordsStayWhole(root: Locator, words: string[]): Promise<void> {
  const found = await wordLineCounts(root, words);
  expect(new Set(found.map((entry) => entry.word))).toEqual(new Set(words));
  const broken = found.filter((entry) => entry.lines !== 1);
  expect(broken, `ordinary words split across lines: ${JSON.stringify(broken)}`).toEqual([]);
}

async function mainOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    return main ? main.scrollWidth - main.clientWidth : 0;
  });
}

async function docOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

const ALL_WIDTHS = [1440, 1280, 1024, 768, 390, 375];
const OBJECT_WORDS = ordinaryWords(LONG_OBJECT_NAME);

test.describe('C01 — Attention Card stays readable at every width (F11.3)', () => {
  async function openC01(page: Page): Promise<void> {
    await openScreen(page, '/app.html/company');
  }

  function attentionRow(page: Page): Locator {
    return page.locator('li').filter({ has: page.getByRole('button', { name: 'Открыть объект' }) });
  }

  // The genuine failure shape here is not two boxes visually intersecting —
  // `.attentionRow`'s three children (badge/body/button) never actually
  // occupy the same pixels, because the outer `<ul>` clips at its own
  // border-box (`overflow: hidden`, for the rounded corners) long before a
  // 0-width child's overflowing text would reach the button. What actually
  // breaks is `.attentionBody` itself: once badge + button leave no room,
  // flexbox clamps its width to 0 rather than negative, and a 0-width inline
  // container cannot lay out any text at all — the name and reason stop
  // being real, positioned content. `boundingBox().width` on the container
  // is the direct, reliable signal for that; a visual pixel-overlap test on
  // its children is not, since `getBoundingClientRect()` reports 0 for a
  // line box the layout engine could not give any width, even where a
  // browser's paint step still spills the glyphs into the neighbouring cell.
  for (const width of ALL_WIDTHS) {
    test(`${width}px: the name/reason column never collapses to zero width`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openC01(page);

      const row = attentionRow(page);
      const body = row.locator('[class*="attentionBody"]');
      const bodyBox = await body.boundingBox();
      expect(bodyBox).not.toBeNull();
      // Comfortably above zero and above a single glyph — this is what a
      // 0-width (or near-0, one-character) collapse looks like geometrically.
      expect(bodyBox!.width).toBeGreaterThan(40);

      // The object name and reason are still there, still readable text —
      // not truncated, not hidden to make room for the action.
      await expect(row).toContainText(LONG_OBJECT_NAME);
      await expect(row).toContainText(LONG_ATTENTION_MESSAGE);
      await assertWordsStayWhole(row, OBJECT_WORDS);

      expect(await mainOverflow(page)).toBeLessThan(4);
      expect(await docOverflow(page)).toBeLessThan(4);
    });
  }

  test('1440px: badge, name/reason and action still share one line', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openC01(page);

    const row = attentionRow(page);
    const button = row.getByRole('button', { name: 'Открыть объект' });
    const body = row.locator('[class*="attentionBody"]');
    const [buttonBox, bodyBox] = await Promise.all([button.boundingBox(), body.boundingBox()]);

    // Same flex line: their vertical ranges overlap, whatever each one's own
    // height and cross-axis centering happen to be.
    const top = Math.max(buttonBox!.y, bodyBox!.y);
    const bottom = Math.min(buttonBox!.y + buttonBox!.height, bodyBox!.y + bodyBox!.height);
    expect(bottom - top, 'badge/body/button no longer share a line at 1440px').toBeGreaterThan(0);
  });
});

// F11.3 inspected this section (`.portionHeader` — a portion's label next to
// its own inspection-status badge) against the same LONG_PORTION_LABEL
// fixture and found no confirmed defect: the label's own column never drops
// below ~130px even at 375px, well above the longest single word in the
// fixture (~120px), so nothing here ever overlaps or splits mid-word — see
// the F11.3 report's Remaining Findings for the one cosmetic observation
// (the badge cross-centers next to a 4-line label rather than sitting flush
// with its first line) left as-is rather than changed without a reproducible
// failure. These tests lock in that already-correct behaviour; none of them
// were failing on the accepted F11.2 baseline.
test.describe('W01 — execution-unit portion header stays legible at every width (F11.3 regression lock)', () => {
  async function openW01(page: Page): Promise<void> {
    await openScreen(page, '/app.html/object/obj-1/work/work-2');
  }

  function portionHeader(page: Page): Locator {
    return page.locator('div').filter({ hasText: LONG_PORTION_LABEL }).filter({ hasText: 'Не предъявлено' }).last();
  }

  const PORTION_WORDS = ordinaryWords(LONG_PORTION_LABEL);

  for (const width of ALL_WIDTHS) {
    test(`${width}px: the portion label stays whole and the badge stays clear of it`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openW01(page);

      const header = portionHeader(page);
      await header.scrollIntoViewIfNeeded();
      const label = header.getByText(LONG_PORTION_LABEL, { exact: true });
      const badge = header.getByText('Не предъявлено', { exact: true });

      const [labelBox, badgeBox] = await Promise.all([label.boundingBox(), badge.boundingBox()]);
      expect(labelBox).not.toBeNull();
      expect(badgeBox).not.toBeNull();

      expect(boxesOverlap(labelBox!, badgeBox!), 'status badge overlaps the portion label').toBe(false);

      await expect(header).toContainText(LONG_PORTION_LABEL);
      await assertWordsStayWhole(header, PORTION_WORDS);

      expect(await mainOverflow(page)).toBeLessThan(4);
      expect(await docOverflow(page)).toBeLessThan(4);
    });
  }

  test('1440px: label and badge keep their current single-line layout', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openW01(page);

    const header = portionHeader(page);
    await header.scrollIntoViewIfNeeded();
    const label = header.getByText(LONG_PORTION_LABEL, { exact: true });
    const badge = header.getByText('Не предъявлено', { exact: true });
    const [labelBox, badgeBox] = await Promise.all([label.boundingBox(), badge.boundingBox()]);

    const top = Math.max(labelBox!.y, badgeBox!.y);
    const bottom = Math.min(labelBox!.y + labelBox!.height, badgeBox!.y + badgeBox!.height);
    expect(bottom - top, 'label/badge no longer share a line at 1440px').toBeGreaterThan(0);
  });
});

test.describe('PageHeader and Breadcrumb — non-table overflow lock (F11.3)', () => {
  for (const width of ALL_WIDTHS) {
    test(`O01 @ ${width}px: long object name in title/breadcrumb causes no page overflow`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openScreen(page, '/app.html/object/obj-1');

      await expect(page.getByRole('heading', { level: 1 })).toContainText(LONG_OBJECT_NAME);
      expect(await mainOverflow(page)).toBeLessThan(4);
      expect(await docOverflow(page)).toBeLessThan(4);
    });

    test(`W01 @ ${width}px: long work/object names in title/breadcrumb cause no page overflow`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await openScreen(page, '/app.html/object/obj-1/work/work-2');

      await expect(page.getByRole('heading', { level: 1 })).toContainText(LONG_WORK_NAME);
      const nav = page.getByRole('navigation', { name: 'Хлебные крошки' });
      await expect(nav).toContainText(LONG_OBJECT_NAME);
      expect(await mainOverflow(page)).toBeLessThan(4);
      expect(await docOverflow(page)).toBeLessThan(4);
    });
  }
});
