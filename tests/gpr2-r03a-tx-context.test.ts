import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/gpr2-isolation';

/**
 * GPR-2 R03a — the transaction context (PGlite). Decision C16; scenario A30.
 * The native-PostgreSQL counterpart (a real snapshot across a concurrent commit, a real serialization failure) is gpr2-r03a-snapshot-pg.test.ts.
 */
delete process.env.DATABASE_URL;
process.env.AUTH_MODE = 'mock';
process.env.MOCK_LOGIN_KEY = 'gpr2-r03a-key';
process.env.DB_MODE = 'pglite';
process.env.PGLITE_DIR = 'memory://';

async function load() {
  const db = await import('../apps/backend/src/db');
  const tx = await import('../apps/backend/src/tx-context');
  await db.pool.query('CREATE TABLE IF NOT EXISTS r03a_probe(id int PRIMARY KEY, note text)');
  await db.pool.query('DELETE FROM r03a_probe');
  return { ...db, ...tx };
}

test('R03a the shared pool is off limits inside a command and inside a snapshot read — directly and through the helpers', async () => {
  const { pool, rows, one, transaction, runCommandTx, runSnapshotRead, NestedPoolAccessError } = await load();
  const refused = (e: any) => e instanceof NestedPoolAccessError;
  await runCommandTx(async (tx: any) => {
    assert.throws(() => pool.query('SELECT 1'), refused, 'pool.query');
    assert.throws(() => pool.connect(), refused, 'pool.connect');
    await assert.rejects(() => rows(pool, 'SELECT 1'), refused, 'the rows() helper over the pool');
    await assert.rejects(() => one(pool, 'SELECT 1'), refused, 'the one() helper over the pool');
    await assert.rejects(() => transaction(async () => 1), refused, 'a nested transaction() — a second connection inside one business operation');
    // the context connection works, and so do helpers handed THAT connection
    assert.equal((await rows(tx.c, 'SELECT 1 AS x'))[0].x, 1);
    // the guard follows the async continuation, including concurrent branches and timers
    await Promise.all([1, 2].map(async () => { await new Promise(r => setTimeout(r, 1)); assert.throws(() => pool.query('SELECT 1'), refused); }));
  });
  await runSnapshotRead(async (tx: any) => {
    assert.throws(() => pool.query('SELECT 1'), refused);
    assert.equal((await rows(tx.c, 'SELECT 2 AS x'))[0].x, 2);
  });
  // outside any context the pool is exactly what it always was
  assert.equal((await rows(pool, 'SELECT 3 AS x'))[0].x, 3);
  assert.equal(await transaction(async c => (await c.query('SELECT 4 AS x')).rows[0].x), 4);
});

test('R03a a command commits as one unit and rolls back as one unit', async () => {
  const { pool, rows, runCommandTx } = await load();
  await runCommandTx(async (tx: any) => { await tx.c.query("INSERT INTO r03a_probe VALUES (1,'committed')"); await tx.c.query("INSERT INTO r03a_probe VALUES (2,'committed')"); });
  assert.equal((await rows(pool, 'SELECT * FROM r03a_probe')).length, 2);
  await assert.rejects(() => runCommandTx(async (tx: any) => { await tx.c.query("INSERT INTO r03a_probe VALUES (3,'doomed')"); throw new Error('business rule'); }), /business rule/);
  assert.deepEqual((await rows(pool, 'SELECT id FROM r03a_probe ORDER BY id')).map((r: any) => r.id), [1, 2], 'an aborted command leaves nothing');
  // the connection went back to the pool clean: the next command works
  await runCommandTx(async (tx: any) => { await tx.c.query("INSERT INTO r03a_probe VALUES (4,'after')"); });
  assert.equal((await rows(pool, 'SELECT count(*)::int AS n FROM r03a_probe'))[0].n, 3);
});

