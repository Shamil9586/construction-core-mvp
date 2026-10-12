import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { harness, closeHarness, setUp, generatedAosr, uploadScheme, presentPackage, SCHEME_FILE } from './helpers/aosr-harness';

/**
 * Documentation Package soft archive (migration 023).
 * Archive is orthogonal metadata (archived_at / archived_by / archive_reason), NOT a lifecycle status: the package stays in the database
 * with its documents, method, scope and history; it leaves the working set, stops reserving its Quantity Portions, and takes no new action.
 */
after(closeHarness);

const ARCHIVED_MSG = /Пакет архивирован/;
const COVERED_MSG = /Этот участок уже включён в активный пакет исполнительной документации\./;
const REASON = 'Тестовый пакет';
const msg = async (r: Response) => ((await r.json()) as any).message as string;
const sql = async (text: string, args: any[] = []) => { const { pool } = await import('../apps/backend/src/db'); return (await pool.query(text, args)).rows; };
const view = async (req: any, id: string) => (await req('snapshot')).documentationPackages.find((p: any) => p.id === id);
const archivedView = async (req: any, id: string) => ((await req('snapshot')).archivedDocumentationPackages ?? []).find((p: any) => p.id === id);
const NO_REASON = Symbol('no reason');
const archive = (raw: any, id: string, version: number, reason: any = REASON) => raw(`documentation-packages/${id}/archive`, { version, ...(reason === NO_REASON ? {} : { reason }) });
const newPkg = async (raw: any, ctx: any, ids: string[]) => { const r = await raw('documentation-packages', { objectWorkId: ctx.work.id, quantityPortionIds: ids }); assert.equal(r.status, 201, JSON.stringify(await r.clone().json())); return (await r.json()) as any; };

test('an eligible DRAFT package can be archived — and the lifecycle status is untouched', async () => {
  const { req, raw } = await harness();
  const ctx = await setUp({ noPackage: true });
  const pkg = await newPkg(raw, ctx, [ctx.portion.id]);
  assert.equal(pkg.status, 'DRAFT');
  const r = await archive(raw, pkg.id, pkg.version);
  assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
  const done = (await r.json()) as any;
  assert.equal(done.status, 'DRAFT', 'archive is not a business status: DRAFT stays DRAFT');
  assert.ok(done.archivedAt);
  assert.equal((await sql('SELECT status FROM documentation_packages WHERE id=$1', [pkg.id]))[0].status, 'DRAFT');
  assert.equal((await archivedView(req, pkg.id)).status, 'DRAFT');
});

test('an eligible PREPARING test package can be archived — including the EXTERNAL verification shape (declared method + file-backed scheme)', async () => {
  const { req, raw } = await harness();
  const ctx = await setUp({ method: 'EXTERNAL' });
  await uploadScheme(req, ctx.pkg.id, 'ES-001');
  const prep = await req(`documentation-packages/${ctx.pkg.id}/status`, { status: 'PREPARING', version: ctx.pkg.version });
  assert.equal(prep.status, 'PREPARING');
  const r = await archive(raw, ctx.pkg.id, prep.version, 'Тестовый пакет EXTERNAL-маршрута');
  assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
  // nothing it carried is erased
  assert.equal((await sql("SELECT count(*)::int AS n FROM documentation_package_aosr_methods WHERE documentation_package_id=$1 AND method='EXTERNAL'", [ctx.pkg.id]))[0].n, 1);
  assert.equal((await sql('SELECT count(*)::int AS n FROM documentation_documents WHERE documentation_package_id=$1', [ctx.pkg.id]))[0].n, 1);
  assert.equal((await sql('SELECT count(*)::int AS n FROM documentation_package_portions WHERE documentation_package_id=$1', [ctx.pkg.id]))[0].n, 1);
  assert.equal((await sql('SELECT count(*)::int AS n FROM documentation_package_status_history WHERE documentation_package_id=$1', [ctx.pkg.id]))[0].n, 1);
});

test('archive requires a reason; whitespace is not a reason; a stale version and a repeat are refused', async () => {
  const { raw } = await harness();
  const ctx = await setUp({ noPackage: true });
  const pkg = await newPkg(raw, ctx, [ctx.portion.id]);
  for (const reason of [NO_REASON, '', '   ']) {
    const r = await archive(raw, pkg.id, pkg.version, reason);
    assert.equal(r.status, 400, `reason ${String(reason)}`);
  }
  assert.equal((await sql('SELECT archived_at FROM documentation_packages WHERE id=$1', [pkg.id]))[0].archived_at, null, 'a refused attempt archives nothing');
  const stale = await archive(raw, pkg.id, pkg.version + 5);
  assert.ok(stale.status >= 400);
  assert.equal((await archive(raw, pkg.id, pkg.version)).status, 201);
  const again = await archive(raw, pkg.id, pkg.version + 1);
  assert.equal(again.status, 400);
  assert.match(await msg(again), /уже архивирован/);
});

