import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * F8.1 — separated quantity confirmation history. RP fact, Internal SC and
 * Customer SC recorded for the same portion are three independent,
 * never-overwriting figures ("all values remain separately. No overwrite.").
 * Backend integration, real PGlite transactions, ProductionService called
 * directly (no HTTP route until Phase 3) — see tests/execution-units.test.ts
 * for why.
 */
test('F8.1: RP fact / Internal SC / Customer SC never overwrite each other, and the history is truly immutable', async () => {
  delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'f8-1-confirmation-key';
  process.env.DB_MODE = 'pglite';
  process.env.PGLITE_DIR = 'memory://';

  const { pool, one, rows } = await import('../apps/backend/src/db');
  const { migrate } = await import('../scripts/migrate');
  const { seed } = await import('../scripts/seed');
  const { ProductionService } = await import('../apps/backend/src/service');

  await migrate();
  const tenant = await seed();
  const service = new ProductionService();

  async function actorWithRole(role: string) {
    return one(pool, 'SELECT * FROM users WHERE tenant_id=$1 AND role=$2 ORDER BY bitrix_user_id LIMIT 1', [tenant.id, role]);
  }

  const pm = await actorWithRole('PROJECT_MANAGER');
  const sk = await actorWithRole('CONSTRUCTION_CONTROL');
  const workType = await one(pool, 'SELECT * FROM work_types WHERE tenant_id=$1 LIMIT 1', [tenant.id]);
  const work = await one(pool, 'SELECT * FROM works WHERE tenant_id=$1 LIMIT 1', [tenant.id]);
  const contractor = await one(pool, 'SELECT * FROM contractors WHERE tenant_id=$1 AND id=$2', [tenant.id, work.contractorId]);

  const unit = await service.createExecutionUnit(pm, {
    objectWorkId: work.id,
    workTypeId: workType.id,
    contractorId: contractor.id,
    unit: 'м²',
    plannedQuantity: '500',
  });
  const portion = await service.createQuantityPortion(pm, unit.id, { label: 'Секция А', plannedQuantity: '500' });

  // --- RP enters fact: partial, then the full 500 required to present ---
  const partial = await service.recordPortionFact(pm, portion.id, { quantity: '300', version: portion.version, comment: 'Промежуточный факт' });
  assert.equal(partial.source, 'RP_FACT');
  assert.equal(partial.quantity, '300.0000');

  await assert.rejects(
    () => service.requestPortionInspection(pm, portion.id, portion.version + 1, 'INTERNAL_SC'),
    /полный объём участка/,
    'business rule 6, at portion granularity: partial fact must not allow presenting the portion',
  );

  const full = await service.recordPortionFact(pm, portion.id, { quantity: '500', version: portion.version + 1, comment: 'Полный факт' });
  assert.equal(full.quantity, '500.0000');

  // --- Internal SC: request, then accept — reuses inspectionAction() unchanged ---
  const internalRequest = await service.requestPortionInspection(pm, portion.id, portion.version + 2, 'INTERNAL_SC');
  assert.equal(internalRequest.inspectionType, 'INTERNAL_SC');
  assert.equal(internalRequest.portionId, portion.id);
  assert.equal(internalRequest.objectWorkId, work.id, 'work-level logic (dependency blockers) must still see this inspection');

  // The freeze guard now applies to this portion: a further fact entry is blocked.
  await assert.rejects(
    () => service.recordPortionFact(pm, portion.id, { quantity: '500', version: portion.version + 3, comment: 'Should be blocked' }),
    /факт участка заблокирован/,
  );

  // inspectionAction() (unchanged) requires a photo before accept — same rule as today.
  await assert.rejects(() => service.inspectionAction(sk, internalRequest.id, internalRequest.version, 'accept', 'ok'), /фотофиксация/);
  const file = await import('../apps/backend/src/db').then((m) => m.insert(pool, 'attachments', tenant.id, { fileName: 'internal-sc.jpg', mimeType: 'image/jpeg', content: Buffer.from('demo'), uploadedBy: sk.id }));
  await pool.query('INSERT INTO inspection_photos(tenant_id,inspection_id,attachment_id,uploaded_by) VALUES($1,$2,$3,$4)', [tenant.id, internalRequest.id, file.id, sk.id]);
  const accepted = await service.inspectionAction(sk, internalRequest.id, internalRequest.version, 'accept', 'Подтверждено СК');
  assert.equal(accepted.status, 'ACCEPTED');
  assert.equal(accepted.inspectionType, 'INTERNAL_SC');

  // Internal SC's own accepted quantity is recorded separately from RP fact —
  // this is application-level bookkeeping (ProductionService does not do this
  // automatically inside inspectionAction(), which stays generic to both
  // types); recorded directly here to prove the confirmation table's shape.
  const internalConfirmation = await one(
    pool,
    "INSERT INTO portion_quantity_confirmations(tenant_id,portion_id,source,quantity,inspection_id,recorded_by) VALUES($1,$2,'INTERNAL_SC',$3,$4,$5) RETURNING *",
    [tenant.id, portion.id, '498', internalRequest.id, sk.id],
  );
  assert.equal(internalConfirmation.source, 'INTERNAL_SC');

  // --- Customer SC: same table, same workflow, distinct type — registered by an internal employee ---
  const customerRequest = await service.requestPortionInspection(pm, portion.id, (await one(pool, 'SELECT version FROM quantity_portions WHERE tenant_id=$1 AND id=$2', [tenant.id, portion.id])).version, 'CUSTOMER_SC');
  assert.equal(customerRequest.inspectionType, 'CUSTOMER_SC');
  assert.equal(customerRequest.portionId, portion.id);
  // Registered by an internal employee (sk here — an authorized internal role);
  // there is no customer user row anywhere in this schema to hold instead.
  await pool.query('INSERT INTO inspection_photos(tenant_id,inspection_id,attachment_id,uploaded_by) VALUES($1,$2,$3,$4)', [tenant.id, customerRequest.id, file.id, sk.id]);
  const customerAccepted = await service.inspectionAction(sk, customerRequest.id, customerRequest.version, 'accept', 'Заказчик принял');
  assert.equal(customerAccepted.status, 'ACCEPTED');
  assert.equal(customerAccepted.inspectorId, sk.id, 'inspector_id is the internal employee who registered the decision, never a customer');

  const customerConfirmation = await one(
    pool,
    "INSERT INTO portion_quantity_confirmations(tenant_id,portion_id,source,quantity,inspection_id,recorded_by) VALUES($1,$2,'CUSTOMER_SC',$3,$4,$5) RETURNING *",
    [tenant.id, portion.id, '496', customerRequest.id, sk.id],
  );

  // --- all three values remain separately: no overwrite, all three readable at once ---
  const history = await rows(
    pool,
    'SELECT source, quantity, recorded_at FROM portion_quantity_confirmations WHERE tenant_id=$1 AND portion_id=$2 ORDER BY recorded_at',
    [tenant.id, portion.id],
  );
  // "Current" = latest row per source — the same shape read-service.ts already
  // uses for last_reported_at (a correlated MAX(recorded_at) subquery), applied
  // here as a plain reduce over the already-fetched rows.
  const latestBySource: Record<string, string> = {};
  for (const row of history) latestBySource[row.source] = row.quantity;
  assert.equal(latestBySource.RP_FACT, '500.0000');
  assert.equal(latestBySource.INTERNAL_SC, '498.0000');
  assert.equal(latestBySource.CUSTOMER_SC, '496.0000');
  assert.notEqual(latestBySource.RP_FACT, latestBySource.INTERNAL_SC);
  assert.notEqual(latestBySource.INTERNAL_SC, latestBySource.CUSTOMER_SC);
  // The partial 300 entry is still there too — nothing was overwritten, ever.
  assert.ok(history.some((h: any) => h.source === 'RP_FACT' && h.quantity === '300.0000'));
  assert.equal(history.length, 4, 'RP_FACT x2 (300, 500) + INTERNAL_SC + CUSTOMER_SC — no row lost, none merged');

  // --- immutability: the trigger actually rejects UPDATE and DELETE, not just exists ---
  await assert.rejects(
    () => pool.query('UPDATE portion_quantity_confirmations SET quantity=$1 WHERE tenant_id=$2 AND id=$3', ['999', tenant.id, internalConfirmation.id]),
    /Append-only history/,
  );
  await assert.rejects(
    () => pool.query('DELETE FROM portion_quantity_confirmations WHERE tenant_id=$1 AND id=$2', [tenant.id, customerConfirmation.id]),
    /Append-only history/,
  );
  const stillThere = await one(pool, 'SELECT quantity FROM portion_quantity_confirmations WHERE tenant_id=$1 AND id=$2', [tenant.id, internalConfirmation.id]);
  assert.equal(stillThere.quantity, '498.0000', 'the rejected UPDATE must not have partially applied');

  // --- CHECK constraints reject bad data, not just accept good data ---
  await assert.rejects(
    () => pool.query("INSERT INTO portion_quantity_confirmations(tenant_id,portion_id,source,quantity,recorded_by) VALUES($1,$2,'NOT_A_REAL_SOURCE','1',$3)", [tenant.id, portion.id, sk.id]),
  );
  await assert.rejects(
    () => pool.query("INSERT INTO portion_quantity_confirmations(tenant_id,portion_id,source,quantity,recorded_by) VALUES($1,$2,'RP_FACT','-1',$3)", [tenant.id, portion.id, sk.id]),
  );

  await pool.end();
});
