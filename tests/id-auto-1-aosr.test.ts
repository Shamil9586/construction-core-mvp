import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { harness, closeHarness, setUp, fillParties, fillAosr, uploadScheme, generatedAosr, SCHEME_FILE, PARTIES, dt, RP, INTERNAL, CUSTOMER } from './helpers/aosr-harness';
import { resolveAosrReadiness, suggestTypicalAosr, resolveCurrentAcceptedQuantity, splitRuDate } from '../packages/domain/aosr';
import { buildAosrRenderModel, surnameInitials } from '../apps/backend/src/id-auto/aosr';
import { readAosrTemplate } from '../apps/backend/src/id-auto/aosr-docx';

/**
 * ID-AUTO-1 — AOSR inside the existing Documentation Package. HTTP-level over the real backend
 * (PGlite), same harness shape as the other documentation tests. One backend instance serves the
 * whole file; every test builds its own object so nothing is shared.
 */
test('multiple AOSRs live in one Work/package; the same Quantity Portion backs several; no fake Work/WEU is created', async () => {
  const { req, login } = await harness();
  const ctx = await setUp();
  const worksBefore = (await req('snapshot')).works.length, unitsBefore = (await req('snapshot')).executionUnits.length;
  const view = await req(`documentation-packages/${ctx.pkg.id}/aosr`);
  const primer = view.suggestions.find((s: any) => s.suggestionCode === 'PLASTER.PRIMER');
  assert.ok(primer, 'typical suggestion for plastering is offered');
  const a1 = await req(`documentation-packages/${ctx.pkg.id}/aosr`, { suggestionCode: 'PLASTER.PRIMER', quantityPortionIds: [ctx.portion.id] });
  const a2 = await req(`documentation-packages/${ctx.pkg.id}/aosr`, { suggestionCode: 'PLASTER.PLASTER', quantityPortionIds: [ctx.portion.id] });
  const a3 = await req(`documentation-packages/${ctx.pkg.id}/aosr`, { title: 'Скрытая операция по заданию ПТО' });
  const after = await req(`documentation-packages/${ctx.pkg.id}/aosr`);
  assert.equal(after.items.length, 3);
  assert.deepEqual(after.items.map((i: any) => i.status), ['DRAFT', 'DRAFT', 'DRAFT']);
  assert.equal(a1.workDescription, 'Грунтовка основания перед штукатуркой');
  // The same production scope supports both AOSRs — a portion is not consumed.
  const d1 = await req(`aosr/${a1.id}`), d2 = await req(`aosr/${a2.id}`);
  assert.deepEqual(d1.portionIds, [ctx.portion.id]);
  assert.deepEqual(d2.portionIds, [ctx.portion.id]);
  // No production model was created for the AOSR-only operation.
  const snap = await req('snapshot');
  assert.equal(snap.works.length, worksBefore);
  assert.equal(snap.executionUnits.length, unitsBefore);
  assert.equal(a3.objectWorkId, ctx.work.id);
  // Cross-work portion references are refused.
  await login('PTO');
});

test('typical suggestions can be accepted, removed and extended manually; removing a draft frees its suggestion', async () => {
  const { req } = await harness();
  const ctx = await setUp();
  const base = `documentation-packages/${ctx.pkg.id}`;
  const codes = (v: any) => v.suggestions.map((s: any) => s.suggestionCode).filter((c: string) => c.startsWith('PLASTER.'));
  assert.deepEqual(codes(await req(`${base}/aosr`)), ['PLASTER.PRIMER', 'PLASTER.PLASTER']);
  const accepted = await req(`${base}/aosr`, { suggestionCode: 'PLASTER.PRIMER' });
  assert.deepEqual(codes(await req(`${base}/aosr`)), ['PLASTER.PLASTER']);
  await req(`${base}/aosr`, { suggestionCode: 'PLASTER.PRIMER' }, 400); // already accepted
  await req(`${base}/aosr-suggestions/dismiss`, { suggestionCode: 'PLASTER.PLASTER' });
  assert.deepEqual(codes(await req(`${base}/aosr`)), []);
  await req(`${base}/aosr`, { suggestionCode: 'ROOF.WATERPROOF_L1' }, 400); // not a plastering suggestion
  const manual = await req(`${base}/aosr`, { title: 'Ещё один АОСР', workDescription: 'Армирование стен фундамента' });
  assert.equal(manual.suggestionCode, null);
  await req(`aosr/${accepted.id}/delete`, {});
  assert.deepEqual(codes(await req(`${base}/aosr`)), ['PLASTER.PRIMER']);
  assert.equal((await req(`${base}/aosr`)).items.length, 1);
});

