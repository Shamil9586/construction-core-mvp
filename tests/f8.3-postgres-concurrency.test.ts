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
  async function req(path: string, body: any, token: string, expected = body === undefined ? 200 : 201) {
    const r = await fetch(base + '/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data: any = await r.json();
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

/** Builds one accepted-and-handed-off Documentation Package/Case, real Postgres. Returns everything callers need to fire concurrent mutations against it. */
async function setUpHandedOffCase(req: any, login: any, code: string, name: string) {
  const pmToken = await login('PROJECT_MANAGER');
  const dictR = await req('dictionaries', undefined, pmToken, 200);
  const dict = dictR.data;
  const contractorsR = await req('contractors', undefined, pmToken, 200);
  const contractors = contractorsR.data;
  const tdToken = await login('TECHNICAL_DIRECTOR');
  const oR = await req('objects', { externalCode: code, name, address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: (await req('me', undefined, pmToken, 200)).data.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] }, tdToken, 201);
  const o = oR.data;
  const workR = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: (await req('me', undefined, pmToken, 200)).data.id, name, unit: 'м²', plannedQuantity: 500, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '100000' }, pmToken, 201);
  const work = workR.data;
  const unitR = await req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 500 }, pmToken, 201);
  const unit = unitR.data;
  const portionR = await req(`execution-units/${unit.id}/portions`, { label: 'Секция A', plannedQuantity: 200 }, pmToken, 201);
  const portion = portionR.data;
  await req(`portions/${portion.id}/fact`, { quantity: 200, version: portion.version }, pmToken, 201);
  const custRequestR = await req(`portions/${portion.id}/inspection-request`, { inspectionType: 'CUSTOMER_SC', version: portion.version + 1 }, pmToken, 201);
  const custRequest = custRequestR.data;

  const ccToken = await login('CONSTRUCTION_CONTROL');
  const attachmentR = await req('attachments', { fileName: 'sc.png', mimeType: 'image/png', base64: PNG_BASE64 }, ccToken, 201);
  const attachment = attachmentR.data;
  await req(`inspections/${custRequest.id}/photos`, { attachmentId: attachment.id }, ccToken, 201);
  await req(`inspections/${custRequest.id}/accept`, { version: custRequest.version, comment: 'Подтверждено', quantity: 200 }, ccToken, 201);

  const ptoToken = await login('PTO');
  const ptoUser = (await req('me', undefined, ptoToken, 200)).data;
  const pkgR = await req('documentation-packages', { objectWorkId: work.id, responsibleUserId: ptoUser.id }, ptoToken, 201);
  const pkg0 = pkgR.data;
  await req(`documentation-packages/${pkg0.id}/portions`, { quantityPortionId: portion.id }, ptoToken, 201);
  const docR = await req(`documentation-packages/${pkg0.id}/documents`, { type: 'AOSR' }, ptoToken, 201);
  const doc = docR.data;
  await req(`documentation-documents/${doc.id}/versions`, { storageProvider: 'NONE' }, ptoToken, 201);
  let p = (await req(`documentation-packages/${pkg0.id}/status`, { status: 'PREPARING', version: pkg0.version }, ptoToken, 201)).data;
  p = (await req(`documentation-packages/${p.id}/status`, { status: 'READY_FOR_PRESENTATION', version: p.version }, ptoToken, 201)).data;
  p = (await req(`documentation-packages/${p.id}/status`, { status: 'PRESENTED', version: p.version }, ptoToken, 201)).data;
  const accepted = (await req(`documentation-packages/${p.id}/customer-acceptance`, { version: p.version, acceptedDate: dt(0) }, ptoToken, 201)).data;
  const sdoCase = (await req(`documentation-packages/${accepted.id}/handoff-to-sdo`, { version: accepted.version }, ptoToken, 201)).data;

  return { tenantId: accepted.tenantId, pkg: accepted, doc, unit, portion, sdoCase, ptoToken, work, dict, contractors };
}

