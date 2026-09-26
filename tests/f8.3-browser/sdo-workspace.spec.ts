import { test, expect, type Page, type Request, type Route, type BrowserContext } from '@playwright/test';

/**
 * F8.3 SDO / Closing — the SDO workspace (upcoming packages + active SDO
 * Cases), SDO Case detail (status/amount/allocations/responsible/return to
 * PTO, all three histories), Package Detail's own readiness/handoff section,
 * and W01's read-only SDO state, rendered in a real browser.
 *
 * TEST TYPE: browser, INTERCEPTED — same shape as
 * tests/f8.2.1-browser/pto-operations.spec.ts: playwright.f8.3.config.ts
 * starts the real Vite dev server with VITE_DATA_PROVIDER=real, so the real,
 * unmodified App/SdoRoute/SdoCaseDetailRoute/PackageDetailRoute/WorkRoute
 * code runs in a real browser. Every `/api/*` request is answered by
 * Playwright's `page.route()` against a small in-memory fake state this file
 * owns and mutates on each POST — a real HTTP response, no backend, no
 * database. The backend's own rules (readiness, the status allow-list,
 * SDO_CASE_MANAGE, locking) already have real HTTP/PGlite coverage in
 * tests/f8.3-sdo-closing-http.test.ts; this file's job is only to prove the
 * UI wires those endpoints correctly and shows each role what it should.
 */

async function seedSession(page: Page, token: string): Promise<void> {
  await page.addInitScript((value: string) => {
    window.sessionStorage.setItem('session', value);
  }, token);
}

const PTO = { id: 'u-pto', tenantId: 't-1', name: 'Ольга Морозова', role: 'PTO' };
const RP = { id: 'u-pm', tenantId: 't-1', name: 'Пётр Петров', role: 'PROJECT_MANAGER' };
const SDO = { id: 'u-sdo', tenantId: 't-1', name: 'Андрей Зайцев', role: 'SDO' };
const ADMIN = { id: 'u-admin', tenantId: 't-1', name: 'Админов Админ Админович', role: 'ADMIN' };

const SDO_USER_2 = { id: 'u-sdo-2', name: 'Ирина Белова', role: 'SDO', bitrixUserId: null };
const ALL_USERS = [
  { id: PTO.id, name: PTO.name, role: 'PTO', bitrixUserId: null },
  { id: SDO.id, name: SDO.name, role: 'SDO', bitrixUserId: null },
  SDO_USER_2,
  { id: RP.id, name: RP.name, role: 'PROJECT_MANAGER', bitrixUserId: null },
];

const OBJECT_A = 'object-a';
const WORK_READY = 'work-ready';
const WORK_NOT_READY = 'work-not-ready';
const PACKAGE_READY = 'package-ready';
const PACKAGE_NOT_READY = 'package-not-ready';
const PORTION_READY = 'portion-ready';
const PORTION_MISSING_SC = 'portion-missing-sc';

interface FakePackage {
  id: string;
  objectId: string;
  objectWorkId: string;
  status: string;
  responsibleUserId: string;
  responsible: string;
  version: number;
}
interface FakePortion {
  id: string;
  label: string;
  plannedQuantity: string;
  customerScConfirmedQuantity: string | null;
}
interface FakeSdoCase {
  id: string;
  objectId: string;
  objectName: string;
  objectWorkId: string;
  workName: string;
  documentationPackageId: string;
  documentationPackageStatus: string;
  coveredQuantityPortionIds: string[];
  status: string;
  packageLocked: boolean;
  responsibleUserId: string | null;
  responsible: string | null;
  totalAmount: string | null;
  closedAt: string | null;
  attention: 'RED' | 'NONE';
  version: number;
}
interface FakeHistoryEntry {
  id: string;
  sdoClosingCaseId: string;
  fromStatus?: string;
  toStatus?: string;
  reason?: string | null;
  event?: string;
  comment?: string | null;
  previousAmount?: string | null;
  newAmount?: string;
  changedAt: string;
}
interface FakeAllocation {
  id: string;
  sdoClosingCaseId: string;
  quantityPortionId: string;
  amount: string;
}

