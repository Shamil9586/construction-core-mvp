import { test, expect, type Page, type Route, type Request } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/**
 * FIN-SDO-1 frontend/browser acceptance smoke. The real application and Design
 * System render in Chromium; FIN endpoints and session are INTERCEPTED in-memory.
 * This is NOT a PostgreSQL, backend, security or LIVE end-to-end test: tenant
 * isolation, RBAC enforcement, CAS and idempotency are proved by the native
 * protected FIN scripts. The mock mirrors the protected API contract (status +
 * `{statusCode,message:<FIN code>}` body) so the UI's handling of it is real.
 * Every test also asserts that the browser never left 127.0.0.1:5173 and that
 * every /api request was answered by the mock (none reached the Vite proxy).
 */
const ORIGIN = 'http://127.0.0.1:5173';
const CORE = '00000000-0000-4000-8000-000000000101';
const HIST = '00000000-0000-4000-8000-000000000102';
const PARTY = '00000000-0000-4000-8000-000000000103';
const CORE2 = '00000000-0000-4000-8000-000000000104';
const WRITE_ROLES = ['SDO', 'SDO_HEAD', 'ADMIN'];
const READ_ROLES = [...WRITE_ROLES, 'GENERAL_DIRECTOR', 'DEPUTY_DIRECTOR'];
const DENIED_ROLES = ['PTO', 'PTO_HEAD', 'PROJECT_MANAGER', 'CONSTRUCTION_CONTROL', 'CONSTRUCTION_CONTROL_HEAD', 'CONTRACTOR_VIEWER', 'UNKNOWN_ROLE'];
/** The only FIN-SDO-1 API surface; anything else (customer/AGREED/override/attribution/export) must never be called. */
const FIN1_PATHS = [/^\/api\/fin-sdo-1\/subjects$/, /^\/api\/fin-sdo-1\/quarter$/, /^\/api\/fin-sdo-1\/buffers(\/[0-9a-f-]{36})?$/,
  /^\/api\/fin-sdo-1\/commit$/, /^\/api\/fin-sdo-1\/historical-subjects$/, /^\/api\/fin-sdo-1\/historical-parties$/];
const actor = (role: string) => ({ id: 'u-' + role, tenantId: 'tenant-fin-browser', name: 'Тест ' + role, role });

type DraftLine = {
  coreObjectId?: string; historicalSubjectId?: string;
  partyKind: 'UNALLOCATED' | 'HISTORICAL_PARTY' | 'CORE_CONTRACTOR';
  partyId?: string; contractKind: 'NOT_SPECIFIED' | 'KNOWN';
  contractNumber?: string; amountMln: string;
};
type Draft = { id: string; year: number; quarter: number; version: number; expectedBookVersion: number; lines: DraftLine[] };
type BookLine = { id: string; createdIn: number; line: DraftLine; revisions: Array<{ rev: number; amountRub: string }> };
type Revision = { revision_no: number; previous_total_rub: string | null; new_total_rub: string; reason: string | null; actor_id: string; effective_on: string; recorded_at: string };
type Fault = { method: string; path: string; status?: number; message?: string; abortAfterApply?: boolean; times?: number };
type Call = { method: string; path: string; body: any; status: number };
type FinState = {
  role: string; calls: Call[]; drafts: Draft[]; version: number; history: Revision[]; lines: BookLine[];
  ledger: Map<string, { fp: string; result: unknown }>; faults: Fault[]; unmocked: string[];
};

const CANONICAL = /^(?:0|[1-9]\d{0,13})\.\d{2}$/;
const kopecks = (mln: string) => { const [w, f] = mln.split('.'); return (BigInt(w) * 100n + BigInt(f)) * 1_000_000n; };
const rub = (k: bigint) => (k / 100n).toString() + '.' + (k % 100n).toString().padStart(2, '0');
const sumRub = (lines: DraftLine[]) => rub(lines.reduce((s, l) => s + kopecks(l.amountMln), 0n));
const lineKey = (l: DraftLine) => [l.coreObjectId ?? '', l.historicalSubjectId ?? '', l.partyKind, l.partyId ?? '', l.contractKind, l.contractNumber ?? ''].join('|');
const lineAt = (b: BookLine, rev: number) => [...b.revisions].reverse().find(r => r.rev <= rev);

