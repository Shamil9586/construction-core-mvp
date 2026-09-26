import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * F8.1 decisions 5-6 — one inspections table, two types, no separate table for
 * Customer SC; Customer SC only ever exists at portion granularity; a
 * pre-F8.1 whole-work Internal SC inspection (portion_id NULL) keeps working
 * through the exact, untouched requestInspection()/inspectionAction().
 */
test('F8.1: Customer SC only ever attaches to a portion; whole-work Internal SC keeps working through the untouched methods', async () => {
  delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'f8-1-inspection-type-key';
  process.env.DB_MODE = 'pglite';
  process.env.PGLITE_DIR = 'memory://';

  const { pool, one, insert } = await import('../apps/backend/src/db');
  const { migrate } = await import('../scripts/migrate');
  const { seed } = await import('../scripts/seed');
  const { ProductionService } = await import('../apps/backend/src/service');

  await migrate();
  const tenant = await seed();
  const service = new ProductionService();

  async function actorWithRole(role: string) {
    return one(pool, 'SELECT * FROM users WHERE tenant_id=$1 AND role=$2 ORDER BY bitrix_user_id LIMIT 1', [tenant.id, role]);
  }

  const sk = await actorWithRole('CONSTRUCTION_CONTROL');
  // seed()'s object index 3 (external code DEMO-2026-004) has every work
  // PLANNED with actual=0 (its `actual` is forced to 0 for every j) and no
  // seeded inspections — fetching a real PM tied to *this specific* object,
  // rather than an arbitrary PROJECT_MANAGER row, is what objectAccess()
  // requires: seed() assigns a different PM per object, and a PM whose id
  // does not match the object's own project_manager_id is correctly refused.
  const seededObject = await one(pool, "SELECT * FROM objects WHERE tenant_id=$1 AND external_code='DEMO-2026-004'", [tenant.id]);
  const pm = await one(pool, 'SELECT * FROM users WHERE tenant_id=$1 AND id=$2', [tenant.id, seededObject.projectManagerId]);
  const objectWorks = await import('../apps/backend/src/db').then((m) =>
    m.rows(pool, 'SELECT * FROM works WHERE tenant_id=$1 AND object_id=$2 ORDER BY name', [tenant.id, seededObject.id]),
  );
  assert.ok(objectWorks.length >= 2, 'fixture assumption: this object has at least two works, per seed()');

  // --- DB-level: CUSTOMER_SC with portion_id NULL is rejected even bypassing the service layer ---
  const bareWork = objectWorks[0];
  await assert.rejects(
    () =>
      pool.query(
        "INSERT INTO inspections(tenant_id,object_id,object_work_id,requested_by,inspection_type,portion_id) VALUES($1,$2,$3,$4,'CUSTOMER_SC',NULL)",
        [tenant.id, bareWork.objectId, bareWork.id, pm.id],
      ),
    /inspections_check|constraint/i,
    'the CHECK constraint, not application code, is what makes this impossible',
  );

  // A row explicitly typed INTERNAL_SC with no portion is exactly the pre-F8.1
  // shape and must remain legal — this is what requestInspection() below produces.
  await pool.query(
    "INSERT INTO inspections(tenant_id,object_id,object_work_id,requested_by,inspection_type,portion_id) VALUES($1,$2,$3,$4,'INTERNAL_SC',NULL)",
    [tenant.id, bareWork.objectId, bareWork.id, pm.id],
  );

  // --- the pre-F8.1 whole-work path, through the actual unmodified methods ---
  const secondWork = objectWorks[1];
  const progressed = await service.progress(pm, secondWork.id, { totalQuantity: secondWork.plannedQuantity, version: secondWork.version, comment: 'F8.1 compatibility: full volume' });
  const wholeWorkInspection = await service.requestInspection(pm, secondWork.id, progressed.version);
  assert.equal(wholeWorkInspection.portionId, null, 'requestInspection() is untouched — it never sets portion_id');
  assert.equal(wholeWorkInspection.inspectionType, 'INTERNAL_SC', "the column's DEFAULT, since requestInspection() does not set it either");

  const file = await insert(pool, 'attachments', tenant.id, { fileName: 'whole-work.jpg', mimeType: 'image/jpeg', content: Buffer.from('demo'), uploadedBy: sk.id });
  await pool.query('INSERT INTO inspection_photos(tenant_id,inspection_id,attachment_id,uploaded_by) VALUES($1,$2,$3,$4)', [tenant.id, wholeWorkInspection.id, file.id, sk.id]);
  const wholeWorkAccepted = await service.inspectionAction(sk, wholeWorkInspection.id, wholeWorkInspection.version, 'accept', 'Принято целиком');
  assert.equal(wholeWorkAccepted.status, 'ACCEPTED');

  // --- issues and photos, already generic over inspections.id, work for Customer SC with no new code ---
  const unit = await service.createExecutionUnit(pm, {
    objectWorkId: bareWork.id,
    workTypeId: bareWork.workTypeId,
    contractorId: bareWork.contractorId,
    unit: bareWork.unit,
    plannedQuantity: '100',
  });
  const portion = await service.createQuantityPortion(pm, unit.id, { label: 'Участок для заказчика', plannedQuantity: '100' });
  await service.recordPortionFact(pm, portion.id, { quantity: '100', version: portion.version, comment: 'Готово к предъявлению' });
  const customerRequest = await service.requestPortionInspection(pm, portion.id, portion.version + 1, 'CUSTOMER_SC');
  assert.equal(customerRequest.portionId, portion.id);
  assert.equal(customerRequest.inspectionType, 'CUSTOMER_SC');

  // addIssue() (unchanged) already FKs to inspections.id generically — a
  // Customer SC inspection can carry a remark with zero new code.
  const issue = await service.addIssue(sk, customerRequest.id, {
    title: 'Замечание заказчика',
    severity: 'MEDIUM',
    responsibleUserId: pm.id,
    dueDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    version: customerRequest.version,
  });
  assert.equal(issue.inspectionId, customerRequest.id);
  const afterIssue = await one(pool, 'SELECT status FROM inspections WHERE tenant_id=$1 AND id=$2', [tenant.id, customerRequest.id]);
  assert.equal(afterIssue.status, 'ISSUES_FOUND');

  await pool.end();
});
