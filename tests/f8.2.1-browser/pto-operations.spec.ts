import { test, expect, type Page, type Request, type Route } from '@playwright/test';

/**
 * F8.2.1 PTO Operations Layer — the PTO Attention Queue, the create/open
 * actions P01 and W01 both call through the same `documentationApi` module
 * (Decision 1), and the package detail screen (status, portions, documents,
 * versions), rendered in a real browser.
 *
 * TEST TYPE: browser, INTERCEPTED — same shape as
 * tests/f8.1-browser/w01-execution.spec.ts and
 * tests/f8.2-browser/pto-workspace.spec.ts: playwright.f8.2.1.config.ts
 * starts the real Vite dev server with VITE_DATA_PROVIDER=real, so the real,
 * unmodified App/PtoRoute/WorkRoute/PackageDetailRoute code runs in a real
 * browser. Every `/api/*` request is answered by Playwright's `page.route()`
 * against a small in-memory fake state this file owns and mutates on each
 * POST — a real HTTP response, but no backend and no database behind it.
 * The backend's own rules (the transition allow-list, DOCUMENTATION_MANAGE,
 * canAccessDocumentation, the storage-reference CHECK) already have real
 * HTTP/PGlite coverage in tests/f8.2.1-*.test.ts; this file's job is only to
 * prove the UI wires those endpoints correctly and shows each role what it
 * should.
 */

async function seedSession(page: Page, token: string): Promise<void> {
  await page.addInitScript((value: string) => {
    window.sessionStorage.setItem('session', value);
  }, token);
}

const PTO = { id: 'u-pto', tenantId: 't-1', name: 'Ольга Морозова', role: 'PTO' };
const RP = { id: 'u-pm', tenantId: 't-1', name: 'Пётр Петров', role: 'PROJECT_MANAGER' };
const SDO = { id: 'u-sdo', tenantId: 't-1', name: 'Сергей Сидоров', role: 'SDO' };
const ADMIN = { id: 'u-admin', tenantId: 't-1', name: 'Админов Админ Админович', role: 'ADMIN' };

// F8.2.1-04 (Corrective Patch) — GET /api/users' own fixture, standing in
// for the real `SELECT id,name,role,bitrix_user_id FROM users WHERE
// tenant_id=$1 AND is_active=true`. Two PTO users so a picker test can prove
// a *specific* selection reaches the backend, plus a non-PTO user so the
// frontend's own PTO-only filter is exercised against real "someone else"
// noise, not just an empty complement.
const PTO_USER_2 = { id: 'u-pto-2', name: 'Виктор Волков', role: 'PTO', bitrixUserId: null };
const ALL_USERS = [
  { id: PTO.id, name: PTO.name, role: 'PTO', bitrixUserId: null },
  PTO_USER_2,
  { id: RP.id, name: RP.name, role: 'PROJECT_MANAGER', bitrixUserId: null },
];

const OBJECT_A = 'object-a';
const WORK_NEW = 'work-new';
const WORK_DRAFT = 'work-draft';
const UNIT_NEW = 'unit-new';
const PORTION_NEW = 'portion-new';

type AttentionLevel = 'RED' | 'YELLOW' | 'NONE';

// Mirrors resolveDocumentationAttention() (packages/domain) — this file owns
// its own small copy of the fixture's business logic exactly as
// tests/f8.1-browser/w01-execution.spec.ts already does for
// PortionCompletionService.unitCoverage().
function packageAttention(status: string): { level: AttentionLevel; reason: string } {
  switch (status) {
    case 'DRAFT':
    case 'PREPARING':
      return { level: 'YELLOW', reason: 'Документы формируются' };
    case 'CORRECTING':
      return { level: 'YELLOW', reason: 'Устраняются замечания' };
    case 'RETURNED':
      return { level: 'RED', reason: 'Возвращено заказчиком' };
    default:
      return { level: 'NONE', reason: '' };
  }
}
const RANK: Record<AttentionLevel, number> = { RED: 0, YELLOW: 1, NONE: 2 };