function projection(state: FinState) {
  const head = state.version;
  return state.lines.filter(b => lineAt(b, head)).map(b => ({
    id: b.id, origin: b.line.coreObjectId ? 'CORE' : 'HISTORICAL', created_in_book_revision: b.createdIn,
    core_object_id: b.line.coreObjectId ?? null, historical_subject_id: b.line.historicalSubjectId ?? null,
    party_kind: b.line.partyKind,
    core_contractor_id: b.line.partyKind === 'CORE_CONTRACTOR' ? b.line.partyId : null,
    historical_party_id: b.line.partyKind === 'HISTORICAL_PARTY' ? b.line.partyId : null,
    contract_kind: b.line.contractKind, contract_number: b.line.contractNumber ?? null,
    amount_rub: lineAt(b, head)!.amountRub,
    original_amount_rub: b.createdIn === 1 ? b.revisions[0].amountRub : null,
  }));
}
/** Applies a committed revision exactly like the protected SQL command (server-side SUM, append-only history). */
function applyRevision(state: FinState, lines: DraftLine[], actorId: string, reason: string | null, effectiveOn: string) {
  const revision = state.version + 1, total = sumRub(lines);
  const previous = state.history.at(-1)?.new_total_rub ?? null;
  for (const l of lines) {
    let b = state.lines.find(x => lineKey(x.line) === lineKey(l));
    if (!b) { b = { id: randomUUID(), createdIn: revision, line: l, revisions: [] }; state.lines.push(b); }
    const now = lineAt(b, state.version);
    if (!now || now.amountRub !== rub(kopecks(l.amountMln))) b.revisions.push({ rev: revision, amountRub: rub(kopecks(l.amountMln)) });
  }
  state.history.push({ revision_no: revision, previous_total_rub: previous, new_total_rub: total, reason, actor_id: actorId,
    effective_on: effectiveOn, recorded_at: new Date(Date.UTC(2026, 9, 25 + revision, 9, 0)).toISOString() });
  state.version = revision;
  return { bookId: 'book-1', bookVersion: revision, revisionNo: revision, totalRub: total };
}
const SIX: DraftLine = { coreObjectId: CORE, partyKind: 'UNALLOCATED', contractKind: 'NOT_SPECIFIED', amountMln: '6.00' };
const FOUR: DraftLine = { historicalSubjectId: HIST, partyKind: 'HISTORICAL_PARTY', partyId: PARTY, contractKind: 'KNOWN', contractNumber: 'ДС-1', amountMln: '4.00' };
function fixture(role: string, initialActive = false): FinState {
  const state: FinState = { role, calls: [], drafts: [], version: 0, history: [], lines: [], ledger: new Map(), faults: [], unmocked: [] };
  if (initialActive) applyRevision(state, [SIX, FOUR], 'u-SDO', null, '2026-10-25');
  return state;
}

const seenRequests: string[] = [];
const states: FinState[] = [];
test.beforeEach(() => { seenRequests.length = 0; states.length = 0; });
test.afterEach(async ({}, testInfo) => {
  const foreign = seenRequests.filter(u => !u.startsWith(ORIGIN + '/') && !/^(data|blob|about):/.test(u));
  expect(foreign, 'no request may leave the local Vite origin (no LIVE / remote backend)').toEqual([]);
  for (const s of states) {
    expect(s.unmocked, 'every /api request must be answered by the FIN mock, never the Vite proxy').toEqual([]);
    const outside = s.calls.filter(c => c.path.startsWith('/api/fin') && !FIN1_PATHS.some(p => p.test(c.path)));
    expect(outside, 'no FIN-SDO-2/3 or unknown financial endpoint is called').toEqual([]);
  }
  await testInfo.attach('fin-api-calls.json', { body: JSON.stringify(states.map(s => s.calls), null, 1), contentType: 'application/json' });
});

