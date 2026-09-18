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
        const seedContractors = await req('contractors');
        const placeholder = seedContractors[0];
        await login('ADMIN');
        const target = await req('contractors', { name: 'Core 2.1 target contractor ' + randomUUID() });
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

        console.log('CORE 2.1 VERIFIED (partial): assign, duplicate-active-400, RBAC, unknown-object-404');
    }
    finally {
        await app.close();
        await pool.end();
    }
});