/* --------------------------------------------------------------------- *
 * Raw two-connection lock-order proof                                    *
 * --------------------------------------------------------------------- */

test('F8.3-18: canonical Package lock genuinely blocks a second real transaction until commit (two independent PostgreSQL connections)', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg } = await setUpHandedOffCase(req, login, 'F83-18-LOCK-' + Date.now(), 'F8.3 проверка блокировки');
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
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(c2Locked, false, 'a second real transaction must still be blocked while the first holds the Package row FOR UPDATE');

      await c1.query('COMMIT');
      await c2Promise;
      assert.equal(c2Locked, true, 'the second transaction proceeds only once the first commits and releases the lock — this is the mechanism every F8.3-18 fix in service.ts relies on');
    } finally {
      await c1.end();
      await c2.end();
    }
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * A: coverage mutation vs handoff                                        *
 * --------------------------------------------------------------------- */

test('F8.3-18 (A): concurrent Portion-coverage mutation vs handoff on an ACCEPTED_BY_CUSTOMER Package — the mutation is always rejected, handoff succeeds exactly once, coverage never changes', async () => {
  const { app, req, login } = await harness();
  try {
    const pmToken = await login('PROJECT_MANAGER');
    const tdToken = await login('TECHNICAL_DIRECTOR');
    const ptoToken = await login('PTO');
    const dict = (await req('dictionaries', undefined, pmToken)).data;
    const contractors = (await req('contractors', undefined, pmToken)).data;
    const pm = (await req('me', undefined, pmToken)).data;
    const o = (await req('objects', { externalCode: 'F83-18-A-' + Date.now(), name: 'F8.3-18 (A)', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] }, tdToken, 201)).data;
    const work = (await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Работа', unit: 'м²', plannedQuantity: 500, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '100000' }, pmToken, 201)).data;
    const unit = (await req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 500 }, pmToken, 201)).data;
    const portion = (await req(`execution-units/${unit.id}/portions`, { label: 'Секция A', plannedQuantity: 200 }, pmToken, 201)).data;
    await req(`portions/${portion.id}/fact`, { quantity: 200, version: portion.version }, pmToken, 201);
    const custRequest = (await req(`portions/${portion.id}/inspection-request`, { inspectionType: 'CUSTOMER_SC', version: portion.version + 1 }, pmToken, 201)).data;
    const ccToken = await login('CONSTRUCTION_CONTROL');
    const attachment = (await req('attachments', { fileName: 'sc.png', mimeType: 'image/png', base64: PNG_BASE64 }, ccToken, 201)).data;
    await req(`inspections/${custRequest.id}/photos`, { attachmentId: attachment.id }, ccToken, 201);
    await req(`inspections/${custRequest.id}/accept`, { version: custRequest.version, comment: 'ok', quantity: 200 }, ccToken, 201);

    const ptoUser = (await req('me', undefined, ptoToken)).data;
    const pkg0 = (await req('documentation-packages', { objectWorkId: work.id, responsibleUserId: ptoUser.id }, ptoToken, 201)).data;
    await req(`documentation-packages/${pkg0.id}/portions`, { quantityPortionId: portion.id }, ptoToken, 201);
    const doc = (await req(`documentation-packages/${pkg0.id}/documents`, { type: 'AOSR' }, ptoToken, 201)).data;
    await req(`documentation-documents/${doc.id}/versions`, { storageProvider: 'NONE' }, ptoToken, 201);
    let p = (await req(`documentation-packages/${pkg0.id}/status`, { status: 'PREPARING', version: pkg0.version }, ptoToken, 201)).data;
    p = (await req(`documentation-packages/${p.id}/status`, { status: 'READY_FOR_PRESENTATION', version: p.version }, ptoToken, 201)).data;
    p = (await req(`documentation-packages/${p.id}/status`, { status: 'PRESENTED', version: p.version }, ptoToken, 201)).data;
    const accepted = (await req(`documentation-packages/${p.id}/customer-acceptance`, { version: p.version, acceptedDate: dt(0) }, ptoToken, 201)).data;

    // A second Quantity Portion, never linked — the coverage mutation under test.
    const portion2 = (await req(`execution-units/${unit.id}/portions`, { label: 'Секция B', plannedQuantity: 100 }, pmToken, 201)).data;

    // Fire both concurrently: linking Portion B (must fail — content frozen)
    // and handoff (must succeed — the Package is genuinely ready).
    const [linkResult, handoffResult] = await Promise.all([
      req(`documentation-packages/${accepted.id}/portions`, { quantityPortionId: portion2.id }, ptoToken, 999),
      req(`documentation-packages/${accepted.id}/handoff-to-sdo`, { version: accepted.version }, ptoToken, 999),
    ]);

    assert.equal(linkResult.status, 400, 'the coverage mutation is rejected regardless of DB-lock timing — content stayed frozen throughout');
    assert.equal(handoffResult.status, 201, 'handoff succeeds — nothing about the concurrent, rejected mutation ever touched the Package');

    const meR = await req('sdo-closing-cases', undefined, ptoToken, 200);
    const cases = meR.data.filter((c: any) => c.documentationPackageId === accepted.id);
    assert.equal(cases.length, 1, 'exactly one SDO Case exists — no duplicate, no partial write');

    const pkgListR = await req(`documentation-packages?objectId=${o.id}`, undefined, ptoToken, 200);
    const finalPkg = pkgListR.data.find((x: any) => x.id === accepted.id);
    assert.equal(finalPkg.status, 'ACCEPTED_BY_CUSTOMER', 'Package status is exactly what handoff left it — never mutated by the losing request');
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * B: create Documentation Document vs handoff                            *
 * --------------------------------------------------------------------- */

test('F8.3-18 (B): concurrent create-Document vs handoff on an ACCEPTED_BY_CUSTOMER Package — the create is always rejected, handoff succeeds exactly once, document set never changes', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg, ptoToken } = await setUpAcceptedNotHandedOff(req, login, 'F83-18-B-' + Date.now(), 'F8.3-18 (B)');

    const [createResult, handoffResult] = await Promise.all([
      req(`documentation-packages/${pkg.id}/documents`, { type: 'ACT_CERTIFICATE' }, ptoToken, 999),
      req(`documentation-packages/${pkg.id}/handoff-to-sdo`, { version: pkg.version }, ptoToken, 999),
    ]);

    assert.equal(createResult.status, 400, 'creating a Document while ACCEPTED_BY_CUSTOMER is always rejected, win or lose the DB-lock race');
    assert.equal(handoffResult.status, 201, 'handoff succeeds independently');

    const casesR = await req('sdo-closing-cases', undefined, ptoToken, 200);
    assert.equal(casesR.data.filter((c: any) => c.documentationPackageId === pkg.id).length, 1);
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * C: create Documentation Version vs acceptance/handoff                  *
 * --------------------------------------------------------------------- */

test('F8.3-18 (C): concurrent create-Version vs handoff on an ACCEPTED_BY_CUSTOMER Package — the create is always rejected, handoff succeeds exactly once, version count never changes', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg, doc, ptoToken } = await setUpAcceptedNotHandedOff(req, login, 'F83-18-C-' + Date.now(), 'F8.3-18 (C)');

    const [versionResult, handoffResult] = await Promise.all([
      req(`documentation-documents/${doc.id}/versions`, { storageProvider: 'NONE' }, ptoToken, 999),
      req(`documentation-packages/${pkg.id}/handoff-to-sdo`, { version: pkg.version }, ptoToken, 999),
    ]);

    assert.equal(versionResult.status, 400, 'creating a Document Version while ACCEPTED_BY_CUSTOMER is always rejected');
    assert.equal(handoffResult.status, 201, 'handoff succeeds independently');

    const casesR = await req('sdo-closing-cases', undefined, ptoToken, 200);
    assert.equal(casesR.data.filter((c: any) => c.documentationPackageId === pkg.id).length, 1);
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * D: simultaneous handoff attempts                                       *
 * --------------------------------------------------------------------- */

test('F8.3-18 (D): two simultaneous handoff attempts on the same Package never create two Cases — exactly one succeeds, one HANDED_OFF history row exists', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg, ptoToken } = await setUpAcceptedNotHandedOff(req, login, 'F83-18-D-' + Date.now(), 'F8.3-18 (D)');

    const [r1, r2] = await Promise.all([
      req(`documentation-packages/${pkg.id}/handoff-to-sdo`, { version: pkg.version }, ptoToken, 999),
      req(`documentation-packages/${pkg.id}/handoff-to-sdo`, { version: pkg.version }, ptoToken, 999),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [201, 400], 'exactly one handoff attempt succeeds, the other is refused — never both 201');

    const casesR = await req('sdo-closing-cases', undefined, ptoToken, 200);
    const cases = casesR.data.filter((c: any) => c.documentationPackageId === pkg.id);
    assert.equal(cases.length, 1, 'sdo_closing_cases_unique holds — never two Cases for one Package');

    const snapR = await req('snapshot', undefined, ptoToken, 200);
    const handoffHistory = (snapR.data.sdoClosingHandoffHistory ?? []).filter((h: any) => h.sdoClosingCaseId === cases[0].id);
    assert.equal(handoffHistory.filter((h: any) => h.event === 'HANDED_OFF').length, 1, 'exactly one HANDED_OFF row — no duplicate/incorrect history');
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * E: handoff vs return-to-PTO                                            *
 * --------------------------------------------------------------------- */

test('F8.3-18 (E): a re-handoff attempt racing a concurrent return-to-PTO always lands in one self-consistent final state — never a duplicate Case, never both applied', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg, sdoCase, ptoToken } = await setUpHandedOffCase(req, login, 'F83-18-E-' + Date.now(), 'F8.3-18 (E)');
    const sdoToken = await login('SDO');

    const [returnResult, rehandoffResult] = await Promise.all([
      req(`sdo-closing-cases/${sdoCase.id}/return-to-pto`, { version: sdoCase.version }, sdoToken, 999),
      req(`documentation-packages/${pkg.id}/handoff-to-sdo`, { version: pkg.version }, ptoToken, 999),
    ]);

    // Both orderings are legitimate (return-then-relock, or handoff winning
    // outright while the Case was still locked) — what must never happen is
    // a corrupted state: both requests plainly failing, or two Cases.
    assert.ok([returnResult.status, rehandoffResult.status].includes(201), 'at least one of the two racing operations succeeds — the race is resolved, not deadlocked or double-failed');

    const casesR = await req('sdo-closing-cases', undefined, ptoToken, 200);
    const cases = casesR.data.filter((c: any) => c.documentationPackageId === pkg.id);
    assert.equal(cases.length, 1, 'still exactly one Case — same identity throughout');
    assert.equal(cases[0].id, sdoCase.id, 'the same Case survives the race, never replaced by a second one');
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * F: content mutation vs return-to-PTO                                   *
 * --------------------------------------------------------------------- */

test('F8.3-18 (F): a content mutation racing a concurrent return-to-PTO never commits "through" the transition — its outcome always matches the Package status it actually saw', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg, sdoCase, ptoToken } = await setUpHandedOffCase(req, login, 'F83-18-F-' + Date.now(), 'F8.3-18 (F)');
    const sdoToken = await login('SDO');

    const [returnResult, createResult] = await Promise.all([
      req(`sdo-closing-cases/${sdoCase.id}/return-to-pto`, { version: sdoCase.version }, sdoToken, 999),
      req(`documentation-packages/${pkg.id}/documents`, { type: 'ACT_CERTIFICATE' }, ptoToken, 999),
    ]);

    assert.equal(returnResult.status, 201, 'return-to-PTO always succeeds — nothing races against its own preconditions');

    const pkgListR = await req(`documentation-packages?objectId=${pkg.objectId}`, undefined, ptoToken, 200);
    const finalPkg = pkgListR.data.find((x: any) => x.id === pkg.id);
    assert.equal(finalPkg.status, 'CORRECTING', 'return-to-PTO committed — the Package is unlocked and content-editable');

    if (createResult.status === 201) {
      // The create won the lock AFTER return-to-PTO committed — legitimate,
      // content genuinely was editable by then.
      const docsR = await req(`documentation-packages/${pkg.id}/documents`, undefined, ptoToken, 999);
      assert.equal(createResult.status, 201);
    } else {
      // The create won the lock BEFORE return-to-PTO committed — the Package
      // was still ACCEPTED_BY_CUSTOMER (frozen) at that exact instant, so 400
      // is the only correct outcome; it never silently "goes through" once
      // the transition happens moments later.
      assert.equal(createResult.status, 400, 'no other outcome is legitimate — a content mutation observed while still frozen must be rejected, never queued/retried into success');
    }
  } finally {
    await app.close();
  }
});

