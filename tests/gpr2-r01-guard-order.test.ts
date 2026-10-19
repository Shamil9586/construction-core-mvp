import './helpers/gpr2-isolation'; // FIRST: no backend module may load before the environment is pinned to in-memory PGlite
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { endpointById, ESTIMATE_MAPPING_REVIEW, isInputFingerprint, type CapabilityAssignment, type CommandResult } from '../packages/domain/gpr2';
import type { Gpr2CommandContext, Gpr2Hooks } from '../apps/backend/src/gpr2-command-guard';
import { assertInMemoryPool } from './helpers/gpr2-isolation';
import { gpr2Harness, validRequest, pilotScenario, KEY, uuid, type Gpr2Harness } from './helpers/gpr2-fixtures';
import { actorByRole, assignPtoToObject } from './helpers/pbx3-fixtures';
import type { Pilot } from './helpers/gpr-fixtures';

/**
 * GPR-2 R01 — the order of the command pipeline, proved with spies (TD §12.4, A19 "no cached-response privilege leak").
 * authenticate → permission → path ids + scope → envelope → replay → execute. Nothing after a failed step may run; in particular a stored result
 * (replay) is never even LOOKED UP for a caller who is not authorised, in scope and well formed.
 */
let g: Gpr2Harness;
let pilot: Pilot;
before(async () => { g = await gpr2Harness('gpr2-r01-order-key'); pilot = await pilotScenario(g.h); assert.equal(await assertInMemoryPool(), true); });
after(async () => { await g?.h.close(); });

const RESULT: CommandResult = { commandId: uuid(), resultIds: [], appliedVersions: { aggregate: '2', scope: null }, warnings: [] };
function spies(replayResult: CommandResult | null = null) {
  const calls: string[] = [], seen: Gpr2CommandContext[] = [];
  const hooks: Gpr2Hooks = {
    replay: async ctx => { calls.push('replay'); seen.push(ctx); return replayResult; },
    execute: async ctx => { calls.push('execute'); seen.push(ctx); return RESULT; }
  };
  return { hooks, calls, seen };
}
// The РП actor is the OWNER of the pilot object (the seeded РП is not necessarily the earliest РП row); every other role is any active user of it.
const actor = async (role: string) => role === 'PROJECT_MANAGER'
  ? (await import('../apps/backend/src/db')).one((await import('../apps/backend/src/db')).pool, 'SELECT * FROM users WHERE id=$1', [pilot.pm.id])
  : actorByRole(role);
const guard = () => import('../apps/backend/src/gpr2-command-guard');
const input = async (id: string, role: string, params: Record<string, string>, tweak: (r: ReturnType<typeof validRequest>) => void = () => {}) => {
  const e = endpointById(id)!, req = validRequest(e, params); tweak(req);
  return { e, run: async (hooks: Gpr2Hooks, assignments?: readonly CapabilityAssignment[], who?: any) =>
    (await guard()).runGpr2Command(e, { actor: who ?? await actor(role), params, headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v])), body: req.body }, hooks, assignments) };
};
const code = async (p: Promise<unknown>) => { try { await p; return 'NO ERROR'; } catch (e: any) { return e.code ?? 'UNEXPECTED:' + e.message; } };
// the router supplies every path parameter in HTTP; a direct call must too — a missing or malformed aggregate id is a 404, never a pass
const at = (objectId: string) => ({ objectId, id: uuid() });
const own = () => at(pilot.object.id);

test('an unauthorised caller reaches NEITHER hook — the stored result of a command is never looked up for them (no cached-response leak)', async () => {
  for (const [id, role] of [['schedule.revision.approve', 'PROJECT_MANAGER'], ['schedule.revision.submit', 'DEPUTY_DIRECTOR'], ['schedule.revision.submit', 'ADMIN'], ['quantity.request.approve', 'PTO'], ['work-type.publication.approve', 'DEPUTY_DIRECTOR']]) {
    const s = spies(RESULT);
    const { run } = await input(id, role, own());
    assert.equal(await code(run(s.hooks)), 'PERMISSION_DENIED', `${role} × ${id}`);
    assert.deepEqual(s.calls, [], `${role} × ${id}: not a single hook ran, although a stored result existed`);
  }
});

test('an out-of-scope caller reaches neither hook either (404), even with the right role and a perfect request', async () => {
  const s = spies(RESULT);
  const { run } = await input('schedule.revision.submit', 'PROJECT_MANAGER', at(pilot.neighbour.id));
  assert.equal(await code(run(s.hooks)), 'RESOURCE_NOT_FOUND');
  assert.deepEqual(s.calls, []);
  for (const objectId of [uuid(), 'nope']) {
    const t = spies(RESULT);
    assert.equal(await code((await input('schedule.revision.approve', 'DEPUTY_DIRECTOR', at(objectId))).run(t.hooks)), 'RESOURCE_NOT_FOUND');
    assert.deepEqual(t.calls, []);
  }
});

test('a malformed envelope reaches neither hook (422)', async () => {
  const s = spies(RESULT);
  const { run } = await input('schedule.revision.submit', 'PROJECT_MANAGER', own(), r => { r.body.expectedVersion = 3; delete r.headers['Idempotency-Key']; });
  assert.equal(await code(run(s.hooks)), 'VALIDATION_FAILED');
  assert.deepEqual(s.calls, []);
});

