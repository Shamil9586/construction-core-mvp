import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { harness, closeHarness, setUp, generatedAosr, uploadScheme, legacyDocumentShell, presentPackage, fillAosr, INTERNAL, CUSTOMER, RP } from './helpers/aosr-harness';
import { addWork, teamEngineer, makeUser, handoffWorkToPto, newPortionFor } from './helpers/registry-fixtures';
import { actorByRole } from './helpers/pbx3-fixtures';

/**
 * ID-AUTO-2 — PTO registry + documentary readiness (the Object-scoped «Реестр ИД» read model).
 *
 * Real backend on PGlite, real routes, mock auth. The fixtures follow the PILOT-W01 shape (plastering, zone «1 этаж»,
 * RP fact 500 / Internal SC 498, a CORE package with one generated AOSR and one unfinished draft) and never touch LIVE.
 * The registry is a read model: these tests also prove it writes nothing, and that its verdict is the SAME as the forward gate's.
 */
after(closeHarness);

const registry = async (objectId: string, qs = '') => {
  const { raw } = await harness();
  const r = await raw(`objects/${objectId}/documentation-registry${qs}`);
  return { status: r.status, body: (await r.json()) as any };
};
const ok = async (objectId: string, qs = '') => { const r = await registry(objectId, qs); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const snapshotPackages = async (objectId: string) => ((await (await harness()).req('snapshot')).documentationPackages ?? []).filter((p: any) => p.objectId === objectId);
const rowOf = (view: any, packageId: string) => view.rows.find((r: any) => r.packageId === packageId);
const codes = (row: any) => row.readiness.reasons.map((r: any) => r.code);
/** The PILOT shape: zone «1 этаж», RP 500 / Internal SC 498 (the harness portion), method CORE. */
const pilot = (extra: any = {}) => setUp({ labels: ['1 этаж', '2 этаж'], location: null, ...extra });
/** A package on a NEW portion of the ctx Work (no overlap with the main package). */
async function extraPackage(ctx: any, method: 'CORE' | 'EXTERNAL' | null, label = 'Доп. участок') {
  const { req, login } = await harness();
  await login('PTO');
  const pkg = await req('documentation-packages', { objectWorkId: ctx.work.id, quantityPortionIds: [await newPortionFor(ctx.work.id, label, ctx.pto.id)] });
  if (method) await req(`documentation-packages/${pkg.id}/aosr-method`, { method });
  return pkg;
}

test('PILOT acceptance: the main CORE package shows work / zone / current quantity / method and WHY it is not ready (one generated AOSR, one unfinished draft)', async () => {
  const { req } = await harness();
  const ctx = await pilot();
  const generated = await generatedAosr(req, ctx, 'Устройство штукатурки стен');
  const draft = await req(`documentation-packages/${ctx.pkg.id}/aosr`, { title: 'Грунтовка основания' });

  const view = await ok(ctx.object.id);
  assert.equal(view.rows.length, 1, 'one active package = one row');
  const row = view.rows[0];

  // business identity, not technical ids
  assert.equal(row.packageId, ctx.pkg.id);
  assert.equal(row.workName, 'Устройство штукатурки стен');
  assert.equal(row.scope.zoneSummary, '1 этаж');
  assert.deepEqual(row.scope.currentQuantity, { quantity: INTERNAL, unit: 'м²', source: 'INTERNAL_SC' }, 'Internal SC 498, not the RP fact 500, and no history chain');
  assert.equal(row.responsible.id, ctx.pto.id);
  assert.equal(row.status, 'DRAFT');
  assert.equal(row.aosrMethod, 'CORE');
  assert.equal(row.aosrCount, 2);
  assert.equal(row.aosrGeneratedCount, 1);

  // the unfinished draft keeps the WHOLE package not ready, and the registry says exactly why
  assert.equal(row.readiness.ready, false);
  const draftReasons = row.readiness.reasons.filter((r: any) => r.aosrId === draft.id);
  assert.deepEqual(draftReasons.map((r: any) => r.code), ['AOSR_NOT_GENERATED', 'AOSR_SCHEME_MISSING']);
  assert.match(draftReasons[0].message, /АОСР «Грунтовка основания» не сформирован/);
  assert.match(draftReasons[1].message, /Для АОСР «Грунтовка основания» отсутствует исполнительная схема с файлом/);
  assert.ok(draftReasons.every((r: any) => r.target.kind === 'AOSR' && r.target.aosrId === draft.id), 'every blocker points at the place that fixes it');
  assert.equal(row.readiness.reasons.some((r: any) => r.aosrId === generated.aosr.id), false, 'the generated AOSR is not blamed');
  assert.ok(row.lastUpdate.at && row.lastUpdate.kind, 'last meaningful documentary update is present');

  // AOSR register: one row = one AOSR; number / no-number; DOCX state; scheme coverage; per-AOSR readiness
  assert.equal(row.aosrs.length, 2);
  const done = row.aosrs.find((a: any) => a.id === generated.aosr.id), open = row.aosrs.find((a: any) => a.id === draft.id);
  assert.equal(done.number, 1);
  assert.deepEqual(done.docx, { state: 'CURRENT', revisionCount: 1 });
  assert.equal(done.schemeCoverage.covered, true);
  assert.equal(done.readiness.ready, true);
  assert.deepEqual(done.generationIssues, [], 'a current act is not asked to be re-generated');
  assert.equal(done.startDate !== null && done.endDate !== null, true, 'work start / finish dates are exposed');
  assert.equal(open.number, null, '«номер не присвоен»');
  assert.equal(open.docx.state, 'NOT_GENERATED');
  assert.equal(open.schemeCoverage.covered, false);
  assert.equal(open.readiness.ready, false);
  assert.ok(open.generationIssues.length > 0, 'what blocks generating the draft is exposed (existing AOSR content readiness)');
  assert.deepEqual(open.zones, [], 'a draft with no provenance link has no zone yet');
  assert.deepEqual(done.zones, ['1 этаж'], 'the generated act is linked to the production scope it documents');

  // the forward gate agrees: this package really cannot be presented
  const refused = await presentPackage(req, ctx.pkg.id, 400);
  assert.match(refused.message, /Не сформирован актуальный DOCX у АОСР: «Грунтовка основания»/);
  assert.equal(row.readiness.reasons[0].message.includes('Грунтовка основания'), true);
});

test('CORE package with every AOSR generated + a file-backed scheme is ready — and the forward gate lets it through', async () => {
  const { req } = await harness();
  const ctx = await pilot();
  const first = await generatedAosr(req, ctx, 'Устройство штукатурки стен');
  await generatedAosr(req, ctx, 'Грунтовка основания', { schemeId: first.schemeId });

  const row = rowOf(await ok(ctx.object.id), ctx.pkg.id);
  assert.equal(row.readiness.ready, true, JSON.stringify(row.readiness));
  assert.deepEqual(row.readiness.reasons, []);
  assert.deepEqual(row.aosrs.map((a: any) => a.number).sort(), [1, 2]);
  assert.equal(row.schemeFileBackedCount, 1);
  await presentPackage(req, ctx.pkg.id); // 201: the gate says the same
});

test('an AOSR edited after its generation is not ready until a new current DOCX is generated', async () => {
  const { req } = await harness();
  const ctx = await pilot();
  const g = await generatedAosr(req, ctx);
  assert.equal(rowOf(await ok(ctx.object.id), ctx.pkg.id).readiness.ready, true);

  const cur = await req(`aosr/${g.aosr.id}`);
  await req(`aosr/${g.aosr.id}/edit`, { additionalInfo: 'Правка после формирования', version: cur.version });
  const view = await ok(ctx.object.id);
  const row = rowOf(view, ctx.pkg.id);
  assert.equal(row.readiness.ready, false);
  assert.deepEqual(codes(row), ['AOSR_DOCX_OUTDATED']);
  assert.equal(row.aosrs[0].docx.state, 'OUTDATED');
  assert.equal(row.aosrs[0].number, 1, 'the official number never changes');
  assert.equal(row.readiness.reasons[0].target.aosrId, g.aosr.id);
  assert.match((await presentPackage(req, ctx.pkg.id, 400)).message, /Не сформирован актуальный DOCX у АОСР: «Устройство штукатурки стен»/);

  await req(`aosr/${g.aosr.id}/generate`, { version: (await req(`aosr/${g.aosr.id}`)).version });
  assert.equal(rowOf(await ok(ctx.object.id), ctx.pkg.id).readiness.ready, true, 'regeneration restores readiness');
});

test('a metadata-only executive scheme never satisfies readiness; a file-backed one does (both methods)', async () => {
  const { req } = await harness();
  // EXTERNAL package: only a legacy bare scheme shell (no file) -> not ready; then a real file -> ready
  const ext = await pilot({ method: 'EXTERNAL' });
  await legacyDocumentShell(ext.pkg.id, 'EXECUTIVE_SCHEME');
  let row = rowOf(await ok(ext.object.id), ext.pkg.id);
  assert.equal(row.schemeCount, 1);
  assert.equal(row.schemeFileBackedCount, 0, 'a record without a file is metadata only');
  assert.deepEqual(codes(row), ['SCHEME_FILE_REQUIRED']);
  assert.equal(row.readiness.reasons[0].target.kind, 'SCHEMES');
  await uploadScheme(req, ext.pkg.id, 'ES-001');
  row = rowOf(await ok(ext.object.id), ext.pkg.id);
  assert.equal(row.schemeFileBackedCount, 1);
  assert.equal(row.readiness.ready, true);

  // CORE: a generated act whose only linked scheme loses its link (anomalous legacy data) is NOT covered, and the gate refuses it too
  const core = await pilot();
  const g = await generatedAosr(req, core);
  assert.equal(rowOf(await ok(core.object.id), core.pkg.id).readiness.ready, true);
  const { pool } = await import('../apps/backend/src/db');
  await pool.query('DELETE FROM aosr_scheme_links WHERE aosr_id=$1', [g.aosr.id]);
  row = rowOf(await ok(core.object.id), core.pkg.id);
  assert.equal(row.readiness.ready, false);
  assert.deepEqual(codes(row), ['AOSR_SCHEME_MISSING']);
  assert.equal(row.aosrs[0].schemeCoverage.covered, false);
  assert.match((await presentPackage(req, core.pkg.id, 400)).message, /Нет исполнительной схемы с файлом у АОСР: «Устройство штукатурки стен»/);
});

test('EXTERNAL package: zero Core AOSRs / DOCX / numbers are valid — no AOSR-related blocker, no placeholder rows', async () => {
  const { req } = await harness();
  const ctx = await pilot({ method: 'EXTERNAL' });
  let row = rowOf(await ok(ctx.object.id), ctx.pkg.id);
  assert.equal(row.aosrMethod, 'EXTERNAL');
  assert.equal(row.aosrCount, 0);
  assert.deepEqual(row.aosrs, [], 'no placeholder AOSR is invented to give the register a row');
  assert.deepEqual(codes(row), ['SCHEME_FILE_REQUIRED'], 'only the genuine evidence requirement — nothing about missing Core AOSRs, DOCX or numbers');
  await uploadScheme(req, ctx.pkg.id, 'ES-ext');
  row = rowOf(await ok(ctx.object.id), ctx.pkg.id);
  assert.equal(row.readiness.ready, true);
  assert.deepEqual(row.readiness.reasons, []);
  await presentPackage(req, ctx.pkg.id);
});

test('METHOD_UNSET is its own explicit state: not ready, never inferred as external, points at the method choice', async () => {
  const { req } = await harness();
  const ctx = await pilot({ method: null });
  await uploadScheme(req, ctx.pkg.id, 'ES-1');
  const view = await ok(ctx.object.id);
  const row = rowOf(view, ctx.pkg.id);
  assert.equal(row.aosrMethod, null);
  assert.equal(row.readiness.ready, false);
  assert.deepEqual(codes(row), ['METHOD_UNSET']);
  assert.deepEqual(row.readiness.reasons[0].target, { kind: 'METHOD' });
  assert.equal((await ok(ctx.object.id, '?method=UNSET')).rows.length, 1);
  assert.equal((await ok(ctx.object.id, '?method=EXTERNAL')).rows.length, 0, 'absence of AOSRs does not make it external');
  assert.equal((await ok(ctx.object.id, '?method=CORE')).rows.length, 0);
  assert.match((await presentPackage(req, ctx.pkg.id, 400)).message, /Сначала выберите способ подготовки АОСР/);
});

test('an unscoped historical package is explicit about its missing scope (SCOPE target), never faked', async () => {
  const ctx = await pilot({ method: 'EXTERNAL' });
  const { pool } = await import('../apps/backend/src/db');
  // reproduce a legacy unscoped package: detach the scope link directly (the trigger forbids only overlap, not removal of history in tests)
  await pool.query('DELETE FROM documentation_package_portions WHERE documentation_package_id=$1', [ctx.pkg.id]);
  const row = rowOf(await ok(ctx.object.id), ctx.pkg.id);
  assert.equal(row.scope.hasScope, false);
  assert.equal(row.scope.zoneSummary, null);
  assert.equal(row.scope.currentQuantity, null);
  assert.equal(row.readiness.reasons[0].code, 'SCOPE_NOT_SELECTED');
  assert.deepEqual(row.readiness.reasons[0].target, { kind: 'SCOPE' });
});

test('the registry is scoped to ONE Object: packages of another Object never appear', async () => {
  const a = await pilot();
  const b = await pilot();
  const viewA = await ok(a.object.id), viewB = await ok(b.object.id);
  assert.deepEqual(viewA.rows.map((r: any) => r.packageId), [a.pkg.id]);
  assert.deepEqual(viewB.rows.map((r: any) => r.packageId), [b.pkg.id]);
  assert.equal(viewA.objectId, a.object.id);
  assert.equal(viewA.rows.some((r: any) => r.workId === b.work.id), false);
  assert.equal(viewA.summary.activePackages, 1, 'the summary counts this Object only');
});

test('archived packages stay out of the active registry, readiness, workload and counts — and are reachable only on explicit request', async () => {
  const { req, raw } = await harness();
  const ctx = await pilot({ method: 'EXTERNAL' });
  await uploadScheme(req, ctx.pkg.id, 'ES-1');
  // a disposable, NOT-ready package (method unset) that is then archived
  const junk = await extraPackage(ctx, null, 'Тестовый участок');
  let view = await ok(ctx.object.id);
  assert.equal(view.summary.activePackages, 2);
  assert.equal(view.summary.notReady, 1);
  assert.equal(view.summary.awaitingEngineerAction, 2, 'both DRAFT packages are on the engineer');

  const arch = await raw(`documentation-packages/${junk.id}/archive`, { reason: 'Тестовый пакет', version: junk.version });
  assert.equal(arch.status, 201, JSON.stringify(await arch.json()));
  view = await ok(ctx.object.id);
  assert.deepEqual(view.rows.map((r: any) => r.packageId), [ctx.pkg.id], 'the archived package is gone from the working registry');
  assert.deepEqual(view.summary, { activePackages: 1, ready: 1, notReady: 0, awaitingEngineerAction: 1 }, 'it no longer affects readiness, workload or attention counts');
  assert.equal(view.archivedCount, 1);
  assert.equal(view.archivedRows, undefined, 'archived packages are not returned unless asked for');

  const withArchive = await ok(ctx.object.id, '?archived=true');
  assert.equal(withArchive.archivedRows.length, 1);
  assert.equal(withArchive.archivedRows[0].packageId, junk.id);
  assert.equal(withArchive.archivedRows[0].archiveReason, 'Тестовый пакет');
  assert.ok(withArchive.archivedRows[0].archivedAt && withArchive.archivedRows[0].archivedByName);
  assert.equal(withArchive.archivedRows[0].readiness, undefined, 'an archived package is not judged for readiness');
  assert.deepEqual(withArchive.summary, view.summary, 'asking for the archive does not change the counts');
  assert.equal(withArchive.rows.length, 1);
});

test('current quantity follows the accepted provenance (customer > Internal SC > RP) and is a single figure, not a history', async () => {
  const { req } = await harness();
  const ctx = await pilot({ method: 'EXTERNAL' });
  await uploadScheme(req, ctx.pkg.id, 'ES-1');
  let row = rowOf(await ok(ctx.object.id), ctx.pkg.id);
  assert.deepEqual(row.scope.currentQuantity, { quantity: INTERNAL, unit: 'м²', source: 'INTERNAL_SC' });
  assert.equal(JSON.stringify(row).includes(RP), false, 'the superseded RP figure is not shown');

  await presentPackage(req, ctx.pkg.id);
  await req(`documentation-packages/${ctx.pkg.id}/customer-accepted-quantity`, { items: [{ quantityPortionId: ctx.portion.id, quantity: CUSTOMER }], idempotencyKey: randomUUID() });
  row = rowOf(await ok(ctx.object.id), ctx.pkg.id);
  assert.deepEqual(row.scope.currentQuantity, { quantity: CUSTOMER, unit: 'м²', source: 'CUSTOMER_ACCEPTED' });
  assert.equal(row.lastUpdate.kind, 'CUSTOMER_QUANTITY_RECORDED');

  // the registry agrees with the existing snapshot identity (same provenance code path, not a second quantity model)
  const snap = (await snapshotPackages(ctx.object.id)).find((p: any) => p.id === ctx.pkg.id);
  assert.deepEqual(row.scope.currentQuantity, snap.scope.currentQuantity);
  assert.equal(row.scope.zoneSummary, snap.scope.zoneSummary);
});

test('counts equal the registry state and are independent of the filters; filters only narrow rows', async () => {
  const { req } = await harness();
  const ctx = await pilot({ method: 'EXTERNAL', noPackage: false });
  await uploadScheme(req, ctx.pkg.id, 'ES-1'); // ready
  await extraPackage(ctx, null, 'Участок без способа'); // METHOD_UNSET -> not ready
  const core = await extraPackage(ctx, 'CORE', 'Участок Core'); // CORE with no AOSR -> not ready
  await req(`documentation-packages/${core.id}/aosr`, { title: 'Грунтовка основания' });

  const view = await ok(ctx.object.id);
  assert.equal(view.rows.length, 3);
  const ready = view.rows.filter((r: any) => r.readiness.ready).length;
  assert.deepEqual(view.summary, { activePackages: 3, ready, notReady: 3 - ready, awaitingEngineerAction: view.rows.filter((r: any) => r.awaitingEngineerAction).length });
  assert.equal(view.summary.ready, 1);
  assert.equal(view.summary.notReady, 2);

  for (const [qs, expected] of [['?ready=true', 1], ['?ready=false', 2], ['?method=CORE', 1], ['?method=UNSET', 1], ['?method=EXTERNAL', 1], ['?status=DRAFT', 3], ['?status=PRESENTED', 0], ['?q=грунтовка', 1], ['?q=ШТУКАТУРКИ', 3], ['?q=нет-такого', 0], [`?responsibleUserId=${ctx.pto.id}`, 3], [`?responsibleUserId=${randomUUID()}`, 0], ['?ready=false&method=UNSET', 1]] as [string, number][]) {
    const v = await ok(ctx.object.id, qs);
    assert.equal(v.rows.length, expected, qs);
    assert.equal(v.matchedCount, expected, qs);
    assert.deepEqual(v.summary, view.summary, `${qs}: counts describe the whole authorized set, not the filter`);
  }
  assert.deepEqual(view.filterOptions.responsible.map((x: any) => x.id), [ctx.pto.id]);
  // unknown / malformed filters are refused, not silently ignored
  assert.equal((await registry(ctx.object.id, '?status=NOPE')).status, 400);
  assert.equal((await registry(ctx.object.id, '?responsibleUserId=1')).status, 400);
  assert.equal((await registry(ctx.object.id, '?bogus=1')).status, 400);
});

test('every registry row opens the right package, and every AOSR row the right act', async () => {
  const { req } = await harness();
  const ctx = await pilot();
  const g = await generatedAosr(req, ctx);
  const second = await extraPackage(ctx, 'EXTERNAL', 'Второй участок');
  const view = await ok(ctx.object.id);
  assert.equal(view.rows.length, 2);
  const snap = await snapshotPackages(ctx.object.id);
  for (const row of view.rows) {
    const detail = await req(`documentation-packages/${row.packageId}/aosr`);
    assert.equal(detail.packageId, row.packageId);
    assert.equal(detail.objectId, ctx.object.id);
    const sp = snap.find((p: any) => p.id === row.packageId);
    assert.ok(sp, 'the same package is in the existing working set (the detail route resolves it)');
    assert.equal(sp.objectWorkId, row.workId);
    assert.equal(sp.workName, row.workName);
    assert.deepEqual(detail.items.map((i: any) => i.id).sort(), row.aosrs.map((a: any) => a.id).sort());
    for (const a of row.aosrs) assert.equal((await req(`aosr/${a.id}`)).packageId, row.packageId);
  }
  assert.ok(rowOf(view, second.id) && rowOf(view, ctx.pkg.id).aosrs[0].id === g.aosr.id);
});

test('registry readiness IS the forward gate: ready <=> the package can be presented, for every rule', async () => {
  const { req } = await harness();
  const scenarios: { name: string; ctx: any; ready: boolean }[] = [];
  const ext = await pilot({ method: 'EXTERNAL' }); await uploadScheme(req, ext.pkg.id, 'ES');
  scenarios.push({ name: 'external + file scheme', ctx: ext, ready: true });
  const extNoFile = await pilot({ method: 'EXTERNAL' });
  scenarios.push({ name: 'external, no scheme', ctx: extNoFile, ready: false });
  const unset = await pilot({ method: null }); await uploadScheme(req, unset.pkg.id, 'ES');
  scenarios.push({ name: 'method unset', ctx: unset, ready: false });
  const coreEmpty = await pilot(); await uploadScheme(req, coreEmpty.pkg.id, 'ES');
  scenarios.push({ name: 'core without AOSR', ctx: coreEmpty, ready: false });
  const coreDone = await pilot(); await generatedAosr(req, coreDone);
  scenarios.push({ name: 'core generated', ctx: coreDone, ready: true });
  for (const s of scenarios) {
    const row = rowOf(await ok(s.ctx.object.id), s.ctx.pkg.id);
    assert.equal(row.readiness.ready, s.ready, s.name);
    const message = row.readiness.reasons[0]?.message;
    if (s.ready) await presentPackage(req, s.ctx.pkg.id);
    else {
      const refused = await presentPackage(req, s.ctx.pkg.id, 400);
      assert.equal(refused.message.length > 0 && !!message, true, s.name);
      if (!/DOCX/.test(refused.message)) assert.equal(refused.message, message, `${s.name}: the gate refuses with the registry's first reason`);
    }
  }
});

test('authorization: PTO engineer = assignment-scoped, PTO head = the object they lead; both equal the existing snapshot visibility', async () => {
  const { req, login, as } = await harness();
  const ctx = await pilot({ method: 'EXTERNAL' });
  const second = await addWork(ctx, 'Окраска стен', 'Участок 2');
  const engineer = await teamEngineer('Инженер Е (без членства в объекте)');
  await handoffWorkToPto(second.work.id, engineer);
  await as(engineer);
  const engineerPkg = await req('documentation-packages', { objectWorkId: second.work.id, quantityPortionIds: [second.portion.id] });
  assert.equal(engineerPkg.responsibleUserId, engineer.id);

  // the object member (seeded PTO) reads every work of the object
  await login('PTO');
  const member = await ok(ctx.object.id);
  assert.equal(member.worksScope, 'ALL_WORKS');
  assert.deepEqual(member.rows.map((r: any) => r.packageId).sort(), [ctx.pkg.id, engineerPkg.id].sort());

  // the engineer is NOT an object member: only the work they hold an effective handoff on
  await as(engineer);
  const mine = await ok(ctx.object.id);
  assert.equal(mine.worksScope, 'ASSIGNED_WORKS');
  assert.deepEqual(mine.rows.map((r: any) => r.packageId), [engineerPkg.id]);
  assert.deepEqual(mine.summary, { activePackages: 1, ready: 0, notReady: 1, awaitingEngineerAction: 1 });
  assert.deepEqual(mine.rows.map((r: any) => r.packageId).sort(), (await snapshotPackages(ctx.object.id)).map((p: any) => p.id).sort(), 'identical to what the snapshot already lets this engineer see');
  // filters cannot widen the scope
  assert.equal((await ok(ctx.object.id, `?responsibleUserId=${ctx.pto.id}`)).rows.length, 0);
  assert.equal((await ok(ctx.object.id, '?q=штукатурки')).rows.length, 0, 'a search for the other work finds nothing: it is outside this engineer\'s scope');
  assert.equal((await ok(ctx.object.id, '?archived=true')).archivedRows.length, 0);

  // an engineer on the team with no handoff and no membership: denied
  const idle = await teamEngineer('Инженер без назначения');
  await as(idle);
  assert.equal((await registry(ctx.object.id)).status, 403);

  // the PTO head of the object sees the whole documentary workload of the object (both engineers' packages)
  await login('PTO_HEAD');
  const head = await ok(ctx.object.id);
  assert.equal(head.worksScope, 'ALL_WORKS');
  assert.deepEqual(head.rows.map((r: any) => r.packageId).sort(), [ctx.pkg.id, engineerPkg.id].sort());
  assert.deepEqual(head.filterOptions.responsible.map((x: any) => x.id).sort(), [ctx.pto.id, engineer.id].sort());
  assert.deepEqual(head.rows.map((r: any) => r.packageId).sort(), (await snapshotPackages(ctx.object.id)).map((p: any) => p.id).sort());
  assert.equal((await ok(ctx.object.id, `?responsibleUserId=${engineer.id}`)).rows[0].packageId, engineerPkg.id);
});

test('authorization: cross-object access, roles outside the PTO workspace and anonymous callers are refused; an unknown object is 404', async () => {
  const { login, as, base } = await harness();
  const a = await pilot();
  const b = await pilot();
  const stranger = await makeUser('Чужой начальник ПТО', 'PTO_HEAD');
  await as(stranger);
  assert.equal((await registry(a.object.id)).status, 403, 'a PTO head who does not lead this object');
  const otherPm = await makeUser('Другой РП', 'PROJECT_MANAGER');
  await as(otherPm);
  assert.equal((await registry(a.object.id)).status, 403, 'a project manager of another object');
  // the registry is PTO's documentary workspace (DOCUMENTATION_MANAGE): roles that only READ documentation status on W01 get none, SDO / contractors neither
  for (const role of ['SDO', 'SDO_HEAD', 'CONTRACTOR_VIEWER', 'PROJECT_MANAGER', 'DEPUTY_DIRECTOR', 'GENERAL_DIRECTOR', 'CONSTRUCTION_CONTROL', 'CONSTRUCTION_CONTROL_HEAD']) {
    await login(role);
    assert.equal((await registry(a.object.id)).status, 403, role);
  }
  await login('PTO');
  assert.equal((await registry(randomUUID())).status, 404);
  assert.equal((await registry('not-a-uuid')).status, 400);
  assert.equal((await fetch(`${base}/objects/${a.object.id}/documentation-registry`)).status, 401);
  // the legitimate actors are unaffected: same two objects, each its own registry (ADMIN = system override, the PTO member via its membership)
  await login('ADMIN');
  assert.equal((await ok(a.object.id)).rows[0].packageId, a.pkg.id);
  assert.equal((await ok(b.object.id)).rows[0].packageId, b.pkg.id);
  await login('PTO');
  assert.equal((await ok(a.object.id)).rows[0].packageId, a.pkg.id);
  // existing visibility is untouched: a read-only role still reads the same packages through the snapshot (W01), it just has no registry
  await login('DEPUTY_DIRECTOR');
  assert.equal((await snapshotPackages(a.object.id)).length >= 1, true);
});

test('the registry is a pure read: no audit rows, no domain rows, no number consumed — viewing and filtering write nothing', async () => {
  const { req } = await harness();
  const ctx = await pilot();
  await generatedAosr(req, ctx);
  await req(`documentation-packages/${ctx.pkg.id}/aosr`, { title: 'Грунтовка основания' });
  const { pool } = await import('../apps/backend/src/db');
  const snapshot = async () => (await pool.query(`SELECT (SELECT count(*) FROM audit_logs)::int AS audit,(SELECT count(*) FROM aosr_documents)::int AS aosr,(SELECT count(*) FROM aosr_number_counters WHERE object_id=$1 AND last_number>0)::int AS counters,(SELECT coalesce(sum(last_number),0) FROM aosr_number_counters WHERE object_id=$1)::int AS last,(SELECT count(*) FROM documentation_packages)::int AS packages,(SELECT sum(version) FROM documentation_packages)::int AS versions`, [ctx.object.id])).rows[0];
  const before = await snapshot();
  await ok(ctx.object.id);
  await ok(ctx.object.id, '?ready=false&q=грунт&archived=true');
  assert.deepEqual(await snapshot(), before);
});

test('performance: a fixed, small number of queries however many packages and AOSRs the Object holds (no N+1)', async () => {
  const { req, login } = await harness();
  const { pool } = await import('../apps/backend/src/db');
  const count = async (objectId: string) => {
    const original = pool.query; let n = 0;
    pool.query = function (...args: any[]) { n++; return original.apply(pool, args); };
    try { await ok(objectId); } finally { pool.query = original; }
    return n;
  };
  const small = await pilot();
  await generatedAosr(req, small);
  const queriesSmall = await count(small.object.id);

  const large = await pilot();
  const shared = await generatedAosr(req, large);
  await generatedAosr(req, large, 'Грунтовка основания', { schemeId: shared.schemeId });
  for (let i = 0; i < 4; i++) {
    await login('PTO');
    const pkg = await req('documentation-packages', { objectWorkId: large.work.id, quantityPortionIds: [await newPortionFor(large.work.id, `Участок ${i + 2}`, large.pto.id)] });
    await req(`documentation-packages/${pkg.id}/aosr-method`, { method: 'CORE' });
    const portion = (await req(`documentation-packages/${pkg.id}/aosr`)).workPortions.find((p: any) => p.label === `Участок ${i + 2}`);
    await generatedAosr(req, { ...large, pkg, portion }, `Акт ${i}`);
    await req(`documentation-packages/${pkg.id}/aosr`, { title: `Черновик ${i}` });
  }
  const view = await ok(large.object.id);
  assert.equal(view.rows.length, 5);
  assert.equal(view.rows.reduce((n: number, r: any) => n + r.aosrs.length, 0), 2 + 4 * 2);
  const queriesLarge = await count(large.object.id);
  assert.equal(queriesLarge, queriesSmall, `1 package/1 AOSR: ${queriesSmall} queries; 5 packages/10 AOSRs: ${queriesLarge} queries`);
  assert.ok(queriesLarge <= 30, 'and the number stays small');
});
