import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkUser, byRole, outboxFor, activeLead, isolate, emptyCmd } from './helpers/pbx5a-fixtures';

/**
 * PBX-5A — Bitrix24 notification foundation + object assignment notification. PGlite (service level).
 * No real Bitrix call is ever made: delivery uses a controlled transport, adapter tests mock global fetch.
 * Native-PostgreSQL concurrency / FK / SKIP LOCKED evidence is in pbx5a-bitrix-notifications-postgres.test.ts.
 * Nothing here claims distributed exactly-once delivery: one Core intent per source assignment + the SAME
 * deterministic TAG for every attempt (provider-side replacement / duplicate-state suppression).
 */
let ctx: any;
before(async () => {
  delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'pbx5a-key';
  process.env.DB_MODE = 'pglite';
  process.env.PGLITE_DIR = 'memory://';
  process.env.TOKEN_ENCRYPTION_KEY = '11'.repeat(32);
  process.env.BITRIX_CLIENT_ID = 'client';
  process.env.BITRIX_CLIENT_SECRET = 'secret';
  process.env.BITRIX_PORTAL = 'pbx5a.bitrix24.ru';
  const { migrate } = await import('../scripts/migrate');
  const { seed } = await import('../scripts/seed');
  const db = await import('../apps/backend/src/db');
  const { ObjectTeamService } = await import('../apps/backend/src/team-service');
  const outbox = await import('../apps/backend/src/bitrix-notification-outbox');
  const bitrix = await import('../apps/backend/src/bitrix');
  await migrate();
  const tenant = await seed();
  const deputy = await byRole(tenant.id, 'DEPUTY_DIRECTOR');
  const objects = (await db.rows(db.pool, 'SELECT id FROM objects WHERE tenant_id=$1 ORDER BY external_code', [tenant.id])).map((o: any) => o.id);
  ctx = { db, svc: new ObjectTeamService(), outbox, bitrix, tenant, deputy, objects };
});
const total = async () => Number((await ctx.db.pool.query('SELECT count(*)::int n FROM bitrix_notification_outbox')).rows[0].n);
const rejects = async (p: Promise<unknown>) => { try { await p; return null; } catch (e: any) { return e; } };
const rename = (id: string, name: string) => ctx.db.pool.query('UPDATE objects SET name=$2 WHERE id=$1', [id, name]);
const row = async (id: string) => ctx.db.one(ctx.db.pool, 'SELECT * FROM bitrix_notification_outbox WHERE id=$1', [id]);

test('A initial PTO lead assignment: one assignment, one intent, exact message from same-tenant objects.name', async () => {
  const obj = ctx.objects[0];
  await rename(obj, 'Объект А');
  const head = await mkUser(ctx.tenant.id, 'Начальник А', 'PTO_HEAD');
  const r = await ctx.svc.assignObjectLead(ctx.deputy, obj, { leadUserId: head.id });
  const rows = await outboxFor(obj);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recipientUserId, head.id);
  assert.equal(rows[0].sourceAssignmentId, r.lead.id);
  assert.equal(rows[0].message, 'Вы назначены начальником ПТО на объекте «Объект А».');
  assert.equal(rows[0].bitrixTag, 'CC5A:' + r.lead.id);
  assert.equal(rows[0].notificationType, 'OBJECT_FUNCTION_LEAD_ASSIGNED');
  assert.equal(rows[0].status, 'PENDING');
  assert.equal(rows[0].attemptCount, 0);
  assert.doesNotMatch(rows[0].message, /[0-9a-f]{8}-[0-9a-f]{4}/);
  const ext = (await ctx.db.one(ctx.db.pool, 'SELECT external_code, address FROM objects WHERE id=$1', [obj]));
  assert.ok(!rows[0].message.includes(ext.externalCode) && !rows[0].message.includes(ext.address));
  assert.equal((await ctx.db.pool.query("SELECT count(*)::int n FROM object_function_lead_assignments WHERE object_id=$1 AND ended_at IS NULL", [obj])).rows[0].n, 1);
});

test('A2 the object name is read from the SAME tenant (other tenant object name never used)', async () => {
  const obj = ctx.objects[1];
  await rename(obj, 'ЖК Северный, корпус 2');
  const head = await mkUser(ctx.tenant.id, 'Начальник Б', 'PTO_HEAD');
  await ctx.svc.assignObjectLead(ctx.deputy, obj, { leadUserId: head.id });
  assert.equal((await outboxFor(obj))[0].message, 'Вы назначены начальником ПТО на объекте «ЖК Северный, корпус 2».');
});

