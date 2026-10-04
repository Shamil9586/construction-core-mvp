import { test } from 'node:test';
import { readyToPresent } from './helpers/present-ready';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeUser, tokenFor } from './helpers/pbx3-fixtures';

/**
 * PILOT-W01 B3 — PBX-3A object membership is generic object access, NOT PTO package-operator authority.
 *
 * The independent reviewer's exact scenario, over real HTTP authorization paths (real app, PGlite):
 *   Object A, W01, PTO_HEAD A, engineer A1 who
 *     - is a legitimate PBX-3A OBJECT MEMBER of A,
 *     - is on PTO_HEAD A's functional team,
 *     - receives the W01 handoff and OWNS EXISTING packages (created before anything changes),
 *   then A1 leaves PTO_HEAD A's functional team (membership of the object stays).
 * A1 keeps generic object read access, but every package MUTATION on W01 must be refused — not only package creation.
 *
 * Every denied request is aimed at a package in the exact state where it would otherwise be VALID, and the same request is shown
 * to succeed for an authorized actor, so a 403 here can only be the authorization rule (never a state/validation answer).
 */
const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);
const DEPUTY = 'DEPUTY_DIRECTOR';
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=';

async function harness() {
  delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'pilot-w01-b3-key';
  process.env.DB_MODE = 'pglite';
  process.env.PGLITE_DIR = 'memory://';
  const { migrate } = await import('../scripts/migrate');
  const { seed } = await import('../scripts/seed');
  const { createApp } = await import('../apps/backend/src/main');
  await migrate();
  await seed();
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  let token = '';
  async function raw(path: string, body?: any) {
    const r = await fetch(base + '/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: (await r.json().catch(() => null)) as any };
  }
  async function req(path: string, body?: any, expected = body === undefined ? 200 : 201) {
    const r = await raw(path, body);
    assert.equal(r.status, expected, path + ': ' + JSON.stringify(r.data));
    return r.data;
  }
  async function login(role: string) { const d = await req('auth/mock', { role, key: 'pilot-w01-b3-key' }); token = d.token; return d.user; }
  async function as(user: any) { token = await tokenFor(user); return user; }
  return { app, req, raw, login, as };
}

async function scenario() {
  const h = await harness();
  const db = await import('../apps/backend/src/db');
  const headA = await makeUser('Начальник А', 'PTO_HEAD');
  const A1 = await makeUser('Инженер А1', 'PTO'), A2 = await makeUser('Инженер А2', 'PTO');
  const pm = await h.login('PROJECT_MANAGER');
  const dict = await h.req('dictionaries');
  const contractors = await h.req('contractors');
  await h.login(DEPUTY);
  const o = await h.req('objects', { externalCode: 'W01B3-' + Date.now() + Math.random().toString(36).slice(2, 6), name: 'Объект A', address: 'Тест, 1', organizationName: 'ООО СЗ', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
  for (const m of [A1, A2]) await h.req('function-teams/pto/org-members', { memberUserId: m.id, managerUserId: headA.id });
  await h.req(`objects/${o.id}/function-team/pto/lead`, { leadUserId: headA.id });
  // A1 is ALSO a legitimate PBX-3A object member (the reviewer's precondition)
  await h.req('function-teams/pto/redistribute', { reason: 'PBX-3A object member', memberAdds: [{ objectId: o.id, memberUserId: A1.id }] });
  await h.login('PROJECT_MANAGER');
  const work = await h.req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'W01', unit: 'м²', plannedQuantity: 500, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '20000' });
  const unit = await h.req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 500 });
  const mkPortion = (label: string) => h.req(`execution-units/${unit.id}/portions`, { label, plannedQuantity: 100 });
  const PA = await mkPortion('PA'), PB = await mkPortion('PB'), PC = await mkPortion('PC');
  // PA carries a full RP fact and an ACCEPTED Customer SC so packages covering it can reach acceptance and SDO handoff
  await h.req(`portions/${PA.id}/fact`, { quantity: 100, version: PA.version });
  const cust = await h.req(`portions/${PA.id}/inspection-request`, { inspectionType: 'CUSTOMER_SC', version: PA.version + 1 });
  await h.login('CONSTRUCTION_CONTROL');
  const att = await h.req('attachments', { fileName: 'sc.png', mimeType: 'image/png', base64: PNG_BASE64 });
  await h.req(`inspections/${cust.id}/photos`, { attachmentId: att.id });
  await h.req(`inspections/${cust.id}/accept`, { version: cust.version, comment: 'Подтверждено', quantity: 100 });
  // the PTO_HEAD hands W01 to A1 (the handoff itself creates no package and no object membership)
  await h.as(headA);
  await h.req(`works/${work.id}/pto-assignment`, { assigneeUserId: A1.id });

  /** A1 (effective assignee AND object member) builds a package through the real routes, up to the requested state. */
  const build = async (until: 'editable' | 'presented' | 'accepted') => {
    await h.as(A1);
    const pkg = await h.req('documentation-packages', { objectWorkId: work.id });
    assert.equal(pkg.responsibleUserId, A1.id);
    await h.req(`documentation-packages/${pkg.id}/portions`, { quantityPortionId: PA.id });
    const doc = await h.req(`documentation-packages/${pkg.id}/documents`, { type: 'AOSR' });
    await h.req(`documentation-documents/${doc.id}/versions`, { storageProvider: 'NONE' });
    if (until === 'editable') return { pkg, doc };
    let p = await h.req(`documentation-packages/${pkg.id}/status`, { status: 'PREPARING', version: pkg.version });
    p = await h.req(`documentation-packages/${pkg.id}/status`, { status: 'READY_FOR_PRESENTATION', version: p.version });
    await readyToPresent(h.req, pkg.id);
    p = await h.req(`documentation-packages/${pkg.id}/status`, { status: 'PRESENTED', version: p.version });
    if (until === 'presented') return { pkg: p, doc };
    p = await h.req(`documentation-packages/${pkg.id}/customer-acceptance`, { version: p.version, acceptedDate: dt(0), reference: 'Акт-1' });
    return { pkg: p, doc };
  };
  const row = async (id: string) => (await db.pool.query('SELECT status,version,responsible_user_id FROM documentation_packages WHERE id=$1', [id])).rows[0];
  const footprint = async () => {
    const q = async (sql: string) => (await db.pool.query(sql, [work.id])).rows[0].n;
    return {
      packages: await q('SELECT count(*)::int n FROM documentation_packages WHERE object_work_id=$1'),
      documents: await q('SELECT count(*)::int n FROM documentation_documents d JOIN documentation_packages p ON p.id=d.documentation_package_id WHERE p.object_work_id=$1'),
      versions: await q('SELECT count(*)::int n FROM documentation_document_versions v JOIN documentation_documents d ON d.id=v.documentation_document_id JOIN documentation_packages p ON p.id=d.documentation_package_id WHERE p.object_work_id=$1'),
      links: await q('SELECT count(*)::int n FROM documentation_package_portions l JOIN documentation_packages p ON p.id=l.documentation_package_id WHERE p.object_work_id=$1'),
      history: await q('SELECT count(*)::int n FROM documentation_package_status_history h JOIN documentation_packages p ON p.id=h.documentation_package_id WHERE p.object_work_id=$1'),
      acceptances: await q('SELECT count(*)::int n FROM documentation_customer_acceptances a JOIN documentation_packages p ON p.id=a.documentation_package_id WHERE p.object_work_id=$1'),
      sdoCases: await q('SELECT count(*)::int n FROM sdo_closing_cases WHERE object_work_id=$1'),
    };
  };
  const leaveTeam = async (who: any) => {
    const cur = await db.one(db.pool, 'SELECT id,version FROM functional_team_memberships WHERE member_user_id=$1 AND ended_at IS NULL', [who.id]);
    await h.login(DEPUTY);
    await h.req('function-teams/pto/redistribute', { reason: 'leaves', orgEnds: [{ memberUserId: who.id, expectedAssignmentId: cur.id, expectedVersion: cur.version }] });
  };
  return { h, db, headA, A1, A2, o, work, unit, PA, PB, PC, build, row, footprint, leaveTeam };
}

