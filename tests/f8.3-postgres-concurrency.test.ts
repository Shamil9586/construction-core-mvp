import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';

/**
 * F8.3-18 — real PostgreSQL concurrency verification.
 *
 * PGlite (every other *-http.test.ts file in this suite) is single-connection
 * and does not give two independent transactions genuine, database-enforced
 * row-lock blocking — it is not evidence for a lock-order/race claim. This
 * file is the one place that requires a REAL PostgreSQL connection and
 * exercises the canonical Package -> Case -> Document lock order
 * (service.ts) under actual concurrent transactions.
 *
 * Independent review of an earlier version of this file found two real
 * weaknesses, both fixed here:
 *
 *  1. `Promise.all([reqA, reqB])` by itself proves nothing about genuine
 *     interleaving — both requests might simply have executed sequentially,
 *     with no serialization boundary ever actually contended. Every
 *     scenario below that claims to test a race now uses
 *     `withPackageLockBarrier()`: an independent, test-only connection
 *     takes `SELECT ... FOR UPDATE` on the Package row FIRST, both real app
 *     requests are fired, the test explicitly asserts NEITHER has settled
 *     yet (proving both are genuinely queued behind the barrier — not
 *     "happened to run in order"), only THEN is the barrier released, and
 *     only then are the requests awaited to completion. This is a
 *     deterministic, bounded mechanism — never a hopeful fixed sleep alone.
 *
 *  2. `req()`'s own `expected` parameter never actually asserted anything —
 *     every call site's implied expectation (a plain `201` on a setup step,
 *     an explicit status on a racing call) went silently unverified,
 *     including the possibility of an unnoticed 500. `req()` below now
 *     requires an explicit `expected` (a status, or an array of the
 *     legitimate statuses for a race) and asserts the real response status
 *     is one of them — there is no default, and no value silently passes.
 *
 * Connection: E2E_DATABASE_URL if set, otherwise the local cluster this
 * session provisioned for this exact purpose
 * (postgresql://postgres:local-test-only@127.0.0.1:5432/construction_test —
 * `pg_ctlcluster 16 main start`, database created, password set). If neither
 * is reachable, every test below fails loudly rather than silently passing
 * against PGlite — a real-PostgreSQL gate that cannot connect is not a gate
 * that passed.
 */
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'postgresql://postgres:local-test-only@127.0.0.1:5432/construction_test';

const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function harness() {
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'f8-3-pg-concurrency-key';
  process.env.DB_MODE = 'postgres';
  process.env.DATABASE_URL = DATABASE_URL;

  const { migrate } = await import('../scripts/migrate');
  const { seed } = await import('../scripts/seed');
  const { createApp } = await import('../apps/backend/src/main');
  await migrate();
  await seed();
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const base = `http://127.0.0.1:${address.port}`;
  const tokens: Record<string, string> = {};
  /**
   * `expected` is mandatory — a single status or the enumerated set of
   * legitimate statuses for a race — and is actually asserted against the
   * real response. There is no "don't care" sentinel: a genuinely racing
   * call site names every status it considers legitimate (never including
   * 500 unless 500 really is the intended outcome), so an unexpected 500,
   * an unhandled error or a status nobody anticipated always fails the test
   * loudly instead of passing silently.
   */
  async function req(path: string, body: any, token: string, expected: number | number[]) {
    const r = await fetch(base + '/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data: any = await r.json();
    const allowed = Array.isArray(expected) ? expected : [expected];
    assert.ok(allowed.includes(r.status), `${path}: expected status in [${allowed.join(', ')}], got ${r.status}: ${JSON.stringify(data)}`);
    return { status: r.status, data };
  }
  async function login(role: string) {
    if (tokens[role]) return tokens[role];
    const r = await fetch(base + '/auth/mock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, key: 'f8-3-pg-concurrency-key' }) });
    const d: any = await r.json();
    tokens[role] = d.token;
    return d.token;
  }
  return { app, req, login };
}

/**
 * The controlled-interleaving mechanism every genuine race scenario below
 * uses: an independent, test-only connection takes `FOR UPDATE` on the
 * Package row first (the canonical lock order's own first lock, so every
 * F8.3-18 route queues behind it identically), fires both real app requests
 * as promises without awaiting them, explicitly PROVES neither has settled
 * yet (a bounded wait, then an assertion — never just a hopeful delay), then
 * releases the barrier and awaits both to completion. A promise that never
 * settles within the bounded window (a real deadlock) fails the `Promise.race`
 * below with a thrown timeout, rather than hanging the suite forever.
 */
async function withPackageLockBarrier<T>(pkgTenantId: string, pkgId: string, fireRacers: () => Promise<T>[]): Promise<T[]> {
  const barrier = new Client({ connectionString: DATABASE_URL });
  await barrier.connect();
  try {
    await barrier.query('BEGIN');
    await barrier.query('SELECT * FROM documentation_packages WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [pkgTenantId, pkgId]);

    const settled: boolean[] = [];
    const racers = fireRacers().map((p, i) => {
      settled[i] = false;
      return p.finally(() => { settled[i] = true; });
    });

    await sleep(400);
    assert.deepEqual(settled, settled.map(() => false), 'every racing request must still be queued behind the barrier\'s Package FOR UPDATE lock — proof of genuine controlled interleaving, not a hopeful Promise.all');

    await barrier.query('COMMIT');

    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('deadlock/timeout: a racing request never settled within 10s of the barrier releasing')), 10000));
    return await Promise.race([Promise.all(racers), timeout]);
  } finally {
    await barrier.end();
  }
}

