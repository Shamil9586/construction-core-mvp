import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// F12.2 Contractor Participation Integrity (F12-D03, locked): there is no normal
// business operation "remove contractor from object after participation".
// removeContractor()/POST /objects/:id/contractors/:contractorId/remove is
// retired outright, not replaced by any active/inactive toggle — once assigned,
// an object_contractors relation is permanent, historically-attributable
// participation. object_contractors_active (removed_at IS NULL) and its existing
// read consumers (objectAccess, CONTRACTOR_VIEWER filtering, GET .../contractors,
// createWork/createExecutionUnit eligibility) are UNCHANGED by this phase — this
// file proves their semantics still hold for pre-existing (pre-F12.2) historical
// data, without ever mutating that historical data.
//
// Invariant under test: assign/duplicate-guard/RBAC on assignContractor() remain
// exactly as before; the retired route is unreachable (a generic infrastructure
// 404, never a business rejection) for every role that used to be able to call
// it; attempting it has zero side effects (no removed_at/removed_by mutation, no
// REMOVE audit event, no CONTRACTOR_VIEWER access revocation); and a fixture row
// representing an already-historically-removed relation reads exactly as the
// active-only read model already promised, and does not block a fresh
// reassignment of the same contractor.
test('F12.2: removeContractor retired — assignment/RBAC intact, retired route unreachable with zero side effects, historical data compatibility preserved', async () => {
    if (!process.env.E2E_DATABASE_URL) delete process.env.DATABASE_URL;
    process.env.AUTH_MODE = 'mock';
    process.env.MOCK_LOGIN_KEY = 'core-2-1-key';
    process.env.DB_MODE = process.env.E2E_DATABASE_URL ? 'postgres' : 'pglite';
    process.env.PGLITE_DIR = 'memory://';
    if (process.env.E2E_DATABASE_URL) {
        if (!new URL(process.env.E2E_DATABASE_URL).pathname.endsWith('_test'))
            throw Error('E2E database name must end with _test');
        process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
    }
    const { pool, insert, one, rows } = await import('../apps/backend/src/db');
    const { seed } = await import('../scripts/seed');
    const { createApp } = await import('../apps/backend/src/main');
    const { migrate } = await import('../scripts/migrate');
    await migrate();
    await seed();
    const app = await createApp();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    const base = `http://127.0.0.1:${address.port}`;
    let token = '';
    async function req(path: string, body?: any, expected = body === undefined ? 200 : 201) { const r = await fetch(base + '/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) }); const data: any = await r.json(); assert.equal(r.status, expected, path + ': ' + JSON.stringify(data)); return data; }
    async function asDeputy<T>(fn: () => Promise<T>): Promise<T> { const prev = token; await login('DEPUTY_DIRECTOR'); try { return await fn(); } finally { token = prev; } } // OBJ-1: object creation is Deputy/Admin authority; fixture only, the test's subject role is restored
    async function login(role: string) { const d = await req('auth/mock', { role, key: 'core-2-1-key' }); token = d.token; return d.user; }
    const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);
    try {
        const pm = await login('PROJECT_MANAGER');
        const seedContractors = await req('contractors');
        const placeholder = seedContractors[0];
        await login('ADMIN');
        const target = await req('contractors', { name: 'F12.2 target contractor ' + randomUUID() });
        // bitrixUserId '0' sorts before seed's CONTRACTOR_VIEWER ('9') in auth/mock's
        // ORDER BY bitrix_user_id LIMIT 1, so login('CONTRACTOR_VIEWER') below picks
        // this user — tied to `target` — instead of the seeded demo contractor viewer.
        await req('users', { bitrixUserId: '0', name: 'F12.2 CONTRACTOR_VIEWER', role: 'CONTRACTOR_VIEWER', contractorId: target.id });
        await login('PROJECT_MANAGER');
        const o = await asDeputy(() => req('objects', { externalCode: 'F12.2-' + randomUUID(), name: 'F12.2 объект', address: 'Тестовая, 122', organizationName: 'ООО Тест', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [placeholder.id] }));
        const oHist = await asDeputy(() => req('objects', { externalCode: 'F12.2-HIST-' + randomUUID(), name: 'F12.2 объект (историческая запись)', address: 'Тестовая, 123', organizationName: 'ООО Тест', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [placeholder.id] }));

        // --- assignContractor(): unchanged — active relation, removedAt=null ---
        const relation = await req(`objects/${o.id}/contractors`, { contractorId: target.id });
        assert.equal(relation.objectId, o.id);
        assert.equal(relation.contractorId, target.id);
        assert.equal(relation.removedAt, null);

        // Duplicate active relation -> 409 (object_contractors_active_unique / explicit check), unchanged
        await req(`objects/${o.id}/contractors`, { contractorId: target.id }, 409);

        // RBAC: OBJECT_MANAGE_CONTRACTORS required, not OBJECT_EDIT/others — unchanged
        await login('CONSTRUCTION_CONTROL');
        await req(`objects/${o.id}/contractors`, { contractorId: placeholder.id }, 403);
        await login('PROJECT_MANAGER');

        // Unknown/foreign object id -> 404 through objectAccess/scoped — unchanged
        await req(`objects/${randomUUID()}/contractors`, { contractorId: target.id }, 404);

        // --- Historical fixture: a row representing participation that was already
        // removed BEFORE this phase (Core 2.1 history), inserted directly — never
        // through any live endpoint, since none can produce this state any more.
        // `target` deliberately has no active relation on `oHist` yet. ---
        await login('ADMIN');
        const historicalRelation = await insert(pool, 'object_contractors', pm.tenantId, { objectId: oHist.id, contractorId: target.id, removedAt: new Date(), removedBy: pm.id });
        await login('PROJECT_MANAGER');

        // --- CONTRACTOR_VIEWER (tied to `target`): active relation on `o` grants
        // access on every object-level path objectAccess() gates; the historical-only
        // relation on `oHist` grants none — today's unchanged read semantics. ---
        await login('CONTRACTOR_VIEWER');
        await req(`objects/${o.id}`);
        await req(`objects/${o.id}/works`);
        await req(`objects/${oHist.id}`, undefined, 403);
        await login('PROJECT_MANAGER');

        // ==================================================================
        // F12-AUTH-01: the retired route must be unreachable — a generic
        // infrastructure 404 ("Cannot POST ..."), never a business rejection —
        // for every role that used to hold OBJECT_MANAGE_CONTRACTORS.
        // ==================================================================
        for (const role of ['PROJECT_MANAGER', 'ADMIN', 'TECHNICAL_DIRECTOR']) {
            await login(role);
            const retired = await req(`objects/${o.id}/contractors/${target.id}/remove`, { relationId: relation.id, version: relation.version }, 404);
            assert.match(retired.message, /^Cannot POST \//, `role ${role}: retired route must be reported as absent/unreachable, not as a product-specific rejection`);
            assert.doesNotMatch(retired.message, /Активное назначение подрядчика не найдено/, `role ${role}: must not surface the old business 404`);
        }
        await login('PROJECT_MANAGER');
        // The 404 is a routing-level fact, independent of the ids/body supplied —
        // proving absence, not a data-dependent business decision.
        const retiredGarbage = await req(`objects/${randomUUID()}/contractors/${randomUUID()}/remove`, { relationId: randomUUID(), version: 1 }, 404);
        assert.match(retiredGarbage.message, /^Cannot POST \//);

        // --- No side effects from attempting the retired route: the active relation
        // used above is untouched, and no REMOVE audit event was produced. ---
        const relationRowAfter = await one(pool, 'SELECT * FROM object_contractors WHERE tenant_id=$1 AND id=$2', [pm.tenantId, relation.id]);
        assert.equal(relationRowAfter.removedAt, null, 'attempting the retired route must not set removed_at');
        assert.equal(relationRowAfter.removedBy, null, 'attempting the retired route must not set removed_by');
        assert.equal(relationRowAfter.version, relation.version, 'attempting the retired route must not advance the relation version');
        const removeAudits = await rows(pool, "SELECT id FROM audit_logs WHERE tenant_id=$1 AND entity_type='ObjectContractor' AND entity_id=$2 AND action='REMOVE'", [pm.tenantId, relation.id]);
        assert.equal(removeAudits.length, 0, 'attempting the retired route must not produce a REMOVE audit event');

        // ...and CONTRACTOR_VIEWER access on `o`, proven above, was never revoked.
        await login('CONTRACTOR_VIEWER');
        await req(`objects/${o.id}`);
        await req(`objects/${o.id}/works`);
        await login('PROJECT_MANAGER');

        // ==================================================================
        // Historical compatibility: every existing active-only read consumer
        // still excludes the pre-existing historically-removed row exactly as
        // before, and it never blocks a fresh reassignment of the same
        // contractor under existing duplicate-active-assignment semantics.
        // ==================================================================
        const listAfterFixture = await req('objects');
        assert.ok(!listAfterFixture.find((x: any) => x.id === oHist.id).contractorIds.includes(target.id), 'historically-removed relation excluded from active contractorIds projection');
        assert.ok(!(await req(`objects/${oHist.id}/contractors`)).some((r: any) => r.contractorId === target.id), 'GET .../contractors excludes the historically-removed relation');
        assert.equal(await one(pool, 'SELECT id FROM object_contractors_active WHERE tenant_id=$1 AND object_id=$2 AND contractor_id=$3', [pm.tenantId, oHist.id, target.id]), undefined, 'object_contractors_active view excludes the historically-removed relation');

        // A fresh assignment for the same contractor is still allowed — the
        // active-only duplicate guard never sees the historical row.
        const reassigned = await req(`objects/${oHist.id}/contractors`, { contractorId: target.id });
        assert.notEqual(reassigned.id, historicalRelation.id, 'fresh assignment creates a new relation row, never resurrecting the historical one');
        assert.equal(reassigned.removedAt, null);

        await login('CONTRACTOR_VIEWER');
        await req(`objects/${oHist.id}`); // now 200 — a real active relation exists
        await login('PROJECT_MANAGER');

        // The historical row itself was read, never written, throughout all of the above.
        const historicalRowAfter = await one(pool, 'SELECT * FROM object_contractors WHERE tenant_id=$1 AND id=$2', [pm.tenantId, historicalRelation.id]);
        assert.equal(historicalRowAfter.version, historicalRelation.version, 'historical row version must not change');
        assert.equal(historicalRowAfter.removedBy, historicalRelation.removedBy, 'historical row removed_by must not change');
        assert.equal(new Date(historicalRowAfter.removedAt).getTime(), new Date(historicalRelation.removedAt).getTime(), 'historical row removed_at must not change');

        // --- F7: tenant isolation — assign/edit still deny a foreign tenant's
        // object/relation the same generic way (no tenant-B data leaked in the 404). ---
        const tenantB = await one(pool, "INSERT INTO tenants(portal,member_id,name) VALUES($1,$2,$3) RETURNING *", ['f12-2-tenant-b-' + randomUUID() + '.local', 'f12-2-tenant-b-' + randomUUID(), 'F12.2 Tenant B']);
        const pmB = await insert(pool, 'users', tenantB.id, { bitrixUserId: 'f12-2-tenant-b-pm', name: 'F12.2 Tenant B PM', role: 'PROJECT_MANAGER' });
        const contractorB = await insert(pool, 'contractors', tenantB.id, { name: 'F12.2 Tenant B contractor' });
        const objectB = await insert(pool, 'objects', tenantB.id, { externalCode: 'B-' + randomUUID(), name: 'F12.2 Tenant B объект', address: 'Tenant B, 1', organizationName: 'Tenant B Org', projectManagerId: pmB.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000' });

        // assign onto a foreign-tenant object -> denied, same generic not-found as any other missing record
        const assignCrossTenant = await req(`objects/${objectB.id}/contractors`, { contractorId: contractorB.id }, 404);
        assert.match(assignCrossTenant.message, /Запись не найдена/);
        // edit a foreign-tenant object -> denied
        const editCrossTenant = await req(`objects/${objectB.id}/edit`, { name: 'hijacked', version: objectB.version }, 404);
        assert.match(editCrossTenant.message, /Запись не найдена/);

        // --- Object Edit: restricted whitelist, partial (only version is required).
        // Unrelated to contractor participation — unchanged coverage of editObject(). ---
        const objectBefore = (await req(`objects/${o.id}`)).object;

        // projectManagerId's mere presence is gated for a non-privileged actor, not just
        // a value change: PM resubmitting their own current id still gets 403.
        await req(`objects/${o.id}/edit`, { name: objectBefore.name, projectManagerId: pm.id, version: objectBefore.version }, 403);

        const edited = await req(`objects/${o.id}/edit`, { name: 'F12.2 объект (переименован)', address: 'Тестовая, 122а', customerName: 'ООО Заказчик', plannedFinishDate: dt(90), version: objectBefore.version });
        assert.equal(edited.name, 'F12.2 объект (переименован)');
        assert.equal(edited.address, 'Тестовая, 122а');
        assert.equal(edited.plannedFinishDate, dt(90));
        assert.equal(edited.projectManagerId, pm.id, 'omitted projectManagerId leaves the existing PM unchanged');
        assert.equal(edited.version, objectBefore.version + 1);

        // Partial edit: a single field changes, every omitted field is preserved as-is
        const partial = await req(`objects/${o.id}/edit`, { customerName: 'ООО Заказчик 2', version: edited.version });
        assert.equal(partial.customerName, 'ООО Заказчик 2');
        assert.equal(partial.name, edited.name, 'omitted name preserved by partial edit');
        assert.equal(partial.address, edited.address, 'omitted address preserved by partial edit');
        assert.equal(partial.plannedFinishDate, edited.plannedFinishDate, 'omitted plannedFinishDate preserved by partial edit');

        // startDate is part of the restricted whitelist — partial edits on either date
        // alone, or both together, must respect the merged effective-date invariant.
        const startDateOnly = await req(`objects/${o.id}/edit`, { startDate: dt(-3), version: partial.version });
        assert.equal(startDateOnly.startDate, dt(-3));
        assert.equal(startDateOnly.plannedFinishDate, partial.plannedFinishDate, 'omitted plannedFinishDate preserved when only startDate changes');

        const finishDateOnly = await req(`objects/${o.id}/edit`, { plannedFinishDate: dt(95), version: startDateOnly.version });
        assert.equal(finishDateOnly.plannedFinishDate, dt(95));
        assert.equal(finishDateOnly.startDate, dt(-3), 'omitted startDate preserved when only plannedFinishDate changes');

        const bothDates = await req(`objects/${o.id}/edit`, { startDate: dt(-2), plannedFinishDate: dt(100), version: finishDateOnly.version });
        assert.equal(bothDates.startDate, dt(-2));
        assert.equal(bothDates.plannedFinishDate, dt(100));

        // New startDate later than the (omitted, existing) plannedFinishDate -> 400
        await req(`objects/${o.id}/edit`, { startDate: dt(200), version: bothDates.version }, 400);
        // New plannedFinishDate earlier than the (omitted, existing) startDate -> 400
        await req(`objects/${o.id}/edit`, { plannedFinishDate: dt(-10), version: bothDates.version }, 400);
        // A version-only body is a no-op edit — rejected, not silently accepted
        await req(`objects/${o.id}/edit`, { version: bothDates.version }, 400);
        // An unknown field is rejected by .strict(), same as contractValue/status below
        await req(`objects/${o.id}/edit`, { name: bothDates.name, version: bothDates.version, unknownField: 'x' }, 400);

        // contractValue/status are not in the whitelist — .strict() rejects them outright
        await req(`objects/${o.id}/edit`, { name: bothDates.name, version: bothDates.version, contractValue: '1' }, 400);
        await req(`objects/${o.id}/edit`, { name: bothDates.name, version: bothDates.version, status: 'ARCHIVED' }, 400);

        // PROJECT_MANAGER cannot reassign projectManagerId, even on their own object —
        // presence of the key is what's rejected (403), regardless of the value inside
        const users = await req('users');
        const otherPm = users.find((u: any) => u.role === 'PROJECT_MANAGER' && u.id !== pm.id);
        await req(`objects/${o.id}/edit`, { projectManagerId: otherPm.id, version: bothDates.version }, 403);

        // TECHNICAL_DIRECTOR can reassign it
        await login('TECHNICAL_DIRECTOR');
        const reassignedPm = await req(`objects/${o.id}/edit`, { projectManagerId: otherPm.id, version: bothDates.version });
        assert.equal(reassignedPm.projectManagerId, otherPm.id);
        assert.equal(reassignedPm.name, bothDates.name, 'omitted fields preserved on a privileged partial edit too');
        assert.equal(reassignedPm.startDate, bothDates.startDate, 'omitted startDate preserved on a privileged partial edit too');

        // Stale version -> 409 (checkVersion, same convention as every other mutating endpoint)
        await req(`objects/${o.id}/edit`, { projectManagerId: otherPm.id, version: bothDates.version }, 409);

        console.log('F12.2 VERIFIED: assign/duplicate-guard/RBAC intact, retired remove route unreachable with zero side effects, historical-row read semantics unchanged and never mutated, restricted Object Edit');
    }
    finally {
        await app.close();
        await pool.end();
    }
});