test('B3-02 reviewer scenario: A1 (PBX-3A member + assigned W01, owns existing packages) leaves the head\'s team — every package mutation is denied, generic access stays', async () => {
  const s = await scenario();
  try {
    const { h, db, A1 } = s;
    // ---- existing packages, in the exact states where each later denied request would otherwise be valid ----
    const E = await s.build('editable');      // edit / status / portion link / document / version
    const P = await s.build('presented');     // customer acceptance
    const C = await s.build('accepted');      // pre-handoff correction
    const H = await s.build('accepted');      // handoff to SDO

    // positive controls: while effective, A1 performs every one of these mutations on E (so they ARE valid requests)
    await h.as(A1);
    let e = await s.row(E.pkg.id);
    assert.equal((await h.raw(`documentation-packages/${E.pkg.id}/edit`, { responsibleUserId: A1.id, version: e.version })).status, 201, 'control: edit');
    assert.equal((await h.raw(`documentation-packages/${E.pkg.id}/portions`, { quantityPortionId: s.PB.id })).status, 201, 'control: portion link');
    assert.equal((await h.raw(`documentation-packages/${E.pkg.id}/documents`, { type: 'ACT_CERTIFICATE' })).status, 201, 'control: document');
    assert.equal((await h.raw(`documentation-documents/${E.doc.id}/versions`, { storageProvider: 'NONE' })).status, 201, 'control: version');
    e = await s.row(E.pkg.id);
    assert.equal((await h.raw(`documentation-packages/${E.pkg.id}/status`, { status: 'PREPARING', version: e.version })).status, 201, 'control: status');
    // preconditions of the scenario
    const memberRows = async () => (await db.pool.query("SELECT count(*)::int n FROM object_function_member_assignments WHERE member_user_id=$1 AND object_id=$2 AND function_code='PTO' AND ended_at IS NULL", [A1.id, s.o.id])).rows[0].n;
    assert.equal(await memberRows(), 1, 'A1 is a PBX-3A object member');
    assert.equal((await h.req(`works/${s.work.id}/pto-assignment`)).canCreatePackage, true);

    // ---- A1 leaves PTO_HEAD A's functional team (object membership is untouched) ----
    await s.leaveTeam(A1);
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM functional_team_memberships WHERE member_user_id=$1 AND ended_at IS NULL', [A1.id])).rows[0].n, 0, 'A1 is no longer on any functional team');
    assert.equal(await memberRows(), 1, 'A1 still holds the PBX-3A object membership (semantics unchanged)');

    // generic PBX-3A access remains ...
    await h.as(A1);
    assert.equal((await h.raw(`objects/${s.o.id}`)).status, 200, 'object access via PBX-3A');
    const snap = await h.req('snapshot');
    assert.ok(snap.objects.some((o: any) => o.id === s.o.id));
    assert.ok(snap.documentationPackages.some((p: any) => p.id === E.pkg.id), 'PBX-3A read access to the packages remains');
    // ... the assignment view says the handoff is no longer effective
    const view = await h.req(`works/${s.work.id}/pto-assignment`);
    assert.equal(view.assignment, null); assert.equal(view.canCreatePackage, false); assert.equal(view.canAssign, false); assert.deepEqual(view.eligible, []);

    // ---- denial matrix: A1 may read, but every mutation is a 403 and nothing changes ----
    const before = { fp: await s.footprint(), E: await s.row(E.pkg.id), P: await s.row(P.pkg.id), C: await s.row(C.pkg.id), H: await s.row(H.pkg.id) };
    const post = (path: string, body: any) => h.raw(path, body).then((r) => r.status);
    const denied: Record<string, number> = {
      create: await post('documentation-packages', { objectWorkId: s.work.id }),
      createNamingSelf: await post('documentation-packages', { objectWorkId: s.work.id, responsibleUserId: A1.id }),
      edit: await post(`documentation-packages/${E.pkg.id}/edit`, { responsibleUserId: A1.id, version: before.E.version }),
      status: await post(`documentation-packages/${E.pkg.id}/status`, { status: 'READY_FOR_PRESENTATION', version: before.E.version }),
      portionLink: await post(`documentation-packages/${E.pkg.id}/portions`, { quantityPortionId: s.PC.id }),
      documentCreate: await post(`documentation-packages/${E.pkg.id}/documents`, { type: 'EXECUTIVE_SCHEME' }),
      versionCreate: await post(`documentation-documents/${E.doc.id}/versions`, { storageProvider: 'NONE' }),
      customerAcceptance: await post(`documentation-packages/${P.pkg.id}/customer-acceptance`, { version: before.P.version, acceptedDate: dt(0), reference: 'Акт-2' }),
      correction: await post(`documentation-packages/${C.pkg.id}/correction`, { version: before.C.version }),
      sdoHandoff: await post(`documentation-packages/${H.pkg.id}/handoff-to-sdo`, { version: before.H.version }),
      sdoHandoffWithKey: await post(`documentation-packages/${H.pkg.id}/handoff-to-sdo`, { version: before.H.version, idempotencyKey: randomUUID() }),
    };
    for (const [op, status] of Object.entries(denied)) assert.equal(status, 403, `${op} must be refused for A1 (got ${status})`);
    assert.deepEqual(await s.footprint(), before.fp, 'no package, document, version, link, status change, acceptance or SDO case was written');
    for (const [k, id] of [['E', E.pkg.id], ['P', P.pkg.id], ['C', C.pkg.id], ['H', H.pkg.id]] as const) assert.deepEqual(await s.row(id), (before as any)[k], k + ' untouched');

    // ---- ADMIN: no stale/ineligible responsible either (already accepted behaviour, preserved) ----
    await h.login('ADMIN');
    assert.equal((await h.raw('documentation-packages', { objectWorkId: s.work.id, responsibleUserId: A1.id })).status, 403);
    assert.equal((await h.raw('documentation-packages', { objectWorkId: s.work.id })).status, 403);

    // ---- the SAME requests are valid for an authorized actor (PTO_HEAD A): the 403s above were authorization, not state ----
    await h.as(s.headA);
    assert.equal((await h.raw(`documentation-packages/${E.pkg.id}/status`, { status: 'READY_FOR_PRESENTATION', version: before.E.version })).status, 201, 'control: status valid for the head');
    assert.equal((await h.raw(`documentation-packages/${P.pkg.id}/customer-acceptance`, { version: before.P.version, acceptedDate: dt(0), reference: 'Акт-2' })).status, 201, 'control: acceptance valid for the head');
    assert.equal((await h.raw(`documentation-packages/${C.pkg.id}/correction`, { version: before.C.version })).status, 201, 'control: correction valid for the head');
    assert.equal((await h.raw(`documentation-packages/${H.pkg.id}/handoff-to-sdo`, { version: before.H.version })).status, 201, 'control: SDO handoff valid for the head');
    const eNow = await s.row(E.pkg.id);
    assert.equal((await h.raw(`documentation-packages/${E.pkg.id}/customer-acceptance`, { version: eNow.version, acceptedDate: dt(0), reference: 'Акт-3' })).status, 400, 'control: a genuinely invalid-state request answers 400 for an authorized actor — the 403s above are not state answers');
  } finally { await s.h.app.close(); }
});

