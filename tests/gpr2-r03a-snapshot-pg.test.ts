import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { IsolatedDatabase, Session, createIsolatedDatabase, recordEvidence, scrubConnectionEnvironment, until } from './helpers/gpr2-native-pg';

/**
 * GPR-2 R03a on NATIVE PostgreSQL — scenario A30: "Не наблюдается current qty новой версии со старым pointer/allocations; aborted command не
 * оставляет ledger-success/partial data". Decision C16 ("несогласованные pool reads").
 *
 * The fixture is the shape the design is about: a current POINTER row and an append-only list of VERSIONS (quantity versions, approved revisions).
 * A writer moves the pointer and appends the new version in ONE transaction. A reader that makes two independent reads can see the new pointer with
 * the old version list (or the reverse) — a state that never existed. runSnapshotRead() cannot.
 */
let db: IsolatedDatabase;
let admin: Session;
before(async () => {
  scrubConnectionEnvironment();
  db = await createIsolatedDatabase('r03a');
  process.env.DB_MODE = 'postgres';
  process.env.DATABASE_URL = db.url;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'gpr2-r03a-pg';
  admin = await Session.open(db.url, 'admin');
  await admin.query('CREATE TABLE probe_pointer(id int PRIMARY KEY, version int NOT NULL)');
  await admin.query('CREATE TABLE probe_versions(version int PRIMARY KEY, qty numeric NOT NULL)');
  await admin.query('CREATE TABLE probe_effects(id serial PRIMARY KEY, note text)');
  await admin.query("INSERT INTO probe_versions VALUES (1, 1000)");
  await admin.query('INSERT INTO probe_pointer VALUES (1, 1)');
  recordEvidence('r03a-isolation', db.evidence);
});
after(async () => {
  await admin?.close();
  const { pool } = await import('../apps/backend/src/db');
  await pool.end();
  await db?.drop();
});

/** The writer: pointer and version move together, in one transaction, from a separate connection. */
async function approveNewVersion(version: number, qty: number) {
  const w = await Session.open(db.url, 'writer');
  try {
    await w.begin();
    await w.query('INSERT INTO probe_versions VALUES ($1,$2)', [version, qty]);
    await w.query('UPDATE probe_pointer SET version=$1 WHERE id=1', [version]);
    await w.commit();
  }
  finally {
    await w.close();
  }
}

test('A30 two independent reads straddling a commit see a state that never existed; a snapshot read cannot', async () => {
  const { pool, rows } = await import('../apps/backend/src/db');
  const { runSnapshotRead } = await import('../apps/backend/src/tx-context');

  // The defect, demonstrated: pointer read BEFORE the commit, version list read AFTER it.
  const pointerBefore = (await rows(pool, 'SELECT version FROM probe_pointer WHERE id=1'))[0].version;
  await approveNewVersion(2, 800);
  const versionsAfter = (await rows(pool, 'SELECT version,qty FROM probe_versions ORDER BY version')).map((r: any) => r.version);
  assert.equal(pointerBefore, 1);
  assert.deepEqual(versionsAfter, [1, 2], 'independent reads: old pointer 1 next to a list that already holds version 2');
  assert.ok(!versionsAfter.every((v: number) => v <= pointerBefore), 'this combination (pointer older than the newest version it was read with) never existed in the database');

  // The cure, with the commit landing BETWEEN the two statements of the snapshot, forced by a barrier.
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  let enteredBetween!: () => void;
  const between = new Promise<void>(r => (enteredBetween = r));
  const reader = runSnapshotRead(async tx => {
    const pointer = (await tx.c.query('SELECT version FROM probe_pointer WHERE id=1')).rows[0].version;
    enteredBetween();
    await gate; // the writer commits now
    const versions = (await tx.c.query('SELECT version FROM probe_versions ORDER BY version')).rows.map((r: any) => r.version);
    return { pointer, versions };
  });
  await between;
  await approveNewVersion(3, 700);
  release();
  const seen = await reader;
  assert.deepEqual(seen, { pointer: 2, versions: [1, 2] }, 'the snapshot holds the pointer and the list of ONE moment — version 3 committed in between and is invisible to the whole read');
  const live = (await rows(pool, 'SELECT version FROM probe_pointer WHERE id=1'))[0].version;
  assert.equal(live, 3, 'and the commit really happened');
  recordEvidence('r03a-snapshot', { independentReads: { pointer: pointerBefore, versions: versionsAfter }, snapshotRead: seen, commitLandedBetween: true, livePointerAfter: live });
});

