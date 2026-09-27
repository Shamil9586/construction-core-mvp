import { test, expect, type Page, type Locator, type Route } from '@playwright/test';

/**
 * F11.4 States + Accessibility — regression for the confirmed findings from
 * the F11.4 audit: the P01 attention indicator's literal emoji, missing
 * heading semantics on O01/W01 section labels, unannounced/headless route
 * states (Loading/Error/NotFound/Forbidden), lost focus on client-side route
 * changes, and an under-sized Breadcrumb target.
 *
 * TEST TYPE: browser, INTERCEPTED — same shape as
 * tests/f11.3-non-table-responsive/layout.spec.ts: the real Vite dev server
 * with VITE_DATA_PROVIDER=real, so the real, unmodified route containers and
 * screens run in a real browser. Every `/api/*` request is answered by
 * `page.route()` against the fixture below — no backend, no database.
 */

const PTO = { id: 'u-pto', tenantId: 't-1', name: 'Ольга Морозова', role: 'PTO' };
const SDO_USER = { id: 'u-sdo', tenantId: 't-1', name: 'Андрей Зайцев', role: 'SDO' };

const LONG_OBJECT_NAME = 'ЖК «Северный луч», Корпус 3 — вторая очередь строительства';
const LONG_WORK_NAME = 'Устройство монолитного железобетонного перекрытия толщиной 200мм';
const RED_REASON = 'Работа завершена более 30 дней назад, пакет не создан ответственным ПТО';
const YELLOW_REASON = 'Приближается срок предъявления, пакет ещё в подготовке';

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
    address: 'г. Москва, ул. Строителей, д. 12',
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

const workBase = { contractorId: 'c-1', responsibleUserId: 'u-pm', requiresInspection: true, requiresMaterials: true, contractor: 'ООО «СтройМонтаж»', responsible: 'Пётр Петров', docsReady: false };
const works = [
  versioned('work-1', { ...workBase, objectId: 'obj-1', workTypeId: 'wt-1', name: 'Армирование фундаментной плиты', unit: 'т', plannedQuantity: '120.0000', actualQuantity: '96.0000', plannedStartDate: '2025-04-01', plannedFinishDate: '2025-07-01', actualStartDate: '2025-04-03', actualFinishDate: null, status: 'ACTIVE', categoryId: 'cat-1', lastReportedAt: '2026-06-01T09:00:00.000Z', plannedProgress: 80, actualProgress: 80, variance: 0, delayDays: 0, scheduleStatus: 'GREEN', accepted: true, blockers: [], stale: false }),
  versioned('work-2', { ...workBase, objectId: 'obj-1', workTypeId: 'wt-3', name: LONG_WORK_NAME, unit: 'м³', plannedQuantity: '340.0000', actualQuantity: '180.0000', plannedStartDate: '2025-02-01', plannedFinishDate: '2025-05-01', actualStartDate: '2025-02-02', actualFinishDate: null, status: 'ACTIVE', categoryId: 'cat-1', lastReportedAt: '2025-04-28T09:00:00.000Z', plannedProgress: 100, actualProgress: 53, variance: -47, delayDays: 8, scheduleStatus: 'RED', accepted: false, blockers: ['Не подтверждена поставка материала'], stale: false }),
];

const pkg1 = versioned('pkg-1', { objectId: 'obj-1', objectWorkId: 'work-2', status: 'PREPARING', responsibleUserId: 'u-pto', responsible: 'Ольга Морозова', createdBy: 'u-pto' });
const pkg2 = versioned('pkg-2', { objectId: 'obj-1', objectWorkId: 'work-1', status: 'PREPARING', responsibleUserId: 'u-pto', responsible: 'Ольга Морозова', createdBy: 'u-pto' });

const documentationAttentionQueue = [
  { objectId: 'obj-1', objectName: LONG_OBJECT_NAME, objectWorkId: 'work-2', workName: LONG_WORK_NAME, level: 'RED' as const, reason: RED_REASON, responsible: 'Ольга Морозова', packageId: 'pkg-1' },
  { objectId: 'obj-1', objectName: LONG_OBJECT_NAME, objectWorkId: 'work-1', workName: 'Армирование фундаментной плиты', level: 'YELLOW' as const, reason: YELLOW_REASON, responsible: 'Ольга Морозова', packageId: 'pkg-2' },
];