test('B3-01 supersession: a retained PBX-3A member whose handoff was superseded cannot mutate; the new effective assignee can', async () => {
  const s = await scenario();
  try {
    const { h, db, A1, A2 } = s;
    const E = await s.build('editable');
    // package-existing reassignment is intentionally NOT an API path, so the superseded state is forced at row level
    await db.pool.query("UPDATE pto_work_assignments SET ended_at=clock_timestamp(),ended_by=assigned_by,end_reason='REASSIGNED',version=version+1 WHERE object_work_id=$1 AND ended_at IS NULL", [s.work.id]);
    await db.pool.query('INSERT INTO pto_work_assignments(tenant_id,object_id,object_work_id,assignee_user_id,assigned_by) SELECT tenant_id,object_id,object_work_id,$2,assigned_by FROM pto_work_assignments WHERE object_work_id=$1 LIMIT 1', [s.work.id, A2.id]);
    const before = { fp: await s.footprint(), E: await s.row(E.pkg.id) };
    // A1: still a PBX-3A member (reads fine) but holds no package authority
    await h.as(A1);
    assert.equal((await h.raw(`objects/${s.o.id}`)).status, 200);
    const v = await h.req(`works/${s.work.id}/pto-assignment`);
    assert.equal(v.assignment.assigneeName, 'Инженер А2'); assert.equal(v.canCreatePackage, false);
    const post = (path: string, body: any) => h.raw(path, body).then((r) => r.status);
    assert.equal(await post('documentation-packages', { objectWorkId: s.work.id }), 403);
    assert.equal(await post(`documentation-packages/${E.pkg.id}/edit`, { responsibleUserId: A1.id, version: before.E.version }), 403);
    assert.equal(await post(`documentation-packages/${E.pkg.id}/status`, { status: 'PREPARING', version: before.E.version }), 403);
    assert.equal(await post(`documentation-packages/${E.pkg.id}/portions`, { quantityPortionId: s.PB.id }), 403);
    assert.equal(await post(`documentation-packages/${E.pkg.id}/documents`, { type: 'ACT_CERTIFICATE' }), 403);
    assert.equal(await post(`documentation-documents/${E.doc.id}/versions`, { storageProvider: 'NONE' }), 403);
    assert.deepEqual(await s.footprint(), before.fp); assert.deepEqual(await s.row(E.pkg.id), before.E);
    // ADMIN may only name the CURRENT assignee
    await h.login('ADMIN');
    assert.equal(await post('documentation-packages', { objectWorkId: s.work.id, responsibleUserId: A1.id }), 403);
    // A2 (not an object member, effective assignee) can operate the existing package
    await h.as(A2);
    assert.equal(await post(`documentation-packages/${E.pkg.id}/status`, { status: 'PREPARING', version: before.E.version }), 201);
    assert.equal(await post(`documentation-packages/${E.pkg.id}/documents`, { type: 'ACT_CERTIFICATE' }), 201);
  } finally { await s.h.app.close(); }
});

