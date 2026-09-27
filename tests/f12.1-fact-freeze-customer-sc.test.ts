import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * F12-QTY-04: fact freeze after Customer SC presentation.
 *
 * Business rule 6 ("После предъявления СК изменение факта блокируется") is a
 * rule about presentation to an applicable SC control contour — not
 * specifically Internal SC. recordPortionFact()'s freeze guard used to query
 * only `inspection_type='INTERNAL_SC'`, so a portion presented directly to
 * Customer SC — the legitimate subcontractor-without-Internal-SC route
 * (F8.1 decision 5: one workflow, either type) — could still take further
 * fact entries after presentation. This test exercises exactly that direct
 * route: no Internal SC activity anywhere in it. Same harness shape as
 * tests/f8.1-quantity-confirmation.test.ts (own file, own pool lifecycle —
 * that file's own single-test-per-file/pool.end() convention is why this is
 * a separate file rather than an appended second test there).
 */
test('F12-QTY-04: Customer SC presentation freezes RP Fact too, even with no prior Internal SC activity — a rejected Customer SC un-freezes it, and a sibling portion is unaffected', async () => {
  delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'f12-qty-04-key';
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

  const unit = await service.createExecutionUnit(pm, { objectWorkId: work.id, workTypeId: workType.id, contractorId: contractor.id, unit: work.unit, plannedQuantity: '1000' });
  const portionA = await service.createQuantityPortion(pm, unit.id, { label: 'Секция A (прямо на СК заказчика)', plannedQuantity: '500' });
  const portionB = await service.createQuantityPortion(pm, unit.id, { label: 'Секция B (соседний участок)', plannedQuantity: '500' });

  // Both portions reach a full fact with NO Internal SC anywhere in sight.
  await service.recordPortionFact(pm, portionA.id, { quantity: '500', version: portionA.version, comment: 'Факт A' });
  await service.recordPortionFact(pm, portionB.id, { quantity: '500', version: portionB.version, comment: 'Факт B' });

  const customerRequest = await service.requestPortionInspection(pm, portionA.id, portionA.version + 1, 'CUSTOMER_SC');
  assert.equal(customerRequest.inspectionType, 'CUSTOMER_SC');

  // --- the finding itself: fact on the presented portion is now blocked, with no Internal SC involved at all ---
  await assert.rejects(
    () => service.recordPortionFact(pm, portionA.id, { quantity: '499', version: portionA.version + 2, comment: 'Should be blocked' }),
    /факт участка заблокирован/,
    'F12-QTY-04: Customer SC presentation alone must freeze RP Fact, exactly as Internal SC presentation already does',
  );

  // --- sibling portion on the same unit is completely unaffected ---
  const siblingFact = await service.recordPortionFact(pm, portionB.id, { quantity: '500', version: portionB.version + 1, comment: 'Сосед не должен быть затронут' });
  assert.equal(siblingFact.quantity, '500.0000');

  // --- a REJECTED Customer SC un-freezes fact again (re-presentation semantics preserved) ---
  const rejected = await service.inspectionAction(sk, customerRequest.id, customerRequest.version, 'reject', 'Отклонено СК заказчика');
  assert.equal(rejected.status, 'REJECTED');

  const portionAVersion = (await one(pool, 'SELECT version FROM quantity_portions WHERE tenant_id=$1 AND id=$2', [tenant.id, portionA.id])).version;
  const factAfterRejection = await service.recordPortionFact(pm, portionA.id, { quantity: '480', version: portionAVersion, comment: 'Корректировка после отклонения' });
  assert.equal(factAfterRejection.quantity, '480.0000', 'a rejected Customer SC inspection must not keep blocking fact entry — re-presentation semantics preserved');

  await pool.end();
});
