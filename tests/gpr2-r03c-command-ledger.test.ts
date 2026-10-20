import './helpers/gpr2-isolation'; // FIRST: no backend module may load before the environment is pinned to in-memory PGlite
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { endpointById, type CommandResult } from '../packages/domain/gpr2';
import type { Gpr2CommandContext, Gpr2Hooks } from '../apps/backend/src/gpr2-command-guard';
import { gpr2Harness, validRequest, foreignTenantObject, KEY, uuid, type Gpr2Harness } from './helpers/gpr2-fixtures';
import { TrustedResources } from './helpers/gpr2-resources';
import { pilotScenario, type Pilot } from './helpers/gpr-fixtures';

/**
 * GPR-2 R03c — the command ledger (TD §12.4; scenarios A19 "authorisation before replay, no cached-response leak", A30 "aborted command leaves no
 * ledger success"). PGlite: ordering, scoping, mismatch, triggers. The race (two connections, same key) is gpr2-r03c-ledger-pg.test.ts.
 *
 * The commands here are PROBES wired through the real R01 pipeline (runGpr2Command) with the real ledger hooks; their only business effect is a row
 * in a scratch table written inside the command's transaction, so "the effect happened once" is a count.
 */
let g: Gpr2Harness;
let pilot: Pilot;
let db: any, guard: any, ledger: any, txc: any, coord: any;
const trusted = new TrustedResources();
const trace: string[] = [];
const endpoint = endpointById('schedule.revision.create')!;

before(async () => {
  g = await gpr2Harness('gpr2-r03c-key');
  pilot = await pilotScenario(g.h);
  db = await import('../apps/backend/src/db');
  guard = await import('../apps/backend/src/gpr2-command-guard');
  ledger = await import('../apps/backend/src/command-ledger');
  txc = await import('../apps/backend/src/tx-context');
  coord = await import('../apps/backend/src/coordination-lock');
  await db.pool.query('CREATE TABLE r03c_effects(id serial PRIMARY KEY, command_id uuid NOT NULL, actor_id uuid NOT NULL)');
});
after(async () => { await g?.h.close(); });

const effects = async () => (await db.pool.query('SELECT count(*)::int AS n FROM r03c_effects')).rows[0].n as number;
const ledgerRows = async () => (await db.pool.query('SELECT * FROM gpr2_command_ledger ORDER BY created_at')).rows as any[];
const actorOf = (id: string) => db.one(db.pool, 'SELECT * FROM users WHERE id=$1', [id]);

/** A command whose execute() is the ledgered probe. */
function hooks(opts: { failAfterEffect?: boolean; authorize?: () => Promise<void>; replaySpy?: string[] } = {}): Gpr2Hooks {
  return {
    resources: trusted,
    replay: async (ctx: Gpr2CommandContext) => { trace.push('pipeline:replay'); opts.replaySpy?.push('replay'); return ledger.ledgerReplayHook(db.pool)(ctx); },
    execute: async (ctx: Gpr2CommandContext): Promise<CommandResult> => {
      trace.push('pipeline:execute');
      const out = await txc.runCommandTx(async (tx: any) => {
        await coord.acquireCoordination(tx.c, ctx.actor.tenantId, ctx.objectId!, 'SHARED');
        return ledger.runLedgered(tx.c, ledger.ledgerCommandOf(ctx), {
          authorize: async () => { await opts.authorize?.(); },
          execute: async (commandId: string) => {
            await tx.c.query('INSERT INTO r03c_effects(command_id, actor_id) VALUES ($1,$2)', [commandId, ctx.actor.id]);
            if (opts.failAfterEffect) throw new Error('rule violated after the effect');
            return { resultIds: [commandId], appliedVersions: { aggregate: '1', scope: null }, warnings: [] };
          },
          trace: (phase: string) => trace.push('ledger:' + phase)
        });
      });
      return out.result;
    }
  };
}
async function call(who: any, key: number, h: Gpr2Hooks, body?: unknown, objectId = pilot.object.id) {
  const req = validRequest(endpoint, { objectId }, key);
  return guard.runGpr2Command(endpoint, { actor: who, params: { objectId }, headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v])), body: body ?? req.body }, h);
}
const code = async (p: Promise<unknown>) => { try { await p; return 'NO ERROR'; } catch (e: any) { return e.code ?? 'UNEXPECTED:' + e.message; } };