test('B3-01 idempotent replay: a former operator cannot replay an SDO handoff to read a stored response after losing package authority', async () => {
  const s = await scenario();
  try {
    const { h, A1 } = s;
    const H = await s.build('accepted');
    const key = randomUUID();
    await h.as(A1);
    const first = await h.raw(`documentation-packages/${H.pkg.id}/handoff-to-sdo`, { version: H.pkg.version, idempotencyKey: key });
    assert.equal(first.status, 201, JSON.stringify(first.data));
    const replay = await h.raw(`documentation-packages/${H.pkg.id}/handoff-to-sdo`, { version: H.pkg.version, idempotencyKey: key });
    assert.equal(replay.status, 201); assert.equal(replay.data.id, first.data.id, 'control: while effective, a retry is served the stored response');
    await s.leaveTeam(A1);
    await h.as(A1);
    assert.equal((await h.raw(`documentation-packages/${H.pkg.id}/handoff-to-sdo`, { version: H.pkg.version, idempotencyKey: key })).status, 403, 'replay refused');
    assert.equal((await h.raw(`documentation-packages/${H.pkg.id}/handoff-to-sdo`, { version: H.pkg.version, idempotencyKey: randomUUID() })).status, 403, 'new key refused');
    assert.equal((await s.footprint()).sdoCases, 1, 'exactly the one original SDO case');
  } finally { await s.h.app.close(); }
});
