import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { IsolatedDatabase, Session, advisoryHolders, createIsolatedDatabase, recordEvidence, scrubConnectionEnvironment, settle, sleep, until, waitUntilBlocked } from './helpers/gpr2-native-pg';

/**
 * GPR-2 R03b on NATIVE PostgreSQL — the object coordination lock (TD §12.3), scenarios A06 / A19 / A30.
 * Every race here is staged with a BARRIER THAT POSTGRESQL ITSELF REPORTS (pg_locks / pg_stat_activity), never with a sleep that hopes:
 * a participant is proved blocked before the lock it waits for is released, and proved to have run strictly after.
 */
let db: IsolatedDatabase;
let observer: Session;
let m: { acquireCoordination: any; coordinationKey: any; CoordinationError: any; heldCoordination: any };
let dbm: any;
const timeline: { t: number; event: string }[] = [];
const T0 = Date.now();
const log = (event: string) => timeline.push({ t: Date.now() - T0, event });

before(async () => {
  scrubConnectionEnvironment();
  db = await createIsolatedDatabase('r03b');
  process.env.DB_MODE = 'postgres';
  process.env.DATABASE_URL = db.url;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'gpr2-r03b-pg';
  dbm = await import('../apps/backend/src/db');
  m = await import('../apps/backend/src/coordination-lock');
  const { migrate } = await import('../scripts/migrate');
  const { seed } = await import('../scripts/seed');
  await migrate();
  await seed();
  observer = await Session.open(db.url, 'observer');
  recordEvidence('r03b-isolation', db.evidence);
});
after(async () => {
  recordEvidence('r03b-timeline', timeline);
  await observer?.close();
  await dbm.pool.end();
  await sleep(300); // let the pool's sockets close before DROP DATABASE ... FORCE (an unhandled 'error' event otherwise, as the F8.3 suites found)
  await db?.drop();
});

const T1 = '11111111-1111-4111-8111-111111111111', T2 = '22222222-2222-4222-8222-222222222222';
const O1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', O2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** A raw session that is inside a transaction block (so the lock is legal) and marked as such. */
async function txSession(label: string): Promise<Session> {
  const s = await Session.open(db.url, label);
  await s.begin();
  dbm.markTransactionClient(s.client);
  return s;
}
const acquire = (s: Session, tenant: string, object: string, mode: 'SHARED' | 'EXCLUSIVE') => m.acquireCoordination(s.client, tenant, object, mode);
const holders = (tenant: string, object: string) => advisoryHolders(observer.client, m.coordinationKey(tenant, object));
const blockedAdvisoryPids = async () => (await observer.query("SELECT DISTINCT l.pid FROM pg_locks l WHERE l.locktype='advisory' AND NOT l.granted")).rows.map((r: any) => r.pid as number);
const pending = async <T>(p: Promise<T>) => { let done = false; p.then(() => (done = true), () => (done = true)); await sleep(50); return !done; };

test('R03b the key: deterministic, namespaced, per tenant and object, a signed 64-bit integer, never the migration lock', () => {
  const k = m.coordinationKey(T1, O1);
  assert.equal(k, m.coordinationKey(T1, O1.toUpperCase()), 'case-insensitive ids');
  assert.notEqual(k, m.coordinationKey(T1, O2));
  assert.notEqual(k, m.coordinationKey(T2, O1), 'the same object id in another tenant is another lock');
  assert.ok(k >= -(2n ** 63n) && k < 2n ** 63n);
  assert.notEqual(k, 830017n);
  assert.throws(() => m.coordinationKey('nope', O1), (e: any) => e.code === 'COORDINATION_BAD_ID');
});