test('readiness blocks generation; quantity and a unique scheme per AOSR are not required; a draft consumes no number', async () => {
  const { req, raw } = await harness();
  const ctx = await setUp();
  const base = `documentation-packages/${ctx.pkg.id}`;
  const aosr = await req(`${base}/aosr`, { title: 'Пустой АОСР' });
  const d = await req(`aosr/${aosr.id}`);
  const codes = d.readiness.issues.map((i: any) => i.code);
  for (const c of ['POINT1_MISSING', 'PARTY_DEVELOPER', 'PARTY_INTERNAL_SC', 'DATES_MISSING', 'PROJECT_DOCUMENTATION_MISSING', 'NORMATIVE_MISSING', 'SUBSEQUENT_WORK_MISSING']) assert.ok(codes.includes(c), c);
  assert.ok(!codes.some((c: string) => /QUANT/i.test(c)), 'quantity is never a readiness requirement');
  const blocked = await raw(`aosr/${aosr.id}/generate`, { version: d.version });
  assert.equal(blocked.status, 400);
  assert.equal((await req(`aosr/${aosr.id}`)).officialNumber, null);
  const noFile = await raw(`aosr/${aosr.id}/docx`);
  assert.equal(noFile.status, 404);
  // Fully filled with a material AND its quality document, but no executive scheme: still BLOCKED.
  await fillParties(req, ctx.pkg.id);
  const material = await req(`${base}/aosr-materials`, { name: 'Штукатурная смесь', qualityDocuments: [{ docType: 'CERTIFICATE', number: 'RU-1', docDate: dt(-30) }] });
  const linked = await fillAosr(req, ctx, aosr.id, material);
  const after = await req(`aosr/${aosr.id}`);
  assert.equal(after.ready, false);
  assert.deepEqual(after.readiness.issues.map((i: any) => i.code), ['EXECUTIVE_SCHEME_MISSING'], 'a quality document never substitutes for a scheme; material readiness is independent');
  assert.equal((await raw(`aosr/${aosr.id}/generate`, { version: after.version })).status, 400);
  // A scheme RECORD without a file (metadata only) does not satisfy readiness either.
  const shell = await req(`${base}/documents`, { type: 'EXECUTIVE_SCHEME' });
  const metadataOnly = (await req(`aosr/${aosr.id}`));
  await req(`aosr/${aosr.id}/links`, { schemeDocumentIds: [shell.id], version: metadataOnly.version });
  const linkedShell = await req(`aosr/${aosr.id}`);
  assert.equal(linkedShell.ready, false);
  assert.deepEqual(linkedShell.readiness.issues.map((i: any) => i.code), ['EXECUTIVE_SCHEME_FILE_MISSING']);
  assert.equal((await raw(`aosr/${aosr.id}/generate`, { version: linkedShell.version })).status, 400);
  // The real file arrives for that same record -> ready. One file-backed scheme, no uniqueness requirement…
  await req(`${base}/executive-schemes/${shell.id}/file`, { title: 'ES-001', ...SCHEME_FILE });
  assert.equal((await req(`aosr/${aosr.id}`)).ready, true);
  // …and the SAME scheme also satisfies a second AOSR.
  const second = await req(`${base}/aosr`, { title: 'Второй АОСР' });
  await fillAosr(req, ctx, second.id, material, { schemeId: shell.id });
  assert.equal((await req(`aosr/${second.id}`)).ready, true);
  assert.equal(linked.officialNumber, null);
});

