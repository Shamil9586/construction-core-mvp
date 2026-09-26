import { test, expect, type Page, type Locator, type Route } from '@playwright/test';

/**
 * F11.2 Dense Tables / Scoped Overflow — responsive regression for the
 * shared DataTable, reproduced through the real screens that surfaced the
 * defect (F11.0): C01's portfolio table, P01's PTO queue, and both SDO
 * workspace tables.
 *
 * TEST TYPE: browser, INTERCEPTED — same shape as
 * tests/f8.2.1-browser/pto-operations.spec.ts and
 * tests/f8.3-browser/sdo-workspace.spec.ts: playwright.f11.2.config.ts starts
 * the real Vite dev server with VITE_DATA_PROVIDER=real, so the real,
 * unmodified route containers and screens run in a real browser. Every
 * `/api/*` request is answered by `page.route()` against the fixture below —
 * no backend, no database.
 *
 * Fixture names are deliberately realistic-length Russian construction
 * content — an object name, a work name and an attention reason each well
 * past what a short demo string would ever exercise — because F11.0's own
 * finding was that short placeholder fixtures are exactly what let the
 * character-by-character collapse and the column-overlap defect ship
 * unnoticed in the first place.
 */

async function seedSession(page: Page, token: string): Promise<void> {
  await page.addInitScript((value: string) => {
    window.sessionStorage.setItem('session', value);
  }, token);
}

const PTO = { id: 'u-pto', tenantId: 't-1', name: 'Ольга Морозова', role: 'PTO' };
const SDO_USER = { id: 'u-sdo', tenantId: 't-1', name: 'Андрей Зайцев', role: 'SDO' };

const LONG_OBJECT_NAME =
  'ЖК «Северный луч», Корпус 3 — вторая очередь строительства, подземная автостоянка';
const LONG_WORK_NAME =
  'Устройство монолитного железобетонного перекрытия толщиной 200мм на отметке -3.300 (подземная автостоянка, секция 2)';
const LONG_REASON =
  'Работа завершена более 30 дней назад, пакет исполнительной документации до сих пор не создан ответственным ПТО';

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
  versioned('obj-2', {
    externalCode: 'CC-031',
    source: 'MANUAL',
    name: 'ЖК Заречный',
    address: 'г. Москва, ул. Речная, д. 5',
    customerName: null,
    organizationName: 'ООО СЗ «Гор-Строй»',
    projectManagerId: 'u-pm',
    startDate: '2025-06-01',
    plannedFinishDate: '2027-03-31',
    actualFinishDate: null,
    status: 'ACTIVE',
    healthStatus: 'GREEN',
    responsible: 'Пётр Петров',
    contractorIds: [],
    contractors: [],
    actualProgress: 12,
    plannedProgress: 10,
  }),
];

