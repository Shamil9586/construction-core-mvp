import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { harness, closeHarness, setUp, fillParties, fillAosr, uploadScheme, generatedAosr, presentPackage, SCHEME_FILE, dt, RP, INTERNAL, CUSTOMER } from './helpers/aosr-harness';
import { makeUser, tokenFor } from './helpers/pbx3-fixtures';

/**
 * ID-AUTO-1 final corrective — the Core AOSR generator is an OPTIONAL tool.
 *
 *   FLOW A  «АОСР формируются в Core»   — generator used            ┐
 *   FLOW B  «АОСР формируются вне Core» — AOSR prepared externally  ┘→ file-backed executive scheme → presentation →
 *                                                                      customer-accepted quantity → SDO (one downstream process)
 */
after(closeHarness);

const present = async (req: any, base: string, pkg: any) => {
  let p = await req(`${base}/status`, { status: 'PREPARING', version: pkg.version });
  p = await req(`${base}/status`, { status: 'READY_FOR_PRESENTATION', version: p.version });
  return req(`${base}/status`, { status: 'PRESENTED', version: p.version });
};
const count = async (sql: string, args: any[] = []) => { const { pool } = await import('../apps/backend/src/db'); return (await pool.query(sql, args)).rows[0].n as number; };
const snapshotFigures = async (req: any, portionId: string, pkgId: string) => {
  const snap = await req('snapshot');
  const portion = snap.portions.find((x: any) => x.id === portionId);
  return { rp: portion.rpFactQuantity, internal: portion.internalScConfirmedQuantity, customer: portion.customerScConfirmedQuantity, sdoReady: snap.sdoPackageReadiness.find((x: any) => x.documentationPackageId === pkgId).ready };
};

test('the generator is optional and explicit: nothing is inferred, Core AOSR operations need «АОСР формируются в Core»', async () => {
  const { req, raw } = await harness();
  const ctx = await setUp({ method: null });
  const base = `documentation-packages/${ctx.pkg.id}`;
  let view = await req(`${base}/aosr`);
  assert.equal(view.method, null, 'no method is inferred from "no AOSR yet"');
  assert.deepEqual(view.suggestions, [], 'no suggestions before the choice');
  assert.equal((await raw(`${base}/aosr`, { title: 'Без выбора' })).status, 400);
  assert.equal((await raw(`${base}/aosr-suggestions/dismiss`, { suggestionCode: 'PLASTER.PRIMER' })).status, 400);
  await req(`${base}/aosr-method`, { method: 'CORE', comment: 'Готовим АОСР в Core' });
  view = await req(`${base}/aosr`);
  assert.equal(view.method, 'CORE');
  assert.ok(view.suggestions.length > 0);
  assert.equal(view.methodHistory.length, 1);
  // Flow A keeps multiple AOSRs per Work.
  const a1 = await req(`${base}/aosr`, { suggestionCode: 'PLASTER.PRIMER' }), a2 = await req(`${base}/aosr`, { suggestionCode: 'PLASTER.PLASTER' });
  assert.equal((await req(`${base}/aosr`)).items.length, 2);
  assert.notEqual(a1.id, a2.id);
  // Declaring the same method again is a no-op (no duplicate audit row).
  await req(`${base}/aosr-method`, { method: 'CORE' });
  assert.equal((await req(`${base}/aosr`)).methodHistory.length, 1);
});