test('archive records who, when and why — in the row, the audit log and the archive read model', async () => {
  const { req, raw, login } = await harness();
  const ctx = await setUp({ noPackage: true });
  const pkg = await newPkg(raw, ctx, [ctx.portion.id]);
  const before = Date.now();
  assert.equal((await archive(raw, pkg.id, pkg.version, '  Создан ошибочно  ')).status, 201);
  const row = (await sql('SELECT p.archived_at,p.archived_by,p.archive_reason,u.name FROM documentation_packages p JOIN users u ON u.id=p.archived_by WHERE p.id=$1', [pkg.id]))[0];
  assert.equal(row.archiveReason ?? row.archive_reason, 'Создан ошибочно', 'the reason is stored trimmed');
  assert.equal(row.name, ctx.pto.name, 'the actor is the authenticated user, never a client-sent value');
  const at = +new Date(row.archived_at);
  assert.ok(at >= before - 2000 && at <= Date.now() + 2000);
  const logged = await sql("SELECT count(*)::int AS n FROM audit_logs WHERE entity_id=$1 AND action='ARCHIVE'", [pkg.id]);
  assert.equal(logged[0].n, 1);
  const a = await archivedView(req, pkg.id);
  assert.equal(a.archiveReason, 'Создан ошибочно');
  assert.equal(a.archivedByName, ctx.pto.name);
  assert.ok(a.archivedAt);
  void login;
});

test('an archived package leaves the normal active lists but stays readable in the archive read model with its scope, method and work', async () => {
  const { req, raw } = await harness();
  const ctx = await setUp({ method: 'CORE', secondPortion: true });
  const keep = await newPkg(raw, ctx, [ctx.portion2.id]);
  const cur = await view(req, ctx.pkg.id);
  assert.equal((await archive(raw, ctx.pkg.id, cur.version)).status, 201);
  const snap = await req('snapshot');
  assert.equal(snap.documentationPackages.some((p: any) => p.id === ctx.pkg.id), false, 'not in the working set');
  assert.equal(snap.documentationPackages.some((p: any) => p.id === keep.id), true, 'the other package of the Work is untouched');
  assert.equal((await req('documentation-packages')).some((p: any) => p.id === ctx.pkg.id), false, 'not in the packages list route either');
  const a = await archivedView(req, ctx.pkg.id);
  assert.ok(a, 'archived packages travel separately');
  assert.equal(a.workName, 'Устройство штукатурки стен');
  assert.equal(a.aosrMethod, 'CORE');
  assert.equal(a.scope.hasScope, true);
  assert.equal(snap.documentationAttentionQueue.some((q: any) => q.packageId === ctx.pkg.id), false);
  // its children are not mixed into the working-set arrays
  assert.equal((snap.documentationPackagePortions ?? []).some((l: any) => l.documentationPackageId === ctx.pkg.id), false);
});