test('B replacement via assignObjectLead and via redistribute().leadChanges: new lead only, old lead gets nothing', async () => {
  // direct route primitive
  const obj = ctx.objects[2];
  const oldLead = await mkUser(ctx.tenant.id, 'Старый', 'PTO_HEAD'), newLead = await mkUser(ctx.tenant.id, 'Новый', 'PTO_HEAD');
  const first = await ctx.svc.assignObjectLead(ctx.deputy, obj, { leadUserId: oldLead.id });
  const second = await ctx.svc.assignObjectLead(ctx.deputy, obj, { leadUserId: newLead.id, reason: 'замена', expectedAssignmentId: first.lead.id, expectedVersion: first.lead.version });
  assert.ok((await ctx.db.one(ctx.db.pool, 'SELECT ended_at FROM object_function_lead_assignments WHERE id=$1', [first.lead.id])).endedAt, 'previous lead assignment ended');
  assert.equal(second.previousLead.id, first.lead.id);
  assert.equal((await activeLead(ctx.tenant.id, obj)).leadUserId, newLead.id);
  const rows = await outboxFor(obj);
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((r: any) => r.sourceAssignmentId === second.lead.id).length, 1);
  assert.equal(rows.find((r: any) => r.sourceAssignmentId === second.lead.id).recipientUserId, newLead.id);
  assert.equal(rows.filter((r: any) => r.recipientUserId === oldLead.id).length, 1, 'only the original assignment of the old lead');
  // redistribute path
  const obj2 = ctx.objects[3];
  const a = await mkUser(ctx.tenant.id, 'Старый2', 'PTO_HEAD'), b = await mkUser(ctx.tenant.id, 'Новый2', 'PTO_HEAD');
  await ctx.svc.assignObjectLead(ctx.deputy, obj2, { leadUserId: a.id });
  const res = await ctx.svc.redistribute(ctx.deputy, { reason: 'r', ...emptyCmd, leadChanges: [{ objectId: obj2, leadUserId: b.id }] });
  const rows2 = await outboxFor(obj2);
  assert.equal(rows2.length, 2);
  const created = rows2.find((r: any) => r.sourceAssignmentId === res.leadChanges[0].current.id);
  assert.equal(created.recipientUserId, b.id);
  assert.equal(rows2.filter((r: any) => r.recipientUserId === a.id).length, 1);
});

test('B2 single centralized trigger: leadChange() only; no route/controller or other service creates intents', () => {
  const svc = fs.readFileSync('apps/backend/src/team-service.ts', 'utf8');
  assert.equal(svc.match(/createLeadAssignedIntent\(/g)!.length, 1);
  const body = svc.slice(svc.indexOf('private async leadChange('), svc.indexOf('private async memberAdd('));
  assert.match(body, /createLeadAssignedIntent\(c, a\.tenantId, row\)/);
  const hits: string[] = [];
  const walk = (d: string) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = d + '/' + f.name; if (f.isDirectory()) walk(p); else if (/\.ts$/.test(f.name) && /createLeadAssignedIntent|bitrix_notification_outbox/.test(fs.readFileSync(p, 'utf8'))) hits.push(p); } };
  walk('apps/backend/src');
  assert.deepEqual(hits.sort(), ['apps/backend/src/bitrix-notification-outbox.ts', 'apps/backend/src/team-service.ts']);
});

test('C logical retry: repeated command and repeated intent creation never produce a second Core intent', async () => {
  const obj = ctx.objects[4];
  const head = await mkUser(ctx.tenant.id, 'Начальник C', 'PTO_HEAD');
  const r = await ctx.svc.assignObjectLead(ctx.deputy, obj, { leadUserId: head.id });
  assert.ok(await rejects(ctx.svc.assignObjectLead(ctx.deputy, obj, { leadUserId: head.id })));
  assert.ok(await rejects(ctx.svc.redistribute(ctx.deputy, { reason: 'r', ...emptyCmd, leadChanges: [{ objectId: obj, leadUserId: head.id }] })));
  assert.equal((await outboxFor(obj)).length, 1);
  // same source identity again => the existing row, verified, not a second one
  const again = await ctx.db.transaction((c: any) => ctx.outbox.createLeadAssignedIntent(c, ctx.tenant.id, r.lead));
  assert.equal(again.id, (await outboxFor(obj))[0].id);
  assert.equal((await outboxFor(obj)).length, 1);
  // same source identity but an inconsistent payload is refused, not silently accepted
  const other = await mkUser(ctx.tenant.id, 'Другой', 'PTO_HEAD');
  assert.ok(await rejects(ctx.db.transaction((c: any) => ctx.outbox.createLeadAssignedIntent(c, ctx.tenant.id, { ...r.lead, leadUserId: other.id }))));
  assert.equal((await outboxFor(obj)).length, 1);
});

