import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { roles, CURRENT_ASSIGNABLE_ROLES, INTERNAL_ASSIGNABLE_ROLES, LEGACY_ONLY_ROLES, Permission, hasPermission, canAccessDocumentation, canAccessSdoWorkspace, isPtoRole, isSdoRole, isConstructionControlRole } from '../packages/domain';
import { canAccessDocumentation as feCanAccessDocumentation, canAccessSdoWorkspace as feCanAccessSdo, canManageDocumentation, INTERNAL_CORE_ROLES, CURRENT_MOCK_SIGN_IN_ROLES, isInternalCoreRole } from '../apps/frontend/src/auth/internalRoles';

/**
 * PBX-2 corrective — Начальник ПТО / Начальник СК / Начальник СДО.
 * Storage set, current-vs-legacy lists, grant parity with the engineer role of
 * the same department, and DEPARTMENT_HEAD's unchanged legacy grants.
 * The three head roles carry the SAME operational bundle as PTO / CONSTRUCTION_CONTROL /
 * SDO (no cross-department authority, no ADMIN_USERS) until object responsibility exists.
 */

const allPermissions = Object.values(Permission);
const grantsOf = (role: any) => allPermissions.filter((p) => hasPermission(role, p)).sort();

test('role sets: storage set, current assignable, PBX-2 internal targets, legacy-only', () => {
  assert.deepEqual([...roles].sort(), ['ADMIN', 'CONSTRUCTION_CONTROL', 'CONSTRUCTION_CONTROL_HEAD', 'CONTRACTOR_VIEWER', 'DEPARTMENT_HEAD', 'DEPUTY_DIRECTOR', 'GENERAL_DIRECTOR', 'PROJECT_MANAGER', 'PTO', 'PTO_HEAD', 'SDO', 'SDO_HEAD', 'TECHNICAL_DIRECTOR']);
  assert.deepEqual([...INTERNAL_ASSIGNABLE_ROLES], ['GENERAL_DIRECTOR', 'DEPUTY_DIRECTOR', 'PROJECT_MANAGER', 'CONSTRUCTION_CONTROL', 'CONSTRUCTION_CONTROL_HEAD', 'PTO', 'PTO_HEAD', 'SDO', 'SDO_HEAD', 'ADMIN']);
  assert.deepEqual([...CURRENT_ASSIGNABLE_ROLES].sort(), [...INTERNAL_ASSIGNABLE_ROLES, 'CONTRACTOR_VIEWER'].sort());
  assert.deepEqual([...LEGACY_ONLY_ROLES].sort(), ['DEPARTMENT_HEAD', 'TECHNICAL_DIRECTOR']);
  for (const r of [...INTERNAL_ASSIGNABLE_ROLES, ...CURRENT_ASSIGNABLE_ROLES, ...LEGACY_ONLY_ROLES]) assert.ok((roles as readonly string[]).includes(r), r);
  // every stored role is either current-assignable or legacy-only; nothing is orphaned
  for (const r of roles) assert.ok((CURRENT_ASSIGNABLE_ROLES as readonly string[]).includes(r) || (LEGACY_ONLY_ROLES as readonly string[]).includes(r), r);
});

test('grant parity: each head role has EXACTLY the bundle of its department engineer role', () => {
  assert.deepEqual(grantsOf('PTO_HEAD'), grantsOf('PTO'));
  assert.deepEqual(grantsOf('SDO_HEAD'), grantsOf('SDO'));
  assert.deepEqual(grantsOf('CONSTRUCTION_CONTROL_HEAD'), grantsOf('CONSTRUCTION_CONTROL'));
});

test('no cross-department authority: heads get no ADMIN_USERS and none of another department\'s permissions', () => {
  const ownDepartment: Record<string, string> = { PTO_HEAD: 'PTO', SDO_HEAD: 'SDO', CONSTRUCTION_CONTROL_HEAD: 'CONSTRUCTION_CONTROL' };
  for (const head of Object.keys(ownDepartment)) {
    assert.equal(hasPermission(head as any, Permission.ADMIN_USERS), false, head);
    const others = ['PTO', 'SDO', 'CONSTRUCTION_CONTROL'].filter((r) => r !== ownDepartment[head]);
    const own = new Set(grantsOf(ownDepartment[head]));
    for (const other of others) for (const p of grantsOf(other)) if (!own.has(p)) assert.equal(hasPermission(head as any, p), false, `${head} must not hold ${p} of ${other}`);
  }
  // DEPUTY_DIRECTOR is oversight, not an operational PTO / SDO / SC role
  for (const p of [Permission.PTO_EDIT, Permission.DOCUMENTATION_MANAGE, Permission.SDO_EDIT, Permission.SDO_CLOSE, Permission.SDO_CASE_MANAGE, Permission.INSPECTION_ACCEPT, Permission.ISSUE_VERIFY]) assert.equal(hasPermission('DEPUTY_DIRECTOR', p), false, p);
});