test('an archived package takes NO new forward action (status, scope, documents, versions, AOSR, method, schemes, acceptance, handoff, edit)', async () => {
  const { req, raw } = await harness();
  const ctx = await setUp({ method: 'CORE', secondPortion: true });
  const doc = await req(`documentation-packages/${ctx.pkg.id}/documents`, { type: 'ACT_CERTIFICATE' });
  const cur = await view(req, ctx.pkg.id);
  assert.equal((await archive(raw, ctx.pkg.id, cur.version)).status, 201);
  const v = cur.version + 1;
  const base = `documentation-packages/${ctx.pkg.id}`;
  const attempts: [string, Response][] = [
    ['status', await raw(`${base}/status`, { status: 'PREPARING', version: v })],
    ['link portion', await raw(`${base}/portions`, { quantityPortionId: ctx.portion2.id })],
    ['create document', await raw(`${base}/documents`, { type: 'ACT_CERTIFICATE' })],
    ['create version', await raw(`documentation-documents/${doc.id}/versions`, { storageProvider: 'NONE' })],
    ['edit', await raw(`${base}/edit`, { responsibleUserId: ctx.pto.id, version: v })],
    ['aosr method', await raw(`${base}/aosr-method`, { method: 'EXTERNAL' })],
    ['create AOSR', await raw(`${base}/aosr`, { title: 'АОСР' })],
    ['scheme upload', await raw(`${base}/executive-schemes`, { title: 'ES-1', ...SCHEME_FILE })],
    ['customer acceptance', await raw(`${base}/customer-acceptance`, { version: v, acceptedDate: '2026-10-01' })],
    ['handoff to SDO', await raw(`${base}/handoff-to-sdo`, { version: v, idempotencyKey: '11111111-1111-4111-8111-111111111111' })],
    ['correction', await raw(`${base}/correction`, { version: v })],
  ];
  for (const [name, r] of attempts) {
    assert.ok(r.status >= 400 && r.status < 500, `${name}: ${r.status}`);
    assert.match(await msg(r), ARCHIVED_MSG, name);
  }
  // the database backstop: an archived row can be neither changed nor deleted, and cannot receive a portion
  await assert.rejects(sql("UPDATE documentation_packages SET status='PREPARING' WHERE id=$1", [ctx.pkg.id]), /не изменяется/);
  await assert.rejects(sql('UPDATE documentation_packages SET archived_at=NULL,archived_by=NULL,archive_reason=NULL WHERE id=$1', [ctx.pkg.id]), /не изменяется/, 'no un-archive');
  await assert.rejects(sql('DELETE FROM documentation_packages WHERE id=$1', [ctx.pkg.id]), /не удаляется/);
  await assert.rejects(sql('INSERT INTO documentation_package_portions(tenant_id,documentation_package_id,quantity_portion_id) SELECT tenant_id,$1,$2 FROM documentation_packages WHERE id=$1', [ctx.pkg.id, ctx.portion2.id]), /архивирован/);
  // and there is no hard-delete API at all
  const { base: url } = await harness();
  const del = await fetch(`${url}/documentation-packages/${ctx.pkg.id}`, { method: 'DELETE' });
  assert.ok([401, 404, 405].includes(del.status), `DELETE ${del.status}`);
  assert.equal((await sql('SELECT count(*)::int AS n FROM documentation_packages WHERE id=$1', [ctx.pkg.id]))[0].n, 1);
});

test('an archived package no longer reserves its Quantity Portions: the portion is eligible again and a new ACTIVE package may use it', async () => {
  const { req, raw } = await harness();
  const ctx = await setUp({ noPackage: true, secondPortion: true });
  const a = await newPkg(raw, ctx, [ctx.portion.id]);
  const assignment = async () => (await req(`works/${ctx.work.id}/pto-assignment`)).packageScope;
  assert.deepEqual((await assignment()).eligiblePortions.map((p: any) => p.id), [ctx.portion2.id], 'while A is active only the free portion is eligible');
  const blocked = await raw('documentation-packages', { objectWorkId: ctx.work.id, quantityPortionIds: [ctx.portion.id] });
  assert.equal(blocked.status, 400);
  assert.match(await msg(blocked), COVERED_MSG);
  assert.equal((await archive(raw, a.id, a.version)).status, 201);
  assert.deepEqual((await assignment()).eligiblePortions.map((p: any) => p.id).sort(), [ctx.portion.id, ctx.portion2.id].sort(), 'released by the archive');
  const b = await newPkg(raw, ctx, [ctx.portion.id]);
  assert.notEqual(b.id, a.id);
  assert.equal((await sql('SELECT count(*)::int AS n FROM documentation_package_portions WHERE quantity_portion_id=$1', [ctx.portion.id]))[0].n, 2, 'the archived link is retained next to the new claim');
  // reassignment is only blocked by ACTIVE packages
  assert.equal((await req(`works/${ctx.work.id}/pto-assignment`)).packageCount, 1);
});

