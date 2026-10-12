import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { harness, closeHarness, setUp, generatedAosr, uploadScheme, presentPackage, INTERNAL, CUSTOMER } from './helpers/aosr-harness';

/**
 * PTO package scope / duplicate prevention / card clarity.
 * A Documentation Package documents an explicit production scope: Quantity Portions of ONE Work. Several packages per Work are fine
 * when their portions differ; two packages may never claim the same portion. (Several AOSRs inside one package may reuse a portion.)
 */
after(closeHarness);

const SCOPE_MSG = /Выберите участок производства для пакета ИД/;
const COVERED_MSG = /Этот участок уже включён в активный пакет исполнительной документации\./;
const pkgView = async (req: any, id: string) => (await req('snapshot')).documentationPackages.find((p: any) => p.id === id);
const count = async (sql: string, args: any[] = []) => { const { pool } = await import('../apps/backend/src/db'); return (await pool.query(sql, args)).rows[0].n as number; };
const create = (raw: any, ctx: any, ids: string[] | undefined, extra: any = {}) => raw('documentation-packages', { objectWorkId: ctx.work.id, ...(ids ? { quantityPortionIds: ids } : {}), ...extra });
const msg = async (r: Response) => ((await r.json()) as any).message as string;

test('a NEW package requires an explicit scope: no ids, empty ids and a portion of another Work are all refused — nothing is created', async () => {
  const { raw } = await harness();
  const ctx = await setUp({ noPackage: true });
  const other = await setUp({ noPackage: true });
  const before = await count('SELECT count(*)::int AS n FROM documentation_packages WHERE object_work_id=$1', [ctx.work.id]);
  for (const ids of [undefined, []]) {
    const r = await create(raw, ctx, ids as any);
    assert.equal(r.status, 400);
    assert.match(await msg(r), SCOPE_MSG);
  }
  const foreign = await create(raw, ctx, [other.portion.id]);
  assert.equal(foreign.status, 400);
  assert.match(await msg(foreign), /другой работе/);
  assert.equal(await count('SELECT count(*)::int AS n FROM documentation_packages WHERE object_work_id=$1', [ctx.work.id]), before, 'no empty/unscoped package was created');
});

test('one package may cover several portions; different packages may cover different portions of the same Work', async () => {
  const { req, raw } = await harness();
  // Three zones of one Work: 1 этаж + 2 этаж in package A (two portions), 3 этаж in package B.
  const ctx = await setUp({ noPackage: true, secondPortion: true, labels: ['1 этаж', '2 этаж'], location: null });
  const { pool } = await import('../apps/backend/src/db');
  await req('snapshot');
  const third = (await pool.query("INSERT INTO quantity_portions(tenant_id,execution_unit_id,label,planned_quantity) SELECT tenant_id,id,'3 этаж',0.0001 FROM work_execution_units WHERE id=$1 RETURNING id", [ctx.unit.id])).rows[0].id;
  const a = await create(raw, ctx, [ctx.portion.id, ctx.portion2.id]);
  assert.equal(a.status, 201);
  const pkgA = (await a.json()) as any;
  const links = await count('SELECT count(*)::int AS n FROM documentation_package_portions WHERE documentation_package_id=$1', [pkgA.id]);
  assert.equal(links, 2);
  const scopeA = (await pkgView(req, pkgA.id)).scope;
  assert.equal(scopeA.hasScope, true);
  assert.equal(scopeA.zoneSummary, '1 этаж, 2 этаж', 'a concise, meaningful summary');
  const b = await create(raw, ctx, [third]);
  assert.equal(b.status, 201, 'a non-overlapping package on the same Work is valid');
  assert.equal((await pkgView(req, ((await b.json()) as any).id)).scope.zoneSummary, '3 этаж');
  assert.equal(await count('SELECT count(*)::int AS n FROM documentation_packages WHERE object_work_id=$1', [ctx.work.id]), 2);
});

