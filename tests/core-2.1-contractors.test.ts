import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Core 2.1: history-aware contractor management (docs/core-2.1-architecture-plan.md).
// Invariant under test: active object_contractors (removed_at IS NULL) = who is
// currently assigned to the object and has related access; works.contractor_id =
// who historically/actually performed a specific work. Soft-remove never touches
// historical works, and re-assigning the same contractor after a remove creates a
// new active relation while the removed one stays as permanent history.
test('Core 2.1: contractor management (assign/remove/reassign), active read model, CONTRACTOR_VIEWER security ripple, Object Edit', async () => {
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
    const { pool } = await import('../apps/backend/src/db');
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
    async function login(role: string) { const d = await req('auth/mock', { role, key: 'core-2-1-key' }); token = d.token; return d.user; }
    const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);
    try {
        const pm = await login('PROJECT_MANAGER');
        const seedContractors = await req('contractors'), dict = await req('dictionaries');
        const placeholder = seedContractors[0];
        await login('ADMIN');
        const target = await req('contractors', { name: 'Core 2.1 target contractor ' + randomUUID() });
        const target2 = await req('contractors', { name: 'Core 2.1 blocked-remove contractor ' + randomUUID() });
        // bitrixUserId '0' sorts before seed's CONTRACTOR_VIEWER ('9') in auth/mock's
        // ORDER BY bitrix_user_id LIMIT 1, so login('CONTRACTOR_VIEWER') below picks this
        // user — tied to `target` — instead of the seeded demo contractor viewer.
        await req('users', { bitrixUserId: '0', name: 'Core 2.1 CONTRACTOR_VIEWER', role: 'CONTRACTOR_VIEWER', contractorId: target.id });
        await login('PROJECT_MANAGER');
        const o = await req('objects', { externalCode: 'C21-' + randomUUID(), name: 'Core 2.1 объект', address: 'Тестовая, 21', organizationName: 'ООО Тест', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [placeholder.id] });

        // Assign: success, active relation with removedAt=null
        const relation = await req(`objects/${o.id}/contractors`, { contractorId: target.id });
        assert.equal(relation.objectId, o.id);
        assert.equal(relation.contractorId, target.id);
        assert.equal(relation.removedAt, null);

        // Assign: duplicate active relation -> 400 (ensure()-based business-rule rejection,
        // same convention as every other "already in this state" check in service.ts —
        // e.g. "Пакет уже передан" — 409 is reserved for checkVersion()/raw DB conflicts)
        await req(`objects/${o.id}/contractors`, { contractorId: target.id }, 400);

        // RBAC: OBJECT_MANAGE_CONTRACTORS required, not OBJECT_EDIT/others
        await login('CONSTRUCTION_CONTROL');
        await req(`objects/${o.id}/contractors`, { contractorId: placeholder.id }, 403);
        await login('PROJECT_MANAGER');

        // Unknown/foreign object id -> 404 through objectAccess/scoped (same path as tenant isolation elsewhere)
        await req(`objects/${randomUUID()}/contractors`, { contractorId: target.id }, 404);

        // Second active relation, used only to prove the active-work removal guard.
        const relation2 = await req(`objects/${o.id}/contractors`, { contractorId: target2.id });

        // Work for `target`, driven to COMPLETED — its historical presence must not
        // block removing `target`'s assignment, and must survive the remove untouched.
        const work = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: target.id, responsibleUserId: pm.id, name: 'Core 2.1 работа подрядчика', unit: 'т', plannedQuantity: 10, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '100000' });
        const completedWork = await req(`works/${work.id}/progress`, { totalQuantity: 10, version: work.version, comment: 'Завершено для теста remove' });
        assert.equal(completedWork.status, 'COMPLETED');

        // Work for `target2` left ACTIVE (not COMPLETED) — its presence must block removal.
        const blockingWork = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: target2.id, responsibleUserId: pm.id, name: 'Core 2.1 незавершённая работа', unit: 'т', plannedQuantity: 10, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '100000' });
        await req(`works/${blockingWork.id}/progress`, { totalQuantity: 5, version: blockingWork.version, comment: 'В процессе' });

        // --- BEFORE remove: CONTRACTOR_VIEWER (tied to `target`) has full access on every work read path ---
        await login('CONTRACTOR_VIEWER');
        await req(`objects/${o.id}`);
        await req(`objects/${o.id}/works`);
        await req(`works/${work.id}`);
        await req(`works/${work.id}/progress`);
        await req(`works/${work.id}/transition`);
        let snap = await req('snapshot');
        assert.ok(snap.objects.some((x: any) => x.id === o.id), 'object visible before remove');
        assert.ok(snap.works.some((w: any) => w.id === work.id), 'work visible before remove');
        await login('PROJECT_MANAGER');

        // --- Active-work guard blocks target2; target (only a COMPLETED work) can be removed ---
        await req(`objects/${o.id}/contractors/${target2.id}/remove`, { version: relation2.version }, 400);
        const removed = await req(`objects/${o.id}/contractors/${target.id}/remove`, { version: relation.version });
        assert.ok(removed.removedAt);
        assert.equal(removed.removedBy, pm.id);

        // works.contractor_id must be unchanged by the remove (checked via PM, whose own
        // access is via project_manager_id and unaffected by the contractor removal)
        const workAfterRemove = await req(`works/${work.id}`);
        assert.equal(workAfterRemove.contractorId, target.id, 'historical work retains its contractor after soft-remove');

        // --- AFTER remove: CONTRACTOR_VIEWER (target) loses access on every one of the same paths ---
        await login('CONTRACTOR_VIEWER');
        await req(`objects/${o.id}`, undefined, 403);
        await req(`objects/${o.id}/works`, undefined, 403);
        await req(`works/${work.id}`, undefined, 403);
        await req(`works/${work.id}/progress`, undefined, 403);
        await req(`works/${work.id}/transition`, undefined, 403);
        snap = await req('snapshot');
        assert.ok(!snap.objects.some((x: any) => x.id === o.id), 'object hidden from snapshot after remove');
        assert.ok(!snap.works.some((w: any) => w.id === work.id), 'work hidden from snapshot after remove');
        await login('PROJECT_MANAGER');

        // --- Repeat remove of an already-removed relation -> 404 with a distinct message; history untouched ---
        const repeat = await req(`objects/${o.id}/contractors/${target.id}/remove`, { version: removed.version }, 404);
        assert.match(repeat.message, /Активное назначение подрядчика не найдено/);
        const genericNotFound = await req(`objects/${randomUUID()}`, undefined, 404);
        assert.match(genericNotFound.message, /Запись не найдена/);
        assert.notEqual(repeat.message, genericNotFound.message);

        // --- Reassign: creates a NEW active relation; the removed row stays as permanent history ---
        const reassigned = await req(`objects/${o.id}/contractors`, { contractorId: target.id });
        assert.notEqual(reassigned.id, relation.id, 'reassign creates a new relation row, not resurrecting the old one');
        assert.equal(reassigned.removedAt, null);

        await login('CONTRACTOR_VIEWER');
        await req(`objects/${o.id}`);
        await req(`objects/${o.id}/works`);
        await req(`works/${work.id}`);
        await req(`works/${work.id}/progress`);
        await req(`works/${work.id}/transition`);
        snap = await req('snapshot');
        assert.ok(snap.objects.some((x: any) => x.id === o.id), 'object visible again after reassign');
        assert.ok(snap.works.some((w: any) => w.id === work.id), 'work visible again after reassign');
        await login('PROJECT_MANAGER');

        const workAfterReassign = await req(`works/${work.id}`);
        assert.equal(workAfterReassign.contractorId, target.id, 'works.contractor_id unaffected by the whole remove/reassign cycle');

        console.log('CORE 2.1 VERIFIED (partial): assign, remove (+active-work guard, +404 repeat), reassign, CONTRACTOR_VIEWER work-access ripple');
    }
    finally {
        await app.close();
        await pool.end();
    }
});