async function harness(page: Page, state: FinState) {
  states.push(state);
  page.on('request', (r: Request) => seenRequests.push(r.url()));
  await page.addInitScript(() => window.sessionStorage.setItem('session', 'fin-browser-valid-token'));
  await page.route(u => u.pathname.startsWith('/api/'), async (route: Route) => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname, m = req.method();
    const body = ['POST', 'PATCH', 'PUT'].includes(m) ? req.postDataJSON() : null;
    const role = state.role, canRead = READ_ROLES.includes(role), canWrite = WRITE_ROLES.includes(role);
    let code = 200; let payload: any = {}; let abort = false;
    const fail = (status: number, message: string) => { code = status; payload = { statusCode: status, message, requestId: 'mock' }; };
    const fault = state.faults.find(f => f.method === m && f.path === p && (f.times ?? 1) > 0);
    if (fault) fault.times = (fault.times ?? 1) - 1;
    if (p === '/api/me') payload = actor(role);
    else if (p === '/api/snapshot') payload = { objects: [], works: [], contractors: [], dependencies: [], inspections: [] };
    else if (p === '/api/health') payload = { status: 'ok', authMode: 'bitrix', databaseMode: 'postgres' };
    else if (p.startsWith('/api/fin-sdo-1/') && !canRead) fail(403, 'FIN_ACCESS_DENIED');
    else if (fault && !fault.abortAfterApply) fail(fault.status ?? 500, fault.message ?? 'Внутренняя ошибка');
    else if (p === '/api/fin-sdo-1/subjects') payload = {
      core: [{ id: CORE, name: 'Объект CORE без СМР', status: 'ACTIVE' }, { id: CORE2, name: 'Архивный объект CORE', status: 'ARCHIVED' }],
      historical: [{ id: HIST, name: 'Исторический объект' }],
      contractors: [], historicalParties: [{ id: PARTY, name: 'Исторический субподрядчик' }],
    };
    else if (p === '/api/fin-sdo-1/quarter') payload = state.version === 0
      ? { status: 'NO_PLAN', year: 2026, quarter: 1, currencyCode: 'RUB', history: [], lines: [], original: null, current: null }
      : { status: 'ACTIVE', bookVersion: state.version, revisionNo: state.version, year: 2026, quarter: 1, currencyCode: 'RUB',
          original: state.history[0].new_total_rub, current: state.history.at(-1)!.new_total_rub, history: state.history, lines: projection(state) };
    else if (!canWrite) fail(403, 'FIN_ACCESS_DENIED');
    else if (p === '/api/fin-sdo-1/buffers' && m === 'GET') payload = state.drafts.map(x => ({
      id: x.id, version: x.version, expected_book_version: x.expectedBookVersion, total_rub: sumRub(x.lines), line_count: x.lines.length }));
    else if (p === '/api/fin-sdo-1/buffers' || /^\/api\/fin-sdo-1\/buffers\/[^/]+$/.test(p)) {
      const id = p.split('/').at(-1)!, d = state.drafts.find(x => x.id === id);
      const bad = body?.lines?.findIndex((l: DraftLine) => !CANONICAL.test(l.amountMln));
      if (m !== 'GET' && (!Array.isArray(body?.lines) || !body.lines.length)) fail(400, 'lines: Too small');
      else if (m !== 'GET' && bad >= 0) fail(400, 'lines.' + bad + '.amountMln: Invalid string: must match pattern');
      else if (m === 'POST') {
        if (body.expectedBookVersion !== state.version) fail(409, 'FIN_QUARTER_BOOK_VERSION_CONFLICT');
        else {
          const x: Draft = { id: randomUUID(), year: body.year, quarter: body.quarter, version: 1, expectedBookVersion: body.expectedBookVersion, lines: body.lines };
          state.drafts.push(x); payload = { bufferId: x.id, version: 1, uncommitted: true, totalRub: sumRub(x.lines) };
        }
      }
      else if (!d) fail(403, 'FIN_ACCESS_DENIED');
      else if (m === 'GET') payload = { buffer: { id: d.id, version: d.version, plan_year: d.year, plan_quarter: d.quarter, expected_book_version: d.expectedBookVersion },
        lines: d.lines.map((x, i) => ({ id: 'draft-' + i, core_object_id: x.coreObjectId ?? null, historical_subject_id: x.historicalSubjectId ?? null,
          party_kind: x.partyKind, core_contractor_id: x.partyKind === 'CORE_CONTRACTOR' ? x.partyId : null,
          historical_party_id: x.partyKind === 'HISTORICAL_PARTY' ? x.partyId : null, contract_kind: x.contractKind,
          contract_number: x.contractNumber ?? null, amount_rub: rub(kopecks(x.amountMln)) })) };
      else if (m === 'PATCH') {
        if (body.expectedBufferVersion !== d.version) fail(409, 'FIN_BUFFER_CAS_CONFLICT');
        else if (body.expectedBookVersion !== d.expectedBookVersion) fail(422, 'FIN_BUFFER_QUARTER_MISMATCH');
        else { d.lines = body.lines; d.version++; payload = { bufferId: d.id, version: d.version, uncommitted: true, totalRub: sumRub(d.lines) }; }
      }
    }
    else if (p === '/api/fin-sdo-1/commit' && m === 'POST') {
      const fp = JSON.stringify({ ...body, idempotencyKey: undefined }), prior = state.ledger.get(body.idempotencyKey);
      const d = state.drafts.find(x => x.id === body.bufferId);
      if (prior) { if (prior.fp !== fp) fail(409, 'FIN_IDEMPOTENCY_PAYLOAD_MISMATCH'); else payload = prior.result; }
      else if (!d) fail(403, 'FIN_ACCESS_DENIED');
      else if (body.expectedBufferVersion !== d.version) fail(409, 'FIN_BUFFER_CAS_CONFLICT');
      else if (body.expectedBookVersion !== d.expectedBookVersion) fail(409, 'FIN_BUFFER_VERSION_CONFLICT');
      else if (body.expectedBookVersion > 0 && !String(body.reason ?? '').trim()) fail(422, 'FIN_CORRECTION_REASON_REQUIRED');
      else if (BigInt(sumRub(d.lines).replace('.', '')) < 1_000_000_000n) fail(422, 'FIN_QUARTER_TOTAL_BELOW_MIN');
      else if (state.version !== body.expectedBookVersion) fail(409, 'FIN_QUARTER_BOOK_VERSION_CONFLICT');
      else if (state.lines.some(b => lineAt(b, state.version) && !d.lines.some(l => lineKey(l) === lineKey(b.line)))) fail(422, 'FIN_EXISTING_LINE_OMITTED');
      else {
        payload = applyRevision(state, d.lines, 'u-' + role, body.reason ?? null, body.effectiveOn);
        state.ledger.set(body.idempotencyKey, { fp, result: payload });
        if (fault?.abortAfterApply) abort = true;
      }
    }
    else if (p === '/api/fin-sdo-1/historical-subjects' && m === 'POST') payload = { id: randomUUID(), name: body.name, origin: 'HISTORICAL' };
    else if (p === '/api/fin-sdo-1/historical-parties' && m === 'POST') payload = { id: randomUUID(), name: body.name };
    else { state.unmocked.push(m + ' ' + p); fail(599, 'Unmocked ' + m + ' ' + p); }
    state.calls.push({ method: m, path: p, body, status: abort ? -1 : code });
    if (abort) return route.abort('connectionreset');
    await route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(payload) });
  });
}