test('R03b lock matrix on a real server: shared+shared coexist; exclusive waits for shared; a waiting exclusive holds later shared back; exclusive excludes all', async () => {
  // --- shared + shared ---------------------------------------------------------------------------------------------------
  const a = await txSession('a'), b = await txSession('b');
  assert.equal(await acquire(a, T1, O1, 'SHARED'), 'ACQUIRED');
  assert.equal(await acquire(b, T1, O1, 'SHARED'), 'ACQUIRED');
  assert.deepEqual((await holders(T1, O1)).map(h => [h.mode, h.granted]), [['ShareLock', true], ['ShareLock', true]], 'two shared holders, both granted');
  log('S+S coexist');

  // --- exclusive waits for the shared holders; shared requested AFTER the exclusive waits behind it ------------------------
  const x = await txSession('x');
  const xAcquire = acquire(x, T1, O1, 'EXCLUSIVE');
  await waitUntilBlocked(observer.client, x.pid, 'the exclusive request');
  log('X blocked behind two S');
  const c = await txSession('c');
  const cAcquire = acquire(c, T1, O1, 'SHARED');
  await waitUntilBlocked(observer.client, c.pid, 'a shared request behind a waiting exclusive');
  assert.equal(await pending(xAcquire), true);
  assert.equal(await pending(cAcquire), true);
  log('S queued behind the waiting X (no starvation of the exclusive)');
  await a.commit();
  assert.equal(await pending(xAcquire), true, 'one shared holder (b) still holds it');
  await b.rollback(); // a rollback releases it just the same
  await xAcquire;
  log('X granted after both S released (commit and rollback)');
  assert.equal(await pending(cAcquire), true, 'the later shared still waits while the exclusive holds');
  await x.commit();
  await cAcquire;
  log('S granted after X released');
  await c.commit();
  for (const s of [a, b, x, c]) await s.close();

  // --- exclusive excludes exclusive and shared ---------------------------------------------------------------------------
  const e1 = await txSession('e1');
  await acquire(e1, T1, O1, 'EXCLUSIVE');
  const e2 = await txSession('e2'), s3 = await txSession('s3');
  // the order of the requests matters (PostgreSQL queues them first-come): the second exclusive is requested and PROVED waiting before the shared one is
  const p2 = acquire(e2, T1, O1, 'EXCLUSIVE');
  await waitUntilBlocked(observer.client, e2.pid, 'second exclusive');
  const p3 = acquire(s3, T1, O1, 'SHARED');
  await waitUntilBlocked(observer.client, s3.pid, 'shared behind exclusive');
  await e1.client.end(); // the holder's CONNECTION dies without commit or rollback: the lock must go with it
  await p2;
  assert.equal(await pending(p3), true, 'the second exclusive now holds it; the shared still waits');
  await e2.commit();
  await p3;
  await s3.commit();
  for (const s of [e2, s3]) await s.close();
  log('X excludes X and S; a dead connection releases the lock');

  // --- other objects and other tenants never interact --------------------------------------------------------------------
  const o1 = await txSession('o1'), o2 = await txSession('o2'), t2 = await txSession('t2');
  await acquire(o1, T1, O1, 'EXCLUSIVE');
  const settledOthers = await Promise.race([Promise.all([acquire(o2, T1, O2, 'EXCLUSIVE'), acquire(t2, T2, O1, 'EXCLUSIVE')]).then(() => 'granted'), sleep(3000).then(() => 'timeout')]);
  assert.equal(settledOthers, 'granted', 'another object, and the same object id in another tenant, are not blocked by it');
  for (const s of [o1, o2, t2]) { await s.commit(); await s.close(); }
  log('independent objects / tenants do not interact');
  assert.deepEqual(await holders(T1, O1), [], 'no lock is left behind');
});

test('R03b a wait is bounded: when the lock is not granted in time the request fails with COORDINATION_TIMEOUT and leaves nothing behind', async () => {
  const holder = await txSession('timeout-holder');
  await acquire(holder, T1, O2, 'EXCLUSIVE');
  const waiter = await txSession('timeout-waiter');
  const t0 = Date.now();
  await assert.rejects(() => m.acquireCoordination(waiter.client, T1, O2, 'SHARED', { waitMs: 300 }), (e: any) => e.code === 'COORDINATION_TIMEOUT');
  const waited = Date.now() - t0;
  assert.ok(waited >= 250 && waited < 5000, 'it waited about the bound, not forever: ' + waited + 'ms');
  await waiter.rollback(); // the statement error aborted the transaction, as for any other error
  await waiter.close();
  assert.deepEqual((await holders(T1, O2)).map(h => [h.mode, h.granted]), [['ExclusiveLock', true]], 'the holder is untouched and nothing queued is left');
  // after a SUCCESSFUL acquisition the rest of the transaction waits as it always did (lock_timeout restored)
  const s = await txSession('restored');
  const before = (await s.query("SELECT current_setting('lock_timeout') AS v")).rows[0].v;
  await acquire(s, T2, O1, 'SHARED');
  assert.equal((await s.query("SELECT current_setting('lock_timeout') AS v")).rows[0].v, before);
  await s.rollback();
  await s.close();
  await holder.rollback();
  await holder.close();
});

