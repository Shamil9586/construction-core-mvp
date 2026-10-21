import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { IsolatedDatabase, Session, createIsolatedDatabase, recordEvidence, scrubConnectionEnvironment, settle, sleep, until, waitUntilBlocked } from './helpers/gpr2-native-pg';

/**
 * GPR-2 R03c on NATIVE PostgreSQL — the ledger under a real race (TD §12.4: "Lost response не создаёт второй quantity version/Work/source mapping.
 * DB uniqueness — последний guard, не замена command ledger"; scenario A30).
 *
 * The decisive property is that the SECOND request with the same key does not run its mutation concurrently and does not race to a unique violation:
 * its INSERT … ON CONFLICT DO NOTHING WAITS on the first transaction's uncommitted claim, PostgreSQL's own conflict check. Every wait below is observed
 * in pg_stat_activity before the first transaction is allowed to finish.
 */
let db: IsolatedDatabase;
let observer: Session;
let dbm: any, ledger: any, txc: any;
let tenantId: string, actorId: string, scopeId: string;
const timeline: string[] = [];

before(async () => {
  scrubConnectionEnvironment();
  db = await createIsolatedDatabase('r03c');
  process.env.DB_MODE = 'postgres';
  process.env.DATABASE_URL = db.url;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'gpr2-r03c-pg';
  dbm = await import('../apps/backend/src/db');
  ledger = await import('../apps/backend/src/command-ledger');
  txc = await import('../apps/backend/src/tx-context');
  const { migrate } = await import('../scripts/migrate');
  const { seed } = await import('../scripts/seed');
  await migrate();
  const tenant = await seed();
  tenantId = tenant.id;
  actorId = (await dbm.one(dbm.pool, "SELECT id FROM users WHERE tenant_id=$1 AND role='PROJECT_MANAGER' LIMIT 1", [tenantId])).id;
  scopeId = (await dbm.one(dbm.pool, 'SELECT id FROM objects WHERE tenant_id=$1 LIMIT 1', [tenantId])).id;
  await dbm.pool.query('CREATE TABLE probe_effects(id serial PRIMARY KEY, command_id uuid NOT NULL, note text)');
  observer = await Session.open(db.url, 'observer');
  recordEvidence('r03c-isolation', db.evidence);
});
after(async () => {
  recordEvidence('r03c-timeline', timeline);
  await observer?.close();
  await dbm.pool.end();
  await sleep(300); // let the pool's sockets close before DROP DATABASE ... FORCE
  await db?.drop();
});

const KEY = (n: number) => `${String(n).padStart(8, '0')}-3333-4333-8333-333333333333`;
const cmd = (n: number, fingerprint = 'a'.repeat(64)) => ({ tenantId, actorId, commandKind: 'schedule.revision.create', scopeId, idempotencyKey: KEY(n), fingerprint });
const effects = async () => (await dbm.pool.query('SELECT count(*)::int AS n FROM probe_effects')).rows[0].n as number;
const ledgerCount = async (n: number) => (await dbm.pool.query('SELECT count(*)::int AS n FROM gpr2_command_ledger WHERE idempotency_key=$1', [KEY(n)])).rows[0].n as number;