const finCalls = (s: FinState) => s.calls.filter(c => c.path.startsWith('/api/fin-sdo-1/'));
const commits = (s: FinState) => s.calls.filter(c => c.path === '/api/fin-sdo-1/commit');
async function open(page: Page, state: FinState) {
  await harness(page, state);
  await page.goto('/app.html/sdo/plan');
  await expect(page.getByRole('heading', { level: 1, name: 'СДО · План закрытия' })).toBeVisible();
}
async function addLine(page: Page, subject: string, amount: string) {
  const n = await page.getByLabel('Сумма млн ₽').count();
  await page.getByRole('button', { name: 'Добавить строку' }).click();
  await page.getByLabel('Объект').nth(n).selectOption(subject);
  await page.getByLabel('Сумма млн ₽').nth(n).fill(amount);
}
const status = (page: Page) => page.getByRole('status');
const alert = (page: Page) => page.getByRole('alert');
const commitButton = (page: Page) => page.getByRole('button', { name: 'Записать квартальный план' });
const saveButton = (page: Page) => page.getByRole('button', { name: 'Сохранить незавершённый ввод' });
const summary = (page: Page) => page.getByTestId('fin-book-summary');

test('B01 SDO: 6.00 draft, resumed 6.00+4.00, one commit creates original 10,00 with expectedBufferVersion', async ({ page }, testInfo) => {
  const state = fixture('SDO');
  await open(page, state);
  await expect(page.getByText('План ещё не записан (NO_PLAN).', { exact: false })).toBeVisible();
  await addLine(page, 'c:' + CORE, '6.00');
  await expect(page.getByText('ниже порога 10,00 млн ₽', { exact: false })).toBeVisible();
  await expect(commitButton(page)).toBeDisabled();
  await saveButton(page).click();
  await expect(status(page)).toContainText('Технический ввод сохранён');
  // A saved technical buffer is NOT a quarter book: management view still says NO_PLAN.
  await expect(page.getByText('План ещё не записан (NO_PLAN).', { exact: false })).toBeVisible();
  expect(state.version).toBe(0);
  await addLine(page, 'h:' + HIST, '4.00');
  await expect(page.getByTestId('fin-input-total')).toHaveText('10,00 млн ₽');
  await saveButton(page).click();
  await expect(status(page)).toContainText('Технический ввод сохранён');
  expect(state.drafts).toHaveLength(1);
  expect(state.drafts[0].lines.map(l => l.amountMln)).toEqual(['6.00', '4.00']);
  expect(state.version).toBe(0);
  await expect(page.getByText('План ещё не записан (NO_PLAN).', { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('b01-before-commit.png'), fullPage: true });
  await expect(commitButton(page)).toBeEnabled();
  await commitButton(page).click();
  await expect(status(page)).toHaveText('Новая действующая версия квартального плана записана.');
  await expect(summary(page)).toContainText('Первоначальный: 10,00 млн ₽');
  await expect(summary(page)).toContainText('Текущий: 10,00 млн ₽');
  expect(state.history).toHaveLength(1);
  expect(commits(state)).toHaveLength(1);
  expect(commits(state)[0].body).toMatchObject({ year: state.drafts[0].year, expectedBookVersion: 0, expectedBufferVersion: 2, bufferId: state.drafts[0].id });
  expect(commits(state)[0].body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'План по объектам, исполнителям и договорам' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('b01-after-commit.png'), fullPage: true });
});