test('R03a a command sees its own writes; its writes are invisible outside until commit (one connection, one transaction)', async () => {
  const { runCommandTx } = await load();
  await runCommandTx(async (tx: any) => {
    await tx.c.query("INSERT INTO r03a_probe VALUES (10,'mine')");
    assert.equal((await tx.c.query('SELECT note FROM r03a_probe WHERE id=10')).rows[0].note, 'mine');
  });
});

test('R03a bounded retry: only PostgreSQL\'s own "try again" failures, with a hard ceiling; a business error is never retried', async () => {
  const { runCommandTx, MAX_ATTEMPTS_CEILING } = await load();
  const retryable = (code: string) => Object.assign(new Error('pg ' + code), { code });
  // 40001 once, then success: the callback is re-run on a fresh transaction and reports its attempt number
  const seen: number[] = [];
  const value = await runCommandTx(async (tx: any) => { seen.push(tx.attempt); if (tx.attempt === 1) throw retryable('40001'); return 'done'; }, { maxAttempts: 3 });
  assert.equal(value, 'done');
  assert.deepEqual(seen, [1, 2]);
  // deadlock_detected is retried too
  let n = 0;
  await runCommandTx(async () => { if (++n === 1) throw retryable('40P01'); }, { maxAttempts: 2 });
  assert.equal(n, 2);
  // default: no retry at all
  let once = 0;
  await assert.rejects(() => runCommandTx(async () => { once++; throw retryable('40001'); }), /40001/);
  assert.equal(once, 1);
  // persistent failure: bounded by what was asked
  let bounded = 0;
  await assert.rejects(() => runCommandTx(async () => { bounded++; throw retryable('40001'); }, { maxAttempts: 3 }), /40001/);
  assert.equal(bounded, 3);
  // ... and by the ceiling, whatever is asked
  let ceiling = 0;
  await assert.rejects(() => runCommandTx(async () => { ceiling++; throw retryable('40001'); }, { maxAttempts: 1000 }), /40001/);
  assert.equal(ceiling, MAX_ATTEMPTS_CEILING);
  // any other error is final on the first attempt (23505 unique violation, a plain Error, a Nest exception)
  for (const err of [retryable('23505'), new Error('plain'), retryable('57014')]) {
    let tries = 0;
    await assert.rejects(() => runCommandTx(async () => { tries++; throw err; }, { maxAttempts: 5 }));
    assert.equal(tries, 1);
  }
});

test('R03a a snapshot read is REPEATABLE READ and READ ONLY; a command is READ COMMITTED unless it asks for more', async () => {
  const { runCommandTx, runSnapshotRead } = await load();
  await runSnapshotRead(async (tx: any) => {
    assert.equal(tx.kind, 'SNAPSHOT_READ');
    assert.equal((await tx.c.query('SHOW transaction_isolation')).rows[0].transaction_isolation, 'repeatable read');
    assert.equal((await tx.c.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
    await assert.rejects(() => tx.c.query("INSERT INTO r03a_probe VALUES (99,'x')"), /read-only transaction/);
  });
  await runCommandTx(async (tx: any) => {
    assert.equal(tx.kind, 'COMMAND');
    assert.equal((await tx.c.query('SHOW transaction_isolation')).rows[0].transaction_isolation, 'read committed');
  });
  await runCommandTx(async (tx: any) => { assert.equal((await tx.c.query('SHOW transaction_isolation')).rows[0].transaction_isolation, 'serializable'); }, { isolation: 'SERIALIZABLE' });
});

test('R03a the context connection is a marked transaction client; the pool and a foreign object are not', async () => {
  const { pool, isTransactionClient, runCommandTx, transaction } = await load();
  assert.equal(isTransactionClient(pool), false);
  assert.equal(isTransactionClient({}), false);
  assert.equal(isTransactionClient(null), false);
  await runCommandTx(async (tx: any) => { assert.equal(isTransactionClient(tx.c), true); assert.equal(Object.isFrozen(tx), true, 'the context is frozen: nothing can swap its connection'); });
  await transaction(async c => { assert.equal(isTransactionClient(c), true, 'the legacy transaction() marks its client too'); });
});
