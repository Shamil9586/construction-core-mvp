import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Core 2.0 hardening — Этап 1 (Regression Mapping ERP -> Core), docs/core-2.0-regression-map.md.
// Каждый тест здесь — MISSING_TEST: поведение уже существует в Core (apps/backend/src/service.ts),
// но не было закреплено тестом. Ничего в production-коде не менялось. Тесты написаны против
// HTTP API Core (не Prisma, не ERP), см. регламент задачи. Ссылки на конкретные строки service.ts
// даны в комментариях к каждому сценарию.
test('Regression net ERP -> Core: object self-assignment, work/dependency guards, progress lock, issue severity, PTO/SDO re-entrancy', async () => {
    if (!process.env.E2E_DATABASE_URL) delete process.env.DATABASE_URL;
    process.env.AUTH_MODE = 'mock';
    process.env.MOCK_LOGIN_KEY = 'regression-erp-parity-key';
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
    async function login(role: string) { const d = await req('auth/mock', { role, key: 'regression-erp-parity-key' }); token = d.token; return d.user; }
    const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);
    try {
        const pm = await login('PROJECT_MANAGER');
        const contractors = await req('contractors'), dict = await req('dictionaries'), users = await req('users');
        const [c1, c2] = contractors;
        const workTypeId = dict.workTypes[0].id;
        const otherPm = users.find((u: any) => u.role === 'PROJECT_MANAGER' && u.id !== pm.id);

        // ---- A. Объект: РП может создать объект только для себя (service.ts createObject,
        // ---- "ensure(pm.id === a.id, 'РП может создать объект только для себя')") — уже
        // ---- реализовано, но не было закреплено тестом (ERP source: business-rules.md/permissions.md,
        // ---- РП ведёт только свои объекты).
        await req('objects', { externalCode: 'REG-A-' + randomUUID(), name: 'Объект чужого РП', address: 'Тестовая, 1', organizationName: 'ООО Тест', projectManagerId: otherPm.id, startDate: dt(-1), plannedFinishDate: dt(30), contractValue: '1000000', contractorIds: [c1.id] }, 400);

        const o = await req('objects', { externalCode: 'REG-O-' + randomUUID(), name: 'Регрессионный объект', address: 'Тестовая, 2', organizationName: 'ООО Тест', projectManagerId: pm.id, startDate: dt(-1), plannedFinishDate: dt(60), contractValue: '5000000', contractorIds: [c1.id] });

        // ---- B. Работы: создание работы с contractorId, не назначенным на объект — 400
        // ---- (service.ts createWork, "Субподрядчик не назначен на объект") — уже реализовано
        // ---- (это тот же хардненинг-фикс 2в, что в ERP critical-path.e2e-spec.ts), но в Core
        // ---- не было теста на него.
        const rejectedWork = await req('works', { objectId: o.id, workTypeId, contractorId: c2.id, responsibleUserId: pm.id, name: 'Работа с чужим подрядчиком', unit: 'т', plannedQuantity: 1, plannedStartDate: dt(0), plannedFinishDate: dt(1), estimatedCost: '1000' }, 400);
        assert.match(rejectedWork.message, /не назначен/i);

        const workA = await req('works', { objectId: o.id, workTypeId, contractorId: c1.id, responsibleUserId: pm.id, name: 'Работа A', unit: 'т', plannedQuantity: 20, plannedStartDate: dt(-10), plannedFinishDate: dt(10), estimatedCost: '900000' });
        const workB = await req('works', { objectId: o.id, workTypeId, contractorId: c1.id, responsibleUserId: pm.id, name: 'Работа B (последующая)', unit: 'т', plannedQuantity: 5, plannedStartDate: dt(0), plannedFinishDate: dt(15), estimatedCost: '100000' });

        // ---- C. Работы: циклическая зависимость отклоняется — 400 (service.ts dependency,
        // ---- рекурсивный CTE + "ensure(!cycle ..., 'Циклическая зависимость')") — уже реализовано,
        // ---- аналога в ERP critical-path нет вообще (Core-специфичная защита), но регрессии не было.
        await req('work-dependencies', { predecessorWorkId: workA.id, successorWorkId: workB.id, requiresAcceptance: true });
        const cyclic = await req('work-dependencies', { predecessorWorkId: workB.id, successorWorkId: workA.id, requiresAcceptance: true }, 400);
        assert.match(cyclic.message, /Циклическая/i);

        // ---- D. Работы: зависимость нельзя добавить к уже начатой работе — 400 (service.ts
        // ---- dependency, "ensure(Number(after.actualQuantity)===0 && after.status==='PLANNED', ...)")
        // ---- — уже реализовано, не было закреплено тестом.
        const workC = await req('works', { objectId: o.id, workTypeId, contractorId: c1.id, responsibleUserId: pm.id, name: 'Работа C (без зависимостей)', unit: 'т', plannedQuantity: 3, plannedStartDate: dt(-5), plannedFinishDate: dt(5), estimatedCost: '50000' });
        const startedC = await req(`works/${workC.id}/start`, { version: workC.version });
        assert.equal(startedC.status, 'ACTIVE');
        const lateDep = await req('work-dependencies', { predecessorWorkId: workB.id, successorWorkId: workC.id, requiresAcceptance: true }, 400);
        assert.match(lateDep.message, /уже начата|Нельзя добавлять/i);

        // ---- E. План/факт: после предъявления на СК внесение факта заблокировано — 400
        // ---- (service.ts progress, "После предъявления СК факт заблокирован. Требуется
        // ---- отдельная корректировка") — уже реализовано, не было закреплено тестом.
        let workD = await req('works', { objectId: o.id, workTypeId, contractorId: c1.id, responsibleUserId: pm.id, name: 'Работа D (план/факт lock)', unit: 'т', plannedQuantity: 10, plannedStartDate: dt(-10), plannedFinishDate: dt(5), estimatedCost: '200000' });
        workD = await req(`works/${workD.id}/progress`, { totalQuantity: 10, version: workD.version, comment: 'Полный объём' });
        const inspectionD = await req(`works/${workD.id}/inspection-request`, { version: workD.version });
        const workDAfterRequest = await req(`works/${workD.id}`);
        const lockedProgress = await req(`works/${workD.id}/progress`, { totalQuantity: 10, version: workDAfterRequest.version, comment: 'Попытка правки после предъявления' }, 400);
        assert.match(lockedProgress.message, /факт заблокирован/i);

        // ---- F. Замечания: расхождение с ERP business-rules.md ("открытое CRITICAL блокирует
        // ---- приёмку", остальные — нет). В Core inspectionAction 'accept' блокируется ЛЮБЫМ
        // ---- незакрытым замечанием независимо от severity (service.ts inspectionAction,
        // ---- "SELECT id FROM issues WHERE ... status<>'CLOSED'"). Тест закрепляет ТЕКУЩЕЕ
        // ---- поведение Core (не ERP-поведение) — расхождение зафиксировано отдельно в
        // ---- docs/core-2.0-regression-map.md и вынесено в decision log (Этап 2, п.5) как решение,
        // ---- а не как дефект, требующий немедленного исправления.
        await login('CONSTRUCTION_CONTROL');
        let issueMedium = await req(`inspections/${inspectionD.id}/issues`, { version: inspectionD.version, title: 'Незначительное замечание (не критическое)', severity: 'MEDIUM', responsibleUserId: pm.id, dueDate: dt(2) });
        await login('PROJECT_MANAGER');
        issueMedium = await req(`issues/${issueMedium.id}/resolve`, { version: issueMedium.version });
        assert.equal(issueMedium.status, 'READY_FOR_VERIFICATION');
        await login('CONSTRUCTION_CONTROL');
        const inspectionsSnapshot1 = await req('inspections');
        let inspectionDFresh = inspectionsSnapshot1.find((i: any) => i.id === inspectionD.id);
        const blockedAccept = await req(`inspections/${inspectionDFresh.id}/accept`, { version: inspectionDFresh.version, comment: 'Попытка приёмки с незакрытым MEDIUM-замечанием' }, 400);
        assert.match(blockedAccept.message, /проверены и закрыты/i);
        await req(`issues/${issueMedium.id}/verify`, { version: issueMedium.version });
        const photo = await req('attachments', { fileName: 'inspection-d.png', mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=' });
        await req(`inspections/${inspectionDFresh.id}/photos`, { attachmentId: photo.id });
        inspectionDFresh = (await req('inspections')).find((i: any) => i.id === inspectionD.id);
        const acceptedD = await req(`inspections/${inspectionDFresh.id}/accept`, { version: inspectionDFresh.version, comment: 'Принято после верификации MEDIUM-замечания' });
        assert.equal(acceptedD.status, 'ACCEPTED');

        // ---- G/H setup: доводим Работу A до принятой СК, готового пакета ИД и переданного в СДО
        // ---- дела — общая база для сценариев G (повторное подтверждение документа) и
        // ---- H (частичное финансовое закрытие в несколько траншей).
        await login('PROJECT_MANAGER');
        let a1 = await req(`works/${workA.id}/progress`, { totalQuantity: 20, version: workA.version, comment: 'Полный объём A' });
        const inspectionA = await req(`works/${workA.id}/inspection-request`, { version: a1.version });
        await login('CONSTRUCTION_CONTROL');
        const photoA = await req('attachments', { fileName: 'inspection-a.png', mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=' });
        await req(`inspections/${inspectionA.id}/photos`, { attachmentId: photoA.id });
        const acceptedA = await req(`inspections/${inspectionA.id}/accept`, { version: inspectionA.version, comment: 'Принято сразу' });
        assert.equal(acceptedA.status, 'ACCEPTED');
        await login('PTO');
        let pkg = await req('executive-packages', { objectWorkId: workA.id });
        const fileA = await req('attachments', { fileName: 'aosr-a.pdf', mimeType: 'application/pdf', base64: Buffer.from('%PDF-1.4\n% Regression fixture\n%%EOF').toString('base64') });
        await req('materials/bind', { objectWorkId: workA.id, name: 'Материал A', manufacturer: 'Завод A', batchNumber: 'REG-BATCH-A', quantity: 20, documentNumber: 'ПС-REG-A', fileId: fileA.id, validUntil: dt(365) });
        let docA = await req('executive-documents', { packageId: pkg.id, type: 'AOSR', number: 'АОСР-REG-A', documentDate: dt(0), fileId: fileA.id });
        docA = await req(`executive-documents/${docA.id}/approve`, { version: docA.version });
        assert.equal(docA.status, 'APPROVED');

        // ---- G. ПТО: повторное подтверждение уже подтверждённого документа — 400 (service.ts
        // ---- approveDocument, "ensure(doc.status !== 'APPROVED', 'Документ уже подтверждён')")
        // ---- — уже реализовано, не было закреплено тестом.
        const reApprove = await req(`executive-documents/${docA.id}/approve`, { version: docA.version }, 400);
        assert.match(reApprove.message, /уже подтверждён/i);

        pkg = (await req('executive-packages')).find((p: any) => p.id === pkg.id);
        pkg = await req(`executive-packages/${pkg.id}/ready`, { version: pkg.version });
        const sdoCase = await req(`executive-packages/${pkg.id}/transfer-sdo`, { version: pkg.version });
        await login('SDO');
        let calculated = await req(`sdo/${sdoCase.id}/calculate`, { version: sdoCase.version, calculatedValue: '1000000' });
        assert.equal(calculated.status, 'CALCULATED');

        // ---- H. Финансовое закрытие: частичное закрытие в несколько траншей — дело остаётся
        // ---- READY_TO_CLOSE до полной суммы и переходит в CLOSED только после неё
        // ---- (service.ts close, "all = sum.add(amount).eq(s.acceptedClosingValue)") — уже
        // ---- реализовано (ERP в критическом пути закрывает делo одним платежом целиком,
        // ---- частичное закрытие — Core-специфичное расширение), но не было теста на переходы
        // ---- READY_TO_CLOSE -> CLOSED.
        const period = dt(0).slice(0, 7);
        const firstClose = await req('financial-closings', { sdoCaseId: sdoCase.id, amount: '400000', period, closingDate: dt(0), version: calculated.version, idempotencyKey: randomUUID() });
        assert.equal(firstClose.amount, '400000.00');
        let sdoAfterFirst = (await req('sdo')).find((s: any) => s.id === sdoCase.id);
        assert.equal(sdoAfterFirst.status, 'READY_TO_CLOSE');
        const secondClose = await req('financial-closings', { sdoCaseId: sdoCase.id, amount: '600000', period, closingDate: dt(0), version: sdoAfterFirst.version, idempotencyKey: randomUUID() });
        assert.equal(secondClose.amount, '600000.00');
        const sdoAfterSecond = (await req('sdo')).find((s: any) => s.id === sdoCase.id);
        assert.equal(sdoAfterSecond.status, 'CLOSED');
        // Дело уже CLOSED — дальнейшее закрытие отклоняется на проверке статуса (раньше,
        // чем на проверке суммы); отдельный тест на превышение суммы уже есть в
        // tests/acceptance.test.ts ("Negative/NaN/invalid/excess closing does not mutate").
        const overClose = await req('financial-closings', { sdoCaseId: sdoCase.id, amount: '1', period, closingDate: dt(0), version: sdoAfterSecond.version, idempotencyKey: randomUUID() }, 400);
        assert.match(overClose.message, /рассчитана или дело закрыто/i);

        console.log('REGRESSION NET VERIFIED: object self-assignment, work/dependency guards, progress lock after inspection, issue-severity acceptance gate, PTO re-approve guard, partial SDO closing');
    }
    finally {
        await app.close();
        await pool.end();
    }
});