test('external mode creates NOTHING: no AOSR record, no document shell, no AOSR number — only the audited fact', async () => {
  const { req, raw } = await harness();
  const ctx = await setUp({ method: null });
  const base = `documentation-packages/${ctx.pkg.id}`;
  const before = {
    aosr: await count('SELECT count(*)::int AS n FROM aosr_documents WHERE documentation_package_id=$1', [ctx.pkg.id]),
    docs: await count('SELECT count(*)::int AS n FROM documentation_documents WHERE documentation_package_id=$1', [ctx.pkg.id]),
    counters: await count('SELECT coalesce(max(last_number),0)::int AS n FROM aosr_number_counters WHERE object_id=$1', [ctx.object.id]),
  };
  const chosen = await req(`${base}/aosr-method`, { method: 'EXTERNAL' });
  assert.equal(chosen.method, 'EXTERNAL');
  assert.deepEqual({
    aosr: await count('SELECT count(*)::int AS n FROM aosr_documents WHERE documentation_package_id=$1', [ctx.pkg.id]),
    docs: await count('SELECT count(*)::int AS n FROM documentation_documents WHERE documentation_package_id=$1', [ctx.pkg.id]),
    counters: await count('SELECT coalesce(max(last_number),0)::int AS n FROM aosr_number_counters WHERE object_id=$1', [ctx.object.id]),
  }, before);
  const view = await req(`${base}/aosr`);
  assert.equal(view.method, 'EXTERNAL');
  assert.deepEqual(view.items, []);
  assert.deepEqual(view.suggestions, []);
  assert.equal(view.methodHistory[0].method, 'EXTERNAL');
  // Core AOSR creation is refused in this mode (no placeholder can appear through the API either).
  assert.equal((await raw(`${base}/aosr`, { title: 'x' })).status, 400);
  assert.equal(await count('SELECT count(*)::int AS n FROM aosr_documents WHERE documentation_package_id=$1', [ctx.pkg.id]), 0);
  // The fact is history: append-only.
  const { pool } = await import('../apps/backend/src/db');
  await assert.rejects(pool.query('UPDATE documentation_package_aosr_methods SET method=$1', ['CORE']));
  await assert.rejects(pool.query('DELETE FROM documentation_package_aosr_methods'));
});

test('switching the method never loses data: Core -> external is refused while Core AOSRs exist; external -> Core is allowed', async () => {
  const { req, raw } = await harness();
  const ctx = await setUp({ method: 'CORE' });
  const base = `documentation-packages/${ctx.pkg.id}`;
  const draft = await req(`${base}/aosr`, { title: 'Черновик' });
  assert.equal((await raw(`${base}/aosr-method`, { method: 'EXTERNAL' })).status, 400, 'a draft AOSR exists');
  await req(`aosr/${draft.id}/delete`, {});
  await req(`${base}/aosr-method`, { method: 'EXTERNAL' });
  await req(`${base}/aosr-method`, { method: 'CORE' });
  const view = await req(`${base}/aosr`);
  assert.deepEqual(view.methodHistory.map((h: any) => h.method), ['CORE', 'EXTERNAL', 'CORE']);
  // A generated AOSR (it owns an official number) keeps the package on Core for good.
  await fillParties(req, ctx.pkg.id);
  const material = await req(`${base}/aosr-materials`, { name: 'Смесь', qualityDocuments: [{ docType: 'CERTIFICATE', number: 'RU-1' }] });
  const scheme = await uploadScheme(req, ctx.pkg.id, 'ES-001');
  const aosr = await req(`${base}/aosr`, { title: 'Сформированный' });
  await fillAosr(req, ctx, aosr.id, material, { schemeId: scheme.id });
  await req(`aosr/${aosr.id}/generate`, { version: (await req(`aosr/${aosr.id}`)).version });
  assert.equal((await raw(`${base}/aosr-method`, { method: 'EXTERNAL' })).status, 400);
});

test('choosing a method is not an authorization bypass: same access gate as every package mutation', async () => {
  const { req, raw, login, base: origin } = await harness();
  const ctx = await setUp({ method: null });
  const base = `documentation-packages/${ctx.pkg.id}`;
  await login('PROJECT_MANAGER');
  assert.equal((await raw(`${base}/aosr-method`, { method: 'EXTERNAL' })).status, 403);
  await login('SDO');
  assert.equal((await raw(`${base}/aosr-method`, { method: 'EXTERNAL' })).status, 403);
  // A PTO engineer who is not the work's effective assignee.
  const stranger = await tokenFor(await makeUser('Чужой ПТО', 'PTO'));
  const r = await fetch(`${origin}/${base}/aosr-method`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + stranger }, body: JSON.stringify({ method: 'EXTERNAL' }) });
  assert.ok([403, 404].includes(r.status), 'stranger refused: ' + r.status);
  await login('PTO');
  assert.equal((await req(`${base}/aosr`)).method, null, 'nothing was recorded by the refused attempts');
});