const works = [
  versioned('work-1', {
    objectId: 'obj-1',
    workTypeId: 'wt-1',
    contractorId: 'c-1',
    responsibleUserId: 'u-pm',
    name: 'Армирование фундаментной плиты',
    unit: 'т',
    plannedQuantity: '120.0000',
    actualQuantity: '96.0000',
    plannedStartDate: '2025-04-01',
    plannedFinishDate: '2025-07-01',
    actualStartDate: '2025-04-03',
    actualFinishDate: null,
    status: 'ACTIVE',
    categoryId: 'cat-1',
    requiresInspection: true,
    requiresMaterials: true,
    contractor: 'ООО «СтройМонтаж»',
    responsible: 'Пётр Петров',
    lastReportedAt: '2026-06-01T09:00:00.000Z',
    plannedProgress: 80,
    actualProgress: 80,
    variance: 0,
    delayDays: 0,
    scheduleStatus: 'GREEN',
    accepted: true,
    docsReady: false,
    blockers: [],
    stale: false,
  }),
  versioned('work-2', {
    objectId: 'obj-1',
    workTypeId: 'wt-3',
    contractorId: 'c-1',
    responsibleUserId: 'u-pm',
    name: LONG_WORK_NAME,
    unit: 'м³',
    plannedQuantity: '340.0000',
    actualQuantity: '340.0000',
    plannedStartDate: '2025-02-01',
    plannedFinishDate: '2025-05-01',
    actualStartDate: '2025-02-02',
    actualFinishDate: '2025-04-28',
    status: 'COMPLETED',
    categoryId: 'cat-1',
    requiresInspection: true,
    requiresMaterials: true,
    contractor: 'ООО «СтройМонтаж»',
    responsible: 'Пётр Петров',
    lastReportedAt: '2025-04-28T09:00:00.000Z',
    plannedProgress: 100,
    actualProgress: 100,
    variance: 0,
    delayDays: 0,
    scheduleStatus: 'GREEN',
    accepted: true,
    docsReady: false,
    blockers: [],
    stale: false,
  }),
  versioned('work-3', {
    objectId: 'obj-2',
    workTypeId: 'wt-2',
    contractorId: 'c-1',
    responsibleUserId: 'u-pm',
    name: 'Кладка наружных стен, секция 2',
    unit: 'м²',
    plannedQuantity: '500.0000',
    actualQuantity: '120.0000',
    plannedStartDate: '2025-05-01',
    plannedFinishDate: '2025-08-01',
    actualStartDate: null,
    actualFinishDate: null,
    status: 'PLANNED',
    categoryId: 'cat-2',
    requiresInspection: true,
    requiresMaterials: true,
    contractor: 'ООО «СтройМонтаж»',
    responsible: 'Пётр Петров',
    lastReportedAt: null,
    plannedProgress: 30,
    actualProgress: 24,
    variance: -6,
    delayDays: 12,
    scheduleStatus: 'RED',
    accepted: false,
    docsReady: false,
    blockers: [],
    stale: true,
  }),
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
  versioned('pkg-2', {
    objectId: 'obj-1',
    objectWorkId: 'work-1',
    status: 'ACCEPTED_BY_CUSTOMER',
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
    reason: LONG_REASON,
    responsible: 'Ольга Морозова',
    packageId: 'pkg-1',
  },
];

const sdoPackageReadiness = [
  {
    documentationPackageId: 'pkg-1',
    objectId: 'obj-1',
    objectName: LONG_OBJECT_NAME,
    objectWorkId: 'work-2',
    workName: LONG_WORK_NAME,
    documentationPackageStatus: 'PREPARING' as const,
    responsible: 'Ольга Морозова',
    ready: false,
    missingReasons: ['Не все участки покрыты пакетом', 'Нет согласия заказчика'],
    sdoClosingCaseId: null,
    packageLocked: false,
    handoffPending: false,
  },
];

const sdoClosingCases = [
  versioned('case-1', {
    objectId: 'obj-1',
    objectName: LONG_OBJECT_NAME,
    objectWorkId: 'work-1',
    workName: 'Армирование фундаментной плиты',
    documentationPackageId: 'pkg-2',
    documentationPackageStatus: 'ACCEPTED_BY_CUSTOMER',
    coveredQuantityPortionIds: [],
    status: 'ON_RECONCILIATION',
    packageLocked: true,
    responsibleUserId: null,
    responsible: null,
    totalAmount: null,
    createdBy: 'u-pto',
    closedAt: null,
    attention: 'RED' as const,
  }),
  versioned('case-2', {
    objectId: 'obj-2',
    objectName: 'ЖК Заречный',
    objectWorkId: 'work-3',
    workName: LONG_WORK_NAME,
    documentationPackageId: 'pkg-1',
    documentationPackageStatus: 'PREPARING',
    coveredQuantityPortionIds: [],
    status: 'CLOSED',
    packageLocked: true,
    responsibleUserId: 'u-sdo',
    responsible: 'Андрей Зайцев',
    totalAmount: '2450000.0000',
    createdBy: 'u-sdo',
    closedAt: '2026-04-01T09:00:00.000Z',
    attention: 'NONE' as const,
  }),
];

const snapshot = {
  objects,
  works,
  contractors: [],
  dependencies: [],
  inspections: [],
  documentationPackages,
  documentationPackagePortions: [],
  documentationDocuments: [],
  documentationVersions: [],
  documentationStatusHistory: [],
  documentationAttentionQueue,
  documentationCustomerAcceptances: [],
  sdoPackageReadiness,
  sdoClosingCases,
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
  await seedSession(page, `token-${actor.role}`);
  await page.route('**/api/**', (route) => fulfillApi(route, actor));
  await page.goto(path, { waitUntil: 'networkidle' });
}

/** Every `columnheader`/`cell` box in a table, in DOM order. */
async function cellBoxes(
  table: Locator,
  role: 'columnheader' | 'cell',
): Promise<Array<{ x: number; width: number }>> {
  const cells = await table.getByRole(role).all();
  const boxes: Array<{ x: number; width: number }> = [];
  for (const cell of cells) {
    const box = await cell.boundingBox();
    if (box) boxes.push({ x: box.x, width: box.width });
  }
  return boxes;
}

/**
 * The defect this whole slice fixes: two cells (most visibly two column
 * headers) painted on top of each other. Boxes are expected in DOM/visual
 * left-to-right order already (a real `<tr>`'s cells render that way even
 * inside a scrolled container), so this only has to check each one starts at
 * or after the previous one's right edge — a 1px tolerance covers adjoining
 * borders/sub-pixel rounding, nothing more.
 */
function assertNoOverlap(boxes: Array<{ x: number; width: number }>): void {
  expect(boxes.length).toBeGreaterThan(1);
  for (let i = 1; i < boxes.length; i += 1) {
    const previous = boxes[i - 1];
    const current = boxes[i];
    expect(current.x).toBeGreaterThanOrEqual(previous.x + previous.width - 1);
  }
}

/**
 * The other shape the same defect takes, which box-position comparison alone
 * misses: `table-layout: fixed`, when the declared columns need more room
 * than the table has, clamps the flexible column's own box toward zero width
 * rather than making boxes geometrically intersect — so a single-word header
 * like "Работа"/"Объект" (nothing to wrap at) or an unwrapped value then
 * paints past its own (now too-narrow) cell and visually over the next
 * column, even though the two `<th>`/`<td>` boxes never technically overlap.
 * `scrollWidth > clientWidth` on the cell itself is the direct, geometric
 * test for exactly that: the content wants more width than its box has.
 */
async function assertNoContentOverflow(table: Locator, role: 'columnheader' | 'cell'): Promise<void> {
  const cells = await table.getByRole(role).all();
  expect(cells.length).toBeGreaterThan(1);
  for (const cell of cells) {
    const overflow = await cell.evaluate((node) => node.scrollWidth - node.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  }
}

/**
 * F11.2-01 — the shape of the defect every check above misses: a column that
 * is wide enough not to collapse, and whose content never overflows its box,
 * but is still narrower than one ordinary word, so `overflow-wrap:
 * break-word` splits that word across two lines ("Армирован / ие"). A DOM
 * Range over exactly the word reports one client rect per line fragment it
 * renders on; a word that stayed whole has all of them on a single line.
 *
 * Returns one entry per occurrence of each word found in the given column's
 * body cells, so a caller can also prove every word was actually found.
 */
async function wordLineCounts(
  table: Locator,
  columnIndex: number,
  words: string[],
): Promise<Array<{ word: string; lines: number }>> {
  return table.evaluate(
    (tableEl, args) => {
      const found: Array<{ word: string; lines: number }> = [];
      const cells = Array.from(tableEl.querySelectorAll('tbody tr'))
        .map((row) => row.children[args.columnIndex])
        .filter((cell): cell is Element => Boolean(cell));
      for (const word of args.words) {
        for (const cell of cells) {
          const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
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
      }
      return found;
    },
    { columnIndex, words },
  );
}

async function assertWordsStayWhole(table: Locator, columnIndex: number, words: string[]): Promise<void> {
  const found = await wordLineCounts(table, columnIndex, words);
  // Non-vacuous: every word must actually be present in that column.
  expect(new Set(found.map((entry) => entry.word))).toEqual(new Set(words));
  const broken = found.filter((entry) => entry.lines !== 1);
  expect(broken, `ordinary words split across lines: ${JSON.stringify(broken)}`).toEqual([]);
}

/** Letter-only words of 6+ letters — the ordinary vocabulary a name is made of. */
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

const TARGET_WORDS = ['Армирование', 'фундаментной', 'железобетонного'];
const WORK_WORDS = Array.from(new Set([...TARGET_WORDS, ...ordinaryWords(LONG_WORK_NAME)]));
const LONG_WORK_ONLY_WORDS = ordinaryWords(LONG_WORK_NAME);
const OBJECT_WORDS = ordinaryWords(LONG_OBJECT_NAME);

async function mainOverflow(page: Page): Promise<{ scrollWidth: number; clientWidth: number }> {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    return { scrollWidth: main?.scrollWidth ?? 0, clientWidth: main?.clientWidth ?? 0 };
  });
}

async function regionOverflow(region: Locator): Promise<{ scrollWidth: number; clientWidth: number }> {
  return region.evaluate((node) => ({ scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
}

const NARROW_WIDTHS = [768, 390, 375];

test.describe('P01 — dense table stays readable and scoped', () => {
  async function openP01(page: Page): Promise<void> {
    await openScreen(page, PTO, '/app.html/pto');
  }

  const table = (page: Page) => page.getByRole('table', { name: 'Очередь ПТО' });
  const region = (page: Page) => page.getByRole('region', { name: 'Очередь ПТО' });

  for (const width of [1280, 1024]) {
    test(`${width}px: no header or cell collision`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openP01(page);

      assertNoOverlap(await cellBoxes(table(page), 'columnheader'));
      await assertNoContentOverflow(table(page), 'columnheader');
      const bodyRow = table(page).locator('tbody tr').first();
      assertNoOverlap(await cellBoxes(bodyRow, 'cell'));
      await assertNoContentOverflow(bodyRow, 'cell');

      // The long work name is still there, still readable text — not
      // replaced, not truncated to an ellipsis, not hidden.
      await expect(table(page)).toContainText(LONG_WORK_NAME);
    });
  }

  test('1440px: retains its current scroll-free layout', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openP01(page);

    assertNoOverlap(await cellBoxes(table(page), 'columnheader'));
    await assertNoContentOverflow(table(page), 'columnheader');
    const overflow = await regionOverflow(region(page));
    // A few px of sub-pixel slack is fine; this must not regress into the
    // same double-digit-or-more overflow the narrow widths legitimately need.
    expect(overflow.scrollWidth - overflow.clientWidth).toBeLessThan(8);
  });

  for (const width of NARROW_WIDTHS) {
    test(`${width}px: table-local horizontal scroll, no destructive collapse`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openP01(page);

      const overflow = await regionOverflow(region(page));
      expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);

      // The fill ("Работа") column is still a real, readable column — not
      // squeezed to a handful of pixels — measured on its header cell, which
      // is unambiguously column 1 regardless of row content.
      const nameHeaderBox = await table(page).getByRole('columnheader', { name: 'Работа' }).boundingBox();
      expect(nameHeaderBox).not.toBeNull();
      expect(nameHeaderBox!.width).toBeGreaterThanOrEqual(100);

      assertNoOverlap(await cellBoxes(table(page), 'columnheader'));
      await assertNoContentOverflow(table(page), 'columnheader');

      // <main> itself is not what's scrolling — only the table's own region.
      const main = await mainOverflow(page);
      expect(main.scrollWidth - main.clientWidth).toBeLessThan(4);
    });
  }

  test('390px: the action button stays reachable and clickable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await openP01(page);

    const createButton = table(page).getByRole('button', { name: 'Создать пакет' }).first();
    await createButton.scrollIntoViewIfNeeded();
    await expect(createButton).toBeVisible();
    await expect(createButton).toBeEnabled();
  });
});

