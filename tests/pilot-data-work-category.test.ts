import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// PILOT-DATA: POST /dictionaries/categories — the one missing supported
// operation needed to bootstrap an empty tenant (categories -> work-types).
test('PILOT-DATA: admin creates a work category via API, tenant-scoped, usable by work-types flow', async () => {
    if (!process.env.E2E_DATABASE_URL) delete process.env.DATABASE_URL;
    process.env.AUTH_MODE = 'mock';
    process.env.MOCK_LOGIN_KEY = 'pilot-data-key';
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
    const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
    let token = '';
    async function call(path: string, body: any, expected: number) { const r = await fetch(base + '/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) }); const data: any = await r.json(); assert.equal(r.status, expected, path + ': ' + JSON.stringify(data)); return data; }
    async function login(role: string) { const d = await call('auth/mock', { role, key: 'pilot-data-key' }, 201); token = d.token; return d.user; }
    const count = async () => Number((await one(pool, 'SELECT count(*)::int AS n FROM work_categories', [])).n);
    try {
        const admin = await login('ADMIN');
        const before = await count();
        const name = 'Pilot cat ' + randomUUID(), code = 'PC-' + randomUUID().slice(0, 8);
        // A. admin create
        const cat = await call('dictionaries/categories', { name, code }, 201);
        assert.equal(cat.tenantId, (await one(pool, 'SELECT tenant_id FROM users WHERE id=$1', [admin.id])).tenantId);
        assert.equal(cat.name, name); assert.equal(cat.code, code);
        assert.equal(cat.parentId, null); assert.equal(cat.sortOrder, 0);
        assert.equal(await count(), before + 1);
        const dict = await call('dictionaries', undefined, 200);
        assert.ok(dict.categories.some((c: any) => c.id === cat.id));
        // C. validation
        for (const bad of [{}, { name }, { code }, { name: '  ', code }, { name, code: '' }, { name, code, extra: 1 }, { name, code, parentId: cat.id }, { name: 5, code }])
            await call('dictionaries/categories', bad, 400);
        assert.equal(await count(), before + 1);
        // D. tenant cannot be supplied by client
        const otherTenant = (await one(pool, "INSERT INTO tenants(portal,member_id,name) VALUES('other.example','other-member','other') RETURNING id", [])).id;
        await call('dictionaries/categories', { name, code, tenantId: otherTenant }, 400);
        await call('dictionaries/categories', { name, code, tenant_id: otherTenant }, 400);
        assert.equal(Number((await one(pool, 'SELECT count(*)::int AS n FROM work_categories WHERE tenant_id=$1', [otherTenant])).n), 0);
        const own = await one(pool, 'SELECT tenant_id FROM work_categories WHERE id=$1', [cat.id]);
        assert.equal(own.tenantId, cat.tenantId);
        // E. existing work-type flow on the new category, no DB setup
        const wt = await call('dictionaries/work-types', { categoryId: cat.id, name: 'Pilot type', unit: 'м2', requiresInspection: true, requiresExecutiveDocs: true, requiresMaterials: false }, 201);
        assert.equal(wt.categoryId, cat.id);
        assert.ok((await call('dictionaries', undefined, 200)).workTypes.some((w: any) => w.id === wt.id));
        // B. authorization
        const afterAdmin = await count();
        for (const role of ['PROJECT_MANAGER', 'DEPUTY_DIRECTOR', 'GENERAL_DIRECTOR', 'CONTRACTOR_VIEWER', 'PTO', 'SDO']) {
            await login(role);
            await call('dictionaries/categories', { name: 'X' + role, code: 'X' + role }, 403);
        }
        assert.equal(await count(), afterAdmin);
    } finally { await app.close(); }
});