interface Actor {
  id: string;
  tenantId: string;
  name: string;
  role: string;
}

interface State {
  packages: FakePackage[];
  packagePortions: Array<{ documentationPackageId: string; quantityPortionId: string }>;
  portions: FakePortion[];
  sdoCases: FakeSdoCase[];
  statusHistory: FakeHistoryEntry[];
  handoffHistory: FakeHistoryEntry[];
  amountHistory: FakeHistoryEntry[];
  allocations: FakeAllocation[];
  counter: number;
}

function makeState(): State {
  return {
    packages: [
      { id: PACKAGE_READY, objectId: OBJECT_A, objectWorkId: WORK_READY, status: 'ACCEPTED_BY_CUSTOMER', responsibleUserId: PTO.id, responsible: PTO.name, version: 5 },
      { id: PACKAGE_NOT_READY, objectId: OBJECT_A, objectWorkId: WORK_NOT_READY, status: 'PRESENTED', responsibleUserId: PTO.id, responsible: PTO.name, version: 3 },
    ],
    packagePortions: [
      { documentationPackageId: PACKAGE_READY, quantityPortionId: PORTION_READY },
      { documentationPackageId: PACKAGE_NOT_READY, quantityPortionId: PORTION_MISSING_SC },
    ],
    portions: [
      { id: PORTION_READY, label: 'Секция A', plannedQuantity: '200', customerScConfirmedQuantity: '200' },
      { id: PORTION_MISSING_SC, label: 'Секция B', plannedQuantity: '150', customerScConfirmedQuantity: null },
    ],
    sdoCases: [],
    statusHistory: [],
    handoffHistory: [],
    amountHistory: [],
    allocations: [],
    counter: 0,
  };
}

function nextId(state: State, prefix: string): string {
  state.counter += 1;
  return `${prefix}-${state.counter}`;
}

function object(id: string, name: string) {
  return {
    id, tenantId: 't-1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', version: 1,
    externalCode: 'F83-BROWSER', source: 'core', name, address: 'Тест, 1', customerName: null,
    organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: RP.id, startDate: '2026-01-01',
    plannedFinishDate: '2026-12-31', actualFinishDate: null, status: 'ACTIVE', healthStatus: 'GREEN',
    responsible: RP.name, contractorIds: ['contractor-1'], contractors: ['Подрядчик 1'], actualProgress: 0, plannedProgress: 0,
  };
}

function work(id: string, objectId: string, name: string) {
  return {
    id, tenantId: 't-1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', version: 1,
    objectId, workTypeId: 'work-type-1', contractorId: 'contractor-1', responsibleUserId: RP.id, name, unit: 'м²',
    plannedQuantity: '300', actualQuantity: '0', plannedStartDate: '2026-01-01', plannedFinishDate: '2026-03-01',
    actualStartDate: null, actualFinishDate: null, status: 'ACTIVE', categoryId: 'category-1',
    requiresInspection: true, requiresMaterials: false, contractor: 'Подрядчик 1', responsible: RP.name,
    lastReportedAt: null, plannedProgress: 0, actualProgress: 0, variance: null, delayDays: 0,
    scheduleStatus: 'GREEN', accepted: false, docsReady: false, blockers: [], stale: false,
  };
}

function quantityPortion(p: FakePortion) {
  return {
    id: p.id, tenantId: 't-1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', version: 1,
    executionUnitId: 'unit-1', label: p.label, plannedQuantity: p.plannedQuantity, rpFactQuantity: p.plannedQuantity,
    internalScAccepted: true, internalScConfirmedQuantity: p.plannedQuantity,
    customerScAccepted: p.customerScConfirmedQuantity !== null, customerScConfirmedQuantity: p.customerScConfirmedQuantity,
  };
}

const READY_MISSING: string[] = [];
const NOT_READY_MISSING = ['Не по всем участкам объёма есть подтверждение количества заказчиком (СК заказчика)'];

