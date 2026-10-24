import { one, rows } from './db';
import { audit } from './security';
import { runCommandTx, runSnapshotRead } from './tx-context';
import { coordinate } from './coordination-lock';
import { ledgered, mapR05DbError, reauthorize } from './gpr2-r05-support';
import type { Gpr2CommandContext } from './gpr2-command-guard';
import { Permission } from '../../../packages/domain';
import {
    CommandResult, GenerationPreview, Gpr2Error, Gpr2Violation, PreviewInput, assertAggregateVersion, assertScopeVersion, blockingError, computeGenerationPreview,
    generationConfirmPayload, generationPreviewPayload, parseR05Payload
} from '../../../packages/domain/gpr2';

/**
 * GPR-2 R05d — Work generation from one object finish-system version: PREVIEW (read only) and CONFIRM (atomic, idempotent)
 * (Technical Design §4.1, §5.2, §11.1–11.2 finish-systems/{id}/preview|confirm, §12.2–12.4; decisions D01, D06, D09; scenarios A01, A07, A12, A19, A30).
 *
 * Generation creates REAL Works in `works` — there is no second planning entity — and binds each to the atomic production obligation(s) it produces
 * (work_scope_bindings). It never invents a quantity, unit, contractor, responsible person, cost or date: a missing quantity / unit is a blocker; the
 * assignments, cost and provisional dates of the new Works are NULL (R04 Early Work), shown as a warning, not a blocker.
 *
 * PREVIEW — one REPEATABLE READ READ ONLY snapshot (runSnapshotRead): PostgreSQL itself refuses any write in it. Answers the proposed Works, the existing
 * producers, every blocker / warning / missing input and the preview fingerprint over all of it.
 *
 * CONFIRM — one transaction, in this order (the R03 lock order: coordination first, then rows):
 *   1. coordinate EXCLUSIVE on the object          Work generation changes the object scope (TD §12.3 item 1); every fact / SC / PTO / SDO writer of the
 *                                                  object waits, and so does every other confirm
 *   2. runLedgered: re-authorization              the CURRENT user row, role → GPR-2 grant + legacy WORK_CREATE (R04's Work-creation authority), tenant,
 *                                                  object scope and the finish system's owner — BEFORE any replay; then claim / compare / replay
 *   3. finish system row lock + expectedVersion   409 STALE_VERSION
 *   4. inputs re-read on this transaction          a reference outside the object → 422 CROSS_SCOPE_REFERENCE
 *   5. source version check                        not the current published version of the finish type (or not the fenced one) → 409 STALE_SOURCE_VERSION
 *   6. scope state check                           expectedScopeVersion ≠ the object's scope version → 409 SCOPE_VERSION_CHANGED
 *   7. fingerprint check                           the preview re-computed under the lock ≠ the confirmed one → 409 STALE_PREVIEW
 *   8. blockers (incl. one-producer pre-check)     422 ONE_PRODUCER_CONFLICT / AREA_SCOPE_CONFLICT / INVALID_MEASUREMENT / MISSING_REQUIRED_DATA
 *   9. Works + producer bindings                   INSERTs; PostgreSQL's unique index and binding trigger are the last word on one producer (infra/032)
 *  10. ledger result, then COMMIT                  any failure above rolls back EVERYTHING, the ledger claim included (A30)
 */
