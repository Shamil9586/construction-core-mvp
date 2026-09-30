import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**

 * OBJ-1 — Object onboarding (OBJ1-D01..D04). One real HTTP harness (PGlite, mock auth, demo seed):
 *  B authority · C RP validation · D duplicate code → 409 · E optional contractors · F no PBX-3A side effects ·
 *  A empty-tenant shape · create-options tenant scoping.
 */
const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);

test('OBJ-1: role matrix (domain)', async () => {
  const { hasPermission, Permission, canCreateObject, roles } = await import('../packages/domain');
  const allowed = new Set(['DEPUTY_DIRECTOR', 'ADMIN']);
  for (const role of roles as readonly string[]) {
    assert.equal(hasPermission(role as any, Permission.OBJECT_CREATE), allowed.has(role), role + ' OBJECT_CREATE');
    assert.equal(canCreateObject(role), allowed.has(role), role + ' canCreateObject');
  }
  // Unrelated PM/TD object authority is NOT broadened or narrowed beyond OBJECT_CREATE.
  assert.ok(hasPermission('PROJECT_MANAGER', Permission.OBJECT_EDIT));
  assert.ok(hasPermission('TECHNICAL_DIRECTOR', Permission.OBJECT_EDIT));
  assert.equal(canCreateObject(undefined), false);
});