test('overlap is refused by the BACKEND (frontend bypassed): new package, linking into another package, and a raw database write', async () => {
  const { req, raw } = await harness();
  const ctx = await setUp({ noPackage: true, secondPortion: true });
  const first = (await (await create(raw, ctx, [ctx.portion.id])).json()) as any;
  // second ACTIVE package on the same portion
  const dup = await create(raw, ctx, [ctx.portion.id]);
  assert.equal(dup.status, 400);
  assert.match(await msg(dup), COVERED_MSG);
  // a package with a mix of a free and a claimed portion is refused as a whole
  const mixed = await create(raw, ctx, [ctx.portion2.id, ctx.portion.id]);
  assert.equal(mixed.status, 400);
  assert.equal(await count('SELECT count(*)::int AS n FROM documentation_packages WHERE object_work_id=$1', [ctx.work.id]), 1, 'the refused attempts left nothing behind');
  // linking the claimed portion into another package of the same Work
  const second = (await (await create(raw, ctx, [ctx.portion2.id])).json()) as any;
  const link = await raw(`documentation-packages/${second.id}/portions`, { quantityPortionId: ctx.portion.id });
  assert.equal(link.status, 400);
  assert.match(await msg(link), COVERED_MSG);
  // the database backstop: a writer that bypasses the service
  const { pool } = await import('../apps/backend/src/db');
  await assert.rejects(pool.query('INSERT INTO documentation_package_portions(tenant_id,documentation_package_id,quantity_portion_id) SELECT tenant_id,$1,$2 FROM documentation_packages WHERE id=$1', [second.id, ctx.portion.id]), /уже включён|23505|duplicate|unique/i);
  assert.equal(await count('SELECT count(*)::int AS n FROM documentation_package_portions WHERE quantity_portion_id=$1', [ctx.portion.id]), 1);
  void first; void req;
});

test('concurrent duplicate creation: of N simultaneous requests for the same portion exactly ONE package is created', async () => {
  const { raw } = await harness();
  const ctx = await setUp({ noPackage: true });
  const results = await Promise.all(Array.from({ length: 6 }, () => create(raw, ctx, [ctx.portion.id])));
  const statuses = results.map(r => r.status).sort();
  assert.deepEqual(statuses, [201, 400, 400, 400, 400, 400], statuses.join(','));
  assert.equal(await count('SELECT count(*)::int AS n FROM documentation_packages WHERE object_work_id=$1', [ctx.work.id]), 1);
  assert.equal(await count('SELECT count(*)::int AS n FROM documentation_package_portions WHERE quantity_portion_id=$1', [ctx.portion.id]), 1);
});

test('double click / retry: the same idempotency key returns the SAME package; without a key the repeat is refused, never a second package', async () => {
  const { raw } = await harness();
  const ctx = await setUp({ noPackage: true });
  const key = randomUUID();
  const one = (await (await create(raw, ctx, [ctx.portion.id], { idempotencyKey: key })).json()) as any;
  const again = await create(raw, ctx, [ctx.portion.id], { idempotencyKey: key });
  assert.equal(again.status, 201);
  assert.equal(((await again.json()) as any).id, one.id);
  const keyless = await create(raw, ctx, [ctx.portion.id]);
  assert.equal(keyless.status, 400);
  assert.equal(await count('SELECT count(*)::int AS n FROM documentation_packages WHERE object_work_id=$1', [ctx.work.id]), 1);
  // a key reused with a different scope is refused
  const ctx2 = await setUp({ noPackage: true });
  assert.notEqual((await create(raw, ctx2, [ctx2.portion.id], { idempotencyKey: key })).status, 201);
});

