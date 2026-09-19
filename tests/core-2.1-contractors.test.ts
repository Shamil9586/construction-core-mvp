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
    const { pool, insert, one } = await import('../apps/backend/src/db');
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

        // Assign: duplicate active relation -> 409 (Conflict: the assignment already
        // exists, same class of conflict as checkVersion()/raw DB unique-violation
        // conflicts — a concurrent duplicate assign already hit the same status via
        // the object_contractors_active_unique index + global 23505->409 mapping;
        // this makes the sequential path consistent with that)
        await req(`objects/${o.id}/contractors`, { contractorId: target.id }, 409);

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

        // --- Active-work guard blocks target2 (409, per docs/core-2.1-architecture-plan.md:95);
        // target (only a COMPLETED work) can be removed ---
        await req(`objects/${o.id}/contractors/${target2.id}/remove`, { relationId: relation2.id, version: relation2.version }, 409);
        const removed = await req(`objects/${o.id}/contractors/${target.id}/remove`, { relationId: relation.id, version: relation.version });
        assert.ok(removed.removedAt);
        assert.equal(removed.removedBy, pm.id);

        // works.contractor_id must be unchanged by the remove (checked via PM, whose own
        // access is via project_manager_id and unaffected by the contractor removal)
        const workAfterRemove = await req(`works/${work.id}`);
        assert.equal(workAfterRemove.contractorId, target.id, 'historical work retains its contractor after soft-remove');

        // objectList.contractors/contractorIds — active object_contractors only, not works-derived
        let afterRemoveList = await req('objects');
        let objAfterRemove = afterRemoveList.find((x: any) => x.id === o.id);
        assert.ok(!objAfterRemove.contractorIds.includes(target.id), 'removed contractor absent from active projection');
        assert.ok(objAfterRemove.contractorIds.includes(placeholder.id) && objAfterRemove.contractorIds.includes(target2.id), 'still-active contractors remain in projection');

        // ?contractorId= filter reflects the same active-only semantics
        assert.ok(!(await req(`objects?contractorId=${target.id}`)).some((x: any) => x.id === o.id), 'contractorId filter excludes object after remove');
        assert.ok((await req(`objects?contractorId=${target2.id}`)).some((x: any) => x.id === o.id), 'contractorId filter still includes object for a contractor that remains active');

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
        const repeat = await req(`objects/${o.id}/contractors/${target.id}/remove`, { relationId: relation.id, version: removed.version }, 404);
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

        // Active projection and filter both reflect the reassignment
        const afterReassignList = await req('objects');
        const objAfterReassign = afterReassignList.find((x: any) => x.id === o.id);
        assert.ok(objAfterReassign.contractorIds.includes(target.id), 'reassigned contractor back in active projection');
        assert.ok((await req(`objects?contractorId=${target.id}`)).some((x: any) => x.id === o.id), 'contractorId filter includes object again after reassign');

        // --- F1: stale remove (old relation A's id+version, post reassign to relation B)
        // must not touch B. Remove addresses the relation by its own id, not just
        // (objectId,contractorId), which is stable across a remove+reassign cycle. ---
        assert.notEqual(reassigned.id, relation.id, 'sanity: B is a distinct relation from A');
        const staleRemove = await req(`objects/${o.id}/contractors/${target.id}/remove`, { relationId: relation.id, version: relation.version }, 404);
        assert.match(staleRemove.message, /Активное назначение подрядчика не найдено/);
        let afterStaleRemove = (await req('objects')).find((x: any) => x.id === o.id);
        assert.ok(afterStaleRemove.contractorIds.includes(target.id), 'B remains active after a stale remove addressed at A');
        await login('CONTRACTOR_VIEWER');
        await req(`objects/${o.id}`);
        await req(`works/${work.id}`);
        await login('PROJECT_MANAGER');

        // Stale version against the correct CURRENT active relation (B) -> 409, not 404
        await req(`objects/${o.id}/contractors/${target.id}/remove`, { relationId: reassigned.id, version: reassigned.version + 1 }, 409);

        // Removing B by its own id+version succeeds, and access follows it
        const removedB = await req(`objects/${o.id}/contractors/${target.id}/remove`, { relationId: reassigned.id, version: reassigned.version });
        assert.ok(removedB.removedAt);
        afterStaleRemove = (await req('objects')).find((x: any) => x.id === o.id);
        assert.ok(!afterStaleRemove.contractorIds.includes(target.id), 'B absent from active projection after its own remove');
        await login('CONTRACTOR_VIEWER');
        await req(`objects/${o.id}`, undefined, 403);
        await login('PROJECT_MANAGER');

        // --- F2: progress() must not reactivate a COMPLETED work whose contractor
        // was removed (target is fully removed from `o` at this point — relations
        // A and B above were both removed). Correcting `work`'s fact downward would
        // otherwise flip it back to ACTIVE with no active contractor assignment. ---
        const beforeReactivationAttempt = await req(`works/${work.id}`);
        assert.equal(beforeReactivationAttempt.status, 'COMPLETED');
        const reactivationAttempt = await req(`works/${work.id}/progress`, { totalQuantity: 5, version: beforeReactivationAttempt.version, comment: 'Откат факта после снятия подрядчика' }, 409);
        assert.match(reactivationAttempt.message, /Подрядчик больше не назначен на объект/);
        const afterReactivationAttempt = await req(`works/${work.id}`);
        assert.equal(afterReactivationAttempt.status, 'COMPLETED', 'work must remain COMPLETED — no partial reactivation');
        assert.equal(afterReactivationAttempt.version, beforeReactivationAttempt.version, 'version must not advance on a rejected reactivation attempt');
        assert.equal(afterReactivationAttempt.actualQuantity, beforeReactivationAttempt.actualQuantity, 'actual quantity must not partially change on a rejected reactivation attempt');

        // Reassign the same contractor -> the same downward correction is now allowed
        const relationC = await req(`objects/${o.id}/contractors`, { contractorId: target.id });
        assert.equal(relationC.removedAt, null);
        const reactivated = await req(`works/${work.id}/progress`, { totalQuantity: 5, version: afterReactivationAttempt.version, comment: 'Откат факта после повторного назначения подрядчика' });
        assert.equal(reactivated.status, 'ACTIVE', 'reassigned contractor allows the work to become ACTIVE again');

        // --- Concurrency invariant: createWork vs removeContractor race on the same
        // object_contractors_active row (both take FOR UPDATE on it) — exactly one of
        // the two must win, and the loser's failure must be a specific, expected
        // business rejection, never a 500 and never "both succeeded"/"both failed".
        // F3 corrective: a plain NestJS @Post has no @HttpCode override, so its
        // default success status is 201, not 200 — removeContractor is no exception.
        // The original `removeResult.status === 200` check made removeOk permanently
        // false and reduced this test to "createWork always looks like it won".
        // Note: under DB_MODE=pglite, localPool()'s connect() holds a single global
        // mutex for a transaction's whole lifetime, so the two requests below are
        // already fully serialized before either query runs — this proves the
        // end-state invariant either way, but only a real Postgres run
        // (E2E_DATABASE_URL) exercises genuine concurrent-connection locking.
        await login('ADMIN');
        const target3 = await req('contractors', { name: 'Core 2.1 concurrency contractor ' + randomUUID() });
        await login('PROJECT_MANAGER');
        const relation3 = await req(`objects/${o.id}/contractors`, { contractorId: target3.id });
        const fetchJson = (path: string, body: any) => fetch(base + '/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, data: await r.json() }));
        const [createResult, removeResult] = await Promise.all([
            fetchJson('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: target3.id, responsibleUserId: pm.id, name: 'Core 2.1 concurrency работа', unit: 'т', plannedQuantity: 1, plannedStartDate: dt(-1), plannedFinishDate: dt(10), estimatedCost: '1000' }),
            fetchJson(`objects/${o.id}/contractors/${target3.id}/remove`, { relationId: relation3.id, version: relation3.version }),
        ]);
        const createWon = createResult.status === 201 && removeResult.status === 409;
        const removeWon = createResult.status === 400 && removeResult.status === 201;
        assert.ok(createWon || removeWon, 'race must resolve to exactly one business-correct outcome pair (create=201/remove=409 or create=400/remove=201), never both/neither/500: ' + JSON.stringify({ createResult, removeResult }));
        const raceObj = (await req('objects')).find((x: any) => x.id === o.id);
        if (createWon) {
            assert.ok(raceObj.contractorIds.includes(target3.id), 'active relation remains when createWork wins the race');
            const created = await req(`works/${createResult.data.id}`);
            assert.ok(['PLANNED', 'ACTIVE'].includes(created.status), 'created work is PLANNED/ACTIVE when createWork wins the race');
        } else {
            assert.ok(!raceObj.contractorIds.includes(target3.id), 'relation removed when removeContractor wins the race');
            assert.match(createResult.data.message, /Субподрядчик не назначен на объект/, 'createWork rejection message when removeContractor wins the race');
        }

        // --- F2 concurrency: progress() reactivating a COMPLETED work must serialize
        // against a concurrent removeContractor on the same object_contractors_active
        // row — exactly one of the two may win; progress must never reactivate a work
        // for a contractor removeContractor has just removed, and vice versa. ---
        await login('ADMIN');
        const target6 = await req('contractors', { name: 'Core 2.1 progress-remove race contractor ' + randomUUID() });
        await login('PROJECT_MANAGER');
        const relation6 = await req(`objects/${o.id}/contractors`, { contractorId: target6.id });
        const work6 = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: target6.id, responsibleUserId: pm.id, name: 'Core 2.1 progress-remove race работа', unit: 'т', plannedQuantity: 10, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '1000' });
        const work6Completed = await req(`works/${work6.id}/progress`, { totalQuantity: 10, version: work6.version, comment: 'Завершено для теста гонки progress/remove' });
        assert.equal(work6Completed.status, 'COMPLETED');
        const [progressRaceResult, removeRaceResult] = await Promise.all([
            fetchJson(`works/${work6.id}/progress`, { totalQuantity: 5, version: work6Completed.version, comment: 'Откат факта в гонке с removeContractor' }),
            fetchJson(`objects/${o.id}/contractors/${target6.id}/remove`, { relationId: relation6.id, version: relation6.version }),
        ]);
        const progressWon = progressRaceResult.status === 201 && removeRaceResult.status === 409;
        const removeWonRace = progressRaceResult.status === 409 && removeRaceResult.status === 201;
        assert.ok(progressWon || removeWonRace, 'progress/removeContractor race must resolve to exactly one business-correct outcome, never both/neither/500: ' + JSON.stringify({ progressRaceResult, removeRaceResult }));
        const work6After = await req(`works/${work6.id}`);
        const raceObj6 = (await req('objects')).find((x: any) => x.id === o.id);
        if (progressWon) {
            assert.equal(work6After.status, 'ACTIVE', 'work reactivated when progress wins the race');
            assert.ok(raceObj6.contractorIds.includes(target6.id), 'contractor relation remains active — removeContractor lost the race');
        } else {
            assert.equal(work6After.status, 'COMPLETED', 'work remains COMPLETED (no partial reactivation) when removeContractor wins the race');
            assert.ok(!raceObj6.contractorIds.includes(target6.id), 'contractor removed — removeContractor won the race');
        }

        // --- F3: deterministic sequential coverage of both business outcomes. A fully
        // controlled interleaving order isn't available without production test hooks,
        // which are out of scope here — these prove each outcome the race above allows
        // is individually reachable end-to-end through the real endpoints. ---
        await login('ADMIN');
        const target4 = await req('contractors', { name: 'Core 2.1 sequential remove-wins contractor ' + randomUUID() });
        const target5 = await req('contractors', { name: 'Core 2.1 sequential create-wins contractor ' + randomUUID() });
        await login('PROJECT_MANAGER');
        // remove-wins order: remove completes first, createWork then sees no active relation
        const relation4 = await req(`objects/${o.id}/contractors`, { contractorId: target4.id });
        await req(`objects/${o.id}/contractors/${target4.id}/remove`, { relationId: relation4.id, version: relation4.version });
        const removeWinsCreate = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: target4.id, responsibleUserId: pm.id, name: 'Core 2.1 remove-wins order', unit: 'т', plannedQuantity: 1, plannedStartDate: dt(-1), plannedFinishDate: dt(10), estimatedCost: '1000' }, 400);
        assert.match(removeWinsCreate.message, /Субподрядчик не назначен на объект/);
        // create-wins order: createWork completes first, removeContractor then sees a blocking PLANNED work
        const relation5 = await req(`objects/${o.id}/contractors`, { contractorId: target5.id });
        await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: target5.id, responsibleUserId: pm.id, name: 'Core 2.1 create-wins order', unit: 'т', plannedQuantity: 1, plannedStartDate: dt(-1), plannedFinishDate: dt(10), estimatedCost: '1000' });
        await req(`objects/${o.id}/contractors/${target5.id}/remove`, { relationId: relation5.id, version: relation5.version }, 409);

        // --- Object Edit: restricted whitelist, partial (only version is required) ---
        const objectBefore = (await req(`objects/${o.id}`)).object;

        // projectManagerId's mere presence is gated for a non-privileged actor, not just
        // a value change: PM resubmitting their own current id still gets 403.
        await req(`objects/${o.id}/edit`, { name: objectBefore.name, projectManagerId: pm.id, version: objectBefore.version }, 403);

        const edited = await req(`objects/${o.id}/edit`, { name: 'Core 2.1 объект (переименован)', address: 'Тестовая, 21а', customerName: 'ООО Заказчик', plannedFinishDate: dt(90), version: objectBefore.version });
        assert.equal(edited.name, 'Core 2.1 объект (переименован)');
        assert.equal(edited.address, 'Тестовая, 21а');
        assert.equal(edited.plannedFinishDate, dt(90));
        assert.equal(edited.projectManagerId, pm.id, 'omitted projectManagerId leaves the existing PM unchanged');
        assert.equal(edited.version, objectBefore.version + 1);

        // Partial edit: a single field changes, every omitted field is preserved as-is
        const partial = await req(`objects/${o.id}/edit`, { customerName: 'ООО Заказчик 2', version: edited.version });
        assert.equal(partial.customerName, 'ООО Заказчик 2');
        assert.equal(partial.name, edited.name, 'omitted name preserved by partial edit');
        assert.equal(partial.address, edited.address, 'omitted address preserved by partial edit');
        assert.equal(partial.plannedFinishDate, edited.plannedFinishDate, 'omitted plannedFinishDate preserved by partial edit');

        // --- F6: startDate is part of the restricted whitelist (an owner decision
        // incompletely carried into baseline docs, not new scope) — partial edits on
        // either date alone, or both together, must respect the merged
        // effective-date invariant (effectivePlannedFinishDate >= effectiveStartDate). ---
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

        // --- F7: tenant isolation hardening. A random/unknown UUID (already covered
        // above, e.g. the assign-to-unknown-object 404 case) only proves scoped()'s
        // not-found path — it doesn't prove a REAL row belonging to a different
        // tenant is rejected. Build a genuine second tenant with its own real
        // object/contractor/relation and confirm every Core 2.1 contractor-management
        // path denies it the same generic way (no tenant-B data leaked in the 404). ---
        const tenantB = await one(pool, "INSERT INTO tenants(portal,member_id,name) VALUES($1,$2,$3) RETURNING *", ['core-2-1-tenant-b-' + randomUUID() + '.local', 'core-2-1-tenant-b-' + randomUUID(), 'Core 2.1 Tenant B']);
        const pmB = await insert(pool, 'users', tenantB.id, { bitrixUserId: 'core-2-1-tenant-b-pm', name: 'Core 2.1 Tenant B PM', role: 'PROJECT_MANAGER' });
        const contractorB = await insert(pool, 'contractors', tenantB.id, { name: 'Core 2.1 Tenant B contractor' });
        const objectB = await insert(pool, 'objects', tenantB.id, { externalCode: 'B-' + randomUUID(), name: 'Core 2.1 Tenant B объект', address: 'Tenant B, 1', organizationName: 'Tenant B Org', projectManagerId: pmB.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000' });
        const relationB = await insert(pool, 'object_contractors', tenantB.id, { objectId: objectB.id, contractorId: contractorB.id });

        await login('PROJECT_MANAGER');
        // assign onto a foreign-tenant object -> denied, same generic not-found as any other missing record
        const assignCrossTenant = await req(`objects/${objectB.id}/contractors`, { contractorId: contractorB.id }, 404);
        assert.match(assignCrossTenant.message, /Запись не найдена/);
        // remove a foreign-tenant relation -> denied
        const removeCrossTenant = await req(`objects/${objectB.id}/contractors/${contractorB.id}/remove`, { relationId: relationB.id, version: relationB.version }, 404);
        assert.match(removeCrossTenant.message, /Запись не найдена/);
        // edit a foreign-tenant object -> denied
        const editCrossTenant = await req(`objects/${objectB.id}/edit`, { name: 'hijacked', version: objectB.version }, 404);
        assert.match(editCrossTenant.message, /Запись не найдена/);

        // relationId from tenant B cannot be reused against a REAL, active tenant-A
        // object+contractor pair — removeContractor must not match across tenants,
        // and tenant A's own active relation must survive the attempt untouched.
        await login('ADMIN');
        const contractorA7 = await req('contractors', { name: 'Core 2.1 tenant-isolation contractor A ' + randomUUID() });
        await login('PROJECT_MANAGER');
        const objectA7 = await req('objects', { externalCode: 'C21-TI-' + randomUUID(), name: 'Core 2.1 tenant-isolation объект A', address: 'Тестовая, 22', organizationName: 'ООО Тест', projectManagerId: pm.id, startDate: dt(-1), plannedFinishDate: dt(30), contractValue: '1', contractorIds: [placeholder.id] });
        const relationA7 = await req(`objects/${objectA7.id}/contractors`, { contractorId: contractorA7.id });
        const crossTenantRelationId = await req(`objects/${objectA7.id}/contractors/${contractorA7.id}/remove`, { relationId: relationB.id, version: relationA7.version }, 404);
        assert.match(crossTenantRelationId.message, /Активное назначение подрядчика не найдено/);
        const stillActive = (await req('objects')).find((x: any) => x.id === objectA7.id);
        assert.ok(stillActive.contractorIds.includes(contractorA7.id), 'tenant A relation remains active after a cross-tenant relationId attempt');

        console.log('CORE 2.1 VERIFIED: assign, remove (+active-work guard, +404 repeat), reassign, CONTRACTOR_VIEWER work-access ripple, active read model, restricted Object Edit');
    }
    finally {
        await app.close();
        await pool.end();
    }
});