test('a NON-archived overlapping active package is still rejected — by the service and by the database', async () => {
  const { raw } = await harness();
  const ctx = await setUp({ noPackage: true, secondPortion: true });
  const a = await newPkg(raw, ctx, [ctx.portion.id]);
  const b = await newPkg(raw, ctx, [ctx.portion2.id]);
  for (const ids of [[ctx.portion.id], [ctx.portion2.id], [ctx.portion.id, ctx.portion2.id]]) {
    const r = await raw('documentation-packages', { objectWorkId: ctx.work.id, quantityPortionIds: ids });
    assert.equal(r.status, 400);
    assert.match(await msg(r), COVERED_MSG);
  }
  const link = await raw(`documentation-packages/${b.id}/portions`, { quantityPortionId: ctx.portion.id });
  assert.equal(link.status, 400);
  assert.match(await msg(link), COVERED_MSG);
  // archive A only: portion 1 is free again, portion 2 (still held by the active B) is NOT
  assert.equal((await archive(raw, a.id, a.version)).status, 201);
  const still = await raw('documentation-packages', { objectWorkId: ctx.work.id, quantityPortionIds: [ctx.portion2.id] });
  assert.equal(still.status, 400);
  assert.match(await msg(still), COVERED_MSG);
  // a new active package C takes the released portion 1; from then on a database write that would give B a second claim is refused
  const c = await newPkg(raw, ctx, [ctx.portion.id]);
  await assert.rejects(sql('INSERT INTO documentation_package_portions(tenant_id,documentation_package_id,quantity_portion_id) SELECT tenant_id,$1,$2 FROM documentation_packages WHERE id=$1', [b.id, ctx.portion.id]), COVERED_MSG);
  assert.equal((await sql('SELECT count(*)::int AS n FROM documentation_package_portions l JOIN documentation_packages p ON p.id=l.documentation_package_id WHERE l.quantity_portion_id=$1 AND p.archived_at IS NULL', [ctx.portion.id]))[0].n, 1);
  void c;
});

test('a package that entered the customer / SDO route, or consumed an AOSR number, cannot be hidden by an archive (clear business error)', async () => {
  const { req, raw } = await harness();
  // generated Core AOSR in a package still in preparation
  const core = await setUp({ method: 'CORE' });
  await generatedAosr(req, core);
  const c1 = await view(req, core.pkg.id);
  const refusedAosr = await archive(raw, core.pkg.id, c1.version);
  assert.equal(refusedAosr.status, 400);
  assert.match(await msg(refusedAosr), /сформированы АОСР/);
  assert.equal(c1.archiveBlocker, 'В пакете сформированы АОСР (присвоен номер или создан документ) — архивирование недоступно.', 'the same rule is exposed to the UI');
  // PRESENTED
  const ext = await setUp({ method: 'EXTERNAL' });
  await uploadScheme(req, ext.pkg.id, 'ES-001');
  const presented = await presentPackage(req, ext.pkg.id);
  const refusedPresented = await archive(raw, ext.pkg.id, presented.version);
  assert.equal(refusedPresented.status, 400);
  assert.match(await msg(refusedPresented), /уже в документообороте/);
  // READY_FOR_PRESENTATION is also past «preparation»
  const ready = await setUp({ method: 'EXTERNAL' });
  await uploadScheme(req, ready.pkg.id, 'ES-001');
  const p = await req(`documentation-packages/${ready.pkg.id}/status`, { status: 'PREPARING', version: (await view(req, ready.pkg.id)).version });
  const r = await req(`documentation-packages/${ready.pkg.id}/status`, { status: 'READY_FOR_PRESENTATION', version: p.version });
  assert.equal((await archive(raw, ready.pkg.id, r.version)).status, 400);
  for (const id of [core.pkg.id, ext.pkg.id, ready.pkg.id]) assert.equal((await sql('SELECT archived_at FROM documentation_packages WHERE id=$1', [id]))[0].archived_at, null);
  // customer acceptance + SDO progression
  const accepted = await setUp({ method: 'EXTERNAL' });
  await uploadScheme(req, accepted.pkg.id, 'ES-001');
  const act = await req(`documentation-packages/${accepted.pkg.id}/documents`, { type: 'ACT_CERTIFICATE' });
  await req(`documentation-documents/${act.id}/versions`, { storageProvider: 'NONE' });
  const pr = await presentPackage(req, accepted.pkg.id);
  const acc = await raw(`documentation-packages/${accepted.pkg.id}/customer-acceptance`, { version: pr.version, acceptedDate: '2026-10-01' });
  assert.equal(acc.status, 201, JSON.stringify(await acc.clone().json()));
  const acceptedPkg = (await acc.json()) as any;
  const refusedAccepted = await archive(raw, accepted.pkg.id, acceptedPkg.version ?? (await view(req, accepted.pkg.id)).version);
  assert.equal(refusedAccepted.status, 400);
  assert.equal((await sql('SELECT archived_at FROM documentation_packages WHERE id=$1', [accepted.pkg.id]))[0].archived_at, null);
});