test('B02 SDO: 9.99 is a private draft; commit stays disabled; no book, no customer/AGREED controls', async ({ page }, testInfo) => {
  const state = fixture('SDO');
  await open(page, state);
  await addLine(page, 'c:' + CORE, '9.99');
  await saveButton(page).click();
  await expect(status(page)).toContainText('Технический ввод сохранён');
  await expect(commitButton(page)).toBeDisabled();
  await expect(page.getByText('ниже порога 10,00 млн ₽', { exact: false })).toBeVisible();
  await expect(page.getByText('не хватает 0,01 млн ₽', { exact: false })).toBeVisible();
  expect(state.version).toBe(0);
  expect(commits(state)).toHaveLength(0);
  await expect(page.getByText('План ещё не записан (NO_PLAN).', { exact: false })).toBeVisible();
  await expect(page.getByText('Финансовый факт заказчика сюда не включён.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: /Утверд|Согласова|AGREED|Финансовый факт|Экспорт|XLSX/ })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('b02-below-min.png'), fullPage: true });
});

for (const role of ['GENERAL_DIRECTOR', 'DEPUTY_DIRECTOR']) {
  test(`B03 ${role}: reads original/current/history read-only; no buffer or write call`, async ({ page }, testInfo) => {
    const state = fixture(role, true);
    applyRevision(state, [{ ...SIX, amountMln: '6.50' }, FOUR], 'u-SDO', 'Уточнение объёма', '2026-10-26');
    await open(page, state);
    await expect(summary(page)).toContainText('Первоначальный: 10,00 млн ₽');
    await expect(summary(page)).toContainText('Текущий: 10,50 млн ₽');
    await expect(page.getByRole('button', { name: 'Добавить строку' })).toHaveCount(0);
    await expect(commitButton(page)).toHaveCount(0);
    await expect(saveButton(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Создать исторический|Добавить исполнителя|Продолжить/ })).toHaveCount(0);
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await page.getByRole('button', { name: /История изменений/ }).click();
    const history = page.getByRole('table', { name: 'История изменений квартального плана' });
    await expect(history).toContainText('10 000 000,00');
    await expect(history).toContainText('Уточнение объёма');
    await expect(history.getByRole('row').nth(2)).toContainText('10,00');
    await expect(history.getByRole('row').nth(2)).toContainText('10,50');
    expect(state.calls.some(x => x.path.startsWith('/api/fin-sdo-1/buffers'))).toBe(false);
    expect(state.calls.filter(x => x.method !== 'GET')).toHaveLength(0);
    await page.screenshot({ path: testInfo.outputPath('b03-' + role + '.png'), fullPage: true });
  });
}

test('B03 denied roles: PTO, PTO_HEAD, PM, SC, SC_HEAD, contractor and unknown get no FIN values, controls or FIN HTTP', async ({ browser }, testInfo) => {
  for (const role of DENIED_ROLES) {
    const page = await browser.newPage();
    try {
      const state = fixture(role, true);
      await harness(page, state);
      await page.goto('/app.html/sdo/plan');
      // CONTRACTOR_VIEWER and an unknown role are stopped earlier by the app-wide gate; every other role by the FIN route guard.
      if (role === 'CONTRACTOR_VIEWER' || role === 'UNKNOWN_ROLE') await expect(page.getByRole('heading', { name: 'Внутреннее приложение недоступно' })).toBeVisible();
      else await expect(page.getByText('Финансовые планы недоступны для вашей роли.')).toBeVisible();
      await expect(page.getByText(/млн ₽|10,00|10\.00|10 000 000/)).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'План закрытия', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Записать|Сохранить|Добавить строку/ })).toHaveCount(0);
      expect(finCalls(state), role + ' must not call FIN HTTP').toHaveLength(0);
      if (role === 'PTO') await page.screenshot({ path: testInfo.outputPath('b03-denied-PTO.png'), fullPage: true });
    } finally { await page.close(); }
  }
});