/** A ledgered command whose mutation can be held at a gate. */
function run(n: number, opts: { gate?: Promise<void>; entered?: () => void; fail?: boolean; fingerprint?: string; label: string }) {
  return txc.runCommandTx(async (tx: any) => ledger.runLedgered(tx.c, cmd(n, opts.fingerprint), {
    authorize: async () => undefined,
    execute: async (commandId: string) => {
      timeline.push(opts.label + ' executing');
      opts.entered?.();
      if (opts.gate) await opts.gate;
      await tx.c.query("INSERT INTO probe_effects(command_id, note) VALUES ($1,$2)", [commandId, opts.label]);
      if (opts.fail) throw new Error(opts.label + ' failed');
      timeline.push(opts.label + ' mutated');
      return { resultIds: [commandId], appliedVersions: { aggregate: '1', scope: null }, warnings: [] };
    }
  }));
}
const blockedPids = async () => (await observer.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND state='active' AND query LIKE 'INSERT INTO gpr2_command_ledger%'")).rows.map((r: any) => r.pid as number);

test('A30 two connections, one key, at the same time: the second WAITS in PostgreSQL, then replays the first\'s result — one effect, one command id', async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  let entered!: () => void;
  const inside = new Promise<void>(r => (entered = r));
  const first = run(1, { gate, entered, label: 'first' });
  await inside; // the first transaction has claimed the key and is stopped INSIDE its mutation
  timeline.push('first holds the claim');
  const second = run(1, { label: 'second' });
  let secondDone = false;
  second.then(() => (secondDone = true), () => (secondDone = true));
  await until(async () => (await blockedPids()).length === 1, 'the second request to be blocked on the first one\'s uncommitted ledger row');
  timeline.push('second blocked in INSERT … ON CONFLICT (observed in pg_stat_activity)');
  await sleep(100);
  assert.equal(secondDone, false, 'the second request did not run its mutation while the first was in flight');
  assert.equal(await effects(), 0, 'and nothing has been written yet');
  release();
  const a = await first;
  const b = await second;
  timeline.push('both finished');
  assert.equal(a.replayed, false);
  assert.equal(b.replayed, true, 'the second request is the lost-response retry: a replay');
  assert.deepEqual(b.result, a.result, 'same result, same command id');
  assert.equal(await effects(), 1, 'exactly one effect');
  assert.equal(await ledgerCount(1), 1);
  assert.deepEqual(timeline.filter(t => t.endsWith('executing')), ['first executing'], 'the second never executed');
});

test('A30 the first transaction ABORTS while the second waits: the claim vanishes with it and the second runs as a first execution', async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  let entered!: () => void;
  const inside = new Promise<void>(r => (entered = r));
  const first = settle(run(2, { gate, entered, fail: true, label: 'doomed' }));
  await inside;
  const second = run(2, { label: 'survivor' });
  await until(async () => (await blockedPids()).length === 1, 'the second request to wait for the doomed claim');
  release();
  const outcome = await first;
  assert.equal(outcome.ok, false);
  const result = await second;
  assert.equal(result.replayed, false, 'the failed attempt left no success behind, so this is a first execution');
  assert.equal(await effects(), 2, 'the doomed effect rolled back; only the survivor\'s exists (1 from the previous test + 1)');
  assert.equal(await ledgerCount(2), 1);
  assert.equal((await dbm.pool.query("SELECT count(*)::int AS n FROM probe_effects WHERE note='doomed'")).rows[0].n, 0);
});

test('A30 same key, DIFFERENT payload, concurrently: the loser is refused with IDEMPOTENCY_PAYLOAD_MISMATCH after the winner commits — nothing else executes', async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  let entered!: () => void;
  const inside = new Promise<void>(r => (entered = r));
  const winner = run(3, { gate, entered, label: 'winner', fingerprint: '1'.repeat(64) });
  await inside;
  const loser = settle(run(3, { label: 'loser', fingerprint: '2'.repeat(64) }));
  await until(async () => (await blockedPids()).length === 1, 'the conflicting request to wait');
  release();
  await winner;
  const lost = await loser;
  assert.equal(lost.ok, false);
  assert.equal((lost as any).error.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
  assert.equal((await dbm.pool.query("SELECT count(*)::int AS n FROM probe_effects WHERE note='loser'")).rows[0].n, 0);
});

test('R03c different keys do not wait for one another', async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  let entered!: () => void;
  const inside = new Promise<void>(r => (entered = r));
  const slow = run(4, { gate, entered, label: 'slow' });
  await inside;
  const quick = await Promise.race([run(5, { label: 'quick' }).then(() => 'done'), sleep(3000).then(() => 'timeout')]);
  assert.equal(quick, 'done', 'another key is not queued behind the first');
  release();
  await slow;
});

test('A30 many concurrent retries of ONE command: exactly one executes, all the others replay the same result', async () => {
  const before = await effects();
  const jobs = Array.from({ length: 8 }, (_, i) => run(6, { label: 'retry-' + i }));
  const results = await Promise.all(jobs);
  assert.equal(results.filter(r => !r.replayed).length, 1, 'one first execution');
  assert.equal(results.filter(r => r.replayed).length, 7);
  assert.equal(new Set(results.map(r => r.result.commandId)).size, 1, 'one command id');
  assert.equal(await effects(), before + 1);
  recordEvidence('r03c-concurrent-retries', { attempts: 8, executions: 1, replays: 7 });
});