test('R03c first call runs once; a lost-response retry with the same key returns the SAME result and does not run again', async () => {
  const pm = await actorOf(pilot.pm.id);
  trace.length = 0;
  const before = await effects();
  const first = await call(pm, 1, hooks());
  assert.equal(await effects(), before + 1);
  assert.deepEqual(trace, ['pipeline:replay', 'pipeline:execute', 'ledger:authorize', 'ledger:claim', 'ledger:execute', 'ledger:complete'], 'look-up first (nothing there), then claim → execute → complete in one transaction');
  const rows = await ledgerRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, first.commandId, 'the ledger row IS the command id the client got');
  assert.deepEqual([rows[0].tenant_id, rows[0].actor_id, rows[0].command_kind, rows[0].scope_id, rows[0].idempotency_key], [pm.tenantId, pm.id, 'schedule.revision.create', pilot.object.id, KEY(1)]);
  assert.match(rows[0].fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(rows[0].result, first);

  trace.length = 0;
  const retry = await call(pm, 1, hooks());
  assert.deepEqual(retry, first, 'same result, same ids');
  assert.deepEqual(trace, ['pipeline:replay'], 'served from the ledger by the replay hook: execute was never reached');
  assert.equal(await effects(), before + 1, 'and nothing happened a second time');
  assert.equal((await ledgerRows()).length, 1);
});

test('R03c the same key with a different payload is 409 IDEMPOTENCY_PAYLOAD_MISMATCH and executes nothing', async () => {
  const pm = await actorOf(pilot.pm.id);
  const before = await effects();
  const changed = { payload: { note: 'другое содержание' } };
  assert.equal(await code(call(pm, 1, hooks(), changed)), 'IDEMPOTENCY_PAYLOAD_MISMATCH');
  assert.equal(await effects(), before);
  // key order and whitespace are not a different payload: the fingerprint is canonical
  const a = await call(pm, 21, hooks(), { payload: { b: 1, a: 2 } });
  const b = await call(pm, 21, hooks(), { payload: { a: 2, b: 1 } });
  assert.deepEqual(b, a);
});

test('R03c AUTHORISATION BEFORE REPLAY: a changed role, another actor or ADMIN holding the key gets no stored result — and the look-up is not even reached', async () => {
  const pm = await actorOf(pilot.pm.id);
  const stored = await call(pm, 2, hooks());
  // (a) the same actor, role changed since: the pipeline refuses before replay
  const spy: string[] = [];
  await db.pool.query("UPDATE users SET role='PTO' WHERE id=$1", [pm.id]);
  try {
    assert.equal(await code(call(await actorOf(pm.id), 2, hooks({ replaySpy: spy }))), 'PERMISSION_DENIED');
    assert.deepEqual(spy, [], 'the replay hook was never called for a caller who may no longer issue the command');
  }
  finally { await db.pool.query("UPDATE users SET role='PROJECT_MANAGER' WHERE id=$1", [pm.id]); }
  // (b) ADMIN knows the key and the aggregate; ADMIN holds no GPR-2 grant
  const admin = await db.one(db.pool, "SELECT * FROM users WHERE role='ADMIN' LIMIT 1");
  spy.length = 0;
  assert.equal(await code(call(admin, 2, hooks({ replaySpy: spy }))), 'PERMISSION_DENIED');
  assert.deepEqual(spy, []);
  // (c) another РП (authorised role, NOT this object's РП) holding the key: scope-safe 404, replay not reached
  const other = await actorOf(pilot.other.id);
  spy.length = 0;
  assert.equal(await code(call(other, 2, hooks({ replaySpy: spy }))), 'RESOURCE_NOT_FOUND');
  assert.deepEqual(spy, []);
  // (d) the owner again: still served
  assert.deepEqual(await call(await actorOf(pm.id), 2, hooks()), stored);
});

test('R03c a key is scoped by tenant, actor, command kind and aggregate: knowing it opens nothing, and it collides with nothing', async () => {
  const pm = await actorOf(pilot.pm.id);
  const base = await call(pm, 3, hooks());
  // the same key on another object (the neighbour РП's own object): another ledger row, another result
  const other = await actorOf(pilot.other.id);
  const theirs = await call(other, 3, hooks(), undefined, pilot.neighbour.id);
  assert.notEqual(theirs.commandId, base.commandId);
  // the same actor, the same key, another command kind: independent too
  const kinds = new Set((await ledgerRows()).filter(r => r.idempotency_key === KEY(3)).map(r => r.command_kind + '|' + r.scope_id + '|' + r.actor_id));
  assert.equal(kinds.size, 2);
});

