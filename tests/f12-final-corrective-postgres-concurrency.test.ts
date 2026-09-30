import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

/**
 * F12.3 FINAL-R01/FINAL-R02/FINAL-R03 — real PostgreSQL concurrency
 * verification (independent review of the first candidate, 424afaf).
 *
 * PGlite (every *-http.test.ts file in this suite) is single-connection and
 * does not give two independent transactions genuine, database-enforced
 * row-lock/conflict blocking — it is not evidence for a concurrency claim.
 * This file is the one place that requires a REAL PostgreSQL connection,
 * mirroring tests/f8.3-postgres-concurrency.test.ts's own harness/barrier
 * pattern exactly (including its own review history: a bare
 * `Promise.all([reqA, reqB])` proves nothing about genuine interleaving —
 * every scenario below either uses `withRowLockBarrier()` — an independent
 * connection takes `FOR UPDATE` first, both racers are fired without being
 * awaited, the test explicitly proves neither has settled yet, only then is
 * the barrier released — or, where no such lockable row exists ahead of the
 * insert itself (a brand-new row's own idempotency key cannot be locked
 * before it exists), steps two raw connections through the exact
 * `INSERT ... ON CONFLICT ... DO NOTHING` statement service.ts/db.ts use,
 * proving PostgreSQL's own conflict-checking blocks the second inserter on
 * the first's uncommitted tuple — never two rows, never a caught unique-
 * violation exception standing in for idempotency.
 *
 * Connection: E2E_DATABASE_URL if set, otherwise the same local cluster
 * convention tests/f8.3-postgres-concurrency.test.ts uses.
 */
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'postgresql://postgres:local-test-only@127.0.0.1:5432/construction_test';
const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=';
const PDF_BASE64 = Buffer.from('%PDF-1.4\n% Test certificate\n%%EOF').toString('base64');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function harness(key: string) {
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = key;
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
  async function req(path: string, body: any, token: string, expected: number | number[]) {
    const r = await fetch(base + '/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data: any = await r.json();
    if (path === 'objects' && body !== undefined && r.status === 201) await (await import('./helpers/pbx3-fixtures')).assignPtoToObject(data.id); // PBX-3A: PTO works only on assigned objects
    const allowed = Array.isArray(expected) ? expected : [expected];
    assert.ok(allowed.includes(r.status), `${path}: expected status in [${allowed.join(', ')}], got ${r.status}: ${JSON.stringify(data)}`);
    return { status: r.status, data };
  }
  async function login(role: string) {
    if (tokens[role]) return tokens[role];
    const r = await fetch(base + '/auth/mock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, key }) });
    const d: any = await r.json();
    tokens[role] = d.token;
    return d.token;
  }
  return { app, req, login };
}

/** Generalized barrier: lock an arbitrary row FOR UPDATE first, fire racers unawaited, prove neither settles, release, await both. */
async function withRowLockBarrier<T>(table: string, tenantId: string, id: string, fireRacers: () => Promise<T>[]): Promise<T[]> {
  const barrier = new Client({ connectionString: DATABASE_URL });
  await barrier.connect();
  try {
    await barrier.query('BEGIN');
    await barrier.query(`SELECT * FROM ${table} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, id]);

    const settled: boolean[] = [];
    const racers = fireRacers().map((p, i) => {
      settled[i] = false;
      return p.finally(() => { settled[i] = true; });
    });

    await sleep(400);
    assert.deepEqual(settled, settled.map(() => false), 'every racing request must still be queued behind the barrier lock — proof of genuine controlled interleaving');

    await barrier.query('COMMIT');

    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('deadlock/timeout: a racing request never settled within 10s of the barrier releasing')), 10000));
    return await Promise.race([Promise.all(racers), timeout]);
  } finally {
    await barrier.end();
  }
}

async function makeObjectAndWork(req: any, login: any, code: string) {
  const pmToken = await login('PROJECT_MANAGER');
  const dict = (await req('dictionaries', undefined, pmToken, 200)).data;
  const contractors = (await req('contractors', undefined, pmToken, 200)).data;
  const pm = (await req('me', undefined, pmToken, 200)).data;
  const deputyToken = await login('DEPUTY_DIRECTOR'); // OBJ-1: object creation is Deputy/Admin authority
  const o = (await req('objects', { externalCode: code, name: code, address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] }, deputyToken, 201)).data;
  const work = (await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: code, unit: 'м²', plannedQuantity: 500, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '100000' }, pmToken, 201)).data;
  return { pmToken, dict, contractors, o, work, tenantId: pm.tenantId };
}

/* --------------------------------------------------------------------- *
 * FINAL-R01: createExecutionUnit() — raw SQL deterministic proof that    *
 * INSERT ... ON CONFLICT ... DO NOTHING blocks a second inserter on the  *
 * first's uncommitted tuple, exactly as insertIdempotent() (db.ts) uses. *
 * No lockable row exists ahead of a brand-new row's own key, so this is  *
 * proven directly against the same SQL statement rather than an app-     *
 * level barrier — deterministic in the same sense: an explicit "settled" *
 * check before release, not a hopeful Promise.all.                       *
 * --------------------------------------------------------------------- */
test('FINAL-R01 (raw SQL): two concurrent INSERT ... ON CONFLICT (work_execution_units) with the same key — the second blocks on the first, then yields zero rows once unblocked', async () => {
  const { app, req, login } = await harness('f12-r01-weu-sql-key');
  try {
    const { work, contractors, dict, tenantId } = await makeObjectAndWork(req, login, 'F12R01WEUSQL-' + Date.now());
    const key = randomUUID();
    const insertSql = `INSERT INTO work_execution_units(tenant_id,object_work_id,work_type_id,contractor_id,unit,planned_quantity,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING *`;
    const params = [tenantId, work.id, dict.workTypes[0].id, contractors[0].id, 'м²', '50', key];

    const c1 = new Client({ connectionString: DATABASE_URL });
    const c2 = new Client({ connectionString: DATABASE_URL });
    await c1.connect();
    await c2.connect();
    try {
      await c1.query('BEGIN');
      const result1 = await c1.query(insertSql, params);
      assert.equal(result1.rows.length, 1, 'the first inserter must succeed and return the new row');

      await c2.query('BEGIN');
      let c2Settled = false;
      const insert2Promise = c2.query(insertSql, params).finally(() => { c2Settled = true; });
      await sleep(400);
      assert.equal(c2Settled, false, 'the second inserter must be genuinely blocked on the first transaction\'s uncommitted conflicting tuple — not merely "happened to run after"');

      await c1.query('COMMIT');
      const result2 = await insert2Promise;
      assert.equal(result2.rows.length, 0, 'once unblocked, ON CONFLICT DO NOTHING must yield zero rows — never a second row, never a raw unique-violation exception');
      await c2.query('COMMIT');

      const finalCount = await c1.query('SELECT count(*)::int AS n FROM work_execution_units WHERE tenant_id=$1 AND idempotency_key=$2', [tenantId, key]);
      assert.equal(finalCount.rows[0].n, 1, 'exactly one row exists for this key after both transactions settle');
    } finally {
      await c1.end();
      await c2.end();
    }
  } finally {
    await app.close();
  }
});

test('FINAL-R01 (raw SQL): two concurrent INSERT ... ON CONFLICT (quantity_portions) with the same key — same guarantee', async () => {
  const { app, req, login } = await harness('f12-r01-qp-sql-key');
  try {
    const { work, contractors, dict, tenantId } = await makeObjectAndWork(req, login, 'F12R01QPSQL-' + Date.now());
    const pmToken = await login('PROJECT_MANAGER');
    const unit = (await req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 500 }, pmToken, 201)).data;
    const key = randomUUID();
    const insertSql = `INSERT INTO quantity_portions(tenant_id,execution_unit_id,label,planned_quantity,idempotency_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT (tenant_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING *`;
    const params = [tenantId, unit.id, 'Секция A', '100', key];

    const c1 = new Client({ connectionString: DATABASE_URL });
    const c2 = new Client({ connectionString: DATABASE_URL });
    await c1.connect();
    await c2.connect();
    try {
      await c1.query('BEGIN');
      const result1 = await c1.query(insertSql, params);
      assert.equal(result1.rows.length, 1);

      await c2.query('BEGIN');
      let c2Settled = false;
      const insert2Promise = c2.query(insertSql, params).finally(() => { c2Settled = true; });
      await sleep(400);
      assert.equal(c2Settled, false, 'the second inserter must be genuinely blocked');

      await c1.query('COMMIT');
      const result2 = await insert2Promise;
      assert.equal(result2.rows.length, 0);
      await c2.query('COMMIT');

      const finalCount = await c1.query('SELECT count(*)::int AS n FROM quantity_portions WHERE tenant_id=$1 AND idempotency_key=$2', [tenantId, key]);
      assert.equal(finalCount.rows[0].n, 1);
    } finally {
      await c1.end();
      await c2.end();
    }
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * FINAL-R01: full-stack HTTP proof — genuinely concurrent identical      *
 * requests (fired via Promise.all, each its own real connection/         *
 * transaction) converge on one entity, one audit row.                    *
 * --------------------------------------------------------------------- */
test('FINAL-R01 (HTTP): N genuinely concurrent createExecutionUnit calls with the same key/payload all succeed with the same id; exactly one row and one CREATE audit exist', async () => {
  const { app, req, login } = await harness('f12-r01-weu-http-key');
  try {
    const { work, contractors, dict, tenantId } = await makeObjectAndWork(req, login, 'F12R01WEUHTTP-' + Date.now());
    const pmToken = await login('PROJECT_MANAGER');
    const key = randomUUID();
    const body = { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 75, idempotencyKey: key };

    const N = 6;
    const results = await Promise.all(Array.from({ length: N }, () => req('execution-units', body, pmToken, [200, 201])));
    const ids = new Set(results.map((r) => r.data.id));
    assert.equal(ids.size, 1, `all ${N} concurrent identical-key requests must resolve to the same execution unit id`);

    const adminToken = await login('ADMIN');
    const auditRows = (await req('audit', undefined, adminToken, 200)).data.filter((a: any) => a.entityType === 'ExecutionUnit' && a.entityId === [...ids][0] && a.action === 'CREATE');
    assert.equal(auditRows.length, 1, 'exactly one CREATE audit row for this execution unit, regardless of how many concurrent callers raced to create it');

    const c = new Client({ connectionString: DATABASE_URL });
    await c.connect();
    try {
      const countRes = await c.query('SELECT count(*)::int AS n FROM work_execution_units WHERE tenant_id=$1 AND idempotency_key=$2', [tenantId, key]);
      assert.equal(countRes.rows[0].n, 1, 'exactly one work_execution_units row for this key');
    } finally {
      await c.end();
    }
  } finally {
    await app.close();
  }
});

test('FINAL-R01 (HTTP, barriered): two concurrent createQuantityPortion calls with the same key/payload, barriered on the parent unit row, both succeed with the same id; exactly one row, quantity sum stays correct', async () => {
  const { app, req, login } = await harness('f12-r01-qp-http-key');
  try {
    const { work, contractors, dict, tenantId } = await makeObjectAndWork(req, login, 'F12R01QPHTTP-' + Date.now());
    const pmToken = await login('PROJECT_MANAGER');
    const unit = (await req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 500 }, pmToken, 201)).data;
    const key = randomUUID();
    const body = { label: 'Секция B', plannedQuantity: 200, idempotencyKey: key };

    // Barriered on the unit's own row — the exact FOR UPDATE lock
    // createQuantityPortion() takes for the sum invariant, and the same lock
    // this fix's post-lock idempotency re-check relies on to close the race.
    const [r1, r2] = await withRowLockBarrier('work_execution_units', tenantId, unit.id, () => [
      req(`execution-units/${unit.id}/portions`, body, pmToken, [200, 201]),
      req(`execution-units/${unit.id}/portions`, body, pmToken, [200, 201]),
    ]);
    assert.equal(r1.data.id, r2.data.id, 'both concurrent identical-key requests must resolve to the same portion id');

    const c = new Client({ connectionString: DATABASE_URL });
    await c.connect();
    try {
      const countRes = await c.query('SELECT count(*)::int AS n FROM quantity_portions WHERE tenant_id=$1 AND idempotency_key=$2', [tenantId, key]);
      assert.equal(countRes.rows[0].n, 1, 'exactly one quantity_portions row for this key — the sum invariant never saw a phantom second portion');
      const sumRes = await c.query('SELECT coalesce(sum(planned_quantity),0)::text AS total FROM quantity_portions WHERE tenant_id=$1 AND execution_unit_id=$2', [tenantId, unit.id]);
      assert.equal(sumRes.rows[0].total, '200.0000', 'the portion sum reflects exactly one 200-unit portion, not two');
    } finally {
      await c.end();
    }
    const adminToken = await login('ADMIN');
    const auditRows = (await req('audit', undefined, adminToken, 200)).data.filter((a: any) => a.entityType === 'QuantityPortion' && a.entityId === r1.data.id && a.action === 'CREATE');
    assert.equal(auditRows.length, 1, 'exactly one CREATE audit row for this portion');
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * FINAL-R02 (representative): the same idempotent_commands ON CONFLICT   *
 * primitive backs all five corrected paths (claimIdempotentCommand(),    *
 * security.ts) — proven once at the SQL level (identical mechanism to    *
 * R01 above, different table) and once end-to-end over HTTP for          *
 * recordPortionFact(), rather than mechanically repeated five times for  *
 * a single shared code path.                                             *
 * --------------------------------------------------------------------- */
test('FINAL-R02 (raw SQL): two concurrent INSERT ... ON CONFLICT (idempotent_commands) with the same key — same guarantee as the R01 tables', async () => {
  const { app, req, login } = await harness('f12-r02-claim-sql-key');
  try {
    const pmToken = await login('PROJECT_MANAGER');
    const pm = (await req('me', undefined, pmToken, 200)).data;
    const key = randomUUID();
    const insertSql = `INSERT INTO idempotent_commands(tenant_id,operation,idempotency_key,scope_id,payload,created_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,operation,idempotency_key) DO NOTHING RETURNING *`;
    const params = [pm.tenantId, 'TEST_OP', key, randomUUID(), JSON.stringify({ a: 1 }), pm.id];

    const c1 = new Client({ connectionString: DATABASE_URL });
    const c2 = new Client({ connectionString: DATABASE_URL });
    await c1.connect();
    await c2.connect();
    try {
      await c1.query('BEGIN');
      const result1 = await c1.query(insertSql, params);
      assert.equal(result1.rows.length, 1);

      await c2.query('BEGIN');
      let c2Settled = false;
      const insert2Promise = c2.query(insertSql, params).finally(() => { c2Settled = true; });
      await sleep(400);
      assert.equal(c2Settled, false, 'the second claim attempt must be genuinely blocked on the first\'s uncommitted claim row');

      await c1.query('COMMIT');
      const result2 = await insert2Promise;
      assert.equal(result2.rows.length, 0);
      await c2.query('COMMIT');
    } finally {
      await c1.end();
      await c2.end();
    }
  } finally {
    await app.close();
  }
});

test('FINAL-R02 (HTTP): N genuinely concurrent recordPortionFact calls with the same key/payload all succeed with the same confirmation id; exactly one confirmation row and one WorkProgressUpdated audit exist', async () => {
  const { app, req, login } = await harness('f12-r02-fact-http-key');
  try {
    const { work, contractors, dict, tenantId } = await makeObjectAndWork(req, login, 'F12R02FACTHTTP-' + Date.now());
    const pmToken = await login('PROJECT_MANAGER');
    const unit = (await req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 500 }, pmToken, 201)).data;
    const portion = (await req(`execution-units/${unit.id}/portions`, { label: 'Секция C', plannedQuantity: 100 }, pmToken, 201)).data;
    const key = randomUUID();
    const body = { quantity: 100, version: portion.version, comment: 'Факт', idempotencyKey: key };

    const N = 6;
    const results = await Promise.all(Array.from({ length: N }, () => req(`portions/${portion.id}/fact`, body, pmToken, [200, 201])));
    const ids = new Set(results.map((r) => r.data.id));
    assert.equal(ids.size, 1, `all ${N} concurrent identical-key requests must resolve to the same confirmation id`);

    const c = new Client({ connectionString: DATABASE_URL });
    await c.connect();
    try {
      const countRes = await c.query('SELECT count(*)::int AS n FROM portion_quantity_confirmations WHERE tenant_id=$1 AND portion_id=$2', [tenantId, portion.id]);
      assert.equal(countRes.rows[0].n, 1, 'exactly one confirmation row for this portion, regardless of how many concurrent callers raced');
      const versionRes = await c.query('SELECT version FROM quantity_portions WHERE tenant_id=$1 AND id=$2', [tenantId, portion.id]);
      assert.equal(versionRes.rows[0].version, portion.version + 1, 'the portion version was bumped exactly once, not once per racing caller');
    } finally {
      await c.end();
    }
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * FINAL-R03: attachment object-ownership first-use race.                 *
 * --------------------------------------------------------------------- */
test('FINAL-R03: two concurrent first-uses of one unattached ordinary attachment for executive documents under different objects — exactly one wins, the other is rejected, never both', async () => {
  const { app, req, login } = await harness('f12-r03-doc-key');
  try {
    const A = await makeObjectAndWork(req, login, 'F12R03DOCA-' + Date.now());
    const B = await makeObjectAndWork(req, login, 'F12R03DOCB-' + Date.now());
    const ptoToken = await login('PTO');
    const packageA = (await req('executive-packages', { objectWorkId: A.work.id }, ptoToken, 201)).data;
    const packageB = (await req('executive-packages', { objectWorkId: B.work.id }, ptoToken, 201)).data;
    const doc = (await req('attachments', { fileName: 'race.pdf', mimeType: 'application/pdf', base64: PDF_BASE64 }, ptoToken, 201)).data;

    const [r1, r2] = await withRowLockBarrier('attachments', A.tenantId, doc.id, () => [
      req('executive-documents', { packageId: packageA.id, type: 'AOSR', number: 'A-1', documentDate: dt(0), fileId: doc.id }, ptoToken, [201, 400]),
      req('executive-documents', { packageId: packageB.id, type: 'AOSR', number: 'B-1', documentDate: dt(0), fileId: doc.id }, ptoToken, [201, 400]),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [201, 400], 'exactly one object wins first use of the attachment; the other is rejected by the object-boundary rule — never both 201');

    const c = new Client({ connectionString: DATABASE_URL });
    await c.connect();
    try {
      const refs = await c.query('SELECT object_id FROM executive_documents WHERE tenant_id=$1 AND file_id=$2', [A.tenantId, doc.id]);
      assert.equal(refs.rows.length, 1, 'the attachment is never simultaneously referenced as an ordinary file by two objects');
    } finally {
      await c.end();
    }

    // Same-object reuse (the winner's own object) keeps working, concurrently or successively.
    const winnerPackage = r1.status === 201 ? packageA : packageB;
    const secondDocSameObject = await req('executive-documents', { packageId: winnerPackage.id, type: 'AOSR', number: 'same-object-2', documentDate: dt(0), fileId: doc.id }, ptoToken, 201);
    assert.equal(secondDocSameObject.status, 201, 'reuse under the SAME object that already won must keep working');
  } finally {
    await app.close();
  }
});

test('FINAL-R03: two concurrent first-uses of one unattached inspection photo under different objects — exactly one wins; material-passport cross-object reuse is unaffected', async () => {
  const { app, req, login } = await harness('f12-r03-photo-key');
  try {
    const A = await makeObjectAndWork(req, login, 'F12R03PHOTOA-' + Date.now());
    const B = await makeObjectAndWork(req, login, 'F12R03PHOTOB-' + Date.now());
    const pmTokenA = await login('PROJECT_MANAGER');
    let workA = (await req(`works/${A.work.id}/progress`, { totalQuantity: 500, version: A.work.version, comment: 'Готово' }, pmTokenA, 201)).data;
    let workB = (await req(`works/${B.work.id}/progress`, { totalQuantity: 500, version: B.work.version, comment: 'Готово' }, pmTokenA, 201)).data;
    const inspectionA = (await req(`works/${workA.id}/inspection-request`, { version: workA.version }, pmTokenA, 201)).data;
    const inspectionB = (await req(`works/${workB.id}/inspection-request`, { version: workB.version }, pmTokenA, 201)).data;

    const ccToken = await login('CONSTRUCTION_CONTROL');
    const photo = (await req('attachments', { fileName: 'race.png', mimeType: 'image/png', base64: PNG_BASE64 }, ccToken, 201)).data;

    const [r1, r2] = await withRowLockBarrier('attachments', A.tenantId, photo.id, () => [
      req(`inspections/${inspectionA.id}/photos`, { attachmentId: photo.id }, ccToken, [201, 400]),
      req(`inspections/${inspectionB.id}/photos`, { attachmentId: photo.id }, ccToken, [201, 400]),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [201, 400], 'exactly one object wins first use of the photo; the other is rejected — never both 201');

    const c = new Client({ connectionString: DATABASE_URL });
    await c.connect();
    try {
      const refs = await c.query('SELECT id FROM inspection_photos WHERE tenant_id=$1 AND attachment_id=$2', [A.tenantId, photo.id]);
      assert.equal(refs.rows.length, 1, 'the photo is never simultaneously referenced as ordinary evidence by two objects');
    } finally {
      await c.end();
    }

    // The locked material-passport/certificate exception is unaffected by
    // FINAL-R03's fix: the same physical passport still binds freely across
    // both (unrelated) objects, concurrently.
    const ptoToken = await login('PTO');
    const passport = (await req('attachments', { fileName: 'passport.pdf', mimeType: 'application/pdf', base64: PDF_BASE64 }, ptoToken, 201)).data;
    const [pA, pB] = await Promise.all([
      req('materials/bind', { objectWorkId: A.work.id, name: 'Арматура А500С', manufacturer: 'Завод', batchNumber: 'П-A', quantity: 5, documentNumber: 'ПС-A', fileId: passport.id, validUntil: dt(365) }, ptoToken, 201),
      req('materials/bind', { objectWorkId: B.work.id, name: 'Арматура А500С', manufacturer: 'Завод', batchNumber: 'П-B', quantity: 5, documentNumber: 'ПС-B', fileId: passport.id, validUntil: dt(365) }, ptoToken, 201),
    ]);
    assert.equal(pA.status, 201);
    assert.equal(pB.status, 201);
  } finally {
    await app.close();
  }
});