test('R03b misuse is refused loudly and leaves no lock: after a row lock, a second object, an upgrade, outside a transaction', async () => {
  const { pool } = dbm;
  const work = (await pool.query('SELECT tenant_id,id,object_id FROM works LIMIT 1')).rows[0];
  // after a row lock: the coordination lock must come first (TD §12.3 item 2) — a package-first order can never be created by accident
  const s = await txSession('late');
  await s.query('SELECT 1 FROM works WHERE id=$1 FOR UPDATE', [work.id]);
  await assert.rejects(() => acquire(s, work.tenant_id, work.object_id, 'SHARED'), (e: any) => e.code === 'COORDINATION_AFTER_ROW_LOCK');
  assert.deepEqual(await holders(work.tenant_id, work.object_id), [], 'refusing took no lock');
  await s.rollback();
  await s.close();
  // a plain SELECT (resolving the object) does not assign a transaction id, so it may precede the lock
  const ok = await txSession('plain');
  await ok.query('SELECT object_id FROM works WHERE id=$1', [work.id]);
  assert.equal(await acquire(ok, work.tenant_id, work.object_id, 'SHARED'), 'ACQUIRED');
  assert.equal(await acquire(ok, work.tenant_id, work.object_id, 'SHARED'), 'ALREADY_HELD');
  await assert.rejects(() => acquire(ok, work.tenant_id, work.object_id, 'EXCLUSIVE'), (e: any) => e.code === 'COORDINATION_UPGRADE_FORBIDDEN');
  await assert.rejects(() => acquire(ok, work.tenant_id, O2, 'SHARED'), (e: any) => e.code === 'COORDINATION_OBJECT_MISMATCH');
  await ok.rollback();
  await ok.close();
  const strong = await txSession('strong');
  await acquire(strong, work.tenant_id, work.object_id, 'EXCLUSIVE');
  assert.equal(await acquire(strong, work.tenant_id, work.object_id, 'SHARED'), 'ALREADY_HELD', 'exclusive already covers shared');
  await strong.rollback();
  await strong.close();
  // outside a transaction block an advisory xact lock would vanish at the end of its own statement
  const bare = new Client({ connectionString: db.url });
  await bare.connect();
  await assert.rejects(() => m.acquireCoordination(bare, work.tenant_id, work.object_id, 'SHARED'), (e: any) => e.code === 'COORDINATION_NOT_IN_TRANSACTION');
  await bare.end();
});

test('R03b a POOLED connection reused by a later transaction takes the lock again (held state belongs to the transaction, not to the client object)', async () => {
  const { pool } = dbm;
  const work = (await pool.query('SELECT tenant_id,id,object_id FROM works LIMIT 1')).rows[0];
  const take = (mode: 'SHARED' | 'EXCLUSIVE') => dbm.transaction(async (c: any) => ({ result: await m.acquireCoordination(c, work.tenant_id, work.object_id, mode), held: m.heldCoordination(c)?.mode }));
  // first use of a pooled client, then it goes back to the pool
  assert.deepEqual(await take('SHARED'), { result: 'ACQUIRED', held: 'SHARED' });
  assert.deepEqual(await take('SHARED'), { result: 'ACQUIRED', held: 'SHARED' }, 'again ACQUIRED — never "ALREADY_HELD" inherited from the previous transaction on that connection');
  assert.deepEqual(await take('EXCLUSIVE'), { result: 'ACQUIRED', held: 'EXCLUSIVE' }, 'an earlier SHARED on the same connection does not count as an upgrade');
  // and it really blocks: another session holds EXCLUSIVE, the reused connection must wait
  const holder = await txSession('holder');
  await acquire(holder, work.tenant_id, work.object_id, 'EXCLUSIVE');
  let done = false;
  const reused = take('SHARED').then(r => { done = true; return r; });
  await until(async () => (await blockedAdvisoryPids()).length > 0, 'the reused pooled connection to be blocked on the coordination lock');
  assert.equal(done, false);
  await holder.commit();
  await holder.close();
  assert.deepEqual(await reused, { result: 'ACQUIRED', held: 'SHARED' });
});