test('defence in depth: a downstream fact blocks the archive even when the status column still says DRAFT (presented history, customer acceptance, SDO case)', async () => {
  const { raw } = await harness();
  const { newPortionFor } = await import('./helpers/package-scope');
  const ctx = await setUp({ noPackage: true, secondPortion: true });
  const third = await newPortionFor(ctx.work.id, '3 этаж');
  const cases: [string, string, RegExp][] = [
    ['presented', "INSERT INTO documentation_package_status_history(tenant_id,documentation_package_id,from_status,to_status,changed_by) SELECT tenant_id,id,'PREPARING','PRESENTED',created_by FROM documentation_packages WHERE id=$1", /предъявлялся заказчику/],
    ['acceptance', "INSERT INTO documentation_customer_acceptances(tenant_id,documentation_package_id,documentation_package_version,accepted_date,registered_by) SELECT tenant_id,id,version,'2026-10-01',created_by FROM documentation_packages WHERE id=$1", /согласие заказчика/],
    ['sdo', 'INSERT INTO sdo_closing_cases(tenant_id,object_id,object_work_id,documentation_package_id,created_by) SELECT tenant_id,object_id,object_work_id,id,created_by FROM documentation_packages WHERE id=$1', /передан в СДО/],
  ];
  const portions = [ctx.portion.id, ctx.portion2.id, third];
  for (const [i, [name, insertSql, text]] of cases.entries()) {
    const pkg = await newPkg(raw, ctx, [portions[i]!]);
    assert.equal(pkg.status, 'DRAFT');
    await sql(insertSql, [pkg.id]);
    const r = await archive(raw, pkg.id, pkg.version);
    assert.equal(r.status, 400, name);
    assert.match(await msg(r), text, name);
    assert.equal((await sql('SELECT archived_at FROM documentation_packages WHERE id=$1', [pkg.id]))[0].archived_at, null, name);
  }
});

test('who may archive: the responsible engineer, the object PTO head and admin — nobody else, and no other engineer for a package that is not theirs', async () => {
  const { req, raw, login } = await harness();
  const { makeUser, assignPtoToObject, tokenFor } = await import('./helpers/pbx3-fixtures');
  const ctx = await setUp({ noPackage: true, secondPortion: true });
  const a = await newPkg(raw, ctx, [ctx.portion.id]);
  const b = await newPkg(raw, ctx, [ctx.portion2.id]);
  for (const role of ['PROJECT_MANAGER', 'SDO', 'CONSTRUCTION_CONTROL', 'DEPUTY_DIRECTOR']) {
    await login(role);
    assert.equal((await archive(raw, a.id, a.version)).status, 403, role);
  }
  // another PTO engineer: on the object team, but not the effective assignee of this Work
  const other = await makeUser('Другой инженер ПТО', 'PTO');
  await assignPtoToObject(ctx.object.id, { member: other });
  const otherToken = await tokenFor(other);
  const { base } = await harness();
  const asOther = await fetch(`${base}/documentation-packages/${a.id}/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + otherToken }, body: JSON.stringify({ version: a.version, reason: REASON }) });
  assert.equal(asOther.status, 403);
  // an engineer who became the effective assignee LATER is still not the owner of a package another engineer is responsible for
  await sql("UPDATE pto_work_assignments SET ended_at=clock_timestamp(),ended_by=assigned_by,end_reason='REASSIGNED',version=version+1 WHERE object_work_id=$1 AND ended_at IS NULL", [ctx.work.id]);
  await sql('INSERT INTO pto_work_assignments(tenant_id,object_id,object_work_id,assignee_user_id,assigned_by) SELECT tenant_id,object_id,object_work_id,$1,assigned_by FROM pto_work_assignments WHERE object_work_id=$2 ORDER BY started_at DESC LIMIT 1', [other.id, ctx.work.id]);
  const asLater = await fetch(`${base}/documentation-packages/${a.id}/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + otherToken }, body: JSON.stringify({ version: a.version, reason: REASON }) });
  assert.equal(asLater.status, 403);
  assert.match(await msg(asLater), /ответственный сотрудник ПТО/);
  assert.equal((await sql('SELECT archived_at FROM documentation_packages WHERE id=$1', [a.id]))[0].archived_at, null);
  // the PTO head of the object and the admin may archive
  await login('PTO_HEAD');
  assert.equal((await archive(raw, a.id, a.version)).status, 201);
  await login('ADMIN');
  assert.equal((await archive(raw, b.id, b.version)).status, 201);
  void req;
});