interface FakePackage {
  id: string;
  objectId: string;
  objectWorkId: string;
  status: string;
  responsibleUserId: string;
  responsible: string;
  createdBy: string;
  version: number;
}
interface FakeLink {
  id: string;
  documentationPackageId: string;
  quantityPortionId: string;
}
interface FakeDocument {
  id: string;
  documentationPackageId: string;
  type: string;
  createdBy: string;
}
interface FakeVersion {
  id: string;
  documentationDocumentId: string;
  versionNumber: number;
  storageProvider: string;
  storageReference: string | null;
  comment: string | null;
  createdBy: string;
}
interface FakeHistoryEntry {
  id: string;
  documentationPackageId: string;
  fromStatus: string;
  toStatus: string;
  changedBy: string;
  changedAt: string;
  comment: string | null;
}

interface Actor {
  id: string;
  tenantId: string;
  name: string;
  role: string;
}

interface State {
  actor: Actor;
  packages: FakePackage[];
  packagePortions: FakeLink[];
  documents: FakeDocument[];
  versions: FakeVersion[];
  statusHistory: FakeHistoryEntry[];
  counter: number;
}

function makeState(actor: Actor, initialPackages: FakePackage[] = []): State {
  return {
    actor,
    packages: initialPackages,
    packagePortions: [],
    documents: [],
    versions: [],
    statusHistory: [],
    counter: 0,
  };
}

function nextId(state: State, prefix: string): string {
  state.counter += 1;
  return `${prefix}-${state.counter}`;
}