test('authorised, in scope, well formed: replay is consulted FIRST and only then execute; a stored result short-circuits execute', async () => {
  const miss = spies(null);
  const { run } = await input('schedule.revision.submit', 'PROJECT_MANAGER', own());
  assert.deepEqual(await run(miss.hooks), RESULT);
  assert.deepEqual(miss.calls, ['replay', 'execute']);
  const hit = spies(RESULT);
  assert.deepEqual(await run(hit.hooks), RESULT);
  assert.deepEqual(hit.calls, ['replay'], 'a replay hit never executes the command a second time');
});

test('the context handed to the stage carries what it needs and nothing unvalidated: canonical ids, parsed tokens, a fingerprint independent of the key', async () => {
  const s = spies();
  const upper = at(pilot.object.id.toUpperCase());
  await (await input('schedule.revision.submit', 'PROJECT_MANAGER', upper)).run(s.hooks);
  const ctx = s.seen[0];
  assert.equal(ctx.objectId, pilot.object.id.toLowerCase(), 'the object id is canonical');
  assert.equal(ctx.endpoint.id, 'schedule.revision.submit');
  assert.deepEqual([ctx.command.expectedVersion, ctx.command.expectedScopeVersion, ctx.command.idempotencyKey], ['1', '1', KEY(1)]);
  assert.ok(isInputFingerprint(ctx.fingerprint));
  // the same command under another key has the same fingerprint (it says "same command", not "same request")...
  const again = spies(); await (await input('schedule.revision.submit', 'PROJECT_MANAGER', own(), r => { r.headers['Idempotency-Key'] = KEY(2); })).run(again.hooks);
  assert.equal(again.seen[0].fingerprint, ctx.fingerprint);
  // ...and a changed payload, token or command changes it
  const other = spies(); await (await input('schedule.revision.submit', 'PROJECT_MANAGER', own(), r => { (r.body.payload as any).changeReason = 'другое'; })).run(other.hooks);
  assert.notEqual(other.seen[0].fingerprint, ctx.fingerprint);
  const stale = spies(); await (await input('schedule.revision.submit', 'PROJECT_MANAGER', own(), r => { r.body.expectedVersion = '2'; })).run(stale.hooks);
  assert.notEqual(stale.seen[0].fingerprint, ctx.fingerprint);
});

test('default hooks: an authorised, in-scope, well-formed call is refused as COMMAND_NOT_ENABLED and nothing is replayed', async () => {
  assert.equal(await code((await input('schedule.revision.submit', 'PROJECT_MANAGER', own())).run((await guard()).DISABLED_HOOKS)), 'COMMAND_NOT_ENABLED');
});

test('only commands with a GPR-2 authorization can enter the pipeline — a query or an "existing rules" command is a programming error, not a silent pass', async () => {
  const s = spies();
  for (const id of ['works.create', 'schedule.current', 'works.assignments.patch'])
    await assert.rejects((await guard()).runGpr2Command(endpointById(id)!, { actor: await actor('ADMIN'), params: own(), headers: {}, body: {} }, s.hooks), /not a command with a GPR-2 authorization/);
  assert.deepEqual(s.calls, []);
});

test('N01: the capability is never implied; once the owner decides and an assignment exists it opens exactly that object for exactly that user — and does not widen scope', async () => {
  const pto = await actor('PTO');
  const a: CapabilityAssignment = { tenantId: pto.tenantId, objectId: pilot.object.id, userId: pto.id, capability: ESTIMATE_MAPPING_REVIEW, assignedBy: pilot.pm.id, assignedAt: '2026-10-19T00:00:00Z', revokedAt: null };
  const review = await input('imports.estimate-labor.mapping-reviews', 'PTO', own());
  const proposals = await input('imports.estimate-labor.mapping-proposals', 'PTO', own());
  const commit = await input('imports.estimate-labor.commit', 'PTO', own());
  // 1. no assignment (the default) — denied, whoever asks
  for (const r of [review, proposals]) { const s = spies(); assert.equal(await code(r.run(s.hooks)), 'PERMISSION_DENIED'); assert.deepEqual(s.calls, []); }
  // 2. an assignment alone is not enough: the user must also have access to the object (PTO membership, PBX-3A) — the capability does not widen scope
  for (const r of [review, proposals]) { const s = spies(); assert.equal(await code(r.run(s.hooks, [a])), 'RESOURCE_NOT_FOUND'); assert.deepEqual(s.calls, []); }
  await assignPtoToObject(pilot.object.id);
  // 3. assignment + object access: the specialist can review and propose — but the import COMMIT stays the РП's (capability ≠ import grant)
  for (const r of [review, proposals]) { const s = spies(); assert.deepEqual(await r.run(s.hooks, [a]), RESULT); assert.deepEqual(s.calls, ['replay', 'execute']); }
  { const s = spies(); assert.equal(await code(commit.run(s.hooks, [a])), 'PERMISSION_DENIED'); assert.deepEqual(s.calls, []); }
  // 4. revoked, another object, another user, another tenant — denied again
  for (const bad of [{ ...a, revokedAt: '2026-10-20T00:00:00Z' }, { ...a, objectId: pilot.neighbour.id }, { ...a, userId: pilot.pm.id }, { ...a, tenantId: uuid() }]) {
    const s = spies(); assert.equal(await code(review.run(s.hooks, [bad])), 'PERMISSION_DENIED', JSON.stringify(bad).slice(0, 80)); assert.deepEqual(s.calls, []);
  }
  // 5. the capability is not a role: a РП is not the specialist merely because they may propose
  const pmReview = await input('imports.estimate-labor.mapping-reviews', 'PROJECT_MANAGER', own());
  { const s = spies(); assert.equal(await code(pmReview.run(s.hooks)), 'PERMISSION_DENIED'); assert.deepEqual(s.calls, []); }
});