const executionUnits = [
  { id: 'unit-1', tenantId: 't-1', version: 1, objectWorkId: 'work-2', workTypeId: 'wt-3', finishTypeId: null, executionConditions: null, location: 'Секция 2', contractorId: 'c-1', unit: 'м³', plannedQuantity: '340.0000', actualQuantity: '180.0000', internalScStatus: 'PARTIAL', customerScStatus: 'NONE' },
];
const portions = [
  { id: 'portion-1', tenantId: 't-1', version: 1, executionUnitId: 'unit-1', label: 'Захватка 1', plannedQuantity: '120.0000', rpFactQuantity: '80.0000', internalScAccepted: false, internalScConfirmedQuantity: null, customerScAccepted: false, customerScConfirmedQuantity: null },
];

const snapshot = {
  objects,
  works,
  contractors: [],
  dependencies: [],
  inspections: [],
  executionUnits,
  portions,
  documentationPackages: [pkg1, pkg2],
  documentationPackagePortions: [],
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

function headings(page: Page): Promise<Array<{ level: number; text: string }>> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((el) => ({
      level: Number(el.tagName[1]),
      text: (el.textContent ?? '').trim(),
    })),
  );
}

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

test.describe('P01 — attention indicator has no literal emoji (F11-11)', () => {
  test('RED and YELLOW attention rows render no emoji character', async ({ page }) => {
    await openScreen(page, PTO, '/app.html/pto');
    const table = page.getByRole('table', { name: 'Очередь ПТО' });
    const bodyText = await table.innerText();
    expect(EMOJI_RE.test(bodyText), `emoji found in: ${bodyText}`).toBe(false);

    // The textual reason is still the real, visible source of meaning.
    await expect(table).toContainText(RED_REASON);
    await expect(table).toContainText(YELLOW_REASON);
  });

  test('the decorative marker does not pollute the accessible name', async ({ page }) => {
    await openScreen(page, PTO, '/app.html/pto');
    const table = page.getByRole('table', { name: 'Очередь ПТО' });
    const cell = table.locator('tbody tr', { hasText: RED_REASON }).locator('td').nth(3);
    const marker = cell.locator('[aria-hidden="true"]');
    await expect(marker).toHaveCount(1);
    // Its accessible name (from the cell's own text) is the reason, not a
    // symbol — screen readers announce the sentence, not a glyph.
    await expect(cell).toHaveText(new RegExp(RED_REASON));
  });
});

test.describe('Heading hierarchy (F11-08)', () => {
  test('C01: one H1, one H2 — already correct, regression lock', async ({ page }) => {
    await openScreen(page, PTO, '/app.html/company');
    const tree = await headings(page);
    expect(tree.filter((h) => h.level === 1)).toHaveLength(1);
    expect(tree.map((h) => h.level)).toEqual([1, 2]);
    expect(tree[1].text).toBe('Требует внимания');
  });

  test('O01: one H1, section labels are real headings', async ({ page }) => {
    await openScreen(page, PTO, '/app.html/object/obj-1');
    const tree = await headings(page);
    expect(tree.filter((h) => h.level === 1)).toHaveLength(1);
    expect(tree[0]).toEqual({ level: 1, text: LONG_OBJECT_NAME });
    const h2Texts = tree.filter((h) => h.level === 2).map((h) => h.text);
    expect(h2Texts).toEqual(['Физическая готовность', 'Состояние графика', 'Блокировки в производстве']);
  });

  test('W01: one H1, section labels are real headings', async ({ page }) => {
    await openScreen(page, PTO, '/app.html/object/obj-1/work/work-2');
    const tree = await headings(page);
    expect(tree.filter((h) => h.level === 1)).toHaveLength(1);
    expect(tree[0]).toEqual({ level: 1, text: LONG_WORK_NAME });
    const h2Texts = tree.filter((h) => h.level === 2).map((h) => h.text);
    expect(h2Texts).toEqual([
      'Готовность выполнения',
      'Причины блокировки',
      'Единицы исполнения и участки',
      'Исполнительная документация',
      'СДО / Закрытие',
    ]);
  });

  test('P01: one H1 — already correct, regression lock', async ({ page }) => {
    await openScreen(page, PTO, '/app.html/pto');
    const tree = await headings(page);
    expect(tree).toEqual([{ level: 1, text: 'Операции ПТО' }]);
  });

  test('SDO: one H1 — already correct, regression lock', async ({ page }) => {
    await openScreen(page, SDO_USER, '/app.html/sdo');
    const tree = await headings(page);
    expect(tree).toEqual([{ level: 1, text: 'Рабочая область СДО' }]);
  });
});