/** Builds one accepted-and-handed-off Documentation Package/Case, real Postgres. Returns everything callers need to fire concurrent mutations against it. */
async function setUpHandedOffCase(req: any, login: any, code: string, name: string) {
  const pmToken = await login('PROJECT_MANAGER');
  const dict = (await req('dictionaries', undefined, pmToken, 200)).data;
  const contractors = (await req('contractors', undefined, pmToken, 200)).data;
  const tdToken = await login('TECHNICAL_DIRECTOR');
  const pm = (await req('me', undefined, pmToken, 200)).data;
  const o = (await req('objects', { externalCode: code, name, address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] }, tdToken, 201)).data;
  const work = (await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name, unit: 'м²', plannedQuantity: 500, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '100000' }, pmToken, 201)).data;
  const unit = (await req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 500 }, pmToken, 201)).data;
  const portion = (await req(`execution-units/${unit.id}/portions`, { label: 'Секция A', plannedQuantity: 200 }, pmToken, 201)).data;
  await req(`portions/${portion.id}/fact`, { quantity: 200, version: portion.version }, pmToken, 201);
  const custRequest = (await req(`portions/${portion.id}/inspection-request`, { inspectionType: 'CUSTOMER_SC', version: portion.version + 1 }, pmToken, 201)).data;

  const ccToken = await login('CONSTRUCTION_CONTROL');
  const attachment = (await req('attachments', { fileName: 'sc.png', mimeType: 'image/png', base64: PNG_BASE64 }, ccToken, 201)).data;
  await req(`inspections/${custRequest.id}/photos`, { attachmentId: attachment.id }, ccToken, 201);
  await req(`inspections/${custRequest.id}/accept`, { version: custRequest.version, comment: 'Подтверждено', quantity: 200 }, ccToken, 201);

  const ptoToken = await login('PTO');
  const ptoUser = (await req('me', undefined, ptoToken, 200)).data;
  const pkg0 = (await req('documentation-packages', { objectWorkId: work.id, responsibleUserId: ptoUser.id }, ptoToken, 201)).data;
  await req(`documentation-packages/${pkg0.id}/portions`, { quantityPortionId: portion.id }, ptoToken, 201);
  const doc = (await req(`documentation-packages/${pkg0.id}/documents`, { type: 'AOSR' }, ptoToken, 201)).data;
  await req(`documentation-documents/${doc.id}/versions`, { storageProvider: 'NONE' }, ptoToken, 201);
  let p = (await req(`documentation-packages/${pkg0.id}/status`, { status: 'PREPARING', version: pkg0.version }, ptoToken, 201)).data;
  p = (await req(`documentation-packages/${p.id}/status`, { status: 'READY_FOR_PRESENTATION', version: p.version }, ptoToken, 201)).data;
  p = (await req(`documentation-packages/${p.id}/status`, { status: 'PRESENTED', version: p.version }, ptoToken, 201)).data;
  const accepted = (await req(`documentation-packages/${p.id}/customer-acceptance`, { version: p.version, acceptedDate: dt(0) }, ptoToken, 201)).data;
  const sdoCase = (await req(`documentation-packages/${accepted.id}/handoff-to-sdo`, { version: accepted.version }, ptoToken, 201)).data;

  return { tenantId: accepted.tenantId, pkg: accepted, doc, unit, portion, sdoCase, ptoToken, work, dict, contractors };
}