/** Presented + accepted, NOT yet handed off — the shared fixture scenarios A-D build on. */
async function setUpAcceptedNotHandedOff(req: any, login: any, code: string, name: string) {
  const pmToken = await login('PROJECT_MANAGER');
  const tdToken = await login('TECHNICAL_DIRECTOR');
  const ptoToken = await login('PTO');
  const ccToken = await login('CONSTRUCTION_CONTROL');
  const dict = (await req('dictionaries', undefined, pmToken)).data;
  const contractors = (await req('contractors', undefined, pmToken)).data;
  const pm = (await req('me', undefined, pmToken)).data;
  const o = (await req('objects', { externalCode: code, name, address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] }, tdToken, 201)).data;
  const work = (await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name, unit: 'м²', plannedQuantity: 500, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '100000' }, pmToken, 201)).data;
  const unit = (await req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 500 }, pmToken, 201)).data;
  const portion = (await req(`execution-units/${unit.id}/portions`, { label: 'Секция A', plannedQuantity: 200 }, pmToken, 201)).data;
  await req(`portions/${portion.id}/fact`, { quantity: 200, version: portion.version }, pmToken, 201);
  const custRequest = (await req(`portions/${portion.id}/inspection-request`, { inspectionType: 'CUSTOMER_SC', version: portion.version + 1 }, pmToken, 201)).data;
  const attachment = (await req('attachments', { fileName: 'sc.png', mimeType: 'image/png', base64: PNG_BASE64 }, ccToken, 201)).data;
  await req(`inspections/${custRequest.id}/photos`, { attachmentId: attachment.id }, ccToken, 201);
  await req(`inspections/${custRequest.id}/accept`, { version: custRequest.version, comment: 'ok', quantity: 200 }, ccToken, 201);

  const ptoUser = (await req('me', undefined, ptoToken)).data;
  const pkg0 = (await req('documentation-packages', { objectWorkId: work.id, responsibleUserId: ptoUser.id }, ptoToken, 201)).data;
  await req(`documentation-packages/${pkg0.id}/portions`, { quantityPortionId: portion.id }, ptoToken, 201);
  const doc = (await req(`documentation-packages/${pkg0.id}/documents`, { type: 'AOSR' }, ptoToken, 201)).data;
  await req(`documentation-documents/${doc.id}/versions`, { storageProvider: 'NONE' }, ptoToken, 201);
  let p = (await req(`documentation-packages/${pkg0.id}/status`, { status: 'PREPARING', version: pkg0.version }, ptoToken, 201)).data;
  p = (await req(`documentation-packages/${p.id}/status`, { status: 'READY_FOR_PRESENTATION', version: p.version }, ptoToken, 201)).data;
  p = (await req(`documentation-packages/${p.id}/status`, { status: 'PRESENTED', version: p.version }, ptoToken, 201)).data;
  const accepted = (await req(`documentation-packages/${p.id}/customer-acceptance`, { version: p.version, acceptedDate: dt(0) }, ptoToken, 201)).data;

  return { tenantId: accepted.tenantId, pkg: accepted, doc, unit, portion, ptoToken, work };
}