function object(id: string, name: string) {
  return {
    id,
    tenantId: 't-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    externalCode: 'F821-BROWSER',
    source: 'core',
    name,
    address: 'Тест, 1',
    customerName: null,
    organizationName: 'ООО СЗ «Гор-Строй»',
    projectManagerId: RP.id,
    startDate: '2026-01-01',
    plannedFinishDate: '2026-12-31',
    actualFinishDate: null,
    status: 'ACTIVE',
    healthStatus: 'GREEN',
    responsible: RP.name,
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
    responsibleUserId: RP.id,
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
    responsible: RP.name,
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

function executionUnit(id: string, objectWorkId: string) {
  return {
    id,
    tenantId: 't-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    objectWorkId,
    workTypeId: 'work-type-1',
    finishTypeId: null,
    executionConditions: null,
    location: null,
    contractorId: 'contractor-1',
    unit: 'м²',
    plannedQuantity: '300',
    actualQuantity: '0',
    internalScStatus: 'NONE',
    customerScStatus: 'NONE',
  };
}

function quantityPortion(id: string, executionUnitId: string, label: string) {
  return {
    id,
    tenantId: 't-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    executionUnitId,
    label,
    plannedQuantity: '100',
    rpFactQuantity: null,
    internalScAccepted: false,
    internalScConfirmedQuantity: null,
    customerScAccepted: false,
    customerScConfirmedQuantity: null,
  };
}

const WORKS = [
  { id: WORK_NEW, objectId: OBJECT_A, name: 'Устройство кровли' },
  { id: WORK_DRAFT, objectId: OBJECT_A, name: 'Штукатурка стен' },
];

function buildAttentionQueue(state: State) {
  const items: unknown[] = [];
  for (const w of WORKS) {
    const ownPackages = state.packages.filter((p) => p.objectWorkId === w.id);
    let worst: { level: AttentionLevel; reason: string; packageId: string | null; responsible: string | null };
    if (ownPackages.length === 0) {
      worst = { level: 'RED', reason: 'Нет пакета ИД', packageId: null, responsible: null };
    } else {
      worst = {
        ...packageAttention(ownPackages[0]!.status),
        packageId: ownPackages[0]!.id,
        responsible: ownPackages[0]!.responsible,
      };
      for (const pkg of ownPackages.slice(1)) {
        const candidate = packageAttention(pkg.status);
        if (RANK[candidate.level] < RANK[worst.level]) {
          worst = { ...candidate, packageId: pkg.id, responsible: pkg.responsible };
        }
      }
    }
    if (worst.level === 'NONE') continue;
    items.push({
      objectId: w.objectId,
      objectName: 'Школа на 550 мест',
      objectWorkId: w.id,
      workName: w.name,
      level: worst.level,
      reason: worst.reason,
      responsible: worst.responsible,
      packageId: worst.packageId,
    });
  }
  return items;
}

// F8.2.1 — SDO's snapshot never carries documentation fields at all
// (canAccessDocumentation), mirrored here so the frontend's own access
// guards (PtoRoute, PackageDetailRoute, DocumentationSection) are exercised
// exactly as they would be against the real backend.
function buildSnapshot(state: State) {
  const visible = state.actor.role !== 'SDO';
  return {
    objects: [object(OBJECT_A, 'Школа на 550 мест')],
    works: WORKS.map((w) => work(w.id, w.objectId, w.name)),
    contractors: [],
    dependencies: [],
    inspections: [],
    executionUnits: [executionUnit(UNIT_NEW, WORK_NEW)],
    portions: [quantityPortion(PORTION_NEW, UNIT_NEW, 'Участок 1')],
    documentationPackages: visible ? state.packages : undefined,
    documentationPackagePortions: visible ? state.packagePortions : undefined,
    documentationDocuments: visible ? state.documents : undefined,
    documentationVersions: visible ? state.versions : undefined,
    documentationStatusHistory: visible ? state.statusHistory : undefined,
    documentationAttentionQueue: visible ? buildAttentionQueue(state) : undefined,
  };
}

function handleApi(
  state: State,
  method: string,
  path: string,
  request: Request,
): { status: number; body?: unknown } | undefined {
  if (method === 'GET' && path === '/api/me') return { status: 200, body: state.actor };
  if (method === 'GET' && path === '/api/snapshot') return { status: 200, body: buildSnapshot(state) };
  if (method === 'GET' && path === '/api/users') return { status: 200, body: ALL_USERS };

  if (method === 'POST' && path === '/api/documentation-packages') {
    const body = request.postDataJSON() as { objectWorkId: string; responsibleUserId: string };
    // F8.2.1-04 — the real backend rejects anything but an active PTO user;
    // this mock enforces the same rule so a test that (by mistake, or by a
    // regression) sends the wrong id fails loudly here rather than silently
    // succeeding against a lenient fake.
    const responsibleUser = ALL_USERS.find((u) => u.id === body.responsibleUserId);
    if (!responsibleUser || responsibleUser.role !== 'PTO') {
      return { status: 400, body: { message: 'Назначьте активного сотрудника ПТО' } };
    }
    const pkg: FakePackage = {
      id: nextId(state, 'package'),
      objectId: OBJECT_A,
      objectWorkId: body.objectWorkId,
      status: 'DRAFT',
      responsibleUserId: body.responsibleUserId,
      responsible: responsibleUser.name,
      createdBy: state.actor.id,
      version: 1,
    };
    state.packages.push(pkg);
    return { status: 201, body: pkg };
  }

  const statusMatch = path.match(/^\/api\/documentation-packages\/([^/]+)\/status$/);
  if (method === 'POST' && statusMatch) {
    const id = statusMatch[1]!;
    const body = request.postDataJSON() as { status: string; version: number; comment?: string };
    const pkg = state.packages.find((p) => p.id === id)!;
    state.statusHistory.push({
      id: nextId(state, 'history'),
      documentationPackageId: id,
      fromStatus: pkg.status,
      toStatus: body.status,
      changedBy: state.actor.id,
      changedAt: new Date().toISOString(),
      comment: body.comment ?? null,
    });
    pkg.status = body.status;
    pkg.version += 1;
    return { status: 201, body: pkg };
  }

  const portionsMatch = path.match(/^\/api\/documentation-packages\/([^/]+)\/portions$/);
  if (method === 'POST' && portionsMatch) {
    const id = portionsMatch[1]!;
    const body = request.postDataJSON() as { quantityPortionId: string };
    const link: FakeLink = { id: nextId(state, 'link'), documentationPackageId: id, quantityPortionId: body.quantityPortionId };
    state.packagePortions.push(link);
    return { status: 201, body: link };
  }

  const documentsMatch = path.match(/^\/api\/documentation-packages\/([^/]+)\/documents$/);
  if (method === 'POST' && documentsMatch) {
    const id = documentsMatch[1]!;
    const body = request.postDataJSON() as { type: string };
    const doc: FakeDocument = { id: nextId(state, 'document'), documentationPackageId: id, type: body.type, createdBy: state.actor.id };
    state.documents.push(doc);
    return { status: 201, body: doc };
  }

  const versionsMatch = path.match(/^\/api\/documentation-documents\/([^/]+)\/versions$/);
  if (method === 'POST' && versionsMatch) {
    const id = versionsMatch[1]!;
    const body = request.postDataJSON() as { storageProvider: string; storageReference?: string; comment?: string };
    const existing = state.versions.filter((v) => v.documentationDocumentId === id);
    const version: FakeVersion = {
      id: nextId(state, 'version'),
      documentationDocumentId: id,
      versionNumber: existing.length + 1,
      storageProvider: body.storageProvider,
      storageReference: body.storageReference ?? null,
      comment: body.comment ?? null,
      createdBy: state.actor.id,
    };
    state.versions.push(version);
    return { status: 201, body: version };
  }

  return undefined;
}

async function mockApi(page: Page, state: State): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());
      const result = handleApi(state, request.method(), url.pathname, request);
      if (!result) {
        await route.fulfill({ status: 599, contentType: 'text/plain', body: `unexpected ${request.method()} ${url.pathname}` });
        return;
      }
      await route.fulfill({ status: result.status, contentType: 'application/json', body: JSON.stringify(result.body ?? {}) });
    },
  );
}