/** Presented + accepted, NOT yet handed off — the shared fixture the coverage/document/version-vs-handoff scenarios build on. */
async function setUpAcceptedNotHandedOff(req: any, login: any, code: string, name: string) {
  const pmToken = await login('PROJECT_MANAGER');
  const tdToken = await login('TECHNICAL_DIRECTOR');
  const ptoToken = await login('PTO');
  const ccToken = await login('CONSTRUCTION_CONTROL');
  const dict = (await req('dictionaries', undefined, pmToken, 200)).data;
  const contractors = (await req('contractors', undefined, pmToken, 200)).data;
  const pm = (await req('me', undefined, pmToken, 200)).data;
  const o = (await req('objects', { externalCode: code, name, address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] }, tdToken, 201)).data;
  const work = (await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name, unit: 'м²', plannedQuantity: 500, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '100000' }, pmToken, 201)).data;
  const unit = (await req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 500 }, pmToken, 201)).data;
  const portion = (await req(`execution-units/${unit.id}/portions`, { label: 'Секция A', plannedQuantity: 200 }, pmToken, 201)).data;
  await req(`portions/${portion.id}/fact`, { quantity: 200, version: portion.version }, pmToken, 201);
  const custRequest = (await req(`portions/${portion.id}/inspection-request`, { inspectionType: 'CUSTOMER_SC', version: portion.version + 1 }, pmToken, 201)).data;
  const attachment = (await req('attachments', { fileName: 'sc.png', mimeType: 'image/png', base64: PNG_BASE64 }, ccToken, 201)).data;
  await req(`inspections/${custRequest.id}/photos`, { attachmentId: attachment.id }, ccToken, 201);
  await req(`inspections/${custRequest.id}/accept`, { version: custRequest.version, comment: 'ok', quantity: 200 }, ccToken, 201);

  const ptoUser = (await req('me', undefined, ptoToken, 200)).data;
  const pkg0 = (await req('documentation-packages', { objectWorkId: work.id, responsibleUserId: ptoUser.id }, ptoToken, 201)).data;
  await req(`documentation-packages/${pkg0.id}/portions`, { quantityPortionId: portion.id }, ptoToken, 201);
  const doc = (await req(`documentation-packages/${pkg0.id}/documents`, { type: 'AOSR' }, ptoToken, 201)).data;
  await req(`documentation-documents/${doc.id}/versions`, { storageProvider: 'NONE' }, ptoToken, 201);
  let p = (await req(`documentation-packages/${pkg0.id}/status`, { status: 'PREPARING', version: pkg0.version }, ptoToken, 201)).data;
  p = (await req(`documentation-packages/${p.id}/status`, { status: 'READY_FOR_PRESENTATION', version: p.version }, ptoToken, 201)).data;
  p = (await req(`documentation-packages/${p.id}/status`, { status: 'PRESENTED', version: p.version }, ptoToken, 201)).data;
  const accepted = (await req(`documentation-packages/${p.id}/customer-acceptance`, { version: p.version, acceptedDate: dt(0) }, ptoToken, 201)).data;

  return { tenantId: accepted.tenantId, pkg: accepted, doc, unit, portion, ptoToken, work, o };
}

/* --------------------------------------------------------------------- *
 * A: Package lock proof — establishes the barrier mechanism itself       *
 * --------------------------------------------------------------------- */