test.describe('SDO — both tables stay readable and scoped', () => {
  async function openSdo(page: Page): Promise<void> {
    await openScreen(page, SDO_USER, '/app.html/sdo');
  }

  const upcoming = (page: Page) => page.getByRole('table', { name: 'Предстоящие пакеты' });
  const active = (page: Page) => page.getByRole('table', { name: 'Дела СДО' });

  for (const width of [1280, 1024]) {
    test(`${width}px: neither table shows header or cell collision`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openSdo(page);

      assertNoOverlap(await cellBoxes(upcoming(page), 'columnheader'));
      assertNoOverlap(await cellBoxes(active(page), 'columnheader'));
      await assertNoContentOverflow(upcoming(page), 'columnheader');
      await assertNoContentOverflow(active(page), 'columnheader');
      await expect(upcoming(page)).toContainText(LONG_WORK_NAME);
      await expect(active(page)).toContainText(LONG_OBJECT_NAME);
    });
  }

  for (const width of NARROW_WIDTHS) {
    test(`${width}px: scoped horizontal scroll on both tables, columns never hidden`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await openSdo(page);

      for (const getTable of [upcoming, active]) {
        assertNoOverlap(await cellBoxes(getTable(page), 'columnheader'));
      }

      // Every operational column header from the source is still present —
      // none dropped to make the table fit.
      await expect(upcoming(page).getByRole('columnheader', { name: 'Не хватает' })).toBeAttached();
      await expect(active(page).getByRole('columnheader', { name: 'Сумма закрытия' })).toBeAttached();

      const main = await mainOverflow(page);
      expect(main.scrollWidth - main.clientWidth).toBeLessThan(4);
    });
  }
});