test('executive scheme evidence (both flows): a metadata-only scheme is not evidence, a file-backed one is; the upload leaves no empty shell', async () => {
  const { req, raw } = await harness();
  const ctx = await setUp({ method: 'EXTERNAL' });
  const base = `documentation-packages/${ctx.pkg.id}`;
  // A scheme record without a file (what an old LIVE record looks like).
  const shell = await req(`${base}/documents`, { type: 'EXECUTIVE_SCHEME' });
  let view = await req(`${base}/aosr`);
  assert.equal(view.schemes.find((s: any) => s.id === shell.id).hasFile, false);
  assert.equal(view.hasFileBackedScheme, false);
  assert.equal((await raw(`${base}/status`, { status: 'PREPARING', version: ctx.pkg.version })).status, 201);
  const cur = (await req('snapshot')).documentationPackages.find((x: any) => x.id === ctx.pkg.id);
  let p = await req(`${base}/status`, { status: 'READY_FOR_PRESENTATION', version: cur.version });
  const refused = await raw(`${base}/status`, { status: 'PRESENTED', version: p.version });
  assert.equal(refused.status, 400);
  assert.match((await refused.json() as any).message, /исполнительная схема с загруженным файлом/);
  // A failed upload (bytes do not match the declared type) leaves nothing behind.
  const docsBefore = await count('SELECT count(*)::int AS n FROM documentation_documents WHERE documentation_package_id=$1', [ctx.pkg.id]);
  assert.equal((await raw(`${base}/executive-schemes`, { title: 'Битый', fileName: 'x.pdf', mimeType: 'application/pdf', base64: Buffer.from('not a pdf').toString('base64') })).status, 400);
  assert.equal(await count('SELECT count(*)::int AS n FROM documentation_documents WHERE documentation_package_id=$1', [ctx.pkg.id]), docsBefore);
  // Attaching the real file to the metadata-only record makes it evidence (and creates one version, CORE_FILE).
  const attached = await req(`${base}/executive-schemes/${shell.id}/file`, { title: 'ES-001', ...SCHEME_FILE });
  assert.equal(attached.hasFile, true);
  assert.equal(attached.title, 'ES-001');
  assert.equal(await count("SELECT count(*)::int AS n FROM documentation_document_versions WHERE documentation_document_id=$1 AND storage_provider='CORE_FILE'", [shell.id]), 1);
  p = await req(`${base}/status`, { status: 'PRESENTED', version: p.version });
  assert.equal(p.status, 'PRESENTED');
  // Created-with-file schemes are never empty: every EXECUTIVE_SCHEME created by upload has its version.
  const own = await count("SELECT count(*)::int AS n FROM documentation_documents d WHERE d.documentation_package_id=$1 AND d.type='EXECUTIVE_SCHEME' AND NOT EXISTS (SELECT 1 FROM documentation_document_versions v WHERE v.documentation_document_id=d.id)", [ctx.pkg.id]);
  assert.equal(own, 0);
});