test('OBJ-1: authority, RP validation, optional contractors, duplicate code, tenant isolation, no PBX-3A side effects', async () => {
  if (!process.env.E2E_DATABASE_URL) delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'obj1-key';
  process.env.DB_MODE = process.env.E2E_DATABASE_URL ? 'postgres' : 'pglite';
  process.env.PGLITE_DIR = 'memory://';
  if (process.env.E2E_DATABASE_URL) process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;

  const { migrate } = await import('../scripts/migrate');
  const { seed } = await import('../scripts/seed');
  const { createApp } = await import('../apps/backend/src/main');
  const { pool, one, rows, insert } = await import('../apps/backend/src/db');
  await migrate();
  await seed();
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as any).port}`;
  const call = async (token: string, method: string, path: string, body?: any) => {
    const r = await fetch(base + '/' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: (await r.json().catch(() => null)) as any };
  };
  const login = async (role: string) => {
    const r = await fetch(base + '/auth/mock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, key: 'obj1-key' }) });
    const d: any = await r.json();
    return { token: d.token as string, user: d.user };
  };
  const body = (over: any = {}) => ({ externalCode: 'OBJ1-' + randomUUID(), name: 'OBJ-1 тест', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.user.id, startDate: dt(-1), plannedFinishDate: dt(30), contractValue: '0.00', ...over });

  const pm = await login('PROJECT_MANAGER');
  try {
    const deputy = await login('DEPUTY_DIRECTOR'), admin = await login('ADMIN'), td = await login('TECHNICAL_DIRECTOR'), gd = await login('GENERAL_DIRECTOR');
    const tenant = (await one(pool, "SELECT id FROM tenants WHERE portal='demo.local'")).id;
    const contractors = await rows(pool, 'SELECT id FROM contractors WHERE tenant_id=$1', [tenant]);
    assert.ok(contractors.length >= 1);

    // ---- PBX-3A snapshot helper ----
    const teamTables = ['functional_team_memberships', 'object_function_lead_assignments', 'object_function_member_assignments', 'object_function_handovers', 'works', 'documentation_packages', 'sdo_closing_cases'];
    const snapshot = async () => Object.fromEntries(await Promise.all(teamTables.map(async (t) => [t, JSON.stringify(await rows(pool, `SELECT * FROM ${t} WHERE tenant_id=$1 ORDER BY id`, [tenant]))])));
    const before = await snapshot();

    // ---- B. authority ----
    const ok = await call(deputy.token, 'POST', 'objects', body());
    assert.equal(ok.status, 201, JSON.stringify(ok.data));
    assert.equal((await call(admin.token, 'POST', 'objects', body())).status, 201, 'ADMIN override');
    for (const [label, who] of [['PROJECT_MANAGER', pm], ['GENERAL_DIRECTOR', gd], ['TECHNICAL_DIRECTOR (legacy)', td]] as const) {
      const n = (await one(pool, 'SELECT count(*)::int AS n FROM objects WHERE tenant_id=$1', [tenant])).n;
      assert.equal((await call(who.token, 'POST', 'objects', body())).status, 403, label + ' must not create');
      assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM objects WHERE tenant_id=$1', [tenant])).n, n, label + ' created nothing');
      assert.equal((await call(who.token, 'GET', 'object-create-options')).status, 403, label + ' options');
    }
    // PM self-assign explicitly rejected, even targeting itself.
    assert.equal((await call(pm.token, 'POST', 'objects', body({ projectManagerId: pm.user.id }))).status, 403);
    assert.equal((await call(deputy.token, 'GET', 'object-create-options')).status, 200);
    assert.equal((await call(admin.token, 'GET', 'object-create-options')).status, 200);

    // audit CREATE intact
    const audited = await one(pool, "SELECT count(*)::int AS n FROM audit_logs WHERE entity_type='Object' AND entity_id=$1 AND action='CREATE'", [ok.data.id]);
    assert.equal(audited.n, 1);

    // ---- C. RP validation ----
    const inactive = await insert(pool, 'users', tenant, { bitrixUserId: 'obj1-i-' + randomUUID(), name: 'Неактивный РП', role: 'PROJECT_MANAGER', isActive: false });
    const wrongRole = await insert(pool, 'users', tenant, { bitrixUserId: 'obj1-w-' + randomUUID(), name: 'ПТО', role: 'PTO', isActive: true });
    const other = await one(pool, "INSERT INTO tenants(portal,member_id,name) VALUES($1,$2,'OBJ1 other') RETURNING *", ['obj1-' + randomUUID() + '.local', randomUUID()]);
    const foreignPm = await insert(pool, 'users', other.id, { bitrixUserId: 'obj1-f-' + randomUUID(), name: 'Чужой РП', role: 'PROJECT_MANAGER', isActive: true });
    const foreignContractor = await insert(pool, 'contractors', other.id, { name: 'Чужой подрядчик' });
    for (const [label, id] of [['inactive', inactive.id], ['wrong role', wrongRole.id], ['cross-tenant', foreignPm.id]] as const) {
      const r = await call(deputy.token, 'POST', 'objects', body({ projectManagerId: id }));
      assert.ok([400, 404].includes(r.status), label + ' must be rejected, got ' + r.status);
    }
    assert.equal((await call(deputy.token, 'POST', 'objects', body({ plannedFinishDate: dt(-10) }))).status, 400, 'finish before start');

    // ---- create-options: only active same-tenant PMs + own contractors ----
    const opts = (await call(deputy.token, 'GET', 'object-create-options')).data;
    assert.ok(opts.projectManagers.length >= 1 && opts.projectManagers.every((p: any) => Object.keys(p).sort().join() === 'id,name'));
    assert.ok(opts.projectManagers.some((p: any) => p.id === pm.user.id));
    for (const bad of [inactive.id, wrongRole.id, foreignPm.id]) assert.ok(!opts.projectManagers.some((p: any) => p.id === bad));
    assert.ok(!opts.contractors.some((c: any) => c.id === foreignContractor.id), 'no cross-tenant contractor');
    assert.ok(opts.contractors.length === contractors.length);

    // ---- E. contractor optionality ----
    const omitted = await call(deputy.token, 'POST', 'objects', body());
    const empty = await call(deputy.token, 'POST', 'objects', body({ contractorIds: [] }));
    assert.equal(omitted.status, 201); assert.equal(empty.status, 201);
    for (const o of [omitted.data, empty.data]) assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM object_contractors WHERE object_id=$1', [o.id])).n, 0);
    const linked = await call(deputy.token, 'POST', 'objects', body({ contractorIds: [contractors[0].id] }));
    assert.equal(linked.status, 201);
    assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM object_contractors_active WHERE object_id=$1 AND contractor_id=$2', [linked.data.id, contractors[0].id])).n, 1);
    const objectsBeforeBad = (await one(pool, 'SELECT count(*)::int AS n FROM objects')).n;
    const badC = await call(deputy.token, 'POST', 'objects', body({ contractorIds: [foreignContractor.id] }));
    assert.ok([400, 404].includes(badC.status), 'cross-tenant contractor rejected, got ' + badC.status);
    assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM objects')).n, objectsBeforeBad, 'rejected create leaves no object row (atomic)');
    assert.equal((await call(deputy.token, 'POST', 'objects', body({ contractorIds: [randomUUID()] }))).status === 201, false, 'unknown contractor rejected');

    // ---- D. duplicate code → 409, one row ----
    const code = 'OBJ1-DUP-' + randomUUID();
    assert.equal((await call(deputy.token, 'POST', 'objects', body({ externalCode: code }))).status, 201);
    const dup = await call(deputy.token, 'POST', 'objects', body({ externalCode: code }));
    assert.equal(dup.status, 409, JSON.stringify(dup.data));
    assert.match(dup.data.message, /код/i);
    assert.equal((await one(pool, "SELECT count(*)::int AS n FROM objects WHERE tenant_id=$1 AND source='MANUAL' AND external_code=$2", [tenant, code])).n, 1);
    // concurrent duplicates: exactly one wins, the other is a clean 409 (never 500)
    const raceCode = 'OBJ1-RACE-' + randomUUID();
    const race = await Promise.all([1, 2, 3].map(() => call(deputy.token, 'POST', 'objects', body({ externalCode: raceCode }))));
    assert.deepEqual(race.map((r) => r.status).sort(), [201, 409, 409]);
    // same code in ANOTHER tenant is isolated
    await insert(pool, 'objects', other.id, { externalCode: code, name: 'x', address: 'x', organizationName: 'x', projectManagerId: foreignPm.id, startDate: dt(0), plannedFinishDate: dt(1), contractValue: '0' });

    // ---- validation: contractorIds shape, strict DTO ----
    assert.equal((await call(deputy.token, 'POST', 'objects', body({ contractorIds: 'nope' }))).status, 400);
    assert.equal((await call(deputy.token, 'POST', 'objects', body({ source: 'BITRIX' }))).status, 400, 'source cannot be supplied');
    assert.equal((await call(deputy.token, 'POST', 'objects', body({ contractValue: '-1' }))).status, 400);

    // ---- F. PBX-3A preservation ----
    assert.deepEqual(await snapshot(), before, 'object creation must not touch team / lead / member / handover / works / packages / SDO rows');
  } finally {
    await app.close();
  }
});

test('OBJ-1 A: LIVE-PBX3A-001 payload with no contractors — exactly one new object, no links, visible in objects list and «Команды и объекты»', async () => {
  if (!process.env.E2E_DATABASE_URL) delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'obj1-empty-key';
  process.env.DB_MODE = process.env.E2E_DATABASE_URL ? 'postgres' : 'pglite';
  process.env.PGLITE_DIR = 'memory://';
  if (process.env.E2E_DATABASE_URL) process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
  const { migrate } = await import('../scripts/migrate');
  const { seed } = await import('../scripts/seed');
  const { createApp } = await import('../apps/backend/src/main');
  const { pool, one, rows } = await import('../apps/backend/src/db');
  await migrate();
  await seed();
  const tenant = (await one(pool, "SELECT id FROM tenants WHERE portal='demo.local'")).id;
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as any).port}`;
  try {
    const login = async (role: string) => ((await (await fetch(base + '/auth/mock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, key: 'obj1-empty-key' }) })).json()) as any);
    const deputy = await login('DEPUTY_DIRECTOR'), pm = await login('PROJECT_MANAGER');
    const before = (await one(pool, 'SELECT count(*)::int AS n FROM objects WHERE tenant_id=$1', [tenant])).n;
    const r = await fetch(base + '/objects', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + deputy.token }, body: JSON.stringify({ externalCode: 'LIVE-PBX3A-001', name: 'LIVE TEST — PBX-3A', address: 'г. Тест, ул. Проверочная, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.user.id, startDate: dt(0), plannedFinishDate: dt(90), contractValue: '0.00' }) });
    const o: any = await r.json();
    assert.equal(r.status, 201, JSON.stringify(o));
    assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM objects WHERE tenant_id=$1', [tenant])).n, before + 1);
    assert.equal((await rows(pool, 'SELECT 1 FROM object_contractors WHERE object_id=$1', [o.id])).length, 0);
    // visible in C01 source (snapshot) and selectable in «Команды и объекты»
    const list: any[] = (await (await fetch(base + '/objects', { headers: { Authorization: 'Bearer ' + deputy.token } })).json()) as any;
    assert.ok(list.some((x) => x.id === o.id));
    const teams: any = await (await fetch(base + '/function-teams/pto/overview', { headers: { Authorization: 'Bearer ' + deputy.token } })).json();
    assert.ok(JSON.stringify(teams).includes(o.id), 'new object appears in the teams overview');
  } finally {
    await app.close();
  }
});
