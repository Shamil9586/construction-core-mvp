/** PBX-5A shared fixtures. The backend is imported lazily so callers configure DB_MODE/DATABASE_URL first. */
let n = 0;
export async function mkUser(tenant: string, name: string, role: string, bitrixUserId?: string, isActive = true) {
  const { pool, insert } = await import('../../apps/backend/src/db');
  return insert(pool, 'users', tenant, { bitrixUserId: bitrixUserId ?? String(900000 + ++n), name, role, isActive });
}
export async function byRole(tenant: string, role: string) {
  const { pool, one } = await import('../../apps/backend/src/db');
  return one(pool, 'SELECT * FROM users WHERE tenant_id=$1 AND role=$2 AND is_active=true ORDER BY created_at LIMIT 1', [tenant, role]);
}
export async function outboxFor(objectId: string) {
  const { pool, rows } = await import('../../apps/backend/src/db');
  return rows(pool, 'SELECT * FROM bitrix_notification_outbox WHERE object_id=$1 ORDER BY created_at, id', [objectId]);
}
export async function activeLead(tenant: string, objectId: string) {
  const { pool, one } = await import('../../apps/backend/src/db');
  return one(pool, "SELECT * FROM object_function_lead_assignments WHERE tenant_id=$1 AND object_id=$2 AND function_code='PTO' AND ended_at IS NULL", [tenant, objectId]);
}
/** Make `outboxId` the only row the worker can see as due (every other pending row is pushed a day out). */
export async function isolate(outboxId: string) {
  const { pool } = await import('../../apps/backend/src/db');
  await pool.query("UPDATE bitrix_notification_outbox SET next_attempt_at=now()+interval '1 day' WHERE id<>$1 AND status IN ('PENDING','RETRY_WAIT')", [outboxId]);
  await pool.query("UPDATE bitrix_notification_outbox SET next_attempt_at=now()-interval '1 second' WHERE id=$1 AND status IN ('PENDING','RETRY_WAIT')", [outboxId]);
}
export const emptyCmd = { orgTransfers: [], orgEnds: [], leadChanges: [], memberEnds: [], memberAdds: [], handovers: [] };