test.describe('C01 — portfolio table keeps a readable object-name column', () => {
  async function openC01(page: Page): Promise<void> {
    await openScreen(page, PTO, '/app.html/company');
  }

  const table = (page: Page) => page.getByRole('table', { name: 'Объекты компании' });

  test('1440px: existing layout, no overlap', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openC01(page);
    assertNoOverlap(await cellBoxes(table(page), 'columnheader'));
    await assertNoContentOverflow(table(page), 'columnheader');
  });

  for (const width of [390, 375]) {
    test(`${width}px: the object-name column does not collapse to one character per line`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await openC01(page);

      const nameHeaderBox = await table(page)
        .getByRole('columnheader', { name: 'Объект / РП' })
        .boundingBox();
      expect(nameHeaderBox).not.toBeNull();
      // The F11.0 failure rendered this column at roughly one glyph's width
      // (well under 40px); a real minimum keeps it a genuine text column.
      expect(nameHeaderBox!.width).toBeGreaterThanOrEqual(100);

      // The long object name is still intact, readable text in the DOM —
      // not truncated — even though it now wraps across several lines.
      await expect(table(page)).toContainText(LONG_OBJECT_NAME);

      assertNoOverlap(await cellBoxes(table(page), 'columnheader'));

      const main = await mainOverflow(page);
      expect(main.scrollWidth - main.clientWidth).toBeLessThan(4);
    });
  }
});