test('A19 cross-tenant: another tenant\'s manager holding the key and this object\'s id gets the scope-safe 404 before any look-up; each tenant\'s ledger row is its own', async () => {
  const pm = await actorOf(pilot.pm.id);
  await call(pm, 8, hooks());
  const foreign = await foreignTenantObject();
  const stranger = await db.one(db.pool, 'SELECT * FROM users WHERE id=$1', [foreign.manager.id]);
  const spy: string[] = [];
  assert.equal(await code(call(stranger, 8, hooks({ replaySpy: spy }))), 'RESOURCE_NOT_FOUND', 'this tenant\'s object does not exist for them');
  assert.deepEqual(spy, [], 'and the stored result was never looked up');
  // in their OWN tenant the same key is simply a new command with its own row
  const own = await call(stranger, 8, hooks(), undefined, foreign.object.id);
  const rows = (await ledgerRows()).filter(r => r.idempotency_key === KEY(8));
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].tenant_id, rows[1].tenant_id);
  assert.ok(own.commandId);
  // the schema itself keeps the tenants apart: the actor of one tenant cannot be recorded against another (composite FK)
  await assert.rejects(() => db.pool.query("INSERT INTO gpr2_command_ledger(tenant_id,actor_id,command_kind,scope_id,idempotency_key,fingerprint) VALUES ($1,$2,'schedule.revision.create',$3,$4,$5)", [pm.tenantId, stranger.id, pilot.object.id, uuid(), 'a'.repeat(64)]), /foreign key|violates/);
});

test('A30 an aborted command leaves NO ledger row and NO effect; a later retry with the same key runs clean', async () => {
  const pm = await actorOf(pilot.pm.id);
  const effectsBefore = await effects(), rowsBefore = (await ledgerRows()).length;
  await assert.rejects(() => call(pm, 4, hooks({ failAfterEffect: true })), /rule violated after the effect/);
  assert.equal(await effects(), effectsBefore, 'the effect rolled back with the claim');
  assert.equal((await ledgerRows()).length, rowsBefore, 'no ledger row records a success that did not happen');
  const retry = await call(pm, 4, hooks());
  assert.equal(await effects(), effectsBefore + 1, 'the retry is a first execution, not a replay of a failure');
  assert.equal((await ledgerRows()).length, rowsBefore + 1);
  assert.equal(retry.resultIds.length, 1);
});

test('R03c the ledger runs authorize() FIRST, always — a refusal claims nothing and looks nothing up; a malformed result is rolled back', async () => {
  const pm = await actorOf(pilot.pm.id);
  const rowsBefore = (await ledgerRows()).length, effectsBefore = await effects();
  trace.length = 0;
  await assert.rejects(() => call(pm, 5, hooks({ authorize: async () => { throw new Error('revoked in the meantime'); } })), /revoked in the meantime/);
  assert.deepEqual(trace.filter(t => t.startsWith('ledger:')), ['ledger:authorize'], 'nothing after authorize ran');
  assert.equal((await ledgerRows()).length, rowsBefore);
  // a result that is not a CommandResult never reaches the table
  await assert.rejects(() => txc.runCommandTx(async (tx: any) => ledger.runLedgered(tx.c, { tenantId: pm.tenantId, actorId: pm.id, commandKind: 'schedule.revision.create', scopeId: pilot.object.id, idempotencyKey: KEY(6), fingerprint: 'b'.repeat(64) }, {
    authorize: async () => undefined, execute: async () => ({ resultIds: ['not-a-uuid'], appliedVersions: { aggregate: 'x', scope: null }, warnings: [] } as any)
  })));
  assert.equal((await ledgerRows()).length, rowsBefore);
  assert.equal(await effects(), effectsBefore);
});

test('R03c a command without a key is simply executed — no ledger row', async () => {
  const pm = await actorOf(pilot.pm.id);
  const rowsBefore = (await ledgerRows()).length;
  const out = await txc.runCommandTx((tx: any) => ledger.runLedgered(tx.c, { tenantId: pm.tenantId, actorId: pm.id, commandKind: 'schedule.revision.create', scopeId: pilot.object.id, idempotencyKey: null, fingerprint: 'c'.repeat(64) }, {
    authorize: async () => undefined, execute: async (id: string) => ({ resultIds: [id], appliedVersions: { aggregate: null, scope: null }, warnings: [] })
  }));
  assert.equal(out.replayed, false);
  assert.equal((await ledgerRows()).length, rowsBefore);
});