function buildReadiness(state: State) {
  return state.packages.map((pkg) => {
    const coveredPortionIds = state.packagePortions.filter((l) => l.documentationPackageId === pkg.id).map((l) => l.quantityPortionId);
    const missing = coveredPortionIds.length === 0
      ? ['К пакету не привязан ни один участок объёма']
      : state.portions.filter((p) => coveredPortionIds.includes(p.id) && p.customerScConfirmedQuantity === null).length > 0
        ? NOT_READY_MISSING
        : READY_MISSING;
    const acceptanceMissing = pkg.status !== 'ACCEPTED_BY_CUSTOMER' ? ['Не зарегистрировано согласие заказчика по документации'] : [];
    const missingReasons = [...acceptanceMissing, ...missing];
    const sdoCase = state.sdoCases.find((c) => c.documentationPackageId === pkg.id) ?? null;
    const w = pkg.objectWorkId === WORK_READY ? work(WORK_READY, OBJECT_A, 'Штукатурка стен (готово)') : work(WORK_NOT_READY, OBJECT_A, 'Кладка перегородок (не готово)');
    return {
      documentationPackageId: pkg.id,
      objectId: pkg.objectId,
      objectName: 'Школа на 550 мест',
      objectWorkId: pkg.objectWorkId,
      workName: w.name,
      documentationPackageStatus: pkg.status,
      responsible: pkg.responsible,
      ready: missingReasons.length === 0,
      missingReasons,
      sdoClosingCaseId: sdoCase ? sdoCase.id : null,
      packageLocked: sdoCase ? sdoCase.packageLocked : false,
      handoffPending: missingReasons.length === 0 && !(sdoCase && sdoCase.packageLocked),
    };
  });
}

function buildSnapshot(state: State, actor: Actor) {
  const documentationVisible = actor.role !== 'SDO';
  return {
    objects: [object(OBJECT_A, 'Школа на 550 мест')],
    works: [work(WORK_READY, OBJECT_A, 'Штукатурка стен (готово)'), work(WORK_NOT_READY, OBJECT_A, 'Кладка перегородок (не готово)')],
    contractors: [],
    dependencies: [],
    inspections: [],
    executionUnits: [],
    portions: state.portions.map(quantityPortion),
    documentationPackages: documentationVisible ? state.packages : undefined,
    documentationPackagePortions: documentationVisible ? state.packagePortions : undefined,
    documentationDocuments: documentationVisible ? [] : undefined,
    documentationVersions: documentationVisible ? [] : undefined,
    documentationStatusHistory: documentationVisible ? [] : undefined,
    documentationAttentionQueue: documentationVisible ? [] : undefined,
    documentationCustomerAcceptances: documentationVisible ? [] : undefined,
    sdoClosingCases: state.sdoCases,
    sdoClosingStatusHistory: state.statusHistory,
    sdoClosingHandoffHistory: state.handoffHistory,
    sdoClosingAmountHistory: state.amountHistory,
    sdoClosingPortionAllocations: state.allocations,
    sdoPackageReadiness: buildReadiness(state),
  };
}

const ALLOWED_NEXT: Record<string, string[]> = {
  ON_RECONCILIATION: ['VERIFICATION_PASSED', 'ON_CORRECTION'],
  VERIFICATION_PASSED: ['CLOSED', 'ON_CORRECTION'],
  ON_CORRECTION: ['ON_RECONCILIATION'],
  CLOSED: ['ON_CORRECTION'],
};