// ------------------------------------------------------------------------------------------------------------------------------
// The real writers
// ------------------------------------------------------------------------------------------------------------------------------

async function fixtures() {
  const { pool, one } = dbm;
  const { ProductionService } = await import('../apps/backend/src/service');
  const service = new ProductionService();
  const tenant = (await one(pool, 'SELECT id FROM tenants LIMIT 1')).id;
  const object = await one(pool, "SELECT * FROM objects WHERE tenant_id=$1 AND external_code='DEMO-2026-004'", [tenant]);
  const pm = await one(pool, 'SELECT * FROM users WHERE id=$1', [object.projectManagerId]);
  return { service, tenant, object, pm, pool, one };
}
async function freshPortions(f: Awaited<ReturnType<typeof fixtures>>, workIndex: number, n: number) {
  const works = (await f.pool.query("SELECT * FROM works w WHERE tenant_id=$1 AND object_id=$2 AND actual_quantity=0 AND NOT EXISTS(SELECT 1 FROM work_dependencies d WHERE d.successor_work_id=w.id OR d.predecessor_work_id=w.id) ORDER BY name", [f.tenant, f.object.id])).rows;
  const w = works[workIndex];
  const unit = await f.service.createExecutionUnit(f.pm, { objectWorkId: w.id, workTypeId: w.work_type_id, contractorId: w.contractor_id, unit: w.unit, plannedQuantity: String(100 * n) });
  const portions = [];
  for (let i = 0; i < n; i++) portions.push(await f.service.createQuantityPortion(f.pm, unit.id, { label: 'P' + i, plannedQuantity: '100' }));
  return { work: w, unit, portions };
}

test('A06 an in-flight fact writer holds the SHARED lock; the scope-changing EXCLUSIVE waits for it, then runs alone — and the other way round', async () => {
  const f = await fixtures();
  const { work, portions } = await freshPortions(f, 0, 1);
  const portion = portions[0];

  // (1) a fact writer is stopped mid-transaction by a barrier on the portion row; it already holds SHARED
  const gate = await Session.open(db.url, 'gate');
  await gate.begin();
  await gate.query('SELECT 1 FROM quantity_portions WHERE id=$1 FOR UPDATE', [portion.id]);
  let writerDone = false;
  const writer = f.service.recordPortionFact(f.pm, portion.id, { quantity: '40', version: portion.version, comment: 'A06 writer' }).then(r => { writerDone = true; log('writer committed'); return r; });
  await until(async () => (await holders(f.tenant, f.object.id)).some(h => h.granted && h.mode === 'ShareLock'), 'the fact writer to hold the SHARED coordination lock');
  log('writer holds SHARED and waits on the portion row');
  assert.equal(writerDone, false);

  // (2) a quantity-reduction-shaped scope change asks for EXCLUSIVE: it must wait for the writer
  const scope = await txSession('scope-change');
  const xAcquire = acquire(scope, f.tenant, f.object.id, 'EXCLUSIVE');
  await waitUntilBlocked(observer.client, scope.pid, 'the exclusive scope change while a fact writer is in flight');
  log('X blocked while the fact writer is in flight');
  assert.equal(await pending(xAcquire), true);

  // (3) release the writer: it finishes, its shared lock goes, the exclusive proceeds
  await gate.commit();
  await gate.close();
  await writer;
  await xAcquire;
  log('X granted only after the writer committed');
  const factCountSeenByExclusive = (await scope.query('SELECT count(*)::int AS n FROM portion_quantity_confirmations WHERE portion_id=$1', [portion.id])).rows[0].n;
  assert.equal(factCountSeenByExclusive, 1, 'the exclusive transaction sees the committed fact: it ran strictly after the writer');
  assert.equal(writerDone, true);

  // (4) the other way round: while the exclusive holds, a new fact writer cannot start
  const secondFact = f.service.recordPortionFact(f.pm, portion.id, { quantity: '70', version: portion.version + 1, comment: 'A06 second' });
  let secondDone = false;
  secondFact.then(() => { secondDone = true; log('second writer committed'); }, () => { secondDone = true; });
  await until(async () => (await blockedAdvisoryPids()).length > 0, 'the second fact writer to be blocked on the coordination lock');
  log('second writer blocked behind X');
  assert.equal(secondDone, false);
  // inside the exclusive section: compute the protected floor, "write the new cap", and prove nothing slipped in meanwhile
  const floorBefore = (await scope.query("SELECT coalesce(sum(quantity),0)::text AS q FROM portion_quantity_confirmations WHERE portion_id=$1 AND source='RP_FACT'", [portion.id])).rows[0].q;
  await sleep(150);
  const floorAfter = (await scope.query("SELECT coalesce(sum(quantity),0)::text AS q FROM portion_quantity_confirmations WHERE portion_id=$1 AND source='RP_FACT'", [portion.id])).rows[0].q;
  assert.equal(floorAfter, floorBefore, 'no fact was recorded between computing the floor and committing the change (A06)');
  assert.equal(secondDone, false);
  await scope.commit();
  log('X committed');
  await scope.close();
  await secondFact;
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM portion_quantity_confirmations WHERE portion_id=$1", [portion.id])).rows[0].n, 2);
  const order = timeline.map(t => t.event);
  assert.ok(order.indexOf('X committed') < order.indexOf('second writer committed'), 'the second fact was recorded strictly after the scope change committed');
  assert.deepEqual(await holders(f.tenant, f.object.id), []);
  recordEvidence('r03b-a06', { work: work.id, portion: portion.id, floorBefore, floorAfter, timeline });
});