test('F8.3-18 (A): canonical Package lock genuinely blocks a second real transaction until commit (two independent PostgreSQL connections)', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg } = await setUpHandedOffCase(req, login, 'F83-18-A-' + Date.now(), 'F8.3-18 (A)');
    const c1 = new Client({ connectionString: DATABASE_URL });
    const c2 = new Client({ connectionString: DATABASE_URL });
    await c1.connect();
    await c2.connect();
    try {
      await c1.query('BEGIN');
      await c1.query('SELECT * FROM documentation_packages WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [pkg.tenantId, pkg.id]);

      let c2Locked = false;
      const c2Promise = (async () => {
        await c2.query('BEGIN');
        await c2.query('SELECT * FROM documentation_packages WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [pkg.tenantId, pkg.id]);
        c2Locked = true;
        await c2.query('COMMIT');
      })();

      // c2's FOR UPDATE must still be waiting on c1's row lock.
      await sleep(400);
      assert.equal(c2Locked, false, 'a second real transaction must still be blocked while the first holds the Package row FOR UPDATE');

      await c1.query('COMMIT');
      await c2Promise;
      assert.equal(c2Locked, true, 'the second transaction proceeds only once the first commits and releases the lock — this is the mechanism every F8.3-18 fix in service.ts relies on, and the mechanism withPackageLockBarrier() below reuses against real app requests');
    } finally {
      await c1.end();
      await c2.end();
    }
  } finally {
    await app.close();
  }
});