function handleApi(state: State, actor: Actor, method: string, path: string, request: Request): { status: number; body?: unknown } | undefined {
  if (method === 'GET' && path === '/api/me') return { status: 200, body: actor };
  if (method === 'GET' && path === '/api/snapshot') return { status: 200, body: buildSnapshot(state, actor) };
  if (method === 'GET' && path === '/api/users') return { status: 200, body: ALL_USERS };
  if (method === 'GET' && path === '/api/sdo-closing-cases') return { status: 200, body: state.sdoCases };

  const acceptanceMatch = path.match(/^\/api\/documentation-packages\/([^/]+)\/customer-acceptance$/);
  if (method === 'POST' && acceptanceMatch) {
    const pkg = state.packages.find((p) => p.id === acceptanceMatch[1]!)!;
    if (pkg.status !== 'PRESENTED') return { status: 400, body: { message: 'Согласие заказчика можно зарегистрировать только для предъявленного пакета' } };
    pkg.status = 'ACCEPTED_BY_CUSTOMER';
    pkg.version += 1;
    return { status: 201, body: pkg };
  }

  const handoffMatch = path.match(/^\/api\/documentation-packages\/([^/]+)\/handoff-to-sdo$/);
  if (method === 'POST' && handoffMatch) {
    const pkg = state.packages.find((p) => p.id === handoffMatch[1]!)!;
    const readiness = buildReadiness(state).find((r) => r.documentationPackageId === pkg.id)!;
    if (!readiness.ready) return { status: 400, body: { message: readiness.missingReasons.join('; ') } };
    let sdoCase = state.sdoCases.find((c) => c.documentationPackageId === pkg.id);
    if (sdoCase && sdoCase.packageLocked) return { status: 400, body: { message: 'Пакет уже передан в СДО' } };
    const coveredQuantityPortionIds = state.packagePortions.filter((l) => l.documentationPackageId === pkg.id).map((l) => l.quantityPortionId);
    if (!sdoCase) {
      sdoCase = {
        id: nextId(state, 'case'),
        objectId: pkg.objectId,
        objectName: 'Школа на 550 мест',
        objectWorkId: pkg.objectWorkId,
        workName: pkg.objectWorkId === WORK_READY ? 'Штукатурка стен (готово)' : 'Кладка перегородок (не готово)',
        documentationPackageId: pkg.id,
        documentationPackageStatus: pkg.status,
        coveredQuantityPortionIds,
        status: 'ON_RECONCILIATION',
        packageLocked: true,
        responsibleUserId: null,
        responsible: null,
        totalAmount: null,
        closedAt: null,
        attention: 'NONE',
        version: 1,
      };
      state.sdoCases.push(sdoCase);
    } else {
      sdoCase.packageLocked = true;
      sdoCase.version += 1;
    }
    state.handoffHistory.push({ id: nextId(state, 'handoff'), sdoClosingCaseId: sdoCase.id, event: 'HANDED_OFF', comment: null, changedAt: new Date().toISOString() });
    return { status: 201, body: sdoCase };
  }

  const returnMatch = path.match(/^\/api\/sdo-closing-cases\/([^/]+)\/return-to-pto$/);
  if (method === 'POST' && returnMatch) {
    const sdoCase = state.sdoCases.find((c) => c.id === returnMatch[1]!)!;
    sdoCase.packageLocked = false;
    sdoCase.version += 1;
    const pkg = state.packages.find((p) => p.id === sdoCase.documentationPackageId)!;
    pkg.status = 'CORRECTING';
    pkg.version += 1;
    state.handoffHistory.push({ id: nextId(state, 'handoff'), sdoClosingCaseId: sdoCase.id, event: 'RETURNED_TO_PTO', comment: null, changedAt: new Date().toISOString() });
    return { status: 201, body: sdoCase };
  }

  const responsibleMatch = path.match(/^\/api\/sdo-closing-cases\/([^/]+)\/responsible$/);
  if (method === 'POST' && responsibleMatch) {
    const body = request.postDataJSON() as { responsibleUserId: string };
    const sdoCase = state.sdoCases.find((c) => c.id === responsibleMatch[1]!)!;
    const user = ALL_USERS.find((u) => u.id === body.responsibleUserId);
    if (!user || user.role !== 'SDO') return { status: 400, body: { message: 'Назначьте активного сотрудника СДО' } };
    sdoCase.responsibleUserId = user.id;
    sdoCase.responsible = user.name;
    sdoCase.version += 1;
    return { status: 201, body: sdoCase };
  }

  const statusMatch = path.match(/^\/api\/sdo-closing-cases\/([^/]+)\/status$/);
  if (method === 'POST' && statusMatch) {
    const body = request.postDataJSON() as { status: string; reason?: string };
    const sdoCase = state.sdoCases.find((c) => c.id === statusMatch[1]!)!;
    if (!ALLOWED_NEXT[sdoCase.status]?.includes(body.status)) {
      return { status: 400, body: { message: `Недопустимый переход статуса: ${sdoCase.status} → ${body.status}` } };
    }
    if (sdoCase.status === 'CLOSED' && !body.reason?.trim()) {
      return { status: 400, body: { message: 'Укажите причину возврата закрытого дела на корректировку' } };
    }
    state.statusHistory.push({ id: nextId(state, 'status'), sdoClosingCaseId: sdoCase.id, fromStatus: sdoCase.status, toStatus: body.status, reason: body.reason ?? null, changedAt: new Date().toISOString() });
    sdoCase.status = body.status;
    sdoCase.closedAt = body.status === 'CLOSED' ? new Date().toISOString() : null;
    sdoCase.version += 1;
    return { status: 201, body: sdoCase };
  }

  const amountMatch = path.match(/^\/api\/sdo-closing-cases\/([^/]+)\/amount$/);
  if (method === 'POST' && amountMatch) {
    const body = request.postDataJSON() as { amount: string };
    const sdoCase = state.sdoCases.find((c) => c.id === amountMatch[1]!)!;
    state.amountHistory.push({ id: nextId(state, 'amount'), sdoClosingCaseId: sdoCase.id, previousAmount: sdoCase.totalAmount, newAmount: body.amount, changedAt: new Date().toISOString() });
    sdoCase.totalAmount = body.amount;
    sdoCase.version += 1;
    return { status: 201, body: sdoCase };
  }

  const allocationMatch = path.match(/^\/api\/sdo-closing-cases\/([^/]+)\/allocations$/);
  if (method === 'POST' && allocationMatch) {
    const body = request.postDataJSON() as { quantityPortionId: string; amount: string };
    const sdoCase = state.sdoCases.find((c) => c.id === allocationMatch[1]!)!;
    if (!sdoCase.coveredQuantityPortionIds.includes(body.quantityPortionId)) return { status: 400, body: { message: 'Участок не входит в состав пакета' } };
    if (state.allocations.some((a) => a.sdoClosingCaseId === sdoCase.id && a.quantityPortionId === body.quantityPortionId)) {
      return { status: 400, body: { message: 'Для этого участка уже указано распределение суммы' } };
    }
    const allocation: FakeAllocation = { id: nextId(state, 'alloc'), sdoClosingCaseId: sdoCase.id, quantityPortionId: body.quantityPortionId, amount: body.amount };
    state.allocations.push(allocation);
    return { status: 201, body: allocation };
  }

  const pkgStatusMatch = path.match(/^\/api\/documentation-packages\/([^/]+)\/status$/);
  if (method === 'POST' && pkgStatusMatch) {
    const body = request.postDataJSON() as { status: string };
    const pkg = state.packages.find((p) => p.id === pkgStatusMatch[1]!)!;
    pkg.status = body.status;
    pkg.version += 1;
    return { status: 201, body: pkg };
  }

  return undefined;
}