test('R03b all three EXCLUSIVE writers of the register (createWork, dependency, approveDraft) wait for an open scope-changing section — and shared writers wait with them — through the real services', async () => {
  const f = await fixtures();
  const { ScheduleService } = await import('../apps/backend/src/schedule-service');
  const schedule = new ScheduleService();
  const { portions } = await freshPortions(f, 1, 1);
  const portion = portions[0];
  const deputy = await f.one(f.pool, "SELECT * FROM users WHERE tenant_id=$1 AND role='DEPUTY_DIRECTOR' LIMIT 1", [f.tenant]);
  const probe = (await f.pool.query('SELECT * FROM works WHERE object_id=$1 ORDER BY name LIMIT 1', [f.object.id])).rows[0];
  const free = (await f.pool.query("SELECT id FROM works w WHERE tenant_id=$1 AND object_id=$2 AND actual_quantity=0 AND status='PLANNED' AND NOT EXISTS(SELECT 1 FROM work_dependencies d WHERE d.successor_work_id=w.id OR d.predecessor_work_id=w.id) AND NOT EXISTS(SELECT 1 FROM work_execution_units u WHERE u.object_work_id=w.id) ORDER BY name", [f.tenant, f.object.id])).rows;
  assert.ok(free.length >= 2, 'fixture: two untouched Works for the dependency');

  const held = await txSession('exclusive-holder');
  await acquire(held, f.tenant, f.object.id, 'EXCLUSIVE');
  const calls: Record<string, Promise<unknown>> = {
    'shared: recordPortionFact': f.service.recordPortionFact(f.pm, portion.id, { quantity: '10', version: portion.version, comment: 'x' }),
    'exclusive: createWork': f.service.createWork(f.pm, { objectId: f.object.id, workTypeId: probe.work_type_id, contractorId: probe.contractor_id, responsibleUserId: probe.responsible_user_id, name: 'R03b-new', unit: probe.unit, plannedQuantity: '10', estimatedCost: '1000', plannedStartDate: '2026-11-01', plannedFinishDate: '2026-11-10' }),
    'exclusive: dependency': f.service.dependency(f.pm, { predecessorWorkId: free[0].id, successorWorkId: free[1].id, requiresAcceptance: false, requiresDocument: false }),
    'exclusive: GPR-1 approveDraft': schedule.approveDraft(deputy, f.object.id, { version: 1 })
  };
  const outcome = new Map<string, 'pending' | 'settled'>(Object.keys(calls).map(k => [k, 'pending']));
  for (const [k, p] of Object.entries(calls)) p.then(() => outcome.set(k, 'settled'), () => outcome.set(k, 'settled'));
  await until(async () => (await blockedAdvisoryPids()).length >= 4, 'all four service writers to be blocked on the coordination lock');
  await sleep(100);
  assert.deepEqual([...outcome.values()], ['pending', 'pending', 'pending', 'pending'], 'none of them ran while the scope-changing section was open');
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM works WHERE name='R03b-new'")).rows[0].n, 0, 'no Work was generated');
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM work_dependencies WHERE predecessor_work_id=$1', [free[0].id])).rows[0].n, 0, 'no dependency was added');
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM portion_quantity_confirmations WHERE portion_id=$1', [portion.id])).rows[0].n, 0, 'no fact was recorded');
  await held.commit();
  await held.close();
  const settled = await Promise.all(Object.entries(calls).map(async ([k, p]) => [k, await settle(p)] as const));
  const byName = Object.fromEntries(settled);
  assert.equal(byName['shared: recordPortionFact'].ok, true);
  assert.equal(byName['exclusive: createWork'].ok, true);
  assert.equal(byName['exclusive: dependency'].ok, true);
  assert.equal(byName['exclusive: GPR-1 approveDraft'].ok, false, 'the approval then fails on its own business rule (there is no draft) — it was only waiting, not blocked from failing');
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM works WHERE name='R03b-new'")).rows[0].n, 1);
  recordEvidence('r03b-exclusive-writers', { blockedWhileHeld: Object.keys(calls), afterRelease: Object.fromEntries(settled.map(([k, r]) => [k, r.ok ? 'applied' : 'refused by its own rule'])) });
});