test('DEPARTMENT_HEAD keeps its previous grants exactly (read-only view bundle); TECHNICAL_DIRECTOR untouched', () => {
  assert.deepEqual(grantsOf('DEPARTMENT_HEAD'), grantsOf('GENERAL_DIRECTOR'));
  assert.equal(hasPermission('DEPARTMENT_HEAD', Permission.OBJECT_VIEW), true);
  for (const p of [Permission.OBJECT_CREATE, Permission.PTO_EDIT, Permission.SDO_EDIT, Permission.INSPECTION_ACCEPT, Permission.ADMIN_USERS, Permission.DOCUMENTATION_MANAGE]) assert.equal(hasPermission('DEPARTMENT_HEAD', p), false, p);
  assert.ok(hasPermission('TECHNICAL_DIRECTOR', Permission.OBJECT_CREATE));
  assert.equal(hasPermission('TECHNICAL_DIRECTOR', Permission.PTO_EDIT), false);
});

test('documentation / SDO workspace predicates: heads mirror the engineer role, backend and frontend agree for every role', () => {
  assert.equal(canAccessDocumentation('PTO_HEAD'), true);
  assert.equal(canAccessDocumentation('SDO_HEAD'), false, 'SDO exclusion from PTO documentation applies to SDO_HEAD too');
  assert.equal(canAccessDocumentation('SDO'), false);
  assert.equal(canAccessDocumentation('CONSTRUCTION_CONTROL_HEAD'), true);
  assert.equal(canAccessSdoWorkspace('SDO_HEAD'), true);
  for (const r of ['PTO_HEAD', 'PTO', 'CONSTRUCTION_CONTROL_HEAD', 'DEPARTMENT_HEAD', 'DEPUTY_DIRECTOR']) assert.equal(canAccessSdoWorkspace(r as any), false, r);
  for (const role of roles) {
    assert.equal(feCanAccessDocumentation(role), canAccessDocumentation(role), 'documentation ' + role);
    assert.equal(feCanAccessSdo(role), canAccessSdoWorkspace(role), 'sdo workspace ' + role);
    assert.equal(canManageDocumentation(role), hasPermission(role, Permission.DOCUMENTATION_MANAGE), 'manage ' + role);
  }
  assert.ok(isPtoRole('PTO_HEAD') && isPtoRole('PTO') && !isPtoRole('SDO_HEAD') && !isPtoRole('ADMIN'));
  assert.ok(isSdoRole('SDO_HEAD') && isSdoRole('SDO') && !isSdoRole('PTO_HEAD'));
  assert.ok(isConstructionControlRole('CONSTRUCTION_CONTROL_HEAD') && !isConstructionControlRole('PTO'));
});

test('frontend classification: heads are internal, legacy roles still recognised, mock sign-in offers neither legacy role', () => {
  for (const r of ['PTO_HEAD', 'CONSTRUCTION_CONTROL_HEAD', 'SDO_HEAD', 'TECHNICAL_DIRECTOR', 'DEPARTMENT_HEAD']) assert.equal(isInternalCoreRole(r), true, r);
  assert.equal(isInternalCoreRole('CONTRACTOR_VIEWER'), false);
  for (const r of roles) assert.equal((INTERNAL_CORE_ROLES as readonly string[]).includes(r), r !== 'CONTRACTOR_VIEWER', r);
  assert.deepEqual([...CURRENT_MOCK_SIGN_IN_ROLES].sort(), [...INTERNAL_ASSIGNABLE_ROLES].sort());
});

test('role-sensitive backend sites recognise the heads (static guard against a stale literal role check)', () => {
  const service = fs.readFileSync('apps/backend/src/service.ts', 'utf8');
  assert.doesNotMatch(service, /responsible\.role === 'PTO'/);
  assert.doesNotMatch(service, /responsible\.role === 'SDO'/);
  assert.doesNotMatch(service, /a\.role !== 'PTO'/);
  const attachments = fs.readFileSync('apps/backend/src/modules/attachments/attachments.controller.ts', 'utf8');
  for (const r of ['PTO_HEAD', 'CONSTRUCTION_CONTROL_HEAD']) assert.match(attachments, new RegExp(r));
  assert.doesNotMatch(attachments, /SDO_HEAD/);
});