function draftPackage(): FakePackage {
  return {
    id: 'package-draft',
    objectId: OBJECT_A,
    objectWorkId: WORK_DRAFT,
    status: 'DRAFT',
    responsibleUserId: PTO.id,
    responsible: PTO.name,
    createdBy: PTO.id,
    version: 1,
  };
}

test('P01: the attention queue shows a RED reason + "Создать пакет" for a work with no package, and a YELLOW reason + "Открыть" for one with a DRAFT package', async ({
  page,
}) => {
  const state = makeState(PTO, [draftPackage()]);
  await seedSession(page, 'f8-2-1-browser-token-queue');
  await mockApi(page, state);

  await page.goto('/app.html/pto');
  await expect(page.getByRole('heading', { level: 1, name: 'Операции ПТО' })).toBeVisible();

  const table = page.locator('table', { hasText: 'Очередь ПТО' });
  const rowNew = table.locator('tr', { hasText: 'Устройство кровли' });
  await expect(rowNew).toContainText('🔴');
  await expect(rowNew).toContainText('Нет пакета ИД');
  await expect(rowNew.getByRole('button', { name: 'Создать пакет' })).toBeVisible();

  const rowDraft = table.locator('tr', { hasText: 'Штукатурка стен' });
  await expect(rowDraft).toContainText('🟡');
  await expect(rowDraft).toContainText('Документы формируются');
  await expect(rowDraft.getByRole('button', { name: 'Открыть' })).toBeVisible();
});