test('R03b stress: shared writers on many portions, exclusive sections and real service calls interleave without deadlock, lost write or timeout', async () => {
  const f = await fixtures();
  const { portions } = await freshPortions(f, 2, 6);
  let deadlocks = 0, exclusiveSections = 0;
  const rng = (() => { let s = 20261020; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; })();
  const jobs: Promise<unknown>[] = [];
  // every portion is its own writer, three facts in sequence (each reads the current version, as a real client does); the portions race one another
  for (const p of portions)
    jobs.push((async () => {
      for (let round = 0; round < 3; round++) {
        await sleep(Math.floor(rng() * 40));
        const version = (await f.pool.query('SELECT version FROM quantity_portions WHERE id=$1', [p.id])).rows[0].version;
        await f.service.recordPortionFact(f.pm, p.id, { quantity: String(10 * (round + 1)), version, comment: 'stress ' + round });
      }
    })().catch(e => { if (e?.code === '40P01') deadlocks++; throw e; }));
  // three scope-changing sections cut in at random moments
  for (let round = 0; round < 3; round++)
    jobs.push((async () => {
      await sleep(Math.floor(rng() * 80));
      const s = await txSession('stress-x' + round);
      try { await acquire(s, f.tenant, f.object.id, 'EXCLUSIVE'); await sleep(Math.floor(rng() * 30)); exclusiveSections++; await s.commit(); } finally { await s.close(); }
    })());
  const results = await Promise.all(jobs.map(j => settle(j)));
  const failed = results.filter(r => !r.ok);
  assert.equal(deadlocks, 0, 'no deadlock');
  assert.deepEqual(failed.map((r: any) => String(r.error?.message ?? r.error)), [], 'every operation completed');
  assert.equal(exclusiveSections, 3);
  const n = (await f.pool.query('SELECT count(*)::int AS n FROM portion_quantity_confirmations WHERE portion_id=ANY($1::uuid[])', [portions.map((p: any) => p.id)])).rows[0].n;
  assert.equal(n, 18, 'every fact was recorded exactly once');
  assert.deepEqual(await blockedAdvisoryPids(), []);
  recordEvidence('r03b-stress', { operations: jobs.length, factsRecorded: n, exclusiveSections, deadlocks });
});