test('A30 an aborted command leaves no partial data — including when the failure is the COMMIT itself', async () => {
  const { pool, rows } = await import('../apps/backend/src/db');
  const { runCommandTx } = await import('../apps/backend/src/tx-context');
  const count = async () => (await rows(pool, 'SELECT count(*)::int AS n FROM probe_effects'))[0].n;
  const base = await count();
  await assert.rejects(() => runCommandTx(async tx => { await tx.c.query("INSERT INTO probe_effects(note) VALUES ('a'),('b')"); await tx.c.query('UPDATE probe_pointer SET version=99 WHERE id=1'); throw new Error('rule violated after two writes'); }), /rule violated/);
  assert.equal(await count(), base, 'no effect row survived');
  assert.notEqual((await rows(pool, 'SELECT version FROM probe_pointer WHERE id=1'))[0].version, 99, 'and the pointer did not move');

  // a deferred constraint that fails at COMMIT: the whole command is rolled back and the error surfaces
  await admin.query('CREATE TABLE probe_deferred(id int PRIMARY KEY, parent int, CONSTRAINT probe_fk FOREIGN KEY (parent) REFERENCES probe_pointer(id) DEFERRABLE INITIALLY DEFERRED)');
  await assert.rejects(() => runCommandTx(async tx => { await tx.c.query("INSERT INTO probe_effects(note) VALUES ('c')"); await tx.c.query('INSERT INTO probe_deferred VALUES (1, 424242)'); }), /probe_fk|foreign key/);
  assert.equal(await count(), base, 'the failed COMMIT rolled the effect back too');
  // and the pool is healthy afterwards
  await runCommandTx(async tx => { await tx.c.query("INSERT INTO probe_effects(note) VALUES ('ok')"); });
  assert.equal(await count(), base + 1);
});

test('A30 a real serialization failure is retried — bounded, with the same command, applying its effect exactly once', async () => {
  const { runCommandTx } = await import('../apps/backend/src/tx-context');
  const { pool, rows } = await import('../apps/backend/src/db');
  await admin.query('CREATE TABLE probe_counter(id int PRIMARY KEY, n int NOT NULL)');
  await admin.query('INSERT INTO probe_counter VALUES (1, 0)');

  const attempts: number[] = [];
  let reachedRead!: () => void;
  const read = new Promise<void>(r => (reachedRead = r));
  let go!: () => void;
  const proceed = new Promise<void>(r => (go = r));
  const command = runCommandTx(async tx => {
    attempts.push(tx.attempt);
    const n = (await tx.c.query('SELECT n FROM probe_counter WHERE id=1')).rows[0].n; // takes the REPEATABLE READ snapshot
    if (tx.attempt === 1) { reachedRead(); await proceed; } // a competitor commits while attempt 1 holds its snapshot
    await tx.c.query('UPDATE probe_counter SET n=$1 WHERE id=1', [n + 10]); // attempt 1: 40001 could not serialize access due to concurrent update
    return n + 10;
  }, { isolation: 'REPEATABLE READ', maxAttempts: 3 });

  await read;
  const competitor = await Session.open(db.url, 'competitor');
  await competitor.query('UPDATE probe_counter SET n=n+1 WHERE id=1'); // autocommit
  await competitor.close();
  go();
  const result = await command;
  assert.deepEqual(attempts, [1, 2], 'attempt 1 failed with 40001, attempt 2 ran on a fresh snapshot');
  assert.equal(result, 11, 'attempt 2 read the competitor\'s 1 and added 10');
  assert.equal((await rows(pool, 'SELECT n FROM probe_counter WHERE id=1'))[0].n, 11, 'the effect was applied once, on top of the competitor\'s');

  // unbounded retry would be a loop: with maxAttempts 1 the same collision is reported, once
  let reached2!: () => void;
  const read2 = new Promise<void>(r => (reached2 = r));
  let go2!: () => void;
  const proceed2 = new Promise<void>(r => (go2 = r));
  const once = runCommandTx(async tx => {
    const n = (await tx.c.query('SELECT n FROM probe_counter WHERE id=1')).rows[0].n;
    reached2(); await proceed2;
    await tx.c.query('UPDATE probe_counter SET n=$1 WHERE id=1', [n + 10]);
  }, { isolation: 'REPEATABLE READ' });
  await read2;
  const c2 = await Session.open(db.url, 'competitor2');
  await c2.query('UPDATE probe_counter SET n=n+1 WHERE id=1');
  await c2.close();
  go2();
  await assert.rejects(() => once, (e: any) => e.code === '40001');
  assert.equal((await rows(pool, 'SELECT n FROM probe_counter WHERE id=1'))[0].n, 12, 'the failed attempt changed nothing');
  recordEvidence('r03a-serialization-retry', { attempts, result });
});

test('R03a the pool guard on a real node-postgres pool', async () => {
  const { pool, NestedPoolAccessError } = await import('../apps/backend/src/db');
  const { runCommandTx } = await import('../apps/backend/src/tx-context');
  await runCommandTx(async () => {
    assert.throws(() => pool.query('SELECT 1'), (e: any) => e instanceof NestedPoolAccessError);
    assert.throws(() => pool.connect(), (e: any) => e instanceof NestedPoolAccessError);
  });
  assert.equal((await pool.query('SELECT 1 AS x')).rows[0].x, 1);
  await until(async () => true, 'noop');
});