test('F8.3-18 (A) negative control: a plain SELECT (no FOR UPDATE) is never blocked by another transaction\'s row lock — proving this file\'s "still blocked" assertion is a real, meaningful signal, not a timing artifact that would pass regardless', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg } = await setUpHandedOffCase(req, login, 'F83-18-NEG-' + Date.now(), 'F8.3-18 negative control');
    const c1 = new Client({ connectionString: DATABASE_URL });
    const c2 = new Client({ connectionString: DATABASE_URL });
    await c1.connect();
    await c2.connect();
    try {
      await c1.query('BEGIN');
      await c1.query('SELECT * FROM documentation_packages WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [pkg.tenantId, pkg.id]);

      let c2Done = false;
      const c2Promise = (async () => {
        await c2.query('BEGIN');
        // Deliberately NOT taking a conflicting lock — a plain read never
        // queues behind another transaction's row lock under Postgres's
        // default READ COMMITTED isolation.
        await c2.query('SELECT * FROM documentation_packages WHERE tenant_id=$1 AND id=$2', [pkg.tenantId, pkg.id]);
        c2Done = true;
        await c2.query('COMMIT');
      })();

      await sleep(400);
      // This is the exact same shape of assertion every other scenario in
      // this file uses to claim "genuinely blocked" — here it must observe
      // the OPPOSITE result, proving the assertion is capable of failing
      // and is therefore real evidence, not a tautology that always reads
      // "still blocked" regardless of what actually happened underneath.
      assert.equal(c2Done, true, 'a plain SELECT is never blocked by a FOR UPDATE lock on the same row — this file\'s blocking assertions are a genuine, falsifiable signal');

      await c1.query('COMMIT');
      await c2Promise;
    } finally {
      await c1.end();
      await c2.end();
    }
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * B: coverage mutation vs handoff                                        *
 * --------------------------------------------------------------------- */

test('F8.3-18 (B): concurrent Portion-coverage mutation vs handoff on an ACCEPTED_BY_CUSTOMER Package — the mutation is always rejected, handoff succeeds exactly once, coverage never changes', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg, ptoToken, unit, portion, o } = await setUpAcceptedNotHandedOff(req, login, 'F83-18-B-' + Date.now(), 'F8.3-18 (B)');
    const pmToken = await login('PROJECT_MANAGER');

    // A second Quantity Portion, never linked — the coverage mutation under test.
    const portion2 = (await req(`execution-units/${unit.id}/portions`, { label: 'Секция B', plannedQuantity: 100 }, pmToken, 201)).data;
    await login('PTO');

    const [linkResult, handoffResult] = await withPackageLockBarrier(pkg.tenantId, pkg.id, () => [
      req(`documentation-packages/${pkg.id}/portions`, { quantityPortionId: portion2.id }, ptoToken, [400]),
      req(`documentation-packages/${pkg.id}/handoff-to-sdo`, { version: pkg.version }, ptoToken, [201]),
    ]);

    assert.equal(linkResult.status, 400, 'the coverage mutation is rejected regardless of DB-lock timing — content stayed frozen throughout');
    assert.equal(handoffResult.status, 201, 'handoff succeeds — nothing about the concurrent, rejected mutation ever touched the Package');

    const snap = (await req('snapshot', undefined, ptoToken, 200)).data;
    const cases = (snap.sdoClosingCases ?? []).filter((c: any) => c.documentationPackageId === pkg.id);
    assert.equal(cases.length, 1, 'exactly one SDO Case exists — no duplicate, no partial write');
    assert.equal(cases[0].packageLocked, true);

    const coverage = (snap.documentationPackagePortions ?? []).filter((l: any) => l.documentationPackageId === pkg.id);
    assert.deepEqual(coverage.map((l: any) => l.quantityPortionId).sort(), [portion.id].sort(), 'coverage is exactly the original single Portion — Portion B never got linked, win or lose the DB-lock race');

    const pkgListR = await req(`documentation-packages?objectId=${o.id}`, undefined, ptoToken, 200);
    const finalPkg = pkgListR.data.find((x: any) => x.id === pkg.id);
    assert.equal(finalPkg.status, 'ACCEPTED_BY_CUSTOMER', 'Package status is exactly what handoff left it — never mutated by the losing request');

    const handoffHistory = (snap.sdoClosingHandoffHistory ?? []).filter((h: any) => h.sdoClosingCaseId === cases[0].id);
    assert.equal(handoffHistory.filter((h: any) => h.event === 'HANDED_OFF').length, 1, 'exactly one HANDED_OFF row');
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * C: create Documentation Document vs handoff                            *
 * --------------------------------------------------------------------- */

test('F8.3-18 (C): concurrent create-Document vs handoff on an ACCEPTED_BY_CUSTOMER Package — the create is always rejected, handoff succeeds exactly once, the document set never changes', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg, ptoToken, doc } = await setUpAcceptedNotHandedOff(req, login, 'F83-18-C-' + Date.now(), 'F8.3-18 (C)');

    const [createResult, handoffResult] = await withPackageLockBarrier(pkg.tenantId, pkg.id, () => [
      req(`documentation-packages/${pkg.id}/documents`, { type: 'ACT_CERTIFICATE' }, ptoToken, [400]),
      req(`documentation-packages/${pkg.id}/handoff-to-sdo`, { version: pkg.version }, ptoToken, [201]),
    ]);

    assert.equal(createResult.status, 400, 'creating a Document while ACCEPTED_BY_CUSTOMER is always rejected, win or lose the DB-lock race');
    assert.equal(handoffResult.status, 201, 'handoff succeeds independently');

    const snap = (await req('snapshot', undefined, ptoToken, 200)).data;
    const cases = (snap.sdoClosingCases ?? []).filter((c: any) => c.documentationPackageId === pkg.id);
    assert.equal(cases.length, 1);
    assert.equal(cases[0].packageLocked, true);

    const documents = (snap.documentationDocuments ?? []).filter((d: any) => d.documentationPackageId === pkg.id);
    assert.equal(documents.length, 1, 'exactly the original AOSR document — the racing ACT_CERTIFICATE never committed');
    assert.equal(documents[0].id, doc.id);
    assert.equal(documents[0].type, 'AOSR');
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * D: create Documentation Version vs handoff                             *
 * --------------------------------------------------------------------- */

test('F8.3-18 (D): concurrent create-Version vs handoff on an ACCEPTED_BY_CUSTOMER Package — the create is always rejected, handoff succeeds exactly once, no stale accepted snapshot survives', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg, ptoToken, doc } = await setUpAcceptedNotHandedOff(req, login, 'F83-18-D-' + Date.now(), 'F8.3-18 (D)');

    const [versionResult, handoffResult] = await withPackageLockBarrier(pkg.tenantId, pkg.id, () => [
      req(`documentation-documents/${doc.id}/versions`, { storageProvider: 'NONE' }, ptoToken, [400]),
      req(`documentation-packages/${pkg.id}/handoff-to-sdo`, { version: pkg.version }, ptoToken, [201]),
    ]);

    assert.equal(versionResult.status, 400, 'creating a Document Version while ACCEPTED_BY_CUSTOMER is always rejected');
    assert.equal(handoffResult.status, 201, 'handoff succeeds independently');

    const snap = (await req('snapshot', undefined, ptoToken, 200)).data;
    const cases = (snap.sdoClosingCases ?? []).filter((c: any) => c.documentationPackageId === pkg.id);
    assert.equal(cases.length, 1);

    const versions = (snap.documentationVersions ?? []).filter((v: any) => v.documentationDocumentId === doc.id);
    assert.equal(versions.length, 1, 'exactly one version exists — the racing second version never committed');
    const currentVersionIds = versions.map((v: any) => v.id).sort();

    const acceptances = (snap.documentationCustomerAcceptances ?? []).filter((a: any) => a.documentationPackageId === pkg.id);
    assert.equal(acceptances.length, 1);
    const acceptedVersionIds = (snap.documentationCustomerAcceptanceVersions ?? [])
      .filter((v: any) => v.customerAcceptanceId === acceptances[0].id)
      .map((v: any) => v.documentationDocumentVersionId)
      .sort();
    assert.deepEqual(acceptedVersionIds, currentVersionIds, 'the accepted snapshot exactly matches the current latest version set — no stale acceptance, no silently-added version underneath it');
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * E: simultaneous handoff attempts                                       *
 * --------------------------------------------------------------------- */

test('F8.3-18 (E): two simultaneous handoff attempts on the same Package never create two Cases — exactly one succeeds, one HANDED_OFF history row exists, no 500', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg, ptoToken } = await setUpAcceptedNotHandedOff(req, login, 'F83-18-E-' + Date.now(), 'F8.3-18 (E)');

    const [r1, r2] = await withPackageLockBarrier(pkg.tenantId, pkg.id, () => [
      req(`documentation-packages/${pkg.id}/handoff-to-sdo`, { version: pkg.version }, ptoToken, [201, 400, 409]),
      req(`documentation-packages/${pkg.id}/handoff-to-sdo`, { version: pkg.version }, ptoToken, [201, 400, 409]),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.equal(statuses.filter((s) => s === 201).length, 1, 'exactly one handoff attempt succeeds');
    assert.ok(statuses[statuses[0] === 201 ? 1 : 0] === 400 || statuses[statuses[0] === 201 ? 1 : 0] === 409, 'the loser is refused outright (already handed off) or hits the optimistic-version conflict — never a 500, never a second success');

    const snap = (await req('snapshot', undefined, ptoToken, 200)).data;
    const cases = (snap.sdoClosingCases ?? []).filter((c: any) => c.documentationPackageId === pkg.id);
    assert.equal(cases.length, 1, 'sdo_closing_cases_unique holds — never two Cases for one Package');
    assert.equal(cases[0].packageLocked, true);

    const handoffHistory = (snap.sdoClosingHandoffHistory ?? []).filter((h: any) => h.sdoClosingCaseId === cases[0].id);
    assert.equal(handoffHistory.filter((h: any) => h.event === 'HANDED_OFF').length, 1, 'exactly one HANDED_OFF row — no duplicate/incorrect history');
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * F: handoff vs return-to-PTO — strengthened (the review found the       *
 * previous version too permissive: "at least one succeeds" is not proof) *
 * --------------------------------------------------------------------- */

test('F8.3-18 (F): a re-handoff attempt racing a concurrent return-to-PTO always leaves return-to-PTO successful and the re-handoff refused outright — never both applied, never a 500, never a duplicate Case', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg, sdoCase, ptoToken } = await setUpHandedOffCase(req, login, 'F83-18-F-' + Date.now(), 'F8.3-18 (F)');
    const sdoToken = await login('SDO');

    // Both orderings are analysed exactly, not merely hoped about:
    //  - return-to-PTO wins the Package lock first: it unlocks the Case and
    //    bumps the Package's own version; the blocked re-handoff attempt
    //    then re-reads a Package whose version no longer matches the
    //    version it was submitted with -> 409 (checkVersion fires before
    //    the "already handed off" check even runs).
    //  - the re-handoff attempt wins the Package lock first: the Case is
    //    still genuinely locked (return-to-PTO has not run yet), so its own
    //    "Пакет уже передан в СДО" guard rejects it outright -> 400.
    // A failed re-handoff never mutates anything (every ensure() in
    // handoffDocumentationPackageToSdo() throws before any write), so
    // return-to-PTO's own preconditions are never invalidated by it losing
    // — return-to-PTO succeeds in both orderings, unconditionally.
    const [returnResult, rehandoffResult] = await withPackageLockBarrier(pkg.tenantId, pkg.id, () => [
      req(`sdo-closing-cases/${sdoCase.id}/return-to-pto`, { version: sdoCase.version }, sdoToken, [201]),
      req(`documentation-packages/${pkg.id}/handoff-to-sdo`, { version: pkg.version }, ptoToken, [400, 409]),
    ]);

    assert.equal(returnResult.status, 201, 'return-to-PTO always succeeds — a losing re-handoff attempt never mutates anything that could invalidate it');
    assert.ok([400, 409].includes(rehandoffResult.status), 'the re-handoff attempt is always refused — 400 ("already handed off") if it loses the lock, 409 (stale version) if it wins the lock but return-to-PTO already committed underneath it — never a 500, never 201');

    const snap = (await req('snapshot', undefined, ptoToken, 200)).data;
    const cases = (snap.sdoClosingCases ?? []).filter((c: any) => c.documentationPackageId === pkg.id);
    assert.equal(cases.length, 1, 'still exactly one Case — same identity throughout');
    assert.equal(cases[0].id, sdoCase.id, 'the same Case survives the race, never replaced by a second one');
    assert.equal(cases[0].packageLocked, false, 'return-to-PTO committed — the Package is unlocked');
    assert.equal(cases[0].documentationPackageStatus, 'CORRECTING');

    const handoffHistory = (snap.sdoClosingHandoffHistory ?? []).filter((h: any) => h.sdoClosingCaseId === sdoCase.id);
    assert.equal(handoffHistory.filter((h: any) => h.event === 'HANDED_OFF').length, 1, 'still exactly the one original HANDED_OFF row — the refused re-handoff never added a second');
    assert.equal(handoffHistory.filter((h: any) => h.event === 'RETURNED_TO_PTO').length, 1, 'exactly one RETURNED_TO_PTO row');
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * G: full recovery lifecycle — return / correction / re-presentation /   *
 * re-handoff, with a genuine race introduced at the return boundary      *
 * --------------------------------------------------------------------- */

test('F8.3-18 (G): the full return -> correct -> re-present -> re-accept -> re-handoff lifecycle survives a concurrent content-mutation attempt at the return boundary, ending with one Case, package_locked=true and no stale acceptance', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg, sdoCase, ptoToken } = await setUpHandedOffCase(req, login, 'F83-18-G-' + Date.now(), 'F8.3-18 (G)');
    const sdoToken = await login('SDO');

    // The race: SDO returns the Case to PTO while PTO simultaneously
    // attempts to add a Document — legitimate only if it is genuinely
    // observed after the Package is unlocked. Both orderings are legitimate
    // here (unlike scenario F, this mutation itself has no stale-version
    // exposure the way a second handoff attempt does): the create is
    // rejected if it hits the still-locked Package, or it succeeds if it
    // hits the just-unlocked one — either way return-to-PTO itself always
    // succeeds, and whichever way the create landed, the full lifecycle
    // below must still end in exactly one self-consistent, fully re-handed
    // off state.
    const [returnResult, createResult] = await withPackageLockBarrier(pkg.tenantId, pkg.id, () => [
      req(`sdo-closing-cases/${sdoCase.id}/return-to-pto`, { version: sdoCase.version }, sdoToken, [201]),
      req(`documentation-packages/${pkg.id}/documents`, { type: 'ACT_CERTIFICATE' }, ptoToken, [201, 400]),
    ]);
    assert.equal(returnResult.status, 201, 'return-to-PTO always succeeds — nothing races against its own preconditions');

    let snap = (await req('snapshot', undefined, ptoToken, 200)).data;
    let currentPkg = (snap.documentationPackages ?? []).find((p: any) => p.id === pkg.id);
    assert.equal(currentPkg.status, 'CORRECTING', 'return-to-PTO committed — the Package is unlocked and content-editable');

    let extraDoc: any;
    if (createResult.status === 201) {
      // Won the lock after return-to-PTO committed — content genuinely was
      // editable by then; the Document already exists.
      extraDoc = createResult.data;
    } else {
      // Lost the race (observed the still-frozen ACCEPTED_BY_CUSTOMER
      // Package) — content is editable now, so create it for real.
      assert.equal(createResult.status, 400, 'no other outcome is legitimate for the loser — a content mutation observed while still frozen must be rejected, never queued/retried into success');
      extraDoc = (await req(`documentation-packages/${pkg.id}/documents`, { type: 'ACT_CERTIFICATE' }, ptoToken, [201])).data;
    }
    // Every document needs a version before PRESENTED/acceptance will
    // accept the Package (F8.3-R02b) — including the pre-existing AOSR
    // document's own original version, already created by setUpHandedOffCase.
    await req(`documentation-documents/${extraDoc.id}/versions`, { storageProvider: 'NONE' }, ptoToken, [201]);

    currentPkg = (await req(`documentation-packages?objectId=${pkg.objectId}`, undefined, ptoToken, 200)).data.find((p: any) => p.id === pkg.id);
    const presented = (await req(`documentation-packages/${currentPkg.id}/status`, { status: 'PRESENTED', version: currentPkg.version }, ptoToken, [201])).data;
    assert.equal(presented.status, 'PRESENTED', 'PRESENTED freezes exactly this final content — the earlier race is long resolved by this point');

    // registerDocumentationCustomerAcceptance() returns the updated Package
    // (now ACCEPTED_BY_CUSTOMER again), never the acceptance record itself
    // — the same shape every other package mutation route returns; the
    // acceptance record's own id/fields are read back from the snapshot below.
    const freshlyAccepted = (await req(`documentation-packages/${presented.id}/customer-acceptance`, { version: presented.version, acceptedDate: dt(0), reference: 'Акт повторного согласия' }, ptoToken, [201])).data;
    const rehandedOff = (await req(`documentation-packages/${freshlyAccepted.id}/handoff-to-sdo`, { version: freshlyAccepted.version }, ptoToken, [201])).data;
    assert.equal(rehandedOff.id, sdoCase.id, 're-handoff resumes the SAME Case, never a second one');
    assert.equal(rehandedOff.packageLocked, true);

    snap = (await req('snapshot', undefined, ptoToken, 200)).data;
    const cases = (snap.sdoClosingCases ?? []).filter((c: any) => c.documentationPackageId === pkg.id);
    assert.equal(cases.length, 1, 'exactly one Case survives the entire lifecycle');
    assert.equal(cases[0].id, sdoCase.id);
    assert.equal(cases[0].packageLocked, true);
    assert.equal(cases[0].documentationPackageStatus, 'ACCEPTED_BY_CUSTOMER');

    // No stale acceptance: the LATEST acceptance's snapshot exactly matches
    // the current latest version of every current document — both original
    // acceptance records remain preserved, immutable, in the history.
    const acceptances = (snap.documentationCustomerAcceptances ?? []).filter((a: any) => a.documentationPackageId === pkg.id).sort((a: any, b: any) => (a.createdAt < b.createdAt ? -1 : 1));
    assert.equal(acceptances.length, 2, 'both the original and the fresh acceptance remain — immutable, never overwritten or deleted');
    const latestAcceptance = acceptances[acceptances.length - 1];
    assert.equal(latestAcceptance.reference, 'Акт повторного согласия', 'the latest acceptance really is the fresh one just registered, not the original');
    const documents = (snap.documentationDocuments ?? []).filter((d: any) => d.documentationPackageId === pkg.id);
    assert.equal(documents.length, 2, 'the original AOSR plus the one ACT_CERTIFICATE added during correction — never a duplicate from the race');
    const currentVersionIds = (snap.documentationVersions ?? [])
      .filter((v: any) => documents.some((d: any) => d.id === v.documentationDocumentId))
      .map((v: any) => v.id)
      .sort();
    const acceptedVersionIds = (snap.documentationCustomerAcceptanceVersions ?? [])
      .filter((v: any) => v.customerAcceptanceId === latestAcceptance.id)
      .map((v: any) => v.documentationDocumentVersionId)
      .sort();
    assert.deepEqual(acceptedVersionIds, currentVersionIds, 'the fresh acceptance snapshot exactly matches every current document\'s current version — no stale acceptance silently survives');

    const handoffHistory = (snap.sdoClosingHandoffHistory ?? []).filter((h: any) => h.sdoClosingCaseId === sdoCase.id).sort((a: any, b: any) => (a.occurredAt < b.occurredAt ? -1 : 1));
    assert.deepEqual(handoffHistory.map((h: any) => h.event), ['HANDED_OFF', 'RETURNED_TO_PTO', 'HANDED_OFF'], 'the full, correctly-ordered handoff/return/re-handoff history — no partial or duplicated entries');
  } finally {
    await app.close();
  }
});
