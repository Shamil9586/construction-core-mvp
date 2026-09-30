import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * F12.3 LOCKED DECISION 1: DEPUTY_DIRECTOR ("Заместитель директора") is the
 * canonical current managerial role — one person over both the construction
 * contour (RP/SK) and the technical contour (PTO/SDO), with exactly the
 * managerial grant (company/object/work visibility + object/work
 * management, incl. object creation) and none of PTO/SDO/Construction Control's
 * operational mutation rights.
 *
 * Against baseline 9ce729b99014c0e39817f1acf5a31cdcc326444b every assertion
 * below fails, because the role does not exist at all yet: `roles`/`grants`
 * (packages/domain) have no DEPUTY_DIRECTOR entry, the DB's users.role CHECK
 * constraint rejects the value outright, and no such role is offered by any
 * UI/mock/seed/admin path.
 */
test('hasPermission(DEPUTY_DIRECTOR): exactly the managerial grant, no PTO/SDO/Construction-Control operational permission', async () => {
  const { hasPermission, Permission } = await import('../packages/domain');
  // Positive: the managerial bundle.
  for (const p of [Permission.OBJECT_VIEW, Permission.WORK_VIEW, Permission.PTO_VIEW, Permission.SDO_VIEW, Permission.FINANCE_VIEW, Permission.OBJECT_CREATE, Permission.OBJECT_EDIT, Permission.OBJECT_MANAGE_CONTRACTORS, Permission.WORK_CREATE, Permission.EXECUTION_UNIT_MANAGE])
    assert.equal(hasPermission('DEPUTY_DIRECTOR' as any, p), true, `DEPUTY_DIRECTOR must hold ${p}`);
  // Negative: no impersonation of PTO/SDO/Construction Control operational actions.
  for (const p of [Permission.DOCUMENTATION_MANAGE, Permission.PTO_EDIT, Permission.PTO_TRANSFER_SDO, Permission.SDO_CASE_MANAGE, Permission.SDO_EDIT, Permission.SDO_CLOSE, Permission.FINANCE_EDIT, Permission.INSPECTION_ACCEPT, Permission.INSPECTION_REJECT, Permission.ISSUE_CREATE, Permission.ISSUE_VERIFY, Permission.WORK_UPDATE_PROGRESS, Permission.INSPECTION_REQUEST, Permission.ISSUE_RESOLVE, Permission.ADMIN_USERS, Permission.ADMIN_DICTIONARIES])
    assert.equal(hasPermission('DEPUTY_DIRECTOR' as any, p), false, `DEPUTY_DIRECTOR must NOT hold ${p}`);
  // ROLE-CLEANUP: the removed legacy roles hold nothing (they are not in the role model at all).
  const { roles } = await import('../packages/domain');
  for (const removed of ['TECHNICAL_DIRECTOR', 'DEPARTMENT_HEAD', 'CONSTRUCTION_DIRECTOR', 'DoC']) {
    assert.equal((roles as readonly string[]).includes(removed), false, removed);
    assert.equal(hasPermission(removed as any, Permission.OBJECT_EDIT), false, removed);
  }
});