test('HTTP (mock auth): heads behave like their department role; legacy POST /users refuses legacy roles', async () => {
  delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'pbx2-heads-key';
  process.env.DB_MODE = 'pglite';
  process.env.PGLITE_DIR = 'memory://';
  const { migrate } = await import('../scripts/migrate');
  const { seed } = await import('../scripts/seed');
  const { createApp } = await import('../apps/backend/src/main');
  await migrate();
  await seed();
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as any).port}`;
  const dt = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
  const tokens: Record<string, string> = {};
  const users: Record<string, any> = {};
  const call = async (method: string, path: string, token: string, body?: any) => {
    const r = await fetch(base + '/' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let data: any; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };
  const login = async (role: string) => {
    const r = await fetch(base + '/auth/mock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, key: 'pbx2-heads-key' }) });
    assert.equal(r.status, 201, 'mock login ' + role);
    const d: any = await r.json();
    tokens[role] = d.token; users[role] = d.user;
    return d.token as string;
  };
  try {
    for (const r of ['ADMIN', 'PROJECT_MANAGER', 'TECHNICAL_DIRECTOR', 'PTO', 'PTO_HEAD', 'SDO', 'SDO_HEAD', 'CONSTRUCTION_CONTROL', 'CONSTRUCTION_CONTROL_HEAD', 'DEPARTMENT_HEAD']) await login(r);
    for (const r of ['PTO_HEAD', 'SDO_HEAD', 'CONSTRUCTION_CONTROL_HEAD']) assert.equal(users[r].role, r);

    const dict = (await call('GET', 'dictionaries', tokens.PROJECT_MANAGER)).data;
    const contractors = (await call('GET', 'contractors', tokens.PROJECT_MANAGER)).data;
    const object = (await call('POST', 'objects', tokens.TECHNICAL_DIRECTOR, { externalCode: 'HEADS-' + Date.now(), name: 'Head roles', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: users.PROJECT_MANAGER.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] })).data;
    const mkWork = async (name: string) => (await call('POST', 'works', tokens.PROJECT_MANAGER, { objectId: object.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: users.PROJECT_MANAGER.id, name, unit: 'м²', plannedQuantity: 100, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '20000' })).data;
    const workA = await mkWork('Работа A'), workB = await mkWork('Работа B');

    // --- PTO parity: PTO and PTO_HEAD run the same documentation operations with the same statuses ---
    for (const [role, work] of [['PTO', workA], ['PTO_HEAD', workB]] as const) {
      const pkg = await call('POST', 'documentation-packages', tokens[role], { objectWorkId: work.id, responsibleUserId: users[role].id });
      assert.equal(pkg.status, 201, role + ' create package (self as responsible): ' + JSON.stringify(pkg.data));
      const doc = await call('POST', `documentation-packages/${pkg.data.id}/documents`, tokens[role], { type: 'AOSR' });
      assert.equal(doc.status, 201, role);
      assert.equal((await call('POST', `documentation-documents/${doc.data.id}/versions`, tokens[role], { storageProvider: 'NONE' })).status, 201, role);
      assert.equal((await call('POST', `documentation-packages/${pkg.data.id}/status`, tokens[role], { status: 'PREPARING', version: pkg.data.version })).status, 201, role);
      assert.equal((await call('GET', 'documentation-packages', tokens[role])).status, 200, role);
      const snapshot = (await call('GET', 'snapshot', tokens[role])).data;
      assert.ok(snapshot.documentationPackages.some((p: any) => p.id === pkg.data.id), role);
    }
    // a PTO_HEAD is an accepted responsible engineer, and a PTO may be the responsible on a head's package
    const pkgB = (await call('GET', 'documentation-packages', tokens.PTO)).data.find((p: any) => p.objectWorkId === workB.id);
    assert.equal((await call('POST', `documentation-packages/${pkgB.id}/edit`, tokens.PTO_HEAD, { responsibleUserId: users.PTO.id, version: pkgB.version })).status, 201);
    assert.equal((await call('POST', `documentation-packages/${pkgB.id}/edit`, tokens.PTO, { responsibleUserId: users.PTO_HEAD.id, version: pkgB.version + 1 })).status, 201);
    // a non-PTO user is still not an acceptable responsible
    assert.equal((await call('POST', `documentation-packages/${pkgB.id}/edit`, tokens.PTO_HEAD, { responsibleUserId: users.SDO_HEAD.id, version: pkgB.version + 2 })).status, 400);

    // --- SDO parity: SDO and SDO_HEAD are excluded from documentation identically, and both reach the SDO contour ---
    for (const role of ['SDO', 'SDO_HEAD']) {
      const list = await call('GET', 'documentation-packages', tokens[role]);
      assert.equal(list.status, (await call('GET', 'documentation-packages', tokens.SDO)).status, role);
      assert.equal(list.status, 403, role);
      assert.equal((await call('GET', 'snapshot', tokens[role])).data.documentationPackages, undefined, role);
      assert.equal((await call('GET', 'sdo-closing-cases', tokens[role])).status, 200, role);
      assert.equal((await call('POST', 'documentation-packages', tokens[role], { objectWorkId: workA.id, responsibleUserId: users.PTO.id })).status, 403, role);
    }
    // --- construction control parity ---
    for (const role of ['CONSTRUCTION_CONTROL', 'CONSTRUCTION_CONTROL_HEAD']) {
      assert.equal((await call('GET', 'snapshot', tokens[role])).status, 200, role);
      assert.equal((await call('POST', 'documentation-packages', tokens[role], { objectWorkId: workA.id, responsibleUserId: users.PTO.id })).status, 403, role);
    }
    // an operational route the base role lacks is refused identically for the head (validation runs after the permission check there)
    const objectBody = { externalCode: 'X-' + Date.now(), name: 'n', address: 'a', organizationName: 'o', projectManagerId: users.PROJECT_MANAGER.id, startDate: dt(-1), plannedFinishDate: dt(5), contractValue: '1', contractorIds: [contractors[0].id] };
    assert.equal((await call('POST', 'objects', tokens.CONSTRUCTION_CONTROL, objectBody)).status, 403);
    assert.equal((await call('POST', 'objects', tokens.CONSTRUCTION_CONTROL_HEAD, objectBody)).status, 403);
    assert.equal((await call('POST', 'objects', tokens.PTO_HEAD, objectBody)).status, 403);
    assert.equal((await call('POST', 'objects', tokens.SDO_HEAD, objectBody)).status, 403);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=';
    const upload = async (role: string) => (await call('POST', 'attachments', tokens[role], { fileName: 'a.png', mimeType: 'image/png', base64: png })).status;
    assert.equal(await upload('PTO_HEAD'), await upload('PTO'));
    assert.equal(await upload('CONSTRUCTION_CONTROL_HEAD'), await upload('CONSTRUCTION_CONTROL'));
    assert.equal(await upload('SDO_HEAD'), await upload('SDO'));
    assert.notEqual(await upload('SDO_HEAD'), 201);
    // --- heads hold no administrator authority ---
    for (const role of ['PTO_HEAD', 'SDO_HEAD', 'CONSTRUCTION_CONTROL_HEAD', 'DEPARTMENT_HEAD']) {
      assert.equal((await call('GET', 'admin/users', tokens[role])).status, 403, role);
      assert.equal((await call('POST', 'users', tokens[role], { bitrixUserId: '901', name: 'X', role: 'PTO' })).status, 403, role);
    }
    // --- existing DEPARTMENT_HEAD keeps authenticating with its previous (view-only) grants ---
    assert.equal((await call('GET', 'me', tokens.DEPARTMENT_HEAD)).data.role, 'DEPARTMENT_HEAD');
    assert.equal((await call('GET', 'snapshot', tokens.DEPARTMENT_HEAD)).status, 200);
    assert.equal((await call('POST', 'objects', tokens.DEPARTMENT_HEAD, objectBody)).status, 403);
    assert.equal((await call('POST', 'documentation-packages', tokens.DEPARTMENT_HEAD, { objectWorkId: workA.id, responsibleUserId: users.PTO.id })).status, 403);

    // --- general POST /users: current heads yes; legacy roles no; external path untouched ---
    let n = 910;
    const add = (role: string, extra: any = {}) => call('POST', 'users', tokens.ADMIN, { bitrixUserId: String(n++), name: 'Тест ' + role, role, ...extra });
    for (const role of ['PTO_HEAD', 'CONSTRUCTION_CONTROL_HEAD', 'SDO_HEAD']) assert.equal((await add(role)).status, 201, role);
    for (const role of ['TECHNICAL_DIRECTOR', 'DEPARTMENT_HEAD']) assert.equal((await add(role)).status, 400, role);
    const noContractor = await add('CONTRACTOR_VIEWER');
    assert.equal(noContractor.status, 400);
    assert.match(noContractor.data.message, /подрядчика/, 'CONTRACTOR_VIEWER still reaches its own contractor rule');
    assert.equal((await add('CONTRACTOR_VIEWER', { contractorId: contractors[0].id })).status, 201);
  } finally {
    await app.close();
  }
});
