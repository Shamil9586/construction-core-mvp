/**
 * PBX-3A shared test fixtures. Imports the backend lazily so callers can configure
 * DB_MODE/DATABASE_URL first (same discipline every *-http.test.ts harness uses).
 *
 * Seeding assignments goes through the REAL service (ObjectTeamService) as the seeded
 * DEPUTY_DIRECTOR — never raw INSERTs — so fixtures exercise the same rules production does.
 */
let counter = 0;
export async function tenantId(): Promise<string> {
  const { pool } = await import('../../apps/backend/src/db');
  return (await pool.query("SELECT id FROM tenants WHERE portal='demo.local'")).rows[0].id;
}
export async function makeUser(name: string, role: string, opts: { active?: boolean; tenant?: string } = {}) {
  const { pool, insert } = await import('../../apps/backend/src/db');
  const t = opts.tenant ?? (await tenantId());
  return insert(pool, 'users', t, { bitrixUserId: 'pbx3-' + Date.now() + '-' + ++counter, name, role, isActive: opts.active ?? true });
}
export async function tokenFor(user: any): Promise<string> {
  const { session } = await import('../../apps/backend/src/security');
  return (await session(user)).token;
}
export async function actorByRole(role: string) {
  const { pool, one } = await import('../../apps/backend/src/db');
  return one(pool, 'SELECT * FROM users WHERE tenant_id=$1 AND role=$2 AND is_active=true ORDER BY created_at LIMIT 1', [await tenantId(), role]);
}
/** Make `pto` an ACTIVE PTO object member and `head` the PTO lead of `objectId` (as the seeded Deputy Director). */
export async function assignPtoToObject(objectId: string, opts: { member?: any; lead?: any } = {}) {
  const { ObjectTeamService } = await import('../../apps/backend/src/team-service');
  const svc = new ObjectTeamService();
  const deputy = await actorByRole('DEPUTY_DIRECTOR');
  const seededHead = opts.lead ?? (await actorByRole('PTO_HEAD'));
  const seededPto = opts.member ?? (await actorByRole('PTO'));
  const { pool, one } = await import('../../apps/backend/src/db');
  const t = await tenantId();
  const hasLead = await one(pool, "SELECT 1 FROM object_function_lead_assignments WHERE tenant_id=$1 AND object_id=$2 AND function_code='PTO' AND lead_user_id=$3 AND ended_at IS NULL", [t, objectId, seededHead.id]);
  if (!hasLead) await svc.assignObjectLead(deputy, objectId, { leadUserId: seededHead.id });
  const hasOrg = await one(pool, "SELECT 1 FROM functional_team_memberships WHERE tenant_id=$1 AND function_code='PTO' AND member_user_id=$2 AND manager_user_id=$3 AND ended_at IS NULL", [t, seededPto.id, seededHead.id]);
  if (!hasOrg) await svc.assignOrgMember(deputy, { memberUserId: seededPto.id, managerUserId: seededHead.id });
  const hasMember = await one(pool, "SELECT 1 FROM object_function_member_assignments WHERE tenant_id=$1 AND object_id=$2 AND function_code='PTO' AND member_user_id=$3 AND ended_at IS NULL", [t, objectId, seededPto.id]);
  if (!hasMember) await svc.redistribute(deputy, { reason: 'test fixture', orgTransfers: [], orgEnds: [], leadChanges: [], memberEnds: [], memberAdds: [{ objectId, memberUserId: seededPto.id }], handovers: [] });
}
