/**
 * Since the package-scope corrective, a Documentation Package is created WITH its production scope (Quantity Portions of its Work).
 * Suites that are about something else call this for the scope: it reuses a portion of the work that no package claims yet, or creates
 * a minimal execution unit + portion for the work directly in the database (the same tables the production model owns).
 */
export async function scopePortionFor(workId: string): Promise<string> {
  const { pool, one, insert } = await import('../../apps/backend/src/db');
  const work = await one(pool, 'SELECT * FROM works WHERE id=$1', [workId]);
  if (!work) return '00000000-0000-0000-0000-000000000000'; // unknown work: let the service answer 404 itself
  const free = await one(pool, 'SELECT p.id FROM quantity_portions p JOIN work_execution_units u ON u.tenant_id=p.tenant_id AND u.id=p.execution_unit_id WHERE u.object_work_id=$1 AND NOT EXISTS (SELECT 1 FROM documentation_package_portions l WHERE l.quantity_portion_id=p.id) ORDER BY p.created_at LIMIT 1', [workId]);
  if (free) return free.id;
  const unit = await insert(pool, 'work_execution_units', work.tenantId, { objectWorkId: work.id, workTypeId: work.workTypeId, contractorId: work.contractorId, unit: work.unit, plannedQuantity: '100', location: '1 этаж' });
  return (await insert(pool, 'quantity_portions', work.tenantId, { executionUnitId: unit.id, label: 'Участок', plannedQuantity: '100' })).id;
}

/** Always creates a NEW portion (own execution unit) for the work — for suites that build several packages on one work. */
export async function newPortionFor(workId: string, label = 'Участок', customerScBy?: string): Promise<string> {
  const { pool, one, insert } = await import('../../apps/backend/src/db');
  const work = await one(pool, 'SELECT * FROM works WHERE id=$1', [workId]);
  const unit = await insert(pool, 'work_execution_units', work.tenantId, { objectWorkId: work.id, workTypeId: work.workTypeId, contractorId: work.contractorId, unit: work.unit, plannedQuantity: '100', location: '1 этаж' });
  const portion = await insert(pool, 'quantity_portions', work.tenantId, { executionUnitId: unit.id, label, plannedQuantity: '100' });
  // Optionally a customer (CUSTOMER_SC) confirmation, so a package covering it can reach SDO readiness.
  if (customerScBy) await insert(pool, 'portion_quantity_confirmations', work.tenantId, { portionId: portion.id, source: 'CUSTOMER_SC', quantity: '100', recordedBy: customerScBy });
  return portion.id;
}
