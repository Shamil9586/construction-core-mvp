import { gprHarness, pilotScenario, type Harness } from './gpr-fixtures';
import { makeUser, tokenFor, tenantId } from './pbx3-fixtures';
import { endpointById, pathParamsOf, type Gpr2Endpoint } from '../../packages/domain/gpr2';

/**
 * GPR-2 R01 shared fixtures: the REAL backend over in-memory PGlite (the gpr-fixtures harness: DATABASE_URL deleted, DB_MODE=pglite, mock auth), with the
 * guarded /v2 command surface switched on. Nothing here can reach a real database: the harness refuses DATABASE_URL before the application is imported.
 */
export const KEY = (n = 1) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
export const uuid = () => crypto.randomUUID();

export async function gpr2Harness(key: string) {
  process.env.GPR2_CONTRACT_ROUTES = 'enabled'; // must be set before main.ts is first imported (the module list is fixed at import)
  const h: Harness = await gprHarness(key);
  const roleTokens: Record<string, string> = {};
  async function roleToken(role: string) {
    if (!roleTokens[role]) {
      const r = await fetch(`${h.base}/auth/mock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, key }) });
      roleTokens[role] = (await r.json()).token;
    }
    return roleTokens[role];
  }
  async function call(token: string | null, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...opts.headers };
    const r = await fetch(h.base + '/' + path.replace(/^\//, ''), { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    return { status: r.status, body: (await r.json().catch(() => null)) as any, headers: r.headers };
  }
  return { h, roleToken, call, makeUser, tokenFor, tenantId };
}
export type Gpr2Harness = Awaited<ReturnType<typeof gpr2Harness>>;

/** A fresh, well-formed approve / commit fence (TD §11.1): the exact input and the immutable source versions it was built from. */
export const fence = () => ({ inputFingerprint: 'a'.repeat(64), expectedSourceVersions: { calendar: uuid(), quantity: uuid() } });
const PAYLOADS: Record<string, () => unknown> = {
  'schedule.revision.submit': () => ({ changeReason: 'готово к утверждению' }),
  'schedule.revision.approve': fence, 'quantity.request.approve': fence, 'imports.boq.commit': fence, 'imports.estimate-labor.commit': fence,
  'finish-change.record-correction': () => ({ reason: 'исправление внешнего решения' }),
  'schedule.changes.apply': () => ({ previewFingerprint: 'a'.repeat(64) }),
  'schedule.revision.return': () => ({ reason: 'нужна доработка' }), 'quantity.request.return': () => ({ reason: 'нужна доработка' }), 'work-type.publication.reject': () => ({ reason: 'дубликат' })
};

/** A well-formed request for a command: every header and token its register row asks for, a payload the contract accepts. */
export function validRequest(e: Gpr2Endpoint, params: Record<string, string>, nth = 1) {
  const path = '/v2' + e.path.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? uuid());
  const body: Record<string, unknown> = { payload: PAYLOADS[e.id]?.() ?? {} };
  if (e.aggregateVersion) body.expectedVersion = '1';
  if (e.scopeFence) body.expectedScopeVersion = '1';
  return { method: e.method, path, body, headers: e.idempotent ? { 'Idempotency-Key': KEY(nth) } : {} };
}
export { endpointById, pathParamsOf, pilotScenario };

/** A second tenant with one manager and one object — the "other tenant's object" of the scope-safety tests. */
export async function foreignTenantObject() {
  const { pool, insert, one } = await import('../../apps/backend/src/db');
  const tenant = await one(pool, "INSERT INTO tenants(portal,member_id,name) VALUES($1,$2,'Чужой tenant') RETURNING *", ['foreign-' + Date.now(), 'foreign-member-' + Date.now()]);
  const manager = await insert(pool, 'users', tenant.id, { bitrixUserId: 'foreign-pm-' + Date.now(), name: 'Чужой РП', role: 'PROJECT_MANAGER', isActive: true });
  const object = await insert(pool, 'objects', tenant.id, { externalCode: 'FOREIGN-' + Date.now(), name: 'Объект чужого tenant', address: 'a', organizationName: 'o', projectManagerId: manager.id, contractValue: '1000000.00', startDate: '2026-01-01', plannedFinishDate: '2026-12-31' });
  return { tenant, manager, object };
}