test('R03c inside the transaction a twin of a completed command is a replay: authorize → claim → compare → replay, no execute', async () => {
  const pm = await actorOf(pilot.pm.id);
  const cmd = { tenantId: pm.tenantId, actorId: pm.id, commandKind: 'schedule.revision.create', scopeId: pilot.object.id, idempotencyKey: KEY(7), fingerprint: 'd'.repeat(64) };
  const run = (fingerprint = cmd.fingerprint, seen: string[] = []) => txc.runCommandTx((tx: any) => ledger.runLedgered(tx.c, { ...cmd, fingerprint }, {
    authorize: async () => undefined, trace: (p: string) => seen.push(p),
    execute: async (id: string) => ({ resultIds: [id], appliedVersions: { aggregate: '3', scope: '9' }, warnings: [{ code: 'NOTE_ONE' }] })
  }));
  const first = await run();
  const seen: string[] = [];
  const second = await run(cmd.fingerprint, seen);
  assert.deepEqual(seen, ['authorize', 'claim', 'compare', 'replay']);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.result, first.result);
  await assert.rejects(() => run('e'.repeat(64)), (e: any) => e.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH');
});

test('R03c the table defends itself: completed rows are immutable, nothing is deleted, a claim cannot be committed without its result, identity cannot be rewritten', async () => {
  const pm = await actorOf(pilot.pm.id);
  const row = (await ledgerRows())[0];
  const fails = (sql: string, args: any[], re: RegExp) => assert.rejects(() => db.pool.query(sql, args), re);
  await fails("UPDATE gpr2_command_ledger SET result='{}'::jsonb WHERE id=$1", [row.id], /immutable/);
  await fails('DELETE FROM gpr2_command_ledger WHERE id=$1', [row.id], /append-only/);
  // a claim that never receives its result cannot survive COMMIT (deferred constraint trigger)
  await assert.rejects(() => txc.runCommandTx(async (tx: any) => { await tx.c.query("INSERT INTO gpr2_command_ledger(tenant_id,actor_id,command_kind,scope_id,idempotency_key,fingerprint) VALUES ($1,$2,'schedule.revision.create',$3,$4,$5)", [pm.tenantId, pm.id, pilot.object.id, uuid(), 'f'.repeat(64)]); }), /committed without a result/);
  // identity columns cannot be rewritten while a claim is open
  await assert.rejects(() => txc.runCommandTx(async (tx: any) => {
    const id = (await tx.c.query("INSERT INTO gpr2_command_ledger(tenant_id,actor_id,command_kind,scope_id,idempotency_key,fingerprint) VALUES ($1,$2,'schedule.revision.create',$3,$4,$5) RETURNING id", [pm.tenantId, pm.id, pilot.object.id, uuid(), '1'.repeat(64)])).rows[0].id;
    await tx.c.query("UPDATE gpr2_command_ledger SET fingerprint=$2 WHERE id=$1", [id, '2'.repeat(64)]);
  }), /only the result may be written onto a claim/);
  // shape checks
  await fails("INSERT INTO gpr2_command_ledger(tenant_id,actor_id,command_kind,scope_id,idempotency_key,fingerprint) VALUES ($1,$2,'Bad Kind',$3,$4,$5)", [pm.tenantId, pm.id, pilot.object.id, uuid(), 'a'.repeat(64)], /check constraint|command_kind/);
  await fails("INSERT INTO gpr2_command_ledger(tenant_id,actor_id,command_kind,scope_id,idempotency_key,fingerprint) VALUES ($1,$2,'schedule.revision.create',$3,$4,'short')", [pm.tenantId, pm.id, pilot.object.id, uuid()], /check constraint|fingerprint/);
  // a result and its completion time come together
  await fails("INSERT INTO gpr2_command_ledger(tenant_id,actor_id,command_kind,scope_id,idempotency_key,fingerprint,result) VALUES ($1,$2,'schedule.revision.create',$3,$4,$5,'{}'::jsonb)", [pm.tenantId, pm.id, pilot.object.id, uuid(), 'a'.repeat(64)], /check constraint/);
});

test('R03c the ledger scope helper: the aggregate when the path names one, else the object, else the tenant', () => {
  const mk = (id: string, params: Record<string, string>, objectId: string | null) => ledger.ledgerScopeId({ endpoint: endpointById(id)!, actor: { tenantId: 'T' }, objectId, params, command: {}, fingerprint: '' } as any);
  const o = uuid(), a = uuid();
  assert.equal(mk('schedule.revision.create', { objectId: o }, o), o.toLowerCase());
  assert.equal(mk('schedule.revision.submit', { objectId: o, id: a }, o), a.toLowerCase());
  assert.equal(mk('work-type.publication.approve', { id: a }, null), a.toLowerCase());
});