test('the generic document endpoint cannot create a bare AOSR shell or a bare executive-scheme shell — nothing is stored', async () => {
  const { req, raw } = await harness();
  const ctx = await setUp({ method: null });
  const count = async () => (await sql('SELECT count(*)::int AS n FROM documentation_documents WHERE documentation_package_id=$1', [ctx.pkg.id]))[0].n;
  const before = await count();
  for (const [type, text] of [['AOSR', /Пустой документ АОСР не создаётся/], ['EXECUTIVE_SCHEME', /Пустая исполнительная схема не создаётся/]] as const) {
    const r = await raw(`documentation-packages/${ctx.pkg.id}/documents`, { type });
    assert.equal(r.status, 400, type);
    assert.match(await msg(r), text);
  }
  assert.equal(await count(), before, 'no shell was created, with the method unset');
  // …whatever the method
  for (const method of ['CORE', 'EXTERNAL']) {
    await req(`documentation-packages/${ctx.pkg.id}/aosr-method`, { method });
    for (const type of ['AOSR', 'EXECUTIVE_SCHEME']) assert.equal((await raw(`documentation-packages/${ctx.pkg.id}/documents`, { type })).status, 400, `${method} ${type}`);
  }
  assert.equal(await count(), before);
  // a document type WITHOUT a dedicated flow is unaffected
  assert.equal((await raw(`documentation-packages/${ctx.pkg.id}/documents`, { type: 'ACT_CERTIFICATE' })).status, 201);
});

test('the dedicated flows still create REAL documents: a generated Core AOSR and a file-backed scheme; nothing is left empty', async () => {
  const { req } = await harness();
  const core = await setUp({ method: 'CORE' });
  await generatedAosr(req, core);
  assert.equal((await sql("SELECT count(*)::int AS n FROM documentation_documents d WHERE d.documentation_package_id=$1 AND d.type='AOSR' AND EXISTS (SELECT 1 FROM documentation_document_versions v WHERE v.documentation_document_id=d.id AND v.storage_provider='CORE_FILE')", [core.pkg.id]))[0].n, 1);
  const ext = await setUp({ method: 'EXTERNAL' });
  await uploadScheme(req, ext.pkg.id, 'ES-001');
  assert.equal((await sql("SELECT count(*)::int AS n FROM documentation_documents d WHERE d.documentation_package_id=$1 AND d.type='EXECUTIVE_SCHEME' AND EXISTS (SELECT 1 FROM documentation_document_versions v WHERE v.documentation_document_id=d.id AND v.storage_provider='CORE_FILE')", [ext.pkg.id]))[0].n, 1);
  assert.equal((await sql("SELECT count(*)::int AS n FROM documentation_documents d WHERE d.documentation_package_id=ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM documentation_document_versions v WHERE v.documentation_document_id=d.id)", [[core.pkg.id, ext.pkg.id]]))[0].n, 0, 'no empty shell');
  assert.equal((await presentPackage(req, core.pkg.id)).status, 'PRESENTED');
  assert.equal((await presentPackage(req, ext.pkg.id)).status, 'PRESENTED');
});

test('concurrency: parallel archives of one package → exactly one wins; archive racing a new claim never leaves two ACTIVE packages on a portion', async () => {
  const { raw } = await harness();
  const ctx = await setUp({ noPackage: true });
  const a = await newPkg(raw, ctx, [ctx.portion.id]);
  const results = await Promise.all(Array.from({ length: 6 }, () => archive(raw, a.id, a.version)));
  assert.equal(results.filter(r => r.status === 201).length, 1, results.map(r => r.status).join(','));
  assert.equal((await sql("SELECT count(*)::int AS n FROM audit_logs WHERE entity_id=$1 AND action='ARCHIVE'", [a.id]))[0].n, 1);
  // race: claim the released portion from several requests at once, while a fresh package is archived next to them
  const claims = await Promise.all(Array.from({ length: 6 }, () => raw('documentation-packages', { objectWorkId: ctx.work.id, quantityPortionIds: [ctx.portion.id] })));
  assert.equal(claims.filter(r => r.status === 201).length, 1, claims.map(r => r.status).join(','));
  const active = await sql('SELECT count(*)::int AS n FROM documentation_package_portions l JOIN documentation_packages p ON p.id=l.documentation_package_id WHERE l.quantity_portion_id=$1 AND p.archived_at IS NULL', [ctx.portion.id]);
  assert.equal(active[0].n, 1, 'one ACTIVE claim on the portion, whatever the interleaving');
});
