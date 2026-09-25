import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * F8.1 Production Execution + Construction Control Foundation — backend
 * integration, real transactions against PGlite (tests/core-2.1-contractors.test.ts's
 * pattern). No HTTP route exists for these methods yet (that is Phase 3), so
 * ProductionService's new methods are called directly with a real Actor —
 * the same style tests/bitrix-contract.test.ts already uses for functions
 * that predate their own HTTP wiring.
 */
test('F8.1: execution unit / layer / quantity portion — create, tenant isolation, concurrency-safe bound check', async () => {
  delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'f8-1-execution-units-key';
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
  const workType = await one(pool, 'SELECT * FROM work_types WHERE tenant_id=$1 LIMIT 1', [tenant.id]);
  const work = await one(pool, 'SELECT * FROM works WHERE tenant_id=$1 LIMIT 1', [tenant.id]);
  const contractor = await one(pool, 'SELECT * FROM contractors WHERE tenant_id=$1 AND id=$2', [tenant.id, work.contractorId]);

  // --- permission: EXECUTION_UNIT_MANAGE, not just any logged-in role ---
  await assert.rejects(
    () =>
      service.createExecutionUnit(sk, {
        objectWorkId: work.id,
        workTypeId: workType.id,
        contractorId: contractor.id,
        unit: 'м²',
        plannedQuantity: '500',
      }),
    (e: any) => e.status === 403 || /Недостаточно прав/.test(e.message),
  );

  // --- create: happy path ---
  const unit = await service.createExecutionUnit(pm, {
    objectWorkId: work.id,
    workTypeId: workType.id,
    contractorId: contractor.id,
    unit: 'м²',
    plannedQuantity: '500',
  });
  assert.equal(unit.objectWorkId, work.id);
  assert.equal(unit.plannedQuantity, '500.0000');
  assert.equal(unit.tenantId, tenant.id);

  // --- layer ---
  const layer = await service.addExecutionUnitLayer(pm, unit.id, { sortOrder: 0, name: 'Грунтовка' });
  assert.equal(layer.executionUnitId, unit.id);
  const layer2 = await service.addExecutionUnitLayer(pm, unit.id, { sortOrder: 1, name: 'Штукатурка' });
  assert.equal(layer2.sortOrder, 1);

  // --- contractor not assigned to the object: rejected, same check createWork already makes ---
  const foreignContractor = await one(
    pool,
    'SELECT * FROM contractors WHERE tenant_id=$1 AND id<>$2 LIMIT 1',
    [tenant.id, contractor.id],
  );
  await assert.rejects(
    () =>
      service.createExecutionUnit(pm, {
        objectWorkId: work.id,
        workTypeId: workType.id,
        contractorId: foreignContractor.id,
        unit: 'м²',
        plannedQuantity: '100',
      }),
    /не назначен на объект/,
  );

  // --- portions: D4 bound ---
  const portion1 = await service.createQuantityPortion(pm, unit.id, { label: 'Секция А', plannedQuantity: '150' });
  assert.equal(portion1.executionUnitId, unit.id);
  const portion2 = await service.createQuantityPortion(pm, unit.id, { label: 'Секция Б', plannedQuantity: '200' });
  const portion3 = await service.createQuantityPortion(pm, unit.id, { label: 'Секция В', plannedQuantity: '150' });
  // 150+200+150 = 500 = unit's planned_quantity exactly — allowed (D4: "cannot exceed", not "must stay below").
  assert.equal(portion3.plannedQuantity, '150.0000');

  await assert.rejects(
    () => service.createQuantityPortion(pm, unit.id, { label: 'Секция Г', plannedQuantity: '0.0001' }),
    /превышает плановый объём/,
    'the sum is already exactly at the unit total — even a tiny additional portion must be rejected',
  );

  // A second unit's portions must not count against the first unit's bound.
  const unit2 = await service.createExecutionUnit(pm, {
    objectWorkId: work.id,
    workTypeId: workType.id,
    contractorId: contractor.id,
    unit: 'м²',
    plannedQuantity: '100',
  });
  const unit2Portion = await service.createQuantityPortion(pm, unit2.id, { label: 'Отдельная секция', plannedQuantity: '80' });
  assert.equal(unit2Portion.executionUnitId, unit2.id);

  // --- concurrency: two portions racing against the same near-full unit — only one may fit ---
  const unit3 = await service.createExecutionUnit(pm, {
    objectWorkId: work.id,
    workTypeId: workType.id,
    contractorId: contractor.id,
    unit: 'м²',
    plannedQuantity: '100',
  });
  await service.createQuantityPortion(pm, unit3.id, { label: 'База', plannedQuantity: '60' });
  const results = await Promise.allSettled([
    service.createQuantityPortion(pm, unit3.id, { label: 'Гонка А', plannedQuantity: '30' }),
    service.createQuantityPortion(pm, unit3.id, { label: 'Гонка Б', plannedQuantity: '30' }),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one of the two racing 30-unit portions must succeed against a 40-remaining budget');
  assert.equal(rejected.length, 1);
  const finalSum = await one(
    pool,
    'SELECT coalesce(sum(planned_quantity),0) AS total FROM quantity_portions WHERE tenant_id=$1 AND execution_unit_id=$2',
    [tenant.id, unit3.id],
  );
  assert.ok(Number(finalSum.total) <= 100, `sum must never exceed the unit total; got ${finalSum.total}`);

  // --- tenant isolation: a second tenant cannot see or extend the first tenant's unit ---
  const otherTenant = await one(
    pool,
    "INSERT INTO tenants(portal,member_id,name) VALUES('f8-1-other.local','f8-1-other','Другой тенант') RETURNING *",
  );
  const { insert } = await import('../apps/backend/src/db');
  const otherUser = await insert(pool, 'users', otherTenant.id, {
    bitrixUserId: '900',
    name: 'Чужой РП',
    role: 'PROJECT_MANAGER',
  });
  await assert.rejects(
    () => service.addExecutionUnitLayer(otherUser, unit.id, { sortOrder: 0, name: 'Чужой слой' }),
    (e: any) => e.status === 404,
  );

  await pool.end();
});