test('E rejected / stale / unauthorized / invalid commands leave zero intents', async () => {
  const obj = ctx.objects[5];
  const before = await total();
  const head = await mkUser(ctx.tenant.id, 'Начальник E', 'PTO_HEAD');
  const pto = await byRole(ctx.tenant.id, 'PTO');
  assert.ok(await rejects(ctx.svc.assignObjectLead(pto, obj, { leadUserId: head.id })), 'unauthorized actor');
  assert.ok(await rejects(ctx.svc.assignObjectLead(ctx.deputy, obj, { leadUserId: pto.id })), 'target is not PTO_HEAD');
  const inactive = await mkUser(ctx.tenant.id, 'Неактивный', 'PTO_HEAD', undefined, false);
  assert.ok(await rejects(ctx.svc.assignObjectLead(ctx.deputy, obj, { leadUserId: inactive.id })), 'inactive target');
  assert.ok(await rejects(ctx.svc.assignObjectLead(ctx.deputy, obj, { leadUserId: '00000000-0000-4000-8000-000000000000' })), 'unknown target');
  assert.equal(await total(), before);
  assert.equal(await activeLead(ctx.tenant.id, obj), undefined);
  const first = await ctx.svc.assignObjectLead(ctx.deputy, obj, { leadUserId: head.id });
  const n = await total();
  const next = await mkUser(ctx.tenant.id, 'Следующий', 'PTO_HEAD');
  assert.ok(await rejects(ctx.svc.assignObjectLead(ctx.deputy, obj, { leadUserId: next.id, reason: 'x', expectedAssignmentId: '00000000-0000-4000-8000-000000000001', expectedVersion: first.lead.version })), 'stale expectedAssignmentId');
  assert.ok(await rejects(ctx.svc.assignObjectLead(ctx.deputy, obj, { leadUserId: next.id, reason: 'x', expectedAssignmentId: first.lead.id, expectedVersion: first.lead.version + 5 })), 'stale expectedVersion');
  assert.ok(await rejects(ctx.svc.assignObjectLead(ctx.deputy, obj, { leadUserId: next.id })), 'replacement without precondition');
  assert.equal(await total(), n);
  assert.equal((await activeLead(ctx.tenant.id, obj)).id, first.lead.id);
});

test('E2 redistribute: a later failure rolls back BOTH the new assignment and its intent', async () => {
  const obj = ctx.objects[6];
  const head = await mkUser(ctx.tenant.id, 'Начальник E2', 'PTO_HEAD');
  const stranger = await mkUser(ctx.tenant.id, 'Инженер', 'PTO');
  const n = await total();
  const err = await rejects(ctx.svc.redistribute(ctx.deputy, { reason: 'r', ...emptyCmd, leadChanges: [{ objectId: obj, leadUserId: head.id }], memberEnds: [{ objectId: obj, memberUserId: stranger.id }] }));
  assert.ok(err, 'memberEnd of a non-member fails after leadChange ran');
  assert.equal(await total(), n);
  assert.equal(await activeLead(ctx.tenant.id, obj), undefined);
  assert.equal((await ctx.db.pool.query("SELECT count(*)::int n FROM object_function_lead_assignments WHERE object_id=$1", [obj])).rows[0].n, 0);
});