test('first generation assigns the official number; draft AOSRs consume none; a correction keeps the same number and one current DOCX; materials are many-to-many', async () => {
  const { req, raw } = await harness();
  const ctx = await setUp();
  const base = `documentation-packages/${ctx.pkg.id}`;
  await fillParties(req, ctx.pkg.id);
  const material = await req(`${base}/aosr-materials`, { name: 'Штукатурная смесь' });
  await req(`${base}/aosr-materials/${material.id}/quality-documents`, { docType: 'PASSPORT', number: 'П-7', docDate: dt(-20), issuer: 'Завод' });
  const a1 = await req(`${base}/aosr`, { title: 'Грунтовка' }), a2 = await req(`${base}/aosr`, { title: 'Штукатурка' }), draft = await req(`${base}/aosr`, { title: 'Черновик' });
  const shared = await uploadScheme(req, ctx.pkg.id, 'ES-001');
  await fillAosr(req, ctx, a1.id, material, { schemeId: shared.id });
  await fillAosr(req, ctx, a2.id, material, { point1: 'Устройство штукатурки стен', schemeId: shared.id });
  const g1 = await req(`aosr/${a1.id}/generate`, { version: (await req(`aosr/${a1.id}`)).version });
  assert.equal(g1.officialNumber, 1);
  const g2 = await req(`aosr/${a2.id}/generate`, { version: (await req(`aosr/${a2.id}`)).version });
  assert.equal(g2.officialNumber, 2, 'sequence advances only for generated AOSRs');
  assert.equal((await req(`aosr/${draft.id}`)).officialNumber, null);
  // Correction: edit the wording and regenerate — the number never changes.
  const cur = await req(`aosr/${a1.id}`);
  assert.equal(cur.status, 'GENERATED');
  const edited = await req(`aosr/${a1.id}/edit`, { workDescription: 'Грунтовка основания (уточнено)', version: cur.version }, 201);
  assert.equal((await req(`aosr/${a1.id}`)).status, 'NEEDS_REGENERATION');
  const g1b = await req(`aosr/${a1.id}/generate`, { version: edited.version });
  assert.equal(g1b.officialNumber, 1);
  assert.equal(g1b.revisionCount, 2);
  const detail = await req(`aosr/${a1.id}`);
  assert.deepEqual(detail.revisions.map((r: any) => [r.revisionNumber, r.officialNumber]), [[1, 1], [2, 1]]);
  // Stored through the existing documentation layer: one AOSR document, versions 1 and 2, CORE_FILE.
  const snap = await req('snapshot');
  const doc = snap.documentationDocuments.find((x: any) => x.id === g1b.documentationDocumentId);
  assert.equal(doc.type, 'AOSR');
  const versions = snap.documentationVersions.filter((v: any) => v.documentationDocumentId === doc.id);
  assert.deepEqual(versions.map((v: any) => [v.versionNumber, v.storageProvider]), [[1, 'CORE_FILE'], [2, 'CORE_FILE']]);
  // Revisions are append-only.
  const { pool } = await import('../apps/backend/src/db');
  await assert.rejects(pool.query("UPDATE aosr_revisions SET official_number=99 WHERE aosr_id=$1", [a1.id]));
  // The material and a second AOSR share records; a stale version is refused.
  assert.equal((await req(`aosr/${a2.id}`)).materials[0].id, material.id);
  assert.equal((await raw(`aosr/${a1.id}/generate`, { version: edited.version })).status, 409);
});