test('the scheme file is downloadable only with authorization, as the real bytes', async () => {
  const { req, raw, base: origin } = await harness();
  const ctx = await setUp({ method: 'EXTERNAL' });
  const scheme = await uploadScheme(req, ctx.pkg.id, 'ES-001');
  const path = `documentation-packages/${ctx.pkg.id}/executive-schemes/${scheme.id}/file`;
  assert.equal((await fetch(`${origin}/${path}`)).status, 401);
  const ok = await raw(path);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'application/pdf');
  assert.match(ok.headers.get('content-disposition') ?? '', /^attachment; filename="scheme\.pdf"; filename\*=UTF-8''scheme\.pdf$/);
  assert.equal(Buffer.from(await ok.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  // A different package cannot read it through its own id.
  const other = await setUp({ method: 'EXTERNAL' });
  assert.equal((await raw(`documentation-packages/${other.pkg.id}/executive-schemes/${scheme.id}/file`)).status, 404);
});

test('FLOW B end to end: no Core AOSR at all -> file-backed scheme -> presented -> customer quantity 496 -> SDO; history 500 -> 498 -> 496', async () => {
  const { req } = await harness();
  const ctx = await setUp({ method: 'EXTERNAL' });
  const base = `documentation-packages/${ctx.pkg.id}`;
  await uploadScheme(req, ctx.pkg.id, 'ES-001');
  const pkg = (await req('snapshot')).documentationPackages.find((x: any) => x.id === ctx.pkg.id);
  const presented = await present(req, base, pkg);
  assert.equal(await count('SELECT count(*)::int AS n FROM aosr_documents WHERE documentation_package_id=$1', [ctx.pkg.id]), 0, 'no Core AOSR exists');
  assert.equal(await count("SELECT count(*)::int AS n FROM documentation_documents WHERE documentation_package_id=$1 AND type='AOSR'", [ctx.pkg.id]), 0, 'no AOSR document shell');
  assert.equal(await count('SELECT count(*)::int AS n FROM aosr_number_counters WHERE object_id=$1', [ctx.object.id]), 0, 'no AOSR number was consumed anywhere in the external route');
  // Before customer acceptance the PTO screen shows the internal figure only.
  assert.equal((await req(`${base}/quantity`)).current.quantity, INTERNAL);
  await req(`${base}/customer-accepted-quantity`, { items: [{ quantityPortionId: ctx.portion.id, quantity: CUSTOMER }], reference: 'Акт приёмки' });
  const q = await req(`${base}/quantity`);
  assert.equal(q.current.quantity, CUSTOMER);
  assert.deepEqual(['RP_FACT', 'INTERNAL_SC', 'CUSTOMER_SC'].map(s => q.history.filter((h: any) => h.source === s).map((h: any) => h.quantity)), [[RP], [INTERNAL], [CUSTOMER]], 'append-only: 500 -> 498 -> 496, nothing overwritten');
  const accepted = await req(`${base}/customer-acceptance`, { version: (await req('snapshot')).documentationPackages.find((x: any) => x.id === ctx.pkg.id).version, acceptedDate: dt(0) });
  assert.equal(presented.status, 'PRESENTED');
  const figures = await snapshotFigures(req, ctx.portion.id, ctx.pkg.id);
  assert.deepEqual({ rp: figures.rp, internal: figures.internal, customer: figures.customer, sdoReady: figures.sdoReady }, { rp: RP, internal: INTERNAL, customer: CUSTOMER, sdoReady: true });
  await req(`${base}/handoff-to-sdo`, { version: accepted.version });
});

test('both flows converge: the same downstream quantity and SDO readiness whether the AOSR was generated in Core or prepared outside', async () => {
  const { req } = await harness();
  // FLOW A — the AOSR is actually formed in Core (generated DOCX) + file-backed scheme.
  const a = await setUp({ method: 'CORE' });
  const baseA = `documentation-packages/${a.pkg.id}`;
  await generatedAosr(req, a);
  await presentPackage(req, a.pkg.id);
  await req(`${baseA}/customer-accepted-quantity`, { items: [{ quantityPortionId: a.portion.id, quantity: CUSTOMER }] });
  await req(`${baseA}/customer-acceptance`, { version: (await req('snapshot')).documentationPackages.find((x: any) => x.id === a.pkg.id).version, acceptedDate: dt(0) });
  // FLOW B — AOSR prepared outside Core.
  const b = await setUp({ method: 'EXTERNAL' });
  const baseB = `documentation-packages/${b.pkg.id}`;
  await uploadScheme(req, b.pkg.id, 'ES-B');
  await present(req, baseB, (await req('snapshot')).documentationPackages.find((x: any) => x.id === b.pkg.id));
  await req(`${baseB}/customer-accepted-quantity`, { items: [{ quantityPortionId: b.portion.id, quantity: CUSTOMER }] });
  await req(`${baseB}/customer-acceptance`, { version: (await req('snapshot')).documentationPackages.find((x: any) => x.id === b.pkg.id).version, acceptedDate: dt(0) });
  const fa = await snapshotFigures(req, a.portion.id, a.pkg.id), fb = await snapshotFigures(req, b.portion.id, b.pkg.id);
  assert.deepEqual(fa, fb);
  assert.deepEqual(fb, { rp: RP, internal: INTERNAL, customer: CUSTOMER, sdoReady: true });
  assert.deepEqual((await req(`${baseA}/quantity`)).current, (await req(`${baseB}/quantity`)).current);
});

test('the customer quantity needs the declared method, the Core AOSRs actually generated (CORE) and a file-backed scheme — checked again at the quantity action', async () => {
  const { req, raw } = await harness();
  const { pool } = await import('../apps/backend/src/db');
  const items = (ctx: any) => ({ items: [{ quantityPortionId: ctx.portion.id, quantity: CUSTOMER }] });
  const noCustomer = (ctx: any) => count("SELECT count(*)::int AS n FROM portion_quantity_confirmations WHERE portion_id=$1 AND source='CUSTOMER_SC'", [ctx.portion.id]);
  // A package forced to PRESENTED without the gate (what a historical package looks like): the gate is re-checked at the quantity action.
  const forcePresented = (ctx: any) => pool.query("UPDATE documentation_packages SET status='PRESENTED' WHERE id=$1", [ctx.pkg.id]);
  // (a) method never declared
  const unset = await setUp({ method: null });
  await forcePresented(unset);
  let r = await raw(`documentation-packages/${unset.pkg.id}/customer-accepted-quantity`, items(unset));
  assert.equal(r.status, 400);
  assert.match((await r.json() as any).message, /Сначала выберите способ подготовки АОСР/);
  assert.equal(await noCustomer(unset), 0);
  // (b) EXTERNAL but no file-backed scheme
  const noScheme = await setUp({ method: 'EXTERNAL' });
  await forcePresented(noScheme);
  r = await raw(`documentation-packages/${noScheme.pkg.id}/customer-accepted-quantity`, items(noScheme));
  assert.match((await r.json() as any).message, /исполнительная схема с загруженным файлом/);
  // (c) CORE with an un-generated (draft) Core AOSR, even with a file-backed scheme
  const draft = await setUp({ method: 'CORE' });
  await uploadScheme(req, draft.pkg.id, 'ES-001');
  await req(`documentation-packages/${draft.pkg.id}/aosr`, { title: 'Черновик, не сформирован' });
  await forcePresented(draft);
  r = await raw(`documentation-packages/${draft.pkg.id}/customer-accepted-quantity`, items(draft));
  assert.equal(r.status, 400);
  assert.match((await r.json() as any).message, /Не сформирован актуальный DOCX у АОСР: «Черновик, не сформирован»/);
  assert.equal(await noCustomer(draft), 0, 'nothing was appended');
});

test('METHOD_UNSET: the package stays readable and historically unchanged, but cannot be presented — no inference from "no AOSR"', async () => {
  const { req, raw } = await harness();
  const ctx = await setUp({ method: null });
  const base = `documentation-packages/${ctx.pkg.id}`;
  // readable
  const view = await req(`${base}/aosr`);
  assert.equal(view.method, null);
  assert.equal((await req(`${base}/quantity`)).current.quantity, INTERNAL);
  assert.ok((await req('snapshot')).documentationPackages.some((x: any) => x.id === ctx.pkg.id));
  // even with a file-backed scheme, an undeclared package may not move to PRESENTED
  await uploadScheme(req, ctx.pkg.id, 'ES-001');
  let p = await req(`${base}/status`, { status: 'PREPARING', version: ctx.pkg.version });
  p = await req(`${base}/status`, { status: 'READY_FOR_PRESENTATION', version: p.version });
  const refused = await raw(`${base}/status`, { status: 'PRESENTED', version: p.version });
  assert.equal(refused.status, 400);
  assert.match((await refused.json() as any).message, /Сначала выберите способ подготовки АОСР.*«АОСР формируются в Core».*«АОСР формируются вне Core»/);
  assert.equal((await req(`${base}/aosr`)).method, null, 'still undeclared — nothing was inferred or recorded');
  // not PRESENTED, and the earlier states still work (backward moves / non-gated edits are not retroactively invalidated)
  assert.equal((await req('snapshot')).documentationPackages.find((x: any) => x.id === ctx.pkg.id).status, 'READY_FOR_PRESENTATION');
  // choosing a method unblocks it
  await req(`${base}/aosr-method`, { method: 'EXTERNAL' });
  assert.equal((await req(`${base}/status`, { status: 'PRESENTED', version: p.version })).status, 'PRESENTED');
});

test('CORE gate: at least one Core AOSR and EVERY Core AOSR generated (current DOCX) before PRESENTED; one scheme file may cover them all', async () => {
  const { req, raw } = await harness();
  const ctx = await setUp({ method: 'CORE' });
  const base = `documentation-packages/${ctx.pkg.id}`;
  const refuse = async (re: RegExp) => {
    const cur = (await req('snapshot')).documentationPackages.find((x: any) => x.id === ctx.pkg.id);
    let p = cur;
    if (p.status === 'DRAFT') p = await req(`${base}/status`, { status: 'PREPARING', version: p.version });
    if (p.status === 'PREPARING') p = await req(`${base}/status`, { status: 'READY_FOR_PRESENTATION', version: p.version });
    const r = await raw(`${base}/status`, { status: 'PRESENTED', version: p.version });
    assert.equal(r.status, 400);
    assert.match((await r.json() as any).message, re);
  };
  // 1) CORE, no AOSR at all (even with a file-backed scheme)
  const scheme = await uploadScheme(req, ctx.pkg.id, 'ES-001');
  await refuse(/сформируйте хотя бы один АОСР в Core/);
  // 2) CORE, one draft (never generated)
  const draft = await req(`${base}/aosr`, { title: 'Грунтовка основания' });
  await refuse(/Не сформирован актуальный DOCX у АОСР: «Грунтовка основания»/);
  // 3) one generated + another draft -> still refused, naming only the unfinished one
  const first = await generatedAosr(req, ctx, 'Устройство штукатурки стен', { schemeId: scheme.id });
  await refuse(/«Грунтовка основания»/);
  // 4) the draft gets generated too, but the first act is EDITED afterwards -> its DOCX is no longer current -> refused
  const m = (await req(`${base}/aosr`)).materials[0];
  await fillAosr(req, ctx, draft.id, m, { schemeId: scheme.id });
  await req(`aosr/${draft.id}/generate`, { version: (await req(`aosr/${draft.id}`)).version });
  await req(`aosr/${first.aosr.id}/edit`, { workDescription: 'Уточнено после формирования', version: (await req(`aosr/${first.aosr.id}`)).version });
  await refuse(/Не сформирован актуальный DOCX у АОСР: «Устройство штукатурки стен»/);
  // 5) regenerated -> every created Core AOSR has a current DOCX; ONE shared scheme file covers both -> allowed
  await req(`aosr/${first.aosr.id}/generate`, { version: (await req(`aosr/${first.aosr.id}`)).version });
  const view = await req(`${base}/aosr`);
  assert.ok(view.items.every((i: any) => i.status === 'GENERATED') && view.items.length === 2);
  assert.equal(view.schemes.length, 1, 'no unique scheme per AOSR');
  const cur = (await req('snapshot')).documentationPackages.find((x: any) => x.id === ctx.pkg.id);
  assert.equal((await req(`${base}/status`, { status: 'PRESENTED', version: cur.version })).status, 'PRESENTED');
});

test('generated DOCX download: authenticated, real binary DOCX bytes, safe headers (ASCII + RFC 5987 file name), not cacheable', async () => {
  const { req, raw, base: origin } = await harness();
  const ctx = await setUp({ method: 'CORE' });
  const base = `documentation-packages/${ctx.pkg.id}`;
  await fillParties(req, ctx.pkg.id);
  const material = await req(`${base}/aosr-materials`, { name: 'Смесь', qualityDocuments: [{ docType: 'CERTIFICATE', number: 'RU-1' }] });
  const scheme = await uploadScheme(req, ctx.pkg.id, 'ES-001');
  const a = await req(`${base}/aosr`, { title: 'Устройство штукатурки стен' });
  await fillAosr(req, ctx, a.id, material, { schemeId: scheme.id });
  await req(`aosr/${a.id}/generate`, { version: (await req(`aosr/${a.id}`)).version });
  assert.equal((await fetch(`${origin}/aosr/${a.id}/docx`)).status, 401, 'never public');
  const res = await raw(`aosr/${a.id}/docx`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const disposition = res.headers.get('content-disposition') ?? '';
  assert.match(disposition, /^attachment; filename="[\x20-\x7e]+\.docx"; filename\*=UTF-8''%D0%90%D0%9E%D0%A1%D0%A0_1_.+\.docx$/, 'ASCII fallback plus the real Cyrillic name');
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(Number(res.headers.get('content-length')), bytes.length);
  assert.equal(bytes.subarray(0, 2).toString(), 'PK');
  const JSZip = (await import('jszip')).default;
  assert.ok((await JSZip.loadAsync(bytes)).file('word/document.xml'), 'a real DOCX package');
  // Another tenant/role without documentation access cannot fetch it.
  const { login } = await harness();
  await login('SDO');
  assert.equal((await raw(`aosr/${a.id}/docx`)).status, 403);
});

test('migration 021 records an explicit CORE declaration for packages that already hold Core AOSRs (no silent inference later)', async () => {
  const { req } = await harness();
  const ctx = await setUp({ method: 'CORE' });
  await req(`documentation-packages/${ctx.pkg.id}/aosr`, { title: 'Существующий АОСР' });
  const sql = fs.readFileSync('infra/021_aosr_method_and_scheme_files.sql', 'utf8');
  const backfill = sql.slice(sql.indexOf('INSERT INTO documentation_package_aosr_methods'), sql.lastIndexOf(';') + 1);
  assert.ok(backfill.includes('FROM aosr_documents'));
  const { pool } = await import('../apps/backend/src/db');
  // A package with AOSR rows but no declaration (as LIVE is before 021): simulate by a second package whose method row we never wrote.
  const legacy = await setUp({ method: null });
  const { rows } = await pool.query('SELECT created_by,object_id,object_work_id,tenant_id FROM aosr_documents WHERE documentation_package_id=$1', [ctx.pkg.id]);
  await pool.query("INSERT INTO aosr_documents(tenant_id,object_id,object_work_id,documentation_package_id,title,created_by) SELECT p.tenant_id,p.object_id,p.object_work_id,p.id,'Старый АОСР',p.created_by FROM documentation_packages p WHERE p.id=$1", [legacy.pkg.id]);
  assert.equal(await count('SELECT count(*)::int AS n FROM documentation_package_aosr_methods WHERE documentation_package_id=$1', [legacy.pkg.id]), 0);
  await pool.query(backfill);
  const declared = (await pool.query('SELECT method,comment FROM documentation_package_aosr_methods WHERE documentation_package_id=$1', [legacy.pkg.id])).rows;
  assert.deepEqual(declared.map((r: any) => r.method), ['CORE']);
  assert.match(declared[0].comment, /миграцией 021/);
  assert.ok(rows.length === 1);
});