test('I non-triggers: ORG-1 transfer, member add, member end, handover alone create no intent', async () => {
  const obj = ctx.objects[7];
  const head = await mkUser(ctx.tenant.id, 'Начальник I', 'PTO_HEAD'), head2 = await mkUser(ctx.tenant.id, 'Начальник I2', 'PTO_HEAD');
  const eng = await mkUser(ctx.tenant.id, 'Инженер I', 'PTO');
  await ctx.svc.assignObjectLead(ctx.deputy, obj, { leadUserId: head.id });
  const n = await total();
  await ctx.svc.assignOrgMember(ctx.deputy, { memberUserId: eng.id, managerUserId: head.id });
  const cur = await ctx.db.one(ctx.db.pool, 'SELECT id,version FROM functional_team_memberships WHERE member_user_id=$1 AND ended_at IS NULL', [eng.id]);
  await ctx.svc.assignOrgMember(ctx.deputy, { memberUserId: eng.id, managerUserId: head2.id, reason: 'перевод', expectedAssignmentId: cur.id, expectedVersion: cur.version });
  assert.equal(await total(), n, 'ORG-1 transfer');
  await ctx.svc.redistribute(ctx.deputy, { reason: 'r', ...emptyCmd, memberAdds: [{ objectId: obj, memberUserId: eng.id }] });
  assert.equal(await total(), n, 'member add');
  await ctx.svc.redistribute(ctx.deputy, { reason: 'r', ...emptyCmd, handovers: [{ objectId: obj, outgoingUserId: head.id, incomingUserId: eng.id }] });
  assert.equal(await total(), n, 'handover alone');
  await ctx.svc.redistribute(ctx.deputy, { reason: 'r', ...emptyCmd, memberEnds: [{ objectId: obj, memberUserId: eng.id }] });
  assert.equal(await total(), n, 'member end');
});

/* ----------------------------- delivery worker ------------------------------------------------------------ */
const fresh = async (label: string, bitrixUserId?: string) => {
  const obj = ctx.objects[8];
  const head = await mkUser(ctx.tenant.id, 'Получатель ' + label, 'PTO_HEAD', bitrixUserId);
  const cur = await activeLead(ctx.tenant.id, obj);
  const r = cur
    ? await ctx.svc.assignObjectLead(ctx.deputy, obj, { leadUserId: head.id, reason: label, expectedAssignmentId: cur.id, expectedVersion: cur.version })
    : await ctx.svc.assignObjectLead(ctx.deputy, obj, { leadUserId: head.id });
  const o = (await outboxFor(obj)).find((x: any) => x.sourceAssignmentId === r.lead.id);
  await isolate(o.id);
  return { o, head, obj };
};
const transport = (impl: (call: any) => any) => { const calls: any[] = []; return { calls, installedCall: async (tenantId: string, method: string, params: any) => { calls.push({ tenantId, method, params }); return impl({ tenantId, method, params, n: calls.length }); } }; };
const makeDue = (id: string) => ctx.db.pool.query("UPDATE bitrix_notification_outbox SET next_attempt_at=now()-interval '1 second' WHERE id=$1", [id]);

test('D1 delivery: exact Bitrix method + params; DELIVERED state; a DELIVERED row is never reconsidered', async () => {
  const { o, head } = await fresh('d1', '4242');
  const t = transport(() => 9001);
  const r = await ctx.outbox.deliverNextBitrixNotification(t);
  assert.deepEqual(r, { outcome: 'DELIVERED', id: o.id });
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].method, 'im.notify.system.add');
  assert.equal(t.calls[0].tenantId, ctx.tenant.id);
  assert.deepEqual(t.calls[0].params, { USER_ID: 4242, MESSAGE: o.message, TAG: 'CC5A:' + o.sourceAssignmentId });
  const d = await row(o.id);
  assert.equal(d.status, 'DELIVERED');
  assert.equal(d.attemptCount, 1);
  assert.equal(d.deliveredBitrixUserId, '4242');
  assert.equal(String(d.bitrixNotificationId), '9001');
  assert.ok(d.deliveredAt && d.lastAttemptAt);
  assert.equal(d.lastErrorCode, null);
  assert.equal(d.version, 2);
  assert.deepEqual(await ctx.outbox.deliverNextBitrixNotification(t), { outcome: 'IDLE' });
  assert.equal(t.calls.length, 1, 'zero new Bitrix calls for a DELIVERED row');
  assert.ok(head);
});