async function loadPreviewInput(c: any, tenantId: string, objectId: string, finishTypeId: string, request: any): Promise<PreviewInput> {
    const ft = await one(c, 'SELECT * FROM object_finish_types WHERE tenant_id=$1 AND object_id=$2 AND id=$3', [tenantId, objectId, finishTypeId]);
    if (!ft)
        throw new Gpr2Error('RESOURCE_NOT_FOUND');
    const sv = await one(c, "SELECT * FROM object_finish_system_versions WHERE tenant_id=$1 AND object_id=$2 AND id=$3 AND state='PUBLISHED'", [tenantId, objectId, request.systemVersionId]);
    if (!sv || sv.finishTypeId !== ft.id)
        throw new Gpr2Error('CROSS_SCOPE_REFERENCE', { violations: [{ path: 'systemVersionId', rule: 'REFERENCE_NOT_IN_SCOPE' }] });
    const latest = (await one(c, "SELECT max(version_number) AS n FROM object_finish_system_versions WHERE tenant_id=$1 AND finish_type_id=$2 AND state='PUBLISHED'", [tenantId, ft.id])).n;
    const occurrences = await rows(c, `SELECT o.*, t.name AS work_type_name, t.unit AS work_type_unit FROM finish_stage_occurrences o JOIN work_types t ON t.tenant_id=o.tenant_id AND t.id=o.work_type_id
        WHERE o.tenant_id=$1 AND o.system_version_id=$2 ORDER BY o.position`, [tenantId, sv.id]);
    const areas = await rows(c, "SELECT id, parent_id, code, name, kind, measure_quantity, measure_unit FROM object_area_scopes WHERE tenant_id=$1 AND object_id=$2 AND lifecycle='ACTIVE'", [tenantId, objectId]);
    const known = new Set(areas.map((a: any) => a.id));
    const refs: Gpr2Violation[] = [];
    (request.areaScopeIds as string[]).forEach((id, i) => { if (!known.has(id)) refs.push({ path: 'areaScopeIds.' + i, rule: 'REFERENCE_NOT_IN_SCOPE' }); });
    const optional = new Set(occurrences.filter((o: any) => !o.required).map((o: any) => o.occurrenceKey));
    (request.includeOptional ?? []).forEach((k: string, i: number) => { if (!optional.has(k)) refs.push({ path: 'includeOptional.' + i, rule: 'REFERENCE_NOT_IN_SCOPE' }); });
    (request.localQuantities ?? []).forEach((l: any, i: number) => { if (!known.has(l.areaScopeId)) refs.push({ path: `localQuantities.${i}.areaScopeId`, rule: 'REFERENCE_NOT_IN_SCOPE' }); });
    if (refs.length)
        throw new Gpr2Error('CROSS_SCOPE_REFERENCE', { violations: refs });
    // with the operation each producer performs (its Work's WorkType, its occurrence's WorkType / unit / measure scope) — R05-IND-NEW-05
    const bindings = await rows(c, `SELECT b.id, b.work_id, b.occurrence_key, b.area_scope_id, b.system_version_id, w.name AS work_name, w.unit AS work_unit, w.planned_quantity::text AS work_quantity,
        w.work_type_id, o.work_type_id AS produced_work_type_id, o.measure_unit AS produced_measure_unit, o.measure_scope AS produced_measure_scope
        FROM work_scope_bindings b JOIN works w ON w.tenant_id=b.tenant_id AND w.id=b.work_id JOIN finish_stage_occurrences o ON o.tenant_id=b.tenant_id AND o.id=b.occurrence_id WHERE b.tenant_id=$1 AND b.object_id=$2 AND b.finish_type_id=$3 AND b.binding_state='ACTIVE' ORDER BY b.id`, [tenantId, objectId, ft.id]);
    const other = await rows(c, "SELECT DISTINCT area_scope_id FROM work_scope_bindings WHERE tenant_id=$1 AND object_id=$2 AND finish_type_id<>$3 AND binding_state='ACTIVE' ORDER BY 1", [tenantId, objectId, ft.id]);
    const legacy = await rows(c, `SELECT w.id, w.work_type_id FROM works w WHERE w.tenant_id=$1 AND w.object_id=$2 AND w.work_type_id = ANY($3::uuid[])
        AND NOT EXISTS (SELECT 1 FROM work_scope_bindings b WHERE b.tenant_id=w.tenant_id AND b.work_id=w.id) ORDER BY w.id`, [tenantId, objectId, [...new Set(occurrences.map((o: any) => o.workTypeId))]]);
    const scope = await one(c, 'SELECT scope_version::text AS v FROM work_scope_state WHERE tenant_id=$1 AND object_id=$2', [tenantId, objectId]);
    return {
        finishType: { id: ft.id, code: ft.code, name: ft.name, version: ft.version },
        systemVersion: { id: sv.id, versionNumber: sv.versionNumber, isCurrent: sv.versionNumber === latest },
        scopeVersion: scope?.v ?? '0',
        occurrences: occurrences.map((o: any) => ({ id: o.id, occurrenceKey: o.occurrenceKey, position: o.position, workTypeId: o.workTypeId, workTypeName: o.workTypeName, workTypeUnit: o.workTypeUnit,
            required: o.required, measureScope: o.measureScope, measureUnit: o.measureUnit, proposedHoldHours: o.proposedHoldHours ?? null, overrideKind: o.overrideKind })),
        areas: areas.map((a: any) => ({ id: a.id, parentId: a.parentId ?? null, code: a.code, name: a.name, kind: a.kind, measureQuantity: a.measureQuantity ?? null, measureUnit: a.measureUnit ?? null })),
        bindings: bindings.map((b: any) => ({ id: b.id, workId: b.workId, occurrenceKey: b.occurrenceKey, areaScopeId: b.areaScopeId, systemVersionId: b.systemVersionId, workName: b.workName, workUnit: b.workUnit, workQuantity: b.workQuantity,
            workTypeId: b.workTypeId, producedWorkTypeId: b.producedWorkTypeId, producedMeasureUnit: b.producedMeasureUnit, producedMeasureScope: b.producedMeasureScope })),
        otherFinishAreaIds: other.map((r: any) => r.areaScopeId),
        legacyWorks: legacy.map((w: any) => ({ workId: w.id, workTypeId: w.workTypeId })),
        request
    };
}