test('the package card exposes Work, zone, CURRENT quantity, AOSR method, responsible PTO and creator; METHOD_UNSET is explicit; history is not cluttered in', async () => {
  const { req, login } = await harness();
  const ctx = await setUp({ method: null, labels: ['1 этаж', '—'], location: null });
  let p = await pkgView(req, ctx.pkg.id);
  assert.equal(p.workName, 'Устройство штукатурки стен');
  assert.equal(p.scope.zoneSummary, '1 этаж');
  assert.equal(p.scope.currentQuantity.quantity, INTERNAL, 'current = Internal SC (498), not RP 500');
  assert.equal(p.scope.currentQuantity.source, 'INTERNAL_SC');
  assert.equal(p.scope.currentQuantity.unit, 'м²');
  assert.equal(p.aosrMethod, null, 'METHOD_UNSET is reported as null — never inferred as external');
  assert.ok(p.responsible);
  assert.equal(p.createdByName, p.responsible, 'created by the assigned PTO engineer');
  assert.ok(p.createdAt);
  assert.ok(!JSON.stringify(p.scope).match(/rpFact|internalSc|customerAccepted|history/i), 'the card carries the current figure only — no RP/SC history');
  await req(`documentation-packages/${ctx.pkg.id}/aosr-method`, { method: 'CORE' });
  assert.equal((await pkgView(req, ctx.pkg.id)).aosrMethod, 'CORE');
  await req(`documentation-packages/${ctx.pkg.id}/aosr-method`, { method: 'EXTERNAL' });
  assert.equal((await pkgView(req, ctx.pkg.id)).aosrMethod, 'EXTERNAL');
  // a customer-accepted quantity (synthetic fixture value) becomes the current figure; RP/Internal history is untouched
  const { pool } = await import('../apps/backend/src/db');
  const tenant = (await pool.query('SELECT tenant_id FROM documentation_packages WHERE id=$1', [ctx.pkg.id])).rows[0].tenant_id;
  await pool.query("INSERT INTO portion_quantity_confirmations(tenant_id,portion_id,source,quantity,recorded_by) VALUES($1,$2,'CUSTOMER_SC',$3,$4)", [tenant, ctx.portion.id, CUSTOMER, ctx.pto.id]);
  p = await pkgView(req, ctx.pkg.id);
  assert.equal(p.scope.currentQuantity.quantity, CUSTOMER);
  assert.equal(p.scope.currentQuantity.source, 'CUSTOMER_ACCEPTED');
  assert.equal(await count("SELECT count(*)::int AS n FROM portion_quantity_confirmations WHERE portion_id=$1 AND source IN ('RP_FACT','INTERNAL_SC')", [ctx.portion.id]), 2, 'RP_FACT / INTERNAL_SC histories untouched');
  await login('PTO');
});

test('"what may a new package be created on": only unclaimed portions are offered; no remaining scope -> none; the work view is server-derived', async () => {
  const { req, raw } = await harness();
  const ctx = await setUp({ noPackage: true, secondPortion: true, labels: ['1 этаж', '2 этаж'], location: null });
  let view = await req(`works/${ctx.work.id}/pto-assignment`);
  assert.deepEqual(view.packageScope.eligiblePortions.map((x: any) => x.zone).sort(), ['1 этаж', '2 этаж']);
  assert.equal(view.packageScope.totalPortions, 2);
  assert.equal(view.canCreatePackage, true);
  await create(raw, ctx, [ctx.portion.id]);
  view = await req(`works/${ctx.work.id}/pto-assignment`);
  assert.deepEqual(view.packageScope.eligiblePortions.map((x: any) => x.zone), ['2 этаж']);
  await create(raw, ctx, [ctx.portion2.id]);
  view = await req(`works/${ctx.work.id}/pto-assignment`);
  assert.deepEqual(view.packageScope.eligiblePortions, [], 'every available portion is already claimed');
  assert.equal(view.packageScope.totalPortions, 2);
  assert.equal((await create(raw, ctx, [ctx.portion.id])).status, 400);
});