test('B04 exact money: 10.00 / 10.50 / 25.75 / 120.00 and 9.99+0.01 commit with exact RUB and 2-decimal display; comma input accepted', async ({ browser }) => {
  const cases: Array<{ inputs: string[]; mln: string; rub: string }> = [
    { inputs: ['10.00'], mln: '10,00', rub: '10000000.00' },
    { inputs: ['10,50'], mln: '10,50', rub: '10500000.00' },
    { inputs: ['25,75'], mln: '25,75', rub: '25750000.00' },
    { inputs: ['120.00'], mln: '120,00', rub: '120000000.00' },
    { inputs: ['9,99', '0.01'], mln: '10,00', rub: '10000000.00' },
  ];
  for (const c of cases) {
    const page = await browser.newPage();
    try {
      const state = fixture('SDO_HEAD');
      await open(page, state);
      await addLine(page, 'c:' + CORE, c.inputs[0]);
      if (c.inputs[1]) await addLine(page, 'h:' + HIST, c.inputs[1]);
      await expect(page.getByTestId('fin-input-total')).toHaveText(c.mln + ' млн ₽');
      await saveButton(page).click();
      await expect(status(page)).toContainText('Технический ввод сохранён');
      expect(state.drafts[0].lines.map(l => l.amountMln)).toEqual(c.inputs.map(v => v.replace(',', '.')));
      await commitButton(page).click();
      await expect(status(page)).toHaveText('Новая действующая версия квартального плана записана.');
      expect(state.history[0].new_total_rub).toBe(c.rub);
      await expect(summary(page)).toContainText('Первоначальный: ' + c.mln + ' млн ₽');
    } finally { await page.close(); }
  }
});

test('B05 invalid money is blocked in the browser and never sent: 10.001, -1.00, 1e7, text, empty; 0.00 alone is below minimum', async ({ page }) => {
  const state = fixture('SDO');
  await open(page, state);
  await addLine(page, 'c:' + CORE, '10.00');
  for (const bad of ['10.001', '-1.00', '1e7', 'десять', '', '10']) {
    await page.getByLabel('Сумма млн ₽').first().fill(bad);
    await expect(page.getByTestId('fin-input-total')).toHaveText('—');
    await expect(alert(page)).toContainText('ровно два знака');
    await expect(saveButton(page)).toBeDisabled();
    await expect(commitButton(page)).toBeDisabled();
  }
  await page.getByLabel('Сумма млн ₽').first().fill('0.00');
  await expect(page.getByTestId('fin-input-total')).toHaveText('0,00 млн ₽');
  await expect(commitButton(page)).toBeDisabled();
  expect(state.calls.filter(c => c.method !== 'GET')).toHaveLength(0);
});