test('F transient failure then success: assignment stays, RETRY_WAIT, backoff advances, same TAG on every attempt, one Core identity', async () => {
  const { o, obj } = await fresh('f');
  const t = transport(({ n }) => { if (n === 1) throw new TypeError('fetch failed'); if (n === 2) throw new ctx.bitrix.BitrixRestError('QUERY_LIMIT_EXCEEDED', 503); return 31337; });
  const r1 = await ctx.outbox.deliverNextBitrixNotification(t);
  assert.deepEqual(r1, { outcome: 'RETRY_WAIT', id: o.id, errorCode: 'NETWORK_ERROR' });
  const a = await row(o.id);
  assert.equal(a.status, 'RETRY_WAIT'); assert.equal(a.attemptCount, 1); assert.equal(a.lastErrorCode, 'NETWORK_ERROR');
  assert.ok(new Date(a.nextAttemptAt).getTime() > Date.now() + 5000, 'not due again immediately');
  assert.deepEqual(await ctx.outbox.deliverNextBitrixNotification(t), { outcome: 'IDLE' }, 'not due: no call');
  assert.equal(t.calls.length, 1);
  assert.ok(await activeLead(ctx.tenant.id, obj), 'assignment untouched');
  await makeDue(o.id);
  const r2 = await ctx.outbox.deliverNextBitrixNotification(t);
  assert.equal(r2.outcome, 'RETRY_WAIT');
  const b = await row(o.id);
  assert.equal(b.lastErrorCode, 'QUERY_LIMIT_EXCEEDED'); assert.equal(b.lastHttpStatus, 503); assert.equal(b.attemptCount, 2);
  assert.ok(new Date(b.nextAttemptAt).getTime() - Date.now() > new Date(a.nextAttemptAt).getTime() - Date.now() - 1000, 'rate-limit delay is at least as long');
  await makeDue(o.id);
  assert.equal((await ctx.outbox.deliverNextBitrixNotification(t)).outcome, 'DELIVERED');
  const c = await row(o.id);
  assert.equal(c.status, 'DELIVERED'); assert.equal(c.attemptCount, 3); assert.equal(c.lastErrorCode, null);
  assert.equal(new Set(t.calls.map(x => x.params.TAG)).size, 1);
  assert.equal(t.calls[0].params.TAG, 'CC5A:' + o.sourceAssignmentId);
  assert.equal((await outboxFor(obj)).filter((x: any) => x.sourceAssignmentId === o.sourceAssignmentId).length, 1);
});

test('F2 ambiguous outcome at the provider boundary: Core did not confirm, retry uses the identical TAG, no second Core identity', async () => {
  const { o, obj } = await fresh('f2');
  const providerByTag = new Map<string, any>();      // provider-side replacement keyed by TAG (mock of Bitrix semantics)
  const t = transport(({ params, n }) => { providerByTag.set(params.TAG, params.MESSAGE); if (n === 1) throw new TypeError('socket hang up'); return 55; });
  assert.equal((await ctx.outbox.deliverNextBitrixNotification(t)).outcome, 'RETRY_WAIT');
  await makeDue(o.id);
  assert.equal((await ctx.outbox.deliverNextBitrixNotification(t)).outcome, 'DELIVERED');
  assert.equal(t.calls[0].params.TAG, t.calls[1].params.TAG);
  assert.equal(providerByTag.size, 1, 'provider keeps one notification state per TAG');
  assert.equal((await outboxFor(obj)).filter((x: any) => x.sourceAssignmentId === o.sourceAssignmentId).length, 1);
});

test('F3 failure classification: transient vs permanent per structured Bitrix code', async () => {
  const E = (code: string, status: number, reset?: number) => new ctx.bitrix.BitrixRestError(code, status, reset ?? null);
  const now = Date.now();
  const cls = (e: any, attempt = 1) => ctx.outbox.classifyFailure(e, attempt, now);
  for (const [code, st] of [['INTERNAL_SERVER_ERROR', 500], ['ERROR_UNEXPECTED_ANSWER', 200], ['QUERY_LIMIT_EXCEEDED', 503], ['OPERATION_TIME_LIMIT', 429]] as const)
    assert.equal(cls(E(code, st)).retry, true, code);
  for (const [code, st] of [['WRONG_AUTH_TYPE', 400], ['USER_ID_EMPTY', 400], ['MESSAGE_EMPTY', 400], ['INVALID_CREDENTIALS', 401], ['insufficient_scope', 403], ['user_access_error', 403], ['ACCESS_DENIED', 403], ['OVERLOAD_LIMIT', 503], ['PORTAL_DELETED', 404], ['expired_token', 401]] as const)
    assert.equal(cls(E(code, st)).retry, false, code);
  assert.equal(cls(new Error('x')).retry, true, 'network error');
  const to = new Error('t'); to.name = 'TimeoutError';
  assert.deepEqual(cls(to).code, 'TIMEOUT');
  assert.equal(cls(new (await import('@nestjs/common')).UnauthorizedException('OAuth refresh failed')).retry, false);
  // no low retry-count cutoff, bounded & increasing backoff
  const d = (n: number) => cls(E('INTERNAL_SERVER_ERROR', 500), n).delayMs;
  assert.ok(d(2) > d(1) && d(1000) === d(50) && d(1000) <= 15 * 60_000 && cls(E('INTERNAL_SERVER_ERROR', 500), 1000).retry);
  const q = (n: number) => cls(E('QUERY_LIMIT_EXCEEDED', 503), n).delayMs;
  assert.ok(q(2) > q(1) && q(40) <= 60 * 60_000);
  // OPERATION_TIME_LIMIT: usable operating_reset_at honoured, otherwise conservative fallback
  const reset = Math.floor(now / 1000) + 120;
  const withReset = cls(E('OPERATION_TIME_LIMIT', 429, reset)).delayMs;
  assert.ok(withReset >= 120_000 - 1000 && withReset <= 125_000);
  assert.equal(cls(E('OPERATION_TIME_LIMIT', 429, Math.floor(now / 1000) - 50)).delayMs, 10 * 60_000);
  assert.equal(cls(E('OPERATION_TIME_LIMIT', 429)).delayMs, 10 * 60_000);
});