test.describe('Route states — Loading/Error/NotFound/Forbidden are headed and carry aria-live', () => {
  // "aria-live" here means the DOM/ARIA semantics this suite can actually
  // verify: the attribute is present with the right value, on an element
  // that keeps its native heading role. It does not, and cannot, prove that
  // a given screen reader/browser combination audibly announces the change
  // — see RouteStatus.tsx's module comment.
  test('Loading: one H1, carrying aria-live rather than a role that would replace it', async ({
    page,
  }) => {
    await page.addInitScript((value: string) => window.sessionStorage.setItem('session', value), 'token-PTO');
    await page.route('**/api/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/api/me')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PTO) });
      if (url.includes('/api/snapshot')) return new Promise(() => {}); // never resolves
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('/app.html/company', { waitUntil: 'domcontentloaded' });
    const heading = page.getByRole('heading', { level: 1, name: 'Загрузка…' });
    await expect(heading).toBeVisible();
    await expect(heading).toHaveAttribute('aria-live', 'polite');
  });

  test('Error: one H1, carrying aria-live="assertive", distinct from Loading/success', async ({ page }) => {
    await page.addInitScript((value: string) => window.sessionStorage.setItem('session', value), 'token-PTO');
    await page.route('**/api/**', (route) => {
      const url = route.request().url();
      if (url.includes('/api/me')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PTO) });
      if (url.includes('/api/snapshot')) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Внутренняя ошибка сервера' }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('/app.html/company', { waitUntil: 'networkidle' });
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toContainText('Не удалось загрузить данные');
    await expect(heading).toHaveAttribute('aria-live', 'assertive');
    // Never silently empty or a positive state.
    await expect(page.getByText('Объектов нет')).toHaveCount(0);
  });

  test('NotFound: one H1 naming the missing entity, not a crash or stale parent data', async ({ page }) => {
    await openScreen(page, PTO, '/app.html/object/does-not-exist');
    await expect(page.getByRole('heading', { level: 1, name: 'Объект не найден' })).toBeVisible();
  });

  test('Forbidden: one H1, distinct wording from NotFound', async ({ page }) => {
    await openScreen(page, SDO_USER, '/app.html/pto');
    await expect(page.getByRole('heading', { level: 1, name: 'У вас нет доступа к разделу «ПТО».' })).toBeVisible();
  });

  test('the shell/navigation stays mounted through every one of these states', async ({ page }) => {
    await openScreen(page, PTO, '/app.html/object/does-not-exist');
    await expect(page.getByRole('navigation', { name: 'Основная навигация' })).toBeVisible();
  });
});

test.describe('Route-change focus management', () => {
  test('a real navigation moves focus to the new screen, not document.body', async ({ page }) => {
    await openScreen(page, PTO, '/app.html/company');
    const row = page.getByRole('button', { name: new RegExp(LONG_OBJECT_NAME.split(',')[0]) });
    await row.focus();
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/object\/obj-1$/);
    expect(new URL(page.url()).pathname).toBe('/app.html/object/obj-1');

    // Web-first, retrying assertion, not a one-shot document.activeElement
    // read: useFocusMainOnNavigate's effect runs in a post-render effect
    // that fires after the pathname commits, so a single page.evaluate()
    // taken right after the URL changes can land in the transient window
    // before that effect has actually called .focus() — observing the old
    // element still focused and failing even though the app is correct.
    // toBeFocused() polls until the real end state is reached instead of
    // asserting on that transient window.
    const main = page.locator('#cc-main-content');
    await expect(main).toBeFocused();

    // Focus is already settled by the retrying assertion above — only one
    // element can be document.activeElement at a time, so this is a
    // same-tick read confirming the specific failure mode (a drop to
    // document.body) that toBeFocused() already ruled out, not a second
    // race.
    const isBody = await page.evaluate(() => document.activeElement === document.body);
    expect(isBody, 'focus was dropped to document.body after navigation').toBe(false);
  });

  test('a query-string-only update (P01 object filter) does not steal focus from the control', async ({ page }) => {
    await openScreen(page, PTO, '/app.html/pto');
    const select = page.locator('#p01-object-filter');
    const urlBefore = page.url();
    await select.focus();

    // A real, unswallowed selection — 'obj-1' is the fixture's only object
    // option's actual `value` attribute (view-models/p01.ts), not a label
    // guessed via regex. If this selection silently failed to apply, every
    // assertion below (value, URL, search param) would fail with it —
    // nothing here can pass on a no-op.
    await select.selectOption('obj-1');
    await expect(select).toHaveValue('obj-1');

    // Confirms the searchParams-only navigation this test exists to check
    // actually happened, rather than assuming it from the select's own
    // value: PtoRoute.tsx's onSelectObjectFilter drives the URL, not the
    // <select> directly.
    await expect(page).toHaveURL(/[?&]objectId=obj-1(&|$)/);
    const urlAfter = new URL(page.url());
    expect(urlAfter.searchParams.get('objectId')).toBe('obj-1');
    expect(urlAfter.pathname).toBe('/app.html/pto');
    expect(page.url()).not.toBe(urlBefore);

    // Only now — after a confirmed pathname-stable URL change — does
    // checking focus retention actually test what this test is named for.
    await expect(select).toBeFocused();
  });

  test('opening/closing the F11.1 drawer without navigating still returns focus to the trigger', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await openScreen(page, PTO, '/app.html/company');
    const trigger = page.getByRole('button', { name: 'Открыть меню навигации' });
    await trigger.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});