test('B06 correction: reason required, history previous→new, late 0.00 line has no original, ≥10 floor kept', async ({ page }, testInfo) => {
  const state = fixture('SDO', true);
  await open(page, state);
  await expect(summary(page)).toContainText('Первоначальный: 10,00 млн ₽');
  await page.getByLabel('Сумма млн ₽').first().fill('6.50');
  await saveButton(page).click();
  await expect(status(page)).toContainText('Технический ввод сохранён');
  await expect(commitButton(page)).toBeDisabled();
  await expect(page.getByText('Для корректировки укажите причину', { exact: false })).toBeVisible();
  await page.getByLabel('Причина корректировки').fill('Уточнение объёма');
  await commitButton(page).click();
  await expect(status(page)).toHaveText('Новая действующая версия квартального плана записана.');
  await expect(summary(page)).toContainText('Первоначальный: 10,00 млн ₽');
  await expect(summary(page)).toContainText('Текущий: 10,50 млн ₽');
  expect(commits(state).at(-1)!.body).toMatchObject({ expectedBookVersion: 1, reason: 'Уточнение объёма' });
  // Third revision adds a late explicit 0.00 line: allowed because the quarter total stays ≥ 10.00.
  await addLine(page, 'c:' + CORE2, '0.00');
  await saveButton(page).click();
  await expect(status(page)).toContainText('Технический ввод сохранён');
  await page.getByLabel('Причина корректировки').fill('Новый объект без суммы');
  await commitButton(page).click();
  await expect(status(page)).toHaveText('Новая действующая версия квартального плана записана.');
  const plan = page.getByRole('table', { name: 'Действующий квартальный план по строкам' });
  const late = plan.getByRole('row').filter({ hasText: 'Архивный объект CORE' });
  await expect(late.getByRole('cell').nth(3)).toHaveText('—');
  await expect(late.getByRole('cell').nth(4)).toHaveText('0,00');
  await expect(summary(page)).toContainText('Первоначальный: 10,00 млн ₽');
  // Reducing the quarter below 10.00 is blocked before any HTTP call.
  await page.getByLabel('Сумма млн ₽').first().fill('5.99');
  await expect(commitButton(page)).toBeDisabled();
  await page.getByRole('button', { name: /История изменений/ }).click();
  const history = page.getByRole('table', { name: 'История изменений квартального плана' });
  await expect(history.getByRole('row')).toHaveCount(4);
  await expect(history.getByRole('row').nth(2)).toContainText('Уточнение объёма');
  await expect(history.getByRole('row').nth(1)).toContainText('Первоначальный план');
  expect(state.history.map(h => h.new_total_rub)).toEqual(['10000000.00', '10500000.00', '10500000.00']);
  await page.screenshot({ path: testInfo.outputPath('b06-corrections-history.png'), fullPage: true });
});

test('B07 restore own buffer; 409 on stale book version re-reads head, keeps input, no success, no silent rebase', async ({ page }, testInfo) => {
  const state = fixture('SDO');
  await open(page, state);
  await addLine(page, 'c:' + CORE, '6.00');
  await addLine(page, 'h:' + HIST, '4.00');
  await saveButton(page).click();
  await expect(status(page)).toContainText('Технический ввод сохранён');
  await page.reload();
  await expect(page.getByLabel('Сумма млн ₽')).toHaveCount(0);
  await page.getByRole('button', { name: /Продолжить 2 стр\. \/ 10,00 млн ₽/ }).click();
  await expect(status(page)).toContainText('Технический ввод восстановлен');
  await expect(page.getByLabel('Сумма млн ₽')).toHaveCount(2);
  await expect(page.getByTestId('fin-input-total')).toHaveText('10,00 млн ₽');
  // Meanwhile another SDO records the quarter (version 0 → 1).
  applyRevision(state, [{ ...SIX, amountMln: '12.00' }], 'u-OTHER', null, '2026-10-26');
  await commitButton(page).click();
  await expect(alert(page)).toContainText('FIN_QUARTER_BOOK_VERSION_CONFLICT');
  await expect(alert(page)).toContainText('изменён');
  await expect(status(page)).toHaveCount(0);
  await expect(summary(page)).toContainText('Текущий: 12,00 млн ₽');
  await expect(page.getByLabel('Сумма млн ₽')).toHaveCount(2);
  await expect(page.getByLabel('Сумма млн ₽').nth(1)).toHaveValue('4.00');
  await expect(commitButton(page)).toBeDisabled();
  expect(commits(state)).toHaveLength(1);
  expect(state.history).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath('b07-stale-409.png'), fullPage: true });
});

test('B07b buffer CAS: stale buffer version from another tab is a visible 409, not an overwrite', async ({ page }) => {
  const state = fixture('SDO');
  await open(page, state);
  await addLine(page, 'c:' + CORE, '6.00');
  await saveButton(page).click();
  await expect(status(page)).toContainText('Технический ввод сохранён');
  state.drafts[0].version = 5; // saved concurrently in another tab
  await page.getByLabel('Сумма млн ₽').first().fill('11.00');
  await saveButton(page).click();
  await expect(alert(page)).toContainText('FIN_BUFFER_CAS_CONFLICT');
  await expect(status(page)).toHaveCount(0);
  expect(state.drafts[0].lines[0].amountMln).toBe('6.00');
  await expect(commitButton(page)).toBeDisabled();
});

