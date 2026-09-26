import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * F8.1 final clarification 3 — "Existing non-portioned works must preserve
 * F7 behaviour exactly." progress(), requestInspection() and
 * inspectionAction() in apps/backend/src/service.ts are not edited by F8.1
 * at all (see that file's own F8.1 section header), so there is no branch
 * for a portion-aware path to leak into — this test pins the exact
 * behaviour anyway, rather than relying on "the source is untouched" as the
 * only proof. read-service.ts is equally untouched in Phase 2, so its real,
 * unmodified snapshot() is exercised here too, after migration 006 and every
 * Phase 2 service addition — proving the schema change alone does not alter
 * what a non-portioned work's read shape or accepted computation produce.
 */
test('F8.1: a non-portioned work — exact guard messages, unchanged accepted computation, additive-only wire shape', async () => {
  delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'f8-1-compatibility-key';
  process.env.DB_MODE = 'pglite';
  process.env.PGLITE_DIR = 'memory://';

  const { pool, one, insert } = await import('../apps/backend/src/db');
  const { migrate } = await import('../scripts/migrate');
  const { seed } = await import('../scripts/seed');
  const { ProductionService } = await import('../apps/backend/src/service');
  const { ReadService } = await import('../apps/backend/src/read-service');

  await migrate();
  const tenant = await seed();
  const service = new ProductionService();
  const read = new ReadService();

  const seededObject = await one(pool, "SELECT * FROM objects WHERE tenant_id=$1 AND external_code='DEMO-2026-004'", [tenant.id]);
  const pm = await one(pool, 'SELECT * FROM users WHERE tenant_id=$1 AND id=$2', [tenant.id, seededObject.projectManagerId]);
  const sk = await one(pool, "SELECT * FROM users WHERE tenant_id=$1 AND role='CONSTRUCTION_CONTROL' LIMIT 1", [tenant.id]);
  const work = await one(pool, "SELECT * FROM works WHERE tenant_id=$1 AND object_id=$2 AND status='PLANNED' LIMIT 1", [tenant.id, seededObject.id]);
  assert.ok(work, 'fixture assumption: this object has at least one PLANNED work, per seed()');

  // No F8.1 concept touches this work at any point in this test — it never
  // gets an execution unit, and the assertions below use only progress(),
  // requestInspection() and inspectionAction(), unmodified.

  // --- exact message: partial fact cannot be presented (business rule 6, unchanged) ---
  const half = await service.progress(pm, work.id, { totalQuantity: String(Number(work.plannedQuantity) / 2), version: work.version, comment: 'Половина объёма' });
  await assert.rejects(
    () => service.requestInspection(pm, work.id, half.version),
    (e: any) => e.message === 'Для MVP предъявляется полный объём работы',
  );

  // --- full fact, then present: succeeds exactly as before ---
  const full = await service.progress(pm, work.id, { totalQuantity: work.plannedQuantity, version: half.version, comment: 'Полный объём' });
  assert.equal(full.status, 'COMPLETED');
  const inspection = await service.requestInspection(pm, work.id, full.version);
  assert.equal(inspection.portionId, null, 'requestInspection() never sets portion_id — it does not know the column exists');

  // --- exact message: fact is frozen once a non-terminal inspection exists (unchanged) ---
  const staleWork = await one(pool, 'SELECT version FROM works WHERE tenant_id=$1 AND id=$2', [tenant.id, work.id]);
  await assert.rejects(
    () => service.progress(pm, work.id, { totalQuantity: work.plannedQuantity, version: staleWork.version, comment: 'Попытка корректировки' }),
    (e: any) => e.message === 'После предъявления СК факт заблокирован. Требуется отдельная корректировка',
  );

  // --- accept, through the exact unmodified inspectionAction() ---
  const file = await insert(pool, 'attachments', tenant.id, { fileName: 'compat.jpg', mimeType: 'image/jpeg', content: Buffer.from('demo'), uploadedBy: sk.id });
  await pool.query('INSERT INTO inspection_photos(tenant_id,inspection_id,attachment_id,uploaded_by) VALUES($1,$2,$3,$4)', [tenant.id, inspection.id, file.id, sk.id]);

  // --- read-service.ts, real and unmodified: accepted is false before, true after ---
  const before = await read.snapshot(pm);
  const beforeWork = before.works.find((w: any) => w.id === work.id);
  assert.equal(beforeWork.accepted, false);

  await service.inspectionAction(sk, inspection.id, inspection.version, 'accept', 'Комплаенс-тест');

  const after = await read.snapshot(pm);
  const afterWork = after.works.find((w: any) => w.id === work.id);
  assert.equal(afterWork.accepted, true, "read-service.ts's own accepted computation is unchanged and still correct after migration 006");

  const afterInspection = after.inspections.find((i: any) => i.id === inspection.id);
  assert.equal(afterInspection.status, 'ACCEPTED');
  // The one visible, additive-only change to the wire shape: every inspection
  // row now also carries these two columns. Nothing is removed or renamed.
  assert.equal(afterInspection.portionId, null);
  assert.equal(afterInspection.inspectionType, 'INTERNAL_SC');

  await pool.end();
});
