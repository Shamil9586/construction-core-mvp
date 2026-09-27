import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * F12-QTY-03 (locked F12-D01): a portion-scoped Customer SC ACCEPT with an
 * explicit confirmed quantity of 0 is not a valid acceptance. Zero remains a
 * real, storable value everywhere else in this system — Internal SC keeps
 * its own existing presence-only rule, verified untouched below — but
 * "ACCEPTED with 0" specifically must be refused, never silently stored, per
 * F12-D01. Own file for the same pool-lifecycle reason as
 * tests/f12.1-fact-freeze-customer-sc.test.ts.
 */
test('F12-QTY-03: Customer SC ACCEPT with an explicit quantity of 0 is refused — no confirmation row is inserted, the inspection is not left ACCEPTED, and Internal SC keeps accepting an explicit 0 unchanged', async () => {
  delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'f12-qty-03-key';
  process.env.DB_MODE = 'pglite';
  process.env.PGLITE_DIR = 'memory://';

  const { pool, one } = await import('../apps/backend/src/db');
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
  const work = await one(pool, 'SELECT * FROM works WHERE tenant_id=$1 LIMIT 1', [tenant.id]);
  const workType = await one(pool, 'SELECT * FROM work_types WHERE tenant_id=$1 AND id=$2', [tenant.id, work.workTypeId]);
  const contractor = await one(pool, 'SELECT * FROM contractors WHERE tenant_id=$1 AND id=$2', [tenant.id, work.contractorId]);

  const unit = await service.createExecutionUnit(pm, { objectWorkId: work.id, workTypeId: workType.id, contractorId: contractor.id, unit: work.unit, plannedQuantity: '300' });
  const portion = await service.createQuantityPortion(pm, unit.id, { label: 'Секция A', plannedQuantity: '300' });
  await service.recordPortionFact(pm, portion.id, { quantity: '300', version: portion.version, comment: 'Полный факт' });
  const customerRequest = await service.requestPortionInspection(pm, portion.id, portion.version + 1, 'CUSTOMER_SC');

  const file = await import('../apps/backend/src/db').then((m) => m.insert(pool, 'attachments', tenant.id, { fileName: 'customer-sc-zero.jpg', mimeType: 'image/jpeg', content: Buffer.from('demo'), uploadedBy: sk.id }));
  await pool.query('INSERT INTO inspection_photos(tenant_id,inspection_id,attachment_id,uploaded_by) VALUES($1,$2,$3,$4)', [tenant.id, customerRequest.id, file.id, sk.id]);

  await assert.rejects(
    () => service.inspectionAction(sk, customerRequest.id, customerRequest.version, 'accept', 'Ничего не подтверждено', '0'),
    /должен быть больше нуля/,
    'F12-QTY-03: an explicit Customer SC quantity of 0 must be refused, never silently accepted',
  );

  const inspectionAfter = await one(pool, 'SELECT status,version FROM inspections WHERE tenant_id=$1 AND id=$2', [tenant.id, customerRequest.id]);
  assert.equal(inspectionAfter.status, 'WAITING', 'the inspection must not be left ACCEPTED by the refused attempt');
  assert.equal(inspectionAfter.version, customerRequest.version, 'the refused attempt must not have mutated the inspection at all');

  const confirmationAfter = await one(pool, "SELECT id FROM portion_quantity_confirmations WHERE tenant_id=$1 AND portion_id=$2 AND source='CUSTOMER_SC'", [tenant.id, portion.id]);
  assert.equal(confirmationAfter, undefined, 'no CUSTOMER_SC confirmation row of any kind must exist after a refused zero-accept');

  // --- a genuine positive Customer SC accept still works normally ---
  const genuineAccept = await service.inspectionAction(sk, customerRequest.id, customerRequest.version, 'accept', 'Подтверждено заказчиком', '300');
  assert.equal(genuineAccept.status, 'ACCEPTED');
  const confirmationAfterGenuine = await one(pool, "SELECT quantity FROM portion_quantity_confirmations WHERE tenant_id=$1 AND portion_id=$2 AND source='CUSTOMER_SC' ORDER BY recorded_at DESC LIMIT 1", [tenant.id, portion.id]);
  assert.equal(confirmationAfterGenuine.quantity, '300.0000');

  // --- Internal SC's own existing presence-only rule is untouched: an explicit Internal SC quantity of 0 is still accepted normally ---
  const unit2 = await service.createExecutionUnit(pm, { objectWorkId: work.id, workTypeId: workType.id, contractorId: contractor.id, unit: work.unit, plannedQuantity: '300' });
  const portion2 = await service.createQuantityPortion(pm, unit2.id, { label: 'Секция B (Internal SC)', plannedQuantity: '300' });
  await service.recordPortionFact(pm, portion2.id, { quantity: '300', version: portion2.version, comment: 'Полный факт' });
  const internalRequest = await service.requestPortionInspection(pm, portion2.id, portion2.version + 1, 'INTERNAL_SC');
  const file2 = await insertAttachment(pool, tenant.id, sk.id);
  await pool.query('INSERT INTO inspection_photos(tenant_id,inspection_id,attachment_id,uploaded_by) VALUES($1,$2,$3,$4)', [tenant.id, internalRequest.id, file2.id, sk.id]);
  const internalAcceptedWithZero = await service.inspectionAction(sk, internalRequest.id, internalRequest.version, 'accept', 'Ноль — тоже реальное значение', '0');
  assert.equal(internalAcceptedWithZero.status, 'ACCEPTED', 'F12-D01 is deliberately scoped to Customer SC only — Internal SC keeps accepting an explicit 0');
  const internalConfirmation = await one(pool, "SELECT quantity FROM portion_quantity_confirmations WHERE tenant_id=$1 AND portion_id=$2 AND source='INTERNAL_SC' ORDER BY recorded_at DESC LIMIT 1", [tenant.id, portion2.id]);
  assert.equal(internalConfirmation.quantity, '0.0000', 'an explicit Internal SC zero must still be stored as a real confirmed value, distinct from absent');

  await pool.end();
});

async function insertAttachment(pool: any, tenantId: string, uploadedBy: string) {
  const { insert } = await import('../apps/backend/src/db');
  return insert(pool, 'attachments', tenantId, { fileName: 'internal-sc-zero.jpg', mimeType: 'image/jpeg', content: Buffer.from('demo'), uploadedBy });
}
