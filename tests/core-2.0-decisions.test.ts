import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Core 2.0 hardening — Этап 2 (Business Decision Log), docs/decision-log-core-2.0.md.
// Единственный реальный backend-код, добавленный на Этапе 2: явный сигнал isOverperformed
// (decision log п.3) — packages/domain/index.ts (ProgressCalculationService.isOverperformed)
// и apps/backend/src/service.ts (progress()). Ничего не персистируется в БД, схема не менялась.
// Решение по п.5 (READY_FOR_VERIFICATION блокирует приёмку) закреплено ранее сценарием F в
// tests/regression-erp-parity.test.ts — не дублируется здесь.
test('Core 2.0 decision log п.3: явный сигнал isOverperformed на POST /works/:id/progress', async () => {
    if (!process.env.E2E_DATABASE_URL) delete process.env.DATABASE_URL;
    process.env.AUTH_MODE = 'mock';
    process.env.MOCK_LOGIN_KEY = 'core-2-0-decisions-key';
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
    async function login(role: string) { const d = await req('auth/mock', { role, key: 'core-2-0-decisions-key' }); token = d.token; return d.user; }
    const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);
    try {
        const pm = await login('PROJECT_MANAGER');
        const contractors = await req('contractors'), dict = await req('dictionaries');
        const c1 = contractors[0], workTypeId = dict.workTypes[0].id;
        const o = await req('objects', { externalCode: 'DEC-O-' + randomUUID(), name: 'Объект для decision log п.3', address: 'Тестовая, 3', organizationName: 'ООО Тест', projectManagerId: pm.id, startDate: dt(-10), plannedFinishDate: dt(30), contractValue: '1000000', contractorIds: [c1.id] });
        const work = await req('works', { objectId: o.id, workTypeId, contractorId: c1.id, responsibleUserId: pm.id, name: 'Работа для isOverperformed', unit: 'т', plannedQuantity: 20, plannedStartDate: dt(-10), plannedFinishDate: dt(10), estimatedCost: '500000' });

        const under = await req(`works/${work.id}/progress`, { totalQuantity: 10, version: work.version, comment: 'Меньше плана' });
        assert.equal(under.isOverperformed, false);

        const exact = await req(`works/${work.id}/progress`, { totalQuantity: 20, version: under.version, comment: 'Ровно план' });
        assert.equal(exact.isOverperformed, false);
        assert.equal(exact.progressPercent, 100);

        const over = await req(`works/${work.id}/progress`, { totalQuantity: 25, version: exact.version, comment: 'Больше плана' });
        assert.equal(over.isOverperformed, true);
        assert.equal(over.progressPercent, 100, 'progressPercent остаётся клампнут в 100 для светофора/UI — isOverperformed это отдельный сигнал');

        console.log('CORE 2.0 DECISION LOG VERIFIED: isOverperformed signal (п.3)');
    }
    finally {
        await app.close();
        await pool.end();
    }
});