test('P01 → package detail: create a package, link a portion, create a document, add a version, advance status — the full PTO flow in one pass', async ({
  page,
}) => {
  const state = makeState(PTO);
  await seedSession(page, 'f8-2-1-browser-token-golden');
  await mockApi(page, state);

  await page.goto('/app.html/pto');
  const table = page.locator('table', { hasText: 'Очередь ПТО' });
  await table.locator('tr', { hasText: 'Устройство кровли' }).getByRole('button', { name: 'Создать пакет' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Устройство кровли' })).toBeVisible();
  await expect(page.getByText('Черновик')).toBeVisible();

  await page.getByLabel('Участок для привязки').selectOption({ label: 'Участок 1' });
  await page.getByRole('button', { name: 'Привязать участок' }).click();
  await expect(page.getByText('Участки ещё не привязаны')).toHaveCount(0);
  await expect(page.getByRole('listitem').filter({ hasText: 'Участок 1' })).toBeVisible();

  await page.getByLabel('Тип документа').selectOption({ label: 'АОСР' });
  await page.getByRole('button', { name: 'Создать документ' }).click();
  await expect(page.locator('span').filter({ hasText: 'АОСР' })).toBeVisible();

  await page.getByRole('button', { name: 'Добавить версию' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'v1' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'Без ссылки на хранилище' })).toBeVisible();

  await page.getByRole('button', { name: 'Начать подготовку' }).click();
  await expect(page.getByText('В подготовке', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Отметить готовность к предъявлению' })).toBeVisible();
});

test('W01: "Создать пакет" creates a package and opens the same package detail screen P01\'s own action opens', async ({
  page,
}) => {
  const state = makeState(PTO);
  await seedSession(page, 'f8-2-1-browser-token-w01-create');
  await mockApi(page, state);

  await page.goto(`/app.html/object/${OBJECT_A}/work/${WORK_NEW}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Устройство кровли' })).toBeVisible();

  const section = page.locator('section', { hasText: 'Исполнительная документация' });
  await expect(section.getByText('Пакет исполнительной документации ещё не создан')).toBeVisible();
  await section.getByRole('button', { name: 'Создать пакет' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Устройство кровли' })).toBeVisible();
  await expect(page.getByText('Черновик')).toBeVisible();
});

test('P01 (Corrective F8.2.1-03): a work with an existing package still offers "Создать ещё один пакет" alongside "Открыть", creating a second, distinct package', async ({
  page,
}) => {
  const state = makeState(PTO, [draftPackage()]);
  await seedSession(page, 'f8-2-1-browser-token-multi-p01');
  await mockApi(page, state);

  await page.goto('/app.html/pto');
  const table = page.locator('table', { hasText: 'Очередь ПТО' });
  const row = table.locator('tr', { hasText: 'Штукатурка стен' });
  await expect(row.getByRole('button', { name: 'Открыть' })).toBeVisible();
  await row.getByRole('button', { name: 'Создать ещё один пакет' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Штукатурка стен' })).toBeVisible();
  await expect(page.getByText('Черновик', { exact: true })).toBeVisible();

  expect(state.packages.length).toBe(2);
  expect(state.packages[0]!.id).not.toBe(state.packages[1]!.id);
  expect(state.packages.every((p) => p.objectWorkId === WORK_DRAFT)).toBe(true);
});

test('W01 (Corrective F8.2.1-03): a work with an existing package still offers "Создать ещё один пакет" alongside "Открыть пакет", creating a second, distinct package', async ({
  page,
}) => {
  const state = makeState(PTO, [draftPackage()]);
  await seedSession(page, 'f8-2-1-browser-token-multi-w01');
  await mockApi(page, state);

  await page.goto(`/app.html/object/${OBJECT_A}/work/${WORK_DRAFT}`);
  const section = page.locator('section', { hasText: 'Исполнительная документация' });
  await expect(section.getByRole('button', { name: 'Открыть пакет' })).toBeVisible();
  await section.getByRole('button', { name: 'Создать ещё один пакет' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Штукатурка стен' })).toBeVisible();
  await expect(page.getByText('Черновик', { exact: true })).toBeVisible();

  expect(state.packages.length).toBe(2);
  expect(state.packages[0]!.id).not.toBe(state.packages[1]!.id);
});

test('P01 (Corrective F8.2.1-04): ADMIN opening the create-package flow sees a PTO-user picker and cannot submit before choosing one — never admin.id', async ({
  page,
}) => {
  const state = makeState(ADMIN);
  await seedSession(page, 'f8-2-1-browser-token-admin-picker');
  await mockApi(page, state);

  await page.goto('/app.html/pto');
  const table = page.locator('table', { hasText: 'Очередь ПТО' });
  const row = table.locator('tr', { hasText: 'Устройство кровли' });

  await expect(row.getByLabel('Ответственный сотрудник ПТО')).toBeVisible();
  await expect(row.getByRole('button', { name: 'Создать пакет' })).toBeDisabled();

  expect(state.packages.length).toBe(0);
});

test('P01 (Corrective F8.2.1-04): ADMIN creates a first package by selecting a PTO responsible user — the package is created for that PTO user, not ADMIN', async ({
  page,
}) => {
  const state = makeState(ADMIN);
  await seedSession(page, 'f8-2-1-browser-token-admin-first');
  await mockApi(page, state);

  await page.goto('/app.html/pto');
  const table = page.locator('table', { hasText: 'Очередь ПТО' });
  const row = table.locator('tr', { hasText: 'Устройство кровли' });

  await row.getByLabel('Ответственный сотрудник ПТО').selectOption({ label: PTO_USER_2.name });
  await row.getByRole('button', { name: 'Создать пакет' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Устройство кровли' })).toBeVisible();
  await expect(page.getByText('Черновик', { exact: true })).toBeVisible();
  await expect(page.getByText(PTO_USER_2.name)).toBeVisible();

  expect(state.packages.length).toBe(1);
  expect(state.packages[0]!.responsibleUserId).toBe(PTO_USER_2.id);
  expect(state.packages[0]!.responsibleUserId).not.toBe(ADMIN.id);
});

test('P01 (Corrective F8.2.1-04): ADMIN creates a second package for a work that already has one, again by selecting a PTO responsible user', async ({
  page,
}) => {
  const state = makeState(ADMIN, [draftPackage()]);
  await seedSession(page, 'f8-2-1-browser-token-admin-second');
  await mockApi(page, state);

  await page.goto('/app.html/pto');
  const table = page.locator('table', { hasText: 'Очередь ПТО' });
  const row = table.locator('tr', { hasText: 'Штукатурка стен' });

  await expect(row.getByRole('button', { name: 'Открыть' })).toBeVisible();
  await row.getByLabel('Ответственный сотрудник ПТО').selectOption({ label: PTO_USER_2.name });
  await row.getByRole('button', { name: 'Создать ещё один пакет' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Штукатурка стен' })).toBeVisible();
  await expect(page.getByText('Черновик', { exact: true })).toBeVisible();

  expect(state.packages.length).toBe(2);
  expect(state.packages[0]!.id).not.toBe(state.packages[1]!.id);
  const second = state.packages.find((p) => p.id !== 'package-draft')!;
  expect(second.responsibleUserId).toBe(PTO_USER_2.id);
  expect(second.responsibleUserId).not.toBe(ADMIN.id);
});

test('W01 (Corrective F8.2.1-04): ADMIN also sees the PTO-user picker there, the same shared flow P01 uses (Decision 1), and never submits admin.id', async ({
  page,
}) => {
  const state = makeState(ADMIN);
  await seedSession(page, 'f8-2-1-browser-token-admin-w01');
  await mockApi(page, state);

  await page.goto(`/app.html/object/${OBJECT_A}/work/${WORK_NEW}`);
  const section = page.locator('section', { hasText: 'Исполнительная документация' });

  await expect(section.getByLabel('Ответственный сотрудник ПТО')).toBeVisible();
  await expect(section.getByRole('button', { name: 'Создать пакет' })).toBeDisabled();
  expect(state.packages.length).toBe(0);

  await section.getByLabel('Ответственный сотрудник ПТО').selectOption({ label: PTO_USER_2.name });
  await section.getByRole('button', { name: 'Создать пакет' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Устройство кровли' })).toBeVisible();
  await expect(page.getByText('Черновик', { exact: true })).toBeVisible();

  expect(state.packages.length).toBe(1);
  expect(state.packages[0]!.responsibleUserId).toBe(PTO_USER_2.id);
  expect(state.packages[0]!.responsibleUserId).not.toBe(ADMIN.id);
});

test('Role visibility (Corrective F8.2.1-02): RP has no "ПТО" nav item and no workspace access, but its W01 documentation visibility is completely unchanged', async ({
  page,
}) => {
  const state = makeState(RP, [draftPackage()]);
  await seedSession(page, 'f8-2-1-browser-token-rp');
  await mockApi(page, state);

  // W01 read visibility (Decision Lock's own explicit "do not remove"):
  // status, responsible, no action buttons — the same as before this patch.
  await page.goto(`/app.html/object/${OBJECT_A}/work/${WORK_DRAFT}`);
  const section = page.locator('section', { hasText: 'Исполнительная документация' });
  await expect(section.getByText('Черновик')).toBeVisible();
  await expect(section.getByRole('button')).toHaveCount(0);

  // The PTO Workspace itself is PTO's own working area, not RP's — no nav
  // item, and direct navigation names whose workspace this is rather than
  // rendering the table or an "access denied" message (RP does have
  // documentation access, just not to this specific workspace).
  await expect(page.getByRole('button', { name: 'ПТО' })).toHaveCount(0);
  await page.goto('/app.html/pto');
  await expect(page.getByText('Раздел «ПТО» — рабочая область ПТО.', { exact: false })).toBeVisible();
  await expect(page.locator('table', { hasText: 'Очередь ПТО' })).toHaveCount(0);

  await page.goto(`/app.html/pto/package/${draftPackage().id}`);
  await expect(page.getByText('Раздел «ПТО» — рабочая область ПТО.', { exact: false })).toBeVisible();
});

test('Role visibility (Corrective F8.2.1-02): SC (CONSTRUCTION_CONTROL) also has no PTO Workspace access, with the same W01 visibility preserved', async ({
  page,
}) => {
  const SC = { id: 'u-sc', tenantId: 't-1', name: 'Строганов Контролёв', role: 'CONSTRUCTION_CONTROL' };
  const state = makeState(SC, [draftPackage()]);
  await seedSession(page, 'f8-2-1-browser-token-sc');
  await mockApi(page, state);

  await page.goto(`/app.html/object/${OBJECT_A}/work/${WORK_DRAFT}`);
  const section = page.locator('section', { hasText: 'Исполнительная документация' });
  await expect(section.getByText('Черновик')).toBeVisible();
  await expect(section.getByRole('button')).toHaveCount(0);

  await expect(page.getByRole('button', { name: 'ПТО' })).toHaveCount(0);
  await page.goto('/app.html/pto');
  await expect(page.getByText('Раздел «ПТО» — рабочая область ПТО.', { exact: false })).toBeVisible();
});

test('Role visibility: SDO has no "ПТО" nav item, and direct navigation to /pto or a work\'s documentation section shows an explicit no-access state, never an empty or misleading one', async ({
  page,
}) => {
  const state = makeState(SDO, [draftPackage()]);
  await seedSession(page, 'f8-2-1-browser-token-sdo');
  await mockApi(page, state);

  await page.goto(`/app.html/object/${OBJECT_A}/work/${WORK_DRAFT}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Штукатурка стен' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ПТО' })).toHaveCount(0);

  const section = page.locator('section', { hasText: 'Исполнительная документация' });
  await expect(section.getByText('Раздел недоступен для вашей роли')).toBeVisible();
  await expect(section.getByText('Пакет исполнительной документации ещё не создан')).toHaveCount(0);

  await page.goto('/app.html/pto');
  await expect(page.getByText('У вас нет доступа к разделу «ПТО».')).toBeVisible();
});