test('F4 permanent failures persist PERMANENT_FAILURE and are never retried: scope, auth type, result=false, expired after refresh', async () => {
  const cases: [string, () => any, string][] = [
    ['insufficient_scope', () => { throw new ctx.bitrix.BitrixRestError('insufficient_scope', 403); }, 'insufficient_scope'],
    ['WRONG_AUTH_TYPE', () => { throw new ctx.bitrix.BitrixRestError('WRONG_AUTH_TYPE', 400); }, 'WRONG_AUTH_TYPE'],
    ['result=false', () => false, 'RESULT_NOT_CONFIRMED'],
    ['expired after refresh', () => { throw new ctx.bitrix.BitrixRestError('expired_token', 401); }, 'OAUTH_EXPIRED'],
  ];
  for (const [label, impl, code] of cases) {
    const { o } = await fresh('f4-' + label);
    const t = transport(impl);
    const r = await ctx.outbox.deliverNextBitrixNotification(t);
    assert.deepEqual(r, { outcome: 'PERMANENT_FAILURE', id: o.id, errorCode: code }, label);
    assert.equal((await row(o.id)).status, 'PERMANENT_FAILURE');
    assert.deepEqual(await ctx.outbox.deliverNextBitrixNotification(t), { outcome: 'IDLE' });
    assert.equal(t.calls.length, 1, label + ': never retried');
  }
});

test('G recipient fail-safe: inactive / malformed mapping => zero Bitrix call, PERMANENT_FAILURE, no fallback recipient', async () => {
  const inactive = await fresh('g-inactive', '7001');
  await ctx.db.pool.query('UPDATE users SET is_active=false WHERE id=$1', [inactive.head.id]);
  const t = transport(() => 1);
  assert.deepEqual(await ctx.outbox.deliverNextBitrixNotification(t), { outcome: 'PERMANENT_FAILURE', id: inactive.o.id, errorCode: 'RECIPIENT_INACTIVE' });
  assert.equal((await ctx.db.one(ctx.db.pool, 'SELECT attempt_count FROM bitrix_notification_outbox WHERE id=$1', [inactive.o.id])).attemptCount, 0);
  for (const bad of ['', '0', 'abc', '-5', '12.5', '007']) {
    const f = await fresh('g-' + bad, '7002');
    await ctx.db.pool.query('UPDATE users SET bitrix_user_id=$2 WHERE id=$1', [f.head.id, bad]);
    assert.deepEqual(await ctx.outbox.deliverNextBitrixNotification(t), { outcome: 'PERMANENT_FAILURE', id: f.o.id, errorCode: 'RECIPIENT_MAPPING_INVALID' }, JSON.stringify(bad));
  }
  assert.equal(t.calls.length, 0);
  // the Core assignment is unaffected
  assert.ok(await activeLead(ctx.tenant.id, ctx.objects[8]));
});