test.describe('F11.2-01 — ordinary construction words are never split inside a word', () => {
  const ALL_WIDTHS = [1440, 1280, 1024, 768, 390, 375];

  for (const width of ALL_WIDTHS) {
    test(`P01 @ ${width}px: work and object names wrap only between words`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openScreen(page, PTO, '/app.html/pto');
      const table = page.getByRole('table', { name: 'Очередь ПТО' });
      await assertWordsStayWhole(table, 0, WORK_WORDS);
      await assertWordsStayWhole(table, 1, OBJECT_WORDS);
    });

    test(`SDO @ ${width}px: both tables wrap work and object names only between words`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await openScreen(page, SDO_USER, '/app.html/sdo');
      const upcoming = page.getByRole('table', { name: 'Предстоящие пакеты' });
      const active = page.getByRole('table', { name: 'Дела СДО' });
      await assertWordsStayWhole(upcoming, 0, LONG_WORK_ONLY_WORDS);
      await assertWordsStayWhole(upcoming, 1, OBJECT_WORDS);
      await assertWordsStayWhole(active, 0, WORK_WORDS);
      await assertWordsStayWhole(active, 1, OBJECT_WORDS);
    });

    test(`O01 @ ${width}px: work names wrap only between words`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openScreen(page, PTO, '/app.html/object/obj-1');
      await assertWordsStayWhole(page.getByRole('table', { name: 'Работы объекта' }), 0, WORK_WORDS);
    });

    test(`C01 @ ${width}px: the object name wraps only between words`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openScreen(page, PTO, '/app.html/company');
      await assertWordsStayWhole(page.getByRole('table', { name: 'Объекты компании' }), 0, OBJECT_WORDS);
    });
  }
});