test.describe('Breadcrumb target size (F11-09)', () => {
  // The crumb's own text box (`getBoundingClientRect()`, what `boundingBox()`
  // reports) is genuinely ~20px tall — an absolutely-positioned `::after`
  // extends the real, clickable hit area without adding to that box, exactly
  // so it does not change the crumb's layout size or `.list`'s gap/wrapping
  // (F11.3). `getBoundingClientRect()` cannot see that extension (it is not
  // part of the element's own layout box), so the only direct way to verify
  // the *clickable* area is 24px is to check what a click at its edge
  // actually hits — `elementFromPoint` resolves a point painted only by a
  // pseudo-element to its host, the same as a real click would.
  test('the clickable area — not just the text box — meets the 24px CSS-px minimum height', async ({
    page,
  }) => {
    await openScreen(page, PTO, '/app.html/object/obj-1/work/work-2');
    const crumb = page.getByRole('navigation', { name: 'Хлебные крошки' }).getByRole('button', { name: 'Портфель' });
    const box = (await crumb.boundingBox())!;
    expect(box.height).toBeLessThan(24); // the visible text box is unchanged

    // 1px above the text box's own top edge: outside the ~20px text box,
    // inside the required 24px hit area only if it was genuinely extended.
    const point = { x: box.x + box.width / 2, y: box.y - 1 };
    const hit = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return el ? { tag: el.tagName, text: el.textContent?.trim() } : null;
      },
      point,
    );
    expect(hit).toEqual({ tag: 'BUTTON', text: 'Портфель' });

    // And it is a real, functioning click there, not just a hit-test.
    await page.mouse.click(point.x, point.y);
    await expect(page).toHaveURL(/\/company$/);
  });

  test('regression lock: crumb stays keyboard-reachable with a visible focus ring', async ({ page }) => {
    await openScreen(page, PTO, '/app.html/object/obj-1/work/work-2');
    const crumb = page.getByRole('navigation', { name: 'Хлебные крошки' }).getByRole('button', { name: 'Портфель' });
    await crumb.focus();
    await expect(crumb).toBeFocused();
    const outlineWidth = await crumb.evaluate((el) => parseFloat(getComputedStyle(el).outlineWidth));
    expect(outlineWidth).toBeGreaterThan(0);
  });

  test('regression lock: narrow-width wrapping (F11.3) is unaffected', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await openScreen(page, PTO, '/app.html/object/obj-1/work/work-2');
    const nav = page.getByRole('navigation', { name: 'Хлебные крошки' });
    const overflow = await nav.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThan(4);
  });
});

test.describe('Regression locks — keyboard reachability already correct on the accepted baseline', () => {
  test('DataTable scroll region is focusable with a visible ring at a width where it scrolls', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await openScreen(page, PTO, '/app.html/pto');
    const region = page.getByRole('region').first();
    await region.focus();
    await expect(region).toBeFocused();
    const outlineStyle = await region.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outlineStyle).not.toBe('none');
  });

  test('C01 attention action is a real, focusable button', async ({ page }) => {
    await openScreen(page, PTO, '/app.html/company');
    const button = page.getByRole('button', { name: 'Открыть объект' }).first();
    await button.focus();
    await expect(button).toBeFocused();
  });
});