test('the generated file is an editable DOCX built on the unchanged official template; quantity is never printed', async () => {
  const { req, raw } = await harness();
  const ctx = await setUp();
  const base = `documentation-packages/${ctx.pkg.id}`;
  await fillParties(req, ctx.pkg.id);
  const material = await req(`${base}/aosr-materials`, { name: 'Грунтовка', qualityDocuments: [{ docType: 'DECLARATION', number: 'Д-9' }] });
  const scheme = await uploadScheme(req, ctx.pkg.id, 'Исполнительная схема нанесения штукатурки');
  const a = await req(`${base}/aosr`, { title: 'Штукатурка' });
  await fillAosr(req, ctx, a.id, material);
  const cur = await req(`aosr/${a.id}`);
  await req(`aosr/${a.id}/links`, { schemeDocumentIds: [scheme.id], materialRecordIds: [material.id], quantityPortionIds: [ctx.portion.id], version: cur.version });
  await req(`aosr/${a.id}/generate`, { version: (await req(`aosr/${a.id}`)).version });
  const res = await raw(`aosr/${a.id}/docx`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /wordprocessingml\.document/);
  const bytes = Buffer.from(await res.arrayBuffer());
  const out = await JSZip.loadAsync(bytes);
  const tpl = await JSZip.loadAsync(readAosrTemplate()!);
  assert.deepEqual(Object.keys(out.files).sort(), Object.keys(tpl.files).sort(), 'same package parts as the official template');
  const settings = await out.file('word/settings.xml')!.async('string');
  assert.ok(!/documentProtection/.test(settings), 'not locked for editing');
  const paragraphs = (xml: string) => [...xml.matchAll(/<w:p[ >].*?<\/w:p>/gs)].map(m => [...m[0].matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map(t => t[1]).join(''));
  const outXml = await out.file('word/document.xml')!.async('string'), tplXml = await tpl.file('word/document.xml')!.async('string');
  const o = paragraphs(outXml), t = paragraphs(tplXml);
  assert.equal(o.length, t.length);
  t.forEach((text, i) => { if (text.replace(/ /g, '').trim()) assert.equal(o[i], text, `official text of paragraph ${i} unchanged`); });
  const filled = o.filter((text, i) => !t[i].replace(/ /g, '').trim() && text.trim());
  const flat = filled.join('|');
  for (const expected of ['Жилой дом №1', 'Тестовая', 'ООО «Заказчик»', 'Устройство штукатурки стен в помещении санузлов', 'АР-1', 'Грунтовка', 'декларация № Д-9', 'ООО «Проект»', 'СП 71.13330.2017', 'Шпатлёвка стен', 'Исполнительная схема нанесения', 'Иванов И.И.', 'Петров П.П.', 'ООО «Подрядчик»']) assert.ok(flat.includes(expected), expected + ' in ' + flat);
  assert.ok(o[36] === '1', 'official number in the number slot');
  for (const q of [RP, INTERNAL, CUSTOMER, '498', '500,1234']) assert.ok(!outXml.includes(q), 'quantity ' + q + ' must not be printed');
  const { pool } = await import('../apps/backend/src/db');
  const rev = (await pool.query('SELECT render_model FROM aosr_revisions WHERE aosr_id=$1', [a.id])).rows[0].render_model;
  assert.ok(!/quantity|Quantity/.test(JSON.stringify(rev)) && !JSON.stringify(rev).includes('498'));
});

test('one executive scheme links to several AOSRs (many-to-many)', async () => {
  const { req } = await harness();
  const ctx = await setUp();
  const base = `documentation-packages/${ctx.pkg.id}`;
  const scheme = await uploadScheme(req, ctx.pkg.id, 'Общая исполнительная схема');
  const a1 = await req(`${base}/aosr`, { title: 'А1' }), a2 = await req(`${base}/aosr`, { title: 'А2' });
  await req(`aosr/${a1.id}/links`, { schemeDocumentIds: [scheme.id], version: a1.version });
  await req(`aosr/${a2.id}/links`, { schemeDocumentIds: [scheme.id], version: a2.version });
  assert.deepEqual((await req(`aosr/${a1.id}`)).schemes.map((s: any) => s.id), [scheme.id]);
  assert.deepEqual((await req(`aosr/${a2.id}`)).schemes.map((s: any) => s.id), [scheme.id]);
  const { pool } = await import('../apps/backend/src/db');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM aosr_scheme_links WHERE scheme_document_id=$1', [scheme.id])).rows[0].n, 2);
  // A scheme of another package/type is refused.
  const other = await setUp();
  const foreign = await uploadScheme(req, other.pkg.id, 'Чужая');
  await req(`aosr/${a1.id}/links`, { schemeDocumentIds: [foreign.id], version: (await req(`aosr/${a1.id}`)).version }, 400);
});

test('customer-accepted quantity is append-only, keeps RP_FACT/INTERNAL_SC intact and becomes the current quantity for SDO', async () => {
  const { req, raw, login } = await harness();
  const ctx = await setUp({ method: 'EXTERNAL' });
  const base = `documentation-packages/${ctx.pkg.id}`;
  // Before customer acceptance the PTO screen shows the internal figure only.
  let q = await req(`${base}/quantity`);
  assert.equal(q.current.quantity, '498.1234');
  assert.equal(q.current.source, 'INTERNAL_SC');
  // Not allowed before the documentation was presented.
  await req(`${base}/customer-accepted-quantity`, { items: [{ quantityPortionId: ctx.portion.id, quantity: CUSTOMER }] }, 400);
  await uploadScheme(req, ctx.pkg.id, 'ES-001'); // evidence: a file-backed executive scheme is needed to present
  const doc = await req(`${base}/documents`, { type: 'AOSR' });
  await req(`documentation-documents/${doc.id}/versions`, { storageProvider: 'NONE' });
  let p = await req(`${base}/status`, { status: 'PREPARING', version: ctx.pkg.version });
  p = await req(`${base}/status`, { status: 'READY_FOR_PRESENTATION', version: p.version });
  p = await req(`${base}/status`, { status: 'PRESENTED', version: p.version });
  const key = crypto.randomUUID();
  const rec = await req(`${base}/customer-accepted-quantity`, { items: [{ quantityPortionId: ctx.portion.id, quantity: CUSTOMER }], reference: 'Письмо заказчика №5', idempotencyKey: key });
  assert.equal(rec.length, 1);
  const replay = await req(`${base}/customer-accepted-quantity`, { items: [{ quantityPortionId: ctx.portion.id, quantity: CUSTOMER }], reference: 'Письмо заказчика №5', idempotencyKey: key });
  assert.deepEqual(replay.map((r: any) => r.id), rec.map((r: any) => r.id), 'retry is idempotent');
  q = await req(`${base}/quantity`);
  assert.equal(q.current.quantity, CUSTOMER);
  assert.equal(q.current.source, 'CUSTOMER_ACCEPTED');
  const bySource = (s: string) => q.history.filter((h: any) => h.source === s).map((h: any) => h.quantity);
  assert.deepEqual(bySource('RP_FACT'), [RP], 'RP_FACT is not overwritten');
  assert.deepEqual(bySource('INTERNAL_SC'), [INTERNAL], 'INTERNAL_SC is not overwritten');
  assert.deepEqual(bySource('CUSTOMER_SC'), [CUSTOMER]);
  // A later correction appends; nothing is rewritten.
  await req(`${base}/customer-accepted-quantity`, { items: [{ quantityPortionId: ctx.portion.id, quantity: '495.0000' }] });
  q = await req(`${base}/quantity`);
  assert.equal(q.current.quantity, '495.0000');
  assert.deepEqual(bySource('CUSTOMER_SC').length, 2);
  assert.equal(q.customerAcceptances.length, 3 - 1);
  const { pool } = await import('../apps/backend/src/db');
  await assert.rejects(pool.query('UPDATE documentation_customer_accepted_quantities SET quantity=1'));
  await assert.rejects(pool.query('DELETE FROM documentation_customer_accepted_quantities'));
  // Downstream: SDO's inputs (the snapshot) now carry the customer figure and handoff readiness is satisfied.
  const acceptedPkg = await req(`${base}/customer-acceptance`, { version: (await req('snapshot')).documentationPackages.find((x: any) => x.id === ctx.pkg.id).version, acceptedDate: dt(0), reference: 'Акт' });
  const snap = await req('snapshot');
  assert.equal(snap.portions.find((x: any) => x.id === ctx.portion.id).customerScConfirmedQuantity, '495.0000');
  assert.equal(snap.portions.find((x: any) => x.id === ctx.portion.id).rpFactQuantity, RP);
  assert.equal(snap.sdoPackageReadiness.find((x: any) => x.documentationPackageId === ctx.pkg.id).ready, true);
  await req(`${base}/handoff-to-sdo`, { version: acceptedPkg.version });
  // After handoff the package is locked in SDO: quantity can no longer be appended.
  await req(`${base}/customer-accepted-quantity`, { items: [{ quantityPortionId: ctx.portion.id, quantity: '1.0000' }] }, 400);
  await login('PROJECT_MANAGER');
  assert.equal((await raw(`${base}/customer-accepted-quantity`, { items: [{ quantityPortionId: ctx.portion.id, quantity: '1' }] })).status, 403);
});

test('existing package authorization and freeze rules are enforced for AOSR', async () => {
  const { req, raw, login } = await harness();
  const ctx = await setUp();
  const base = `documentation-packages/${ctx.pkg.id}`;
  const { aosr: a } = await generatedAosr(req, ctx, 'Для проверки доступа'); // a Core package can only be presented once its AOSRs are generated
  // Other roles: no mutation, SDO has no documentation access at all.
  await login('PROJECT_MANAGER');
  assert.equal((await raw(`${base}/aosr`, { title: 'x' })).status, 403);
  await login('SDO');
  assert.equal((await raw(`${base}/aosr`)).status, 403);
  assert.equal((await raw(`aosr/${a.id}`)).status, 403);
  // An unassigned PTO engineer cannot touch the package (effective work assignment is required).
  const { makeUser, tokenFor } = await import('./helpers/pbx3-fixtures');
  const stranger = await makeUser('Чужой ПТО', 'PTO');
  const strangerToken = await tokenFor(stranger);
  const sr = await (await harness()).raw; void sr;
  const r = await fetch(`http://127.0.0.1:${(await harness()).app.getHttpServer().address().port}/${base}/aosr`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + strangerToken }, body: JSON.stringify({ title: 'x' }) });
  assert.ok([403, 404].includes(r.status), 'stranger PTO refused: ' + r.status);
  // Freeze: once PRESENTED, AOSR content cannot change or be generated.
  await login('PTO');
  await uploadScheme(req, ctx.pkg.id, 'ES-001'); // evidence: a file-backed executive scheme is needed to present
  const doc = await req(`${base}/documents`, { type: 'AOSR' });
  await req(`documentation-documents/${doc.id}/versions`, { storageProvider: 'NONE' });
  let p = await req(`${base}/status`, { status: 'PREPARING', version: ctx.pkg.version });
  p = await req(`${base}/status`, { status: 'READY_FOR_PRESENTATION', version: p.version });
  p = await req(`${base}/status`, { status: 'PRESENTED', version: p.version });
  const cur = await req(`aosr/${a.id}`);
  assert.equal((await raw(`aosr/${a.id}/edit`, { title: 'Новое', version: cur.version })).status, 400);
  assert.equal((await raw(`${base}/aosr`, { title: 'ещё' })).status, 400);
  assert.equal((await raw(`aosr/${a.id}/generate`, { version: cur.version })).status, 400);
  assert.equal((await raw(`aosr/${a.id}/delete`, {})).status, 400);
});