test('H tenant isolation (schema level): another tenant object / recipient / source assignment cannot be referenced', async () => {
  const t2 = await ctx.db.one(ctx.db.pool, "INSERT INTO tenants(portal,member_id,name) VALUES('other.example.com','other-member-1','Другой') RETURNING *");
  const u2 = await mkUser(t2.id, 'Чужой', 'PTO_HEAD');
  const t1o = (await outboxFor(ctx.objects[0]))[0];
  const codeOf = async (c: any, sql: string, args: any[]) => { await c.query('SAVEPOINT s'); try { await c.query(sql, args); await c.query('RELEASE SAVEPOINT s'); return null; } catch (e: any) { await c.query('ROLLBACK TO SAVEPOINT s'); return e.code; } };
  const sql = `INSERT INTO bitrix_notification_outbox(tenant_id,notification_type,source_assignment_id,object_id,recipient_user_id,message,bitrix_tag) VALUES($1,'OBJECT_FUNCTION_LEAD_ASSIGNED',$2,$3,$4,'m',$5)`;
  const c = await ctx.db.pool.connect();
  try {
    await c.query('BEGIN');
    // free the logical identity of the tenant-1 assignment so only the FK under test can fire
    await c.query('DELETE FROM bitrix_notification_outbox WHERE id=$1', [t1o.id]);
    assert.equal(await codeOf(c, sql, [ctx.tenant.id, t1o.sourceAssignmentId, t1o.objectId, t1o.recipientUserId, 'ok-1']), null, 'control: the same-tenant triple is accepted');
    await c.query('DELETE FROM bitrix_notification_outbox WHERE id<>$1 AND source_assignment_id=$2', ['00000000-0000-0000-0000-000000000000', t1o.sourceAssignmentId]);
    assert.equal(await codeOf(c, sql, [ctx.tenant.id, t1o.sourceAssignmentId, t1o.objectId, u2.id, 'x-1']), '23503', 'recipient of another tenant');
    assert.equal(await codeOf(c, sql, [t2.id, t1o.sourceAssignmentId, t1o.objectId, u2.id, 'x-2']), '23503', 'object + source assignment of another tenant');
    assert.equal(await codeOf(c, sql, [ctx.tenant.id, '00000000-0000-4000-8000-0000000000aa', t1o.objectId, t1o.recipientUserId, 'x-3']), '23503', 'unknown / foreign source assignment');
    assert.equal(await codeOf(c, sql, [ctx.tenant.id, t1o.sourceAssignmentId, '00000000-0000-4000-8000-0000000000bb', t1o.recipientUserId, 'x-4']), '23503', 'foreign object');
    await c.query('ROLLBACK');
  } finally { c.release(); }
});