test('a historical UNSCOPED package stays readable ("Участок не выбран") but cannot go forward until a scope is assigned', async () => {
  const { req, raw } = await harness();
  const ctx = await setUp({ noPackage: true, method: null });
  const { pool } = await import('../apps/backend/src/db');
  // What an old package looks like: created before scope existed — no covered portion.
  const legacy = (await pool.query("INSERT INTO documentation_packages(tenant_id,object_id,object_work_id,responsible_user_id,created_by) SELECT tenant_id,object_id,id,$2,$2 FROM works WHERE id=$1 RETURNING *", [ctx.work.id, ctx.pto.id])).rows[0];
  // readable, not silently scoped, nothing inferred from the Work
  const p = await pkgView(req, legacy.id);
  assert.equal(p.scope.hasScope, false);
  assert.equal(p.scope.zoneSummary, null);
  assert.equal(p.scope.currentQuantity, null);
  assert.equal(p.aosrMethod, null);
  assert.equal(await count('SELECT count(*)::int AS n FROM documentation_package_portions WHERE documentation_package_id=$1', [legacy.id]), 0, 'no scope was assigned behind the engineer\'s back');
  // forward actions are refused with the business reason
  const prep = await raw(`documentation-packages/${legacy.id}/status`, { status: 'PREPARING', version: legacy.version });
  assert.equal(prep.status, 400);
  assert.match(await msg(prep), /Участок не выбран/);
  // an unscoped package that is already PRESENTED: acceptance, quantity and the gate are all refused
  await pool.query("UPDATE documentation_packages SET status='PRESENTED' WHERE id=$1", [legacy.id]);
  await raw(`documentation-packages/${legacy.id}/aosr-method`, { method: 'EXTERNAL' });
  await uploadScheme({ ...(await harness()), req }, legacy.id, 'ES-001').catch(() => undefined);
  const acc = await raw(`documentation-packages/${legacy.id}/customer-acceptance`, { version: legacy.version, acceptedDate: new Date().toISOString().slice(0, 10) });
  assert.equal(acc.status, 400);
  const qty = await raw(`documentation-packages/${legacy.id}/customer-accepted-quantity`, { items: [{ quantityPortionId: ctx.portion.id, quantity: '1' }] });
  assert.equal(qty.status, 400);
  assert.match(await msg(qty), /Участок не выбран/);
  // ...but it can still go BACK (RETURNED -> CORRECTING) and have a scope assigned there; then it is a normal scoped package
  const cur = (await pool.query('SELECT version FROM documentation_packages WHERE id=$1', [legacy.id])).rows[0];
  const returned = await raw(`documentation-packages/${legacy.id}/status`, { status: 'RETURNED', version: cur.version });
  assert.equal(returned.status, 201);
  const back = (await (await raw(`documentation-packages/${legacy.id}/status`, { status: 'CORRECTING', version: ((await returned.json()) as any).version })).json()) as any;
  assert.equal(back.status, 'CORRECTING');
  const linked = await raw(`documentation-packages/${legacy.id}/portions`, { quantityPortionId: ctx.portion.id });
  assert.equal(linked.status, 201, 'the engineer assigns the scope explicitly');
  assert.equal((await pkgView(req, legacy.id)).scope.hasScope, true);
});

test('a scoped Core / external package still goes the whole ID-AUTO-1 route (generated AOSR or external, scheme file, presentation)', async () => {
  const { req } = await harness();
  const core = await setUp({ method: 'CORE' });
  await generatedAosr(req, core);
  assert.equal((await presentPackage(req, core.pkg.id)).status, 'PRESENTED');
  const ext = await setUp({ method: 'EXTERNAL' });
  await uploadScheme(req, ext.pkg.id, 'ES-001');
  assert.equal((await presentPackage(req, ext.pkg.id)).status, 'PRESENTED');
  assert.equal((await pkgView(req, ext.pkg.id)).aosrMethod, 'EXTERNAL');
});