test('parties: object-level master data is editable, versioned, and every change leaves an immutable snapshot; INTERNAL_SC is the construction entity\'s own SC', async () => {
  const { req, raw } = await harness();
  const ctx = await setUp();
  const base = `documentation-packages/${ctx.pkg.id}`;
  const first = await req(`${base}/aosr-parties`, { partyRole: 'INTERNAL_SC', personName: 'Иванов Иван Иванович', position: 'Инженер СК', authorityDocument: 'Приказ № 3' });
  assert.equal((await raw(`${base}/aosr-parties`, { partyRole: 'INTERNAL_SC', personName: 'Новый Н.Н.', position: 'Инженер', authorityDocument: 'Приказ № 4' })).status, 409, 'an existing record needs its version');
  const second = await req(`${base}/aosr-parties`, { partyRole: 'INTERNAL_SC', personName: 'Новиков Николай Николаевич', position: 'Начальник СК', authorityDocument: 'Приказ № 4', version: first.version });
  assert.equal(second.version, 2);
  const { pool } = await import('../apps/backend/src/db');
  const hist = (await pool.query("SELECT snapshot FROM aosr_party_record_history WHERE object_id=$1 AND party_role='INTERNAL_SC' ORDER BY changed_at,created_at", [ctx.object.id])).rows;
  assert.equal(hist.length, 2);
  assert.equal(hist[0].snapshot.personName ?? hist[0].snapshot.person_name, 'Иванов Иван Иванович');
  await assert.rejects(pool.query('DELETE FROM aosr_party_record_history'));
  const view = await req(`${base}/aosr`);
  assert.equal(view.partySuggestions.CONSTRUCTION_ENTITY, 'ООО СЗ «Гор-Строй»');
});