/** What a pure preview answers: the projection itself (it is not a command and carries no command id — the register marks it `pure`). */
export interface PreviewResponse { preview: GenerationPreview; appliedVersions: { aggregate: string; scope: string }; resultIds: string[]; warnings: { code: string; path?: string }[] }

export async function previewGeneration(ctx: Gpr2CommandContext): Promise<PreviewResponse> {
    const request = parseR05Payload(generationPreviewPayload, ctx.command.payload);
    const finishTypeId = ctx.params.id.toLowerCase();
    return runSnapshotRead(async tx => {
        await reauthorize(tx.c, ctx, { readOnly: true, legacy: [Permission.WORK_CREATE] });
        const ft = await one(tx.c, 'SELECT version FROM object_finish_types WHERE tenant_id=$1 AND object_id=$2 AND id=$3', [ctx.actor.tenantId, ctx.objectId, finishTypeId]);
        if (!ft)
            throw new Gpr2Error('RESOURCE_NOT_FOUND');
        assertAggregateVersion(ctx.command.expectedVersion as any, ft.version);
        const preview = computeGenerationPreview(await loadPreviewInput(tx.c, ctx.actor.tenantId, ctx.objectId!, finishTypeId, request));
        return { preview, appliedVersions: { aggregate: String(ft.version), scope: preview.scopeVersion }, resultIds: [], warnings: preview.warnings };
    });
}

export async function confirmGeneration(ctx: Gpr2CommandContext): Promise<CommandResult> {
    const payload = parseR05Payload(generationConfirmPayload, ctx.command.payload);
    const { previewFingerprint, expectedSourceVersions, ...request } = payload;
    const finishTypeId = ctx.params.id.toLowerCase();
    return runCommandTx(async tx => {
        await coordinate(tx.c, 'gpr2-r05-generation.ts#confirmGeneration', ctx.actor.tenantId, { object: ctx.objectId! });
        const c = tx.c;
        return (await ledgered(c, ctx, async (a, commandId) => {
            const ft = await one(c, 'SELECT * FROM object_finish_types WHERE tenant_id=$1 AND object_id=$2 AND id=$3 FOR UPDATE', [a.tenantId, ctx.objectId, finishTypeId]);
            if (!ft)
                throw new Gpr2Error('RESOURCE_NOT_FOUND');
            assertAggregateVersion(ctx.command.expectedVersion as any, ft.version);
            const input = await loadPreviewInput(c, a.tenantId, ctx.objectId!, finishTypeId, request);
            if (!input.systemVersion.isCurrent || expectedSourceVersions.systemVersion !== request.systemVersionId)
                throw new Gpr2Error('STALE_SOURCE_VERSION');
            assertScopeVersion(ctx.command.expectedScopeVersion as any, input.scopeVersion);
            const preview = computeGenerationPreview(input);
            if (preview.previewFingerprint !== previewFingerprint)
                throw new Gpr2Error('STALE_PREVIEW');
            const blocked = blockingError(preview);
            if (blocked)
                throw blocked;
            const workIds: string[] = [];
            for (const w of preview.proposedWorks) {
                // A real Work (R04 Early Work): known WorkType, unit and quantity; contractor, responsible, cost and provisional dates NULL — never invented.
                const work = await one(c, `INSERT INTO works(tenant_id,object_id,work_type_id,name,unit,planned_quantity,contractor_id,responsible_user_id,estimated_cost,planned_start_date,planned_finish_date)
                    VALUES($1,$2,$3,$4,$5,$6,NULL,NULL,NULL,NULL,NULL) RETURNING *`, [a.tenantId, ctx.objectId, w.workTypeId, w.name, w.unit, w.quantity]);
                for (const q of w.areaQuantities)
                    await c.query(`INSERT INTO work_scope_bindings(tenant_id,object_id,work_id,finish_type_id,system_version_id,occurrence_id,occurrence_key,area_scope_id,measure_scope,basis_quantity,command_id,created_by)
                        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [a.tenantId, ctx.objectId, work.id, ft.id, w.sourceSystemVersionId, w.occurrenceId, w.occurrenceKey, q.areaScopeId, w.measureScope, q.quantity, commandId, a.id]);
                await audit(c, a, 'Work', work.id, 'CREATE', null, { ...work, generatedFrom: { finishTypeId: ft.id, systemVersionId: w.sourceSystemVersionId, occurrenceId: w.occurrenceId, areaScopeIds: w.areaScopeIds, commandId } });
                workIds.push(work.id);
            }
            const scope = (await one(c, 'SELECT scope_version::text AS v FROM work_scope_state WHERE tenant_id=$1 AND object_id=$2', [a.tenantId, ctx.objectId])).v;
            return { resultIds: workIds, appliedVersions: { aggregate: String(ft.version), scope }, warnings: preview.warnings };
        }, { legacy: [Permission.WORK_CREATE] })).result;
    }).catch(mapR05DbError);
}