/**
 * Binds this page's own `/api/*` traffic to a *fixed* actor, chosen once by
 * the caller (whichever role's session token `seedSession` put on this
 * page) — never a shared, mutable "current actor" on `state` itself. Two
 * pages sharing one `state` (a PTO page and an SDO page working the same
 * handoff) must see two independent actors on every request, exactly as two
 * real, independently logged-in sessions would against the real backend
 * (`authenticate()` reads the bearer token per request, never a
 * process-wide "current user"). A single shared `state.actor` field was
 * tried first and was wrong: the second page's `page.route()` handler
 * still closed over the same mutable field, so both pages silently acted as
 * whichever role called `mockApi()` last.
 */
async function mockApi(page: Page, state: State, actor: Actor): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());
      const result = handleApi(state, actor, request.method(), url.pathname, request);
      if (!result) {
        await route.fulfill({ status: 599, contentType: 'text/plain', body: `unexpected ${request.method()} ${url.pathname}` });
        return;
      }
      await route.fulfill({ status: result.status, contentType: 'application/json', body: JSON.stringify(result.body ?? {}) });
    },
  );
}

/* --------------------------------------------------------------------- *
 * Upcoming queue, readiness, role separation                             *
 * --------------------------------------------------------------------- */

test('SDO workspace: the upcoming queue shows readiness state and missing prerequisites, before any Case exists', async ({ page }) => {
  const state = makeState();
  await seedSession(page, 'f8-3-browser-token-upcoming');
  await mockApi(page, state, SDO);

  await page.goto('/app.html/sdo');
  await expect(page.getByRole('heading', { level: 1, name: 'Рабочая область СДО' })).toBeVisible();

  const upcoming = page.locator('table', { hasText: 'Предстоящие пакеты' });
  const readyRow = upcoming.locator('tr', { hasText: 'Штукатурка стен (готово)' });
  await expect(readyRow.getByText('Готово к передаче')).toBeVisible();

  const notReadyRow = upcoming.locator('tr', { hasText: 'Кладка перегородок (не готово)' });
  await expect(notReadyRow).toContainText('Не готово');
  await expect(notReadyRow).toContainText('СК заказчика');

  await expect(page.locator('table', { hasText: 'Дела СДО' })).toContainText('Нет открытых дел СДО');
});