test('F12.3: DEPUTY_DIRECTOR performs manager operations and company/object visibility, but cannot perform PTO/SDO/SC operational mutations', async () => {
  if (!process.env.E2E_DATABASE_URL) delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'f12-deputy-director-key';
  process.env.DB_MODE = process.env.E2E_DATABASE_URL ? 'postgres' : 'pglite';
  process.env.PGLITE_DIR = 'memory://';
  if (process.env.E2E_DATABASE_URL) process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;

  const { migrate } = await import('../scripts/migrate');
  const { seed } = await import('../scripts/seed');
  const { createApp } = await import('../apps/backend/src/main');
  await migrate();
  await seed();
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const base = `http://127.0.0.1:${address.port}`;
  let token = '';
  async function req(path: string, body?: any, expected = body === undefined ? 200 : 201) {
    const r = await fetch(base + '/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data: any = await r.json();
    assert.equal(r.status, expected, path + ': ' + JSON.stringify(data));
    return data;
  }
  async function asDeputy<T>(fn: () => Promise<T>): Promise<T> { const prev = token; await login('DEPUTY_DIRECTOR'); try { return await fn(); } finally { token = prev; } } // OBJ-1: object creation is Deputy/Admin authority; fixture only, the test's subject role is restored
  async function login(role: string) {
    const d = await req('auth/mock', { role, key: 'f12-deputy-director-key' });
    token = d.token;
    return d.user;
  }
  const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);

  try {
    const pm = await login('PROJECT_MANAGER');
    const contractors = await req('contractors'), dict = await req('dictionaries');

    const deputy = await login('DEPUTY_DIRECTOR');
    assert.equal(deputy.role, 'DEPUTY_DIRECTOR');

    // ---- manager operations: object/work creation, PM reassignment ----
    const o = await asDeputy(() => req('objects', { externalCode: 'F12-DD-' + randomUUID(), name: 'F12 Deputy Director', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] }));
    const work = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Работа ЗД', unit: 'м²', plannedQuantity: 50, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '10000' });
    await req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 50 });
    const otherPm = (await req('users')).find((u: any) => u.role === 'PROJECT_MANAGER' && u.id !== pm.id);
    const edited = await req(`objects/${o.id}/edit`, { projectManagerId: otherPm.id, version: o.version });
    assert.equal(edited.projectManagerId, otherPm.id, 'DEPUTY_DIRECTOR must be able to reassign the project manager');

    // ---- company/object visibility across both contours ----
    const snapshot = await req('snapshot');
    assert.ok(snapshot.objects.some((x: any) => x.id === o.id));
    await req('audit');

    // ---- no impersonation of PTO/SDO/Construction Control operational actions ----
    // requirePermission() is always the first line of the target service
    // method (before any DB lookup of the id in the path), so a syntactically
    // valid but nonexistent id is enough to probe the permission boundary
    // itself — the request must never get far enough to even look, let alone
    // report "not found" (which would leak whether ISSUE_CREATE-gated
    // business logic ran) instead of "forbidden".
    const nowhere = randomUUID();
    await req('documentation-packages', { objectWorkId: work.id, responsibleUserId: pm.id }, 403); // DOCUMENTATION_MANAGE (PTO)
    await req('executive-packages', { objectWorkId: work.id }, 403); // PTO_EDIT (PTO)
    await req(`works/${work.id}/inspection-request`, { version: 1 }, 403); // INSPECTION_REQUEST
    await req(`inspections/${nowhere}/accept`, { version: 1, comment: 'ЗД пытается принять' }, 403); // INSPECTION_ACCEPT (SK)
    await req(`inspections/${nowhere}/issues`, { version: 1, title: 'x', severity: 'LOW', responsibleUserId: pm.id, dueDate: dt(1) }, 403); // ISSUE_CREATE (SK)
    await req(`sdo-closing-cases/${nowhere}/status`, { status: 'VERIFICATION_PASSED', version: 1 }, 403); // SDO_CASE_MANAGE (SDO)

    // ---- ROLE-CLEANUP: removed roles can neither authenticate nor be newly assigned ----
    for (const removed of ['TECHNICAL_DIRECTOR', 'DEPARTMENT_HEAD']) {
      const r = await fetch(base + '/auth/mock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: removed, key: 'f12-deputy-director-key' }) });
      assert.ok(r.status >= 400 && r.status < 500, removed + ' rejected by auth/mock');
    }
    await login('ADMIN');
    assert.equal((await req('users')).some((u: any) => u.role === 'TECHNICAL_DIRECTOR' || u.role === 'DEPARTMENT_HEAD'), false, 'seed carries no removed-role user');
    // bitrixUserId must be digits-only (validation.ts) but otherwise arbitrary;
    // minted from the clock because seed() reuses the same persistent demo tenant
    // on every call against a real Postgres DB (E2E_DATABASE_URL).
    const freshBitrixId = () => String(Date.now()) + String(Math.floor(Math.random() * 1000)).padStart(3, '0');
    for (const removed of ['TECHNICAL_DIRECTOR', 'DEPARTMENT_HEAD']) {
      const rejectedNew = await req('users', { bitrixUserId: freshBitrixId(), name: 'Удалённая роль', role: removed }, 400);
      const message = String(rejectedNew.message);
      assert.match(message, /role/i, 'rejection must be a role-validation failure');
      assert.doesNotMatch(message, new RegExp(`"${removed}"`), removed + ' must not be offered as an assignable role choice');
      assert.match(message, /"DEPUTY_DIRECTOR"/, 'DEPUTY_DIRECTOR must be offered as an assignable role choice');
    }
    const newDeputy = await req('users', { bitrixUserId: freshBitrixId(), name: 'Новый Заместитель', role: 'DEPUTY_DIRECTOR' });
    assert.equal(newDeputy.role, 'DEPUTY_DIRECTOR', 'ADMIN must be able to create a new DEPUTY_DIRECTOR user through the normal assignment path');

    console.log('F12.3 VERIFIED: DEPUTY_DIRECTOR has manager/visibility permissions without PTO/SDO/SC operational access; POST /users offers DEPUTY_DIRECTOR for new assignment and refuses removed roles');
  } finally {
    await app.close();
  }
});