test('J adapter contract (mocked fetch): exact method/params, backend OAuth token, structured errors, expired_token refresh once', async () => {
  const { pool, one, insert } = ctx.db;
  const { encrypt, decrypt } = await import('../apps/backend/src/security');
  const tenant = await one(pool, "INSERT INTO tenants(portal,member_id,name) VALUES('pbx5a.bitrix24.ru','pbx5a-member','J') RETURNING *");
  await insert(pool, 'bitrix_installations', tenant.id, { portal: 'pbx5a.bitrix24.ru', memberId: 'pbx5a-member', encryptedAccessToken: encrypt('acc-1'), encryptedRefreshToken: encrypt('ref-1'), encryptedApplicationToken: encrypt('app-token'), expiresAt: new Date(Date.now() + 3600_000) });
  const original = globalThis.fetch;
  const seen: any[] = [];
  let script: (url: string, body: any) => Response;
  globalThis.fetch = (async (input: any, init: any) => { const url = String(input); const body = init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : JSON.parse(init.body); seen.push({ url, body }); return script(url, body); }) as any;
  try {
    const adapter = new ctx.bitrix.RealBitrixAdapter();
    const params = { USER_ID: 5, MESSAGE: 'м', TAG: 'CC5A:x' };
    script = () => new Response(JSON.stringify({ result: 123 }));
    assert.equal(await adapter.installedCall(tenant.id, 'im.notify.system.add', params), 123);
    assert.equal(seen[0].url, 'https://pbx5a.bitrix24.ru/rest/im.notify.system.add.json');
    assert.deepEqual(seen[0].body, { ...params, auth: 'acc-1' }, 'backend installed OAuth access token, not APPLICATION_TOKEN');
    assert.notEqual(seen[0].body.auth, 'app-token');
    const failing = async (status: number, body: any) => { script = () => new Response(JSON.stringify(body), { status }); try { await adapter.installedCall(tenant.id, 'im.notify.system.add', params); } catch (e: any) { return e; } throw new Error('no error'); };
    let e = await failing(503, { error: 'QUERY_LIMIT_EXCEEDED', error_description: 'Слишком много запросов' });
    assert.ok(e instanceof ctx.bitrix.BitrixRestError && e.code === 'QUERY_LIMIT_EXCEEDED' && e.httpStatus === 503);
    assert.equal(e.message, 'Bitrix REST request failed: QUERY_LIMIT_EXCEEDED', 'legacy message preserved, no localized text');
    assert.equal((await import('@nestjs/common')).BadRequestException.name, Object.getPrototypeOf(ctx.bitrix.BitrixRestError).name);
    e = await failing(429, { error: 'OPERATION_TIME_LIMIT', time: { operating_reset_at: 1893456000 } });
    assert.equal(e.code, 'OPERATION_TIME_LIMIT'); assert.equal(e.operatingResetAt, 1893456000);
    e = await failing(500, { error: 'INTERNAL_SERVER_ERROR' }); assert.equal(e.code, 'INTERNAL_SERVER_ERROR'); assert.equal(e.httpStatus, 500);
    e = await failing(403, { error: 'insufficient_scope' }); assert.equal(e.code, 'insufficient_scope');
    e = await failing(400, { error: 'WRONG_AUTH_TYPE' }); assert.equal(e.code, 'WRONG_AUTH_TYPE');
    script = () => new Response('<html>bad gateway</html>', { status: 502 });
    e = await adapter.installedCall(tenant.id, 'im.notify.system.add', params).catch((x: any) => x); assert.equal(e.code, 'HTTP_502');
    script = () => new Response('not json', { status: 200 });
    e = await adapter.installedCall(tenant.id, 'im.notify.system.add', params).catch((x: any) => x); assert.equal(e.code, 'ERROR_UNEXPECTED_ANSWER');
    script = () => new Response(JSON.stringify({ result: false }));
    assert.equal(await adapter.installedCall(tenant.id, 'im.notify.system.add', params), false);
    // expired_token: structured detection => one refresh, rotation, ONE retry with the rotated token
    seen.length = 0;
    script = (url, body) => url.startsWith('https://oauth.bitrix.info') ? new Response(JSON.stringify({ access_token: 'acc-2', refresh_token: 'ref-2', expires_in: 3600, member_id: 'pbx5a-member' })) : body.auth === 'acc-1' ? new Response(JSON.stringify({ error: 'expired_token' }), { status: 401 }) : new Response(JSON.stringify({ result: 77 }));
    assert.equal(await adapter.installedCall(tenant.id, 'im.notify.system.add', params), 77);
    assert.deepEqual(seen.map(s => s.url.includes('oauth') ? 'refresh' : s.body.auth), ['acc-1', 'refresh', 'acc-2']);
    const stored = await one(pool, 'SELECT * FROM bitrix_installations WHERE tenant_id=$1', [tenant.id]);
    assert.equal(decrypt(stored.encryptedAccessToken), 'acc-2'); assert.equal(decrypt(stored.encryptedRefreshToken), 'ref-2');
    // refresh with the wrong member_id => OAuth state invalid (permanent for the worker)
    script = (url, body) => url.startsWith('https://oauth.bitrix.info') ? new Response(JSON.stringify({ access_token: 'x', refresh_token: 'y', expires_in: 3600, member_id: 'WRONG' })) : new Response(JSON.stringify({ error: 'expired_token' }), { status: 401 });
    e = await adapter.installedCall(tenant.id, 'im.notify.system.add', params).catch((x: any) => x);
    assert.equal(e.constructor.name, 'UnauthorizedException');
    assert.equal(ctx.outbox.classifyFailure(e, 1, Date.now()).retry, false);
  } finally { globalThis.fetch = original; }
});

test('K worker start flag: polling only with AUTH_MODE=bitrix AND BITRIX_NOTIFICATION_DELIVERY_ENABLED=true; default off', () => {
  const on = ctx.outbox.bitrixNotificationWorkerEnabled;
  assert.equal(on({ AUTH_MODE: 'bitrix', BITRIX_NOTIFICATION_DELIVERY_ENABLED: 'true' } as any), true);
  assert.equal(on({ AUTH_MODE: 'bitrix' } as any), false);
  assert.equal(on({ AUTH_MODE: 'bitrix', BITRIX_NOTIFICATION_DELIVERY_ENABLED: 'false' } as any), false);
  assert.equal(on({ AUTH_MODE: 'mock', BITRIX_NOTIFICATION_DELIVERY_ENABLED: 'true' } as any), false);
  assert.equal(on({ AUTH_MODE: 'bitrix', BITRIX_NOTIFICATION_DELIVERY_ENABLED: 'TRUE' } as any), false);
  assert.match(fs.readFileSync('.env.example', 'utf8'), /^BITRIX_NOTIFICATION_DELIVERY_ENABLED=false$/m);
});