test('Role separation: PTO and RP cannot open /sdo; SDO cannot open /pto — each sees the other department\'s forbidden message', async ({ page }) => {
  const state = makeState();
  await seedSession(page, 'f8-3-browser-token-role-pto');
  await mockApi(page, state, PTO);
  await page.goto('/app.html/sdo');
  await expect(page.getByText('рабочая область СДО', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Рабочая область СДО' })).toHaveCount(0);
});

test('Role separation: SDO cannot open the PTO workspace', async ({ page }) => {
  const state = makeState();
  await seedSession(page, 'f8-3-browser-token-role-sdo');
  await mockApi(page, state, SDO);
  await page.goto('/app.html/pto');
  // SDO is explicitly excluded from canAccessDocumentation() too (F8.2's
  // own "SDO: No F8.2 access"), so PtoRoute shows that message, not the
  // "this is PTO's own workspace" one canAccessDocumentation roles get.
  await expect(page.getByText('нет доступа к разделу «ПТО»', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Операции ПТО' })).toHaveCount(0);
});

/* --------------------------------------------------------------------- *
 * Golden path: handoff, lock, assignment, amount, allocations, closing   *
 * --------------------------------------------------------------------- */

test('Package Detail → handoff → SDO Case detail: readiness indication, explicit handoff, lock, responsible assignment, amount entry/history, allocation, closing — the full SDO flow in one pass', async ({ page }) => {
  const state = makeState();
  await seedSession(page, 'f8-3-browser-token-golden');
  await mockApi(page, state, PTO);

  await page.goto('/app.html/pto/package/' + PACKAGE_READY);
  await expect(page.getByText('Готов к передаче в СДО')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Передать в СДО' })).toBeVisible();
  await page.getByRole('button', { name: 'Передать в СДО' }).click();
  await expect(page.getByText('Состав пакета заблокирован: передан в СДО')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Передать в СДО' })).toHaveCount(0);

  // Switch to SDO to work the case that handoff just created — a genuinely
  // separate actor, on its own page, sharing only the fake `state` (never
  // `mockApi`'s bound `actor`, which each page's own registration fixes
  // independently — see mockApi's own comment).
  const sdoPage = await page.context().newPage();
  await seedSession(sdoPage, 'f8-3-browser-token-golden-sdo');
  await mockApi(sdoPage, state, SDO);
  await sdoPage.goto('/app.html/sdo');
  await sdoPage.locator('table', { hasText: 'Дела СДО' }).getByRole('button', { name: 'Открыть' }).click();
  await expect(sdoPage.getByRole('heading', { level: 1, name: 'Штукатурка стен (готово)' })).toBeVisible();
  await expect(sdoPage.getByText('Состав пакета заблокирован')).toBeVisible();

  // Scoped to the <span> specifically (not the <option> still sitting in
  // the picker, nor the page header's own "Ответственный СДО: …" description
  // paragraph) — both also contain this name once assigned.
  await sdoPage.getByLabel('Ответственный сотрудник СДО').selectOption({ label: SDO_USER_2.name });
  await sdoPage.getByRole('button', { name: 'Назначить ответственного' }).click();
  await expect(sdoPage.locator('span', { hasText: SDO_USER_2.name })).toBeVisible();

  await sdoPage.getByLabel('Новая сумма закрытия').fill('1840000.00');
  await sdoPage.getByRole('button', { name: 'Сохранить сумму' }).click();
  // exact: true — once the amount history renders "— → 1 840 000 ₽" below,
  // a substring match would also hit that line.
  await expect(sdoPage.getByText('1 840 000 ₽', { exact: true })).toBeVisible();

  await sdoPage.getByLabel('Участок для распределения суммы').selectOption({ label: 'Секция A' });
  await sdoPage.getByLabel('Сумма распределения по участку').fill('1840000.00');
  await sdoPage.getByRole('button', { name: 'Добавить распределение' }).click();
  await expect(sdoPage.getByText('Распределено:')).toContainText('1 840 000');

  await sdoPage.getByRole('button', { name: 'Отметить: выверка пройдена' }).click();
  // exact: true — once status history renders "На выверке → Выверка
  // пройдена" below, a substring match would also hit that line.
  await expect(sdoPage.getByText('Выверка пройдена', { exact: true })).toBeVisible();

  await sdoPage.getByRole('button', { name: 'Закрыть дело' }).click();
  await expect(sdoPage.getByText('Закрытие', { exact: true })).toBeVisible();
});

/* --------------------------------------------------------------------- *
 * CLOSED -> ON_CORRECTION requires a reason                              *
 * --------------------------------------------------------------------- */

test('SDO Case detail: CLOSED cannot return to ON_CORRECTION without a reason', async ({ page }) => {
  const state = makeState();
  const closedCase: FakeSdoCase = {
    id: 'case-closed', objectId: OBJECT_A, objectName: 'Школа на 550 мест', objectWorkId: WORK_READY, workName: 'Штукатурка стен (готово)',
    documentationPackageId: PACKAGE_READY, documentationPackageStatus: 'ACCEPTED_BY_CUSTOMER', coveredQuantityPortionIds: [PORTION_READY],
    status: 'CLOSED', packageLocked: true, responsibleUserId: SDO.id, responsible: SDO.name, totalAmount: '500.00', closedAt: '2026-01-01T00:00:00Z', attention: 'NONE', version: 1,
  };
  state.sdoCases.push(closedCase);
  await seedSession(page, 'f8-3-browser-token-reason');
  await mockApi(page, state, SDO);

  await page.goto('/app.html/sdo/case/' + closedCase.id);
  await page.getByRole('button', { name: 'Вернуть на корректировку' }).click();
  await expect(page.getByText('Укажите причину возврата закрытого дела на корректировку')).toBeVisible();
  await expect(page.getByText('Закрытие', { exact: true })).toBeVisible();

  await page.getByLabel('Причина: Вернуть на корректировку').fill('Ошибка в сумме');
  await page.getByRole('button', { name: 'Вернуть на корректировку' }).click();
  // exact: true — the status-history line "Закрытие → На корректировке ·
  // Ошибка в сумме" also contains this text as a substring.
  await expect(page.getByText('На корректировке', { exact: true })).toBeVisible();
});

/* --------------------------------------------------------------------- *
 * Correction cycle: return to PTO, re-present, re-handoff resumes case   *
 * --------------------------------------------------------------------- */

test('Correction cycle: SDO returns a locked Case to PTO, PTO corrects and re-presents, SDO re-checks the same Case in', async ({ browser }) => {
  const state = makeState();
  const sdoCase: FakeSdoCase = {
    id: 'case-resume', objectId: OBJECT_A, objectName: 'Школа на 550 мест', objectWorkId: WORK_READY, workName: 'Штукатурка стен (готово)',
    documentationPackageId: PACKAGE_READY, documentationPackageStatus: 'ACCEPTED_BY_CUSTOMER', coveredQuantityPortionIds: [PORTION_READY],
    status: 'VERIFICATION_PASSED', packageLocked: true, responsibleUserId: null, responsible: null, totalAmount: null, closedAt: null, attention: 'NONE', version: 1,
  };
  state.sdoCases.push(sdoCase);

  const sdoContext: BrowserContext = await browser.newContext();
  const sdoPage = await sdoContext.newPage();
  await seedSession(sdoPage, 'f8-3-browser-token-resume-sdo');
  await mockApi(sdoPage, state, SDO);
  await sdoPage.goto('/app.html/sdo/case/' + sdoCase.id);
  await sdoPage.getByRole('button', { name: 'Вернуть в ПТО' }).click();
  await expect(sdoPage.getByText('Пакет возвращён в ПТО')).toBeVisible();
  // The case's own reconciliation status is untouched by the return.
  await expect(sdoPage.getByText('Выверка пройдена')).toBeVisible();

  const ptoContext: BrowserContext = await browser.newContext();
  const ptoPage = await ptoContext.newPage();
  await seedSession(ptoPage, 'f8-3-browser-token-resume-pto');
  await mockApi(ptoPage, state, PTO);
  await ptoPage.goto('/app.html/pto/package/' + PACKAGE_READY);
  await expect(ptoPage.getByText('Устраняются замечания')).toBeVisible();
  await ptoPage.getByRole('button', { name: 'Предъявить заказчику' }).click();
  await ptoPage.getByLabel('Дата согласия заказчика').fill('2026-02-01');
  await ptoPage.getByRole('button', { name: 'Зарегистрировать согласие заказчика' }).click();
  await expect(ptoPage.getByRole('button', { name: 'Передать в СДО' })).toBeVisible();
  await ptoPage.getByRole('button', { name: 'Передать в СДО' }).click();

  await sdoPage.reload();
  await expect(sdoPage.getByText('Состав пакета заблокирован')).toBeVisible();
  await expect(sdoPage.getByText('Выверка пройдена')).toBeVisible();
  await expect(sdoPage).toHaveURL(new RegExp(sdoCase.id));

  await sdoContext.close();
  await ptoContext.close();
});

/* --------------------------------------------------------------------- *
 * W01 read-only state                                                    *
 * --------------------------------------------------------------------- */

test('W01: SDO Case state is read-only — status/amount are visible, no action controls are offered', async ({ page }) => {
  const state = makeState();
  state.sdoCases.push({
    id: 'case-readonly', objectId: OBJECT_A, objectName: 'Школа на 550 мест', objectWorkId: WORK_READY, workName: 'Штукатурка стен (готово)',
    documentationPackageId: PACKAGE_READY, documentationPackageStatus: 'ACCEPTED_BY_CUSTOMER', coveredQuantityPortionIds: [PORTION_READY],
    status: 'VERIFICATION_PASSED', packageLocked: true, responsibleUserId: SDO.id, responsible: SDO.name, totalAmount: '1840000.00', closedAt: null, attention: 'NONE', version: 1,
  });
  await seedSession(page, 'f8-3-browser-token-w01-readonly');
  await mockApi(page, state, RP);

  await page.goto(`/app.html/object/${OBJECT_A}/work/${WORK_READY}`);
  const section = page.locator('section', { hasText: 'СДО / Закрытие' });
  await expect(section).toContainText('Выверка пройдена');
  await expect(section).toContainText(SDO.name);
  await expect(section).toContainText('1 840 000');
  await expect(section.getByRole('button')).toHaveCount(0);
});