test('B08 HTTP failures are visible and never reported as a recorded plan (500, 422 below-min, 403)', async ({ page }) => {
  const state = fixture('SDO');
  await open(page, state);
  await addLine(page, 'c:' + CORE, '10.00');
  await saveButton(page).click();
  await expect(status(page)).toContainText('Технический ввод сохранён');
  state.faults.push({ method: 'POST', path: '/api/fin-sdo-1/commit', status: 500, message: 'Внутренняя ошибка' });
  await commitButton(page).click();
  await expect(alert(page)).toContainText('не записан');
  await expect(status(page)).toHaveCount(0);
  await expect(page.getByText('План ещё не записан (NO_PLAN).', { exact: false })).toBeVisible();
  state.faults.push({ method: 'POST', path: '/api/fin-sdo-1/commit', status: 422, message: 'FIN_QUARTER_TOTAL_BELOW_MIN' });
  await commitButton(page).click();
  await expect(alert(page)).toContainText('FIN_QUARTER_TOTAL_BELOW_MIN');
  await expect(alert(page)).toContainText('10,00 млн ₽');
  await expect(status(page)).toHaveCount(0);
  state.faults.push({ method: 'POST', path: '/api/fin-sdo-1/commit', status: 403, message: 'FIN_ACCESS_DENIED' });
  await commitButton(page).click();
  await expect(alert(page)).toContainText('Нет прав');
  expect(state.version).toBe(0);
  await expect(page.getByText('План ещё не записан (NO_PLAN).', { exact: false })).toBeVisible();
});

test('B09 lost commit response: retry reuses the same idempotency key and yields one revision', async ({ page }, testInfo) => {
  const state = fixture('SDO');
  await open(page, state);
  await addLine(page, 'c:' + CORE, '10.00');
  await saveButton(page).click();
  await expect(status(page)).toContainText('Технический ввод сохранён');
  state.faults.push({ method: 'POST', path: '/api/fin-sdo-1/commit', abortAfterApply: true });
  await commitButton(page).click();
  await expect(alert(page)).toContainText('результат неизвестен');
  await expect(status(page)).toHaveCount(0);
  expect(state.version).toBe(1); // server applied it; the browser never saw the answer
  await commitButton(page).click();
  await expect(status(page)).toHaveText('Новая действующая версия квартального плана записана.');
  const sent = commits(state);
  expect(sent).toHaveLength(2);
  expect(sent[1].body.idempotencyKey).toBe(sent[0].body.idempotencyKey);
  expect(sent[1].body).toEqual(sent[0].body);
  expect(state.history).toHaveLength(1);
  await expect(summary(page)).toContainText('Первоначальный: 10,00 млн ₽');
  await page.screenshot({ path: testInfo.outputPath('b09-lost-response-replay.png'), fullPage: true });
});

test('B10 navigation: sidebar entry and deep link for SDO_HEAD and ADMIN (write); ADMIN sees its own tenant only via session', async ({ browser }) => {
  for (const role of ['SDO_HEAD', 'ADMIN']) {
    const page = await browser.newPage();
    try {
      const state = fixture(role, true);
      await harness(page, state);
      await page.goto('/app.html/sdo');
      await page.getByRole('button', { name: 'План закрытия', exact: true }).click();
      await expect(page).toHaveURL(/\/app\.html\/sdo\/plan$/);
      await expect(page.getByRole('heading', { level: 1, name: 'СДО · План закрытия' })).toBeVisible();
      await expect(summary(page)).toContainText('Первоначальный: 10,00 млн ₽');
      await expect(saveButton(page)).toBeVisible();
      expect(finCalls(state).every(c => !('tenantId' in (c.body ?? {})) && !('actorId' in (c.body ?? {})))).toBe(true);
    } finally { await page.close(); }
  }
});

test('B11 FIN-SDO-2/3 absent: no customer agreement, override/D03, attribution or export controls', async ({ page }) => {
  const state = fixture('ADMIN', true);
  await open(page, state);
  await expect(summary(page)).toContainText('Текущий: 10,00 млн ₽');
  const forbidden = /Согласова|AGREED|Подач|выверк|Оверрайд|override|D03|Атрибуц|Экспорт|XLSX|Excel|Движение закрытия|Свод закрытия|факт заказчика/i;
  await expect(page.getByRole('button', { name: forbidden })).toHaveCount(0);
  await expect(page.getByRole('link', { name: forbidden })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: forbidden })).toHaveCount(0);
  expect(state.calls.filter(c => /customer|agreed|override|attribution|export|xlsx|submission/i.test(c.path))).toHaveLength(0);
});