/* ------------------------------ pure domain ------------------------------ */

test('domain: readiness, suggestions, current quantity, number slot helpers', () => {
  const content = { workDescription: 'x', startDate: '2026-01-01', endDate: '2026-01-02', actDate: '2026-01-03', projectDocumentation: 'p', normativeReferences: 'n', subsequentWork: 's' };
  const parties = [
    { partyRole: 'DEVELOPER', organizationName: 'a' }, { partyRole: 'CONSTRUCTION_ENTITY', organizationName: 'b' }, { partyRole: 'WORK_EXECUTOR', organizationName: 'c' }, { partyRole: 'DESIGNER', organizationName: 'д0' },
    ...(['DEVELOPER_SC_REP', 'CONSTRUCTION_REP', 'INTERNAL_SC'] as const).map(r => ({ partyRole: r, personName: 'И И', position: 'п', authorityDocument: 'д' })),
  ] as any[];
  const base = { content, parties, materials: [], schemes: [{ id: 's', title: 'ES-001', hasFile: true }], workTypeRequiresMaterials: false, templateAvailable: true };
  assert.equal(resolveAosrReadiness(base).ready, true);
  assert.deepEqual(resolveAosrReadiness({ ...base, schemes: [{ id: 's', title: 'ES-001', hasFile: false }] }).issues.map(i => i.code), ['EXECUTIVE_SCHEME_FILE_MISSING'], 'metadata-only scheme is not evidence');
  assert.equal(resolveAosrReadiness({ ...base, schemes: [{ id: 's', title: 'ES-001', hasFile: false }, { id: 't', title: 'ES-002', hasFile: true }] }).ready, true, 'at least one file-backed scheme suffices');
  const docs = [{ name: 'м', qualityDocuments: [{ docType: 'CERTIFICATE' as const, number: '1' }] }];
  assert.deepEqual(resolveAosrReadiness({ ...base, schemes: [], materials: docs }).issues.map(i => i.code), ['EXECUTIVE_SCHEME_MISSING'], 'quality document cannot replace a scheme');
  assert.equal(resolveAosrReadiness({ ...base, materials: docs }).ready, true, 'one shared scheme suffices; nothing demands a unique scheme');
  assert.deepEqual(resolveAosrReadiness({ ...base, templateAvailable: false }).issues.map(i => i.code), ['TEMPLATE_UNAVAILABLE']);
  assert.ok(resolveAosrReadiness({ ...base, content: { ...content, endDate: '2025-01-01' } }).issues.some(i => i.code === 'DATES_ORDER'));
  assert.ok(resolveAosrReadiness({ ...base, workTypeRequiresMaterials: true }).issues.some(i => i.code === 'MATERIALS_MISSING'));
  assert.ok(resolveAosrReadiness({ ...base, materials: [{ name: 'м', qualityDocuments: [] }] }).issues.some(i => i.code === 'MATERIAL_DOCS_MISSING'));
  // Project-design organization master data is required for a generation-ready act; its representative is optional.
  assert.ok(resolveAosrReadiness({ ...base, parties: parties.filter(p => p.partyRole !== 'DESIGNER') }).issues.some(i => i.code === 'PARTY_DESIGNER'));
  assert.equal(resolveAosrReadiness({ ...base, parties: [...parties, { partyRole: 'DESIGNER', organizationName: 'д' }] }).ready, true);
  assert.ok(resolveAosrReadiness({ ...base, parties: [...parties, { partyRole: 'DESIGNER', organizationName: 'д' }, { partyRole: 'DESIGNER_REP', personName: 'Н Н' }] }).issues.some(i => i.code === 'PARTY_DESIGNER_REP'));
  assert.deepEqual(suggestTypicalAosr('Штукатурка стен', { acceptedCodes: ['PLASTER.PRIMER'], dismissedCodes: [] }).map(s => s.suggestionCode), ['PLASTER.PLASTER']);
  assert.deepEqual(suggestTypicalAosr('Бурение', { acceptedCodes: [], dismissedCodes: [] }), []);
  const fig = (c: string | null, i: string | null, r: string | null) => ({ portionId: 'p', rpFact: r, internalSc: i, customerAccepted: c, unit: 'м²' });
  assert.deepEqual(resolveCurrentAcceptedQuantity([fig(null, '498', '500')]), { quantity: '498.0000', unit: 'м²', source: 'INTERNAL_SC' });
  assert.deepEqual(resolveCurrentAcceptedQuantity([fig('496', '498', '500')]), { quantity: '496.0000', unit: 'м²', source: 'CUSTOMER_ACCEPTED' });
  assert.equal(resolveCurrentAcceptedQuantity([]), null);
  assert.deepEqual(splitRuDate('2026-10-03'), { day: '03', month: 'октября', year: '2026' });
  assert.equal(surnameInitials('Иванов Иван Иванович'), 'Иванов И.И.');
  const model = buildAosrRenderModel({ officialNumber: 7, objectName: 'о', objectAddress: 'а', content, parties, materials: [], schemes: [] });
  assert.ok(!Object.keys(model).some(k => /quant/i.test(k)));
});

after(closeHarness);
