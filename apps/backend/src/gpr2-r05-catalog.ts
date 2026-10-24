import { one } from './db';
import { audit } from './security';
import { runCommandTx } from './tx-context';
import { coordinate } from './coordination-lock';
import { ledgered, mapR05DbError } from './gpr2-r05-support';
import type { Gpr2CommandContext } from './gpr2-command-guard';
import { Actor } from './security';
import { runLedgered } from './command-ledger';
import { authorizeObjectCatalog } from './gpr2-r05-legacy';
import {
    CommandResult, Gpr2Error, WORK_TYPE_PUBLICATION_REQUEST, areaScopeCreatePayload, assertAggregateVersion, commandFingerprint, parseR05Payload, publicationRequestPayload,
    transitionForEndpoint, workTypeCreatePayload, CODE_PATTERN
} from '../../../packages/domain/gpr2';

/**
 * GPR-2 R05a — one WorkType model, two scopes (Technical Design §5.2, §11.2–11.3; decisions D03, D05; scenarios A03, A19).
 *
 *   work-type.create                РП, own object: a NEW OBJECT-scope WorkType. Never a corporate one, never a copy or a merge of a same-named type —
 *                                   a same name is reported (warning SAME_NAME_EXISTS) and the new type gets its own id.
 *   work-type.publication.request   РП: a separate, explicit proposal to make that object type corporate. It snapshots the proposed metadata.
 *   work-type.publication.approve   Admin (CORPORATE_PUBLICATION, the one explicit Admin grant): PROMOTED — the SAME id becomes corporate, every
 *                                   historical reference keeps pointing at it; or ALIASED — the object type stays an object type and names a reviewed
 *                                   corporate type of the same unit. Neither rewrites a Work, a WEU or a fact.
 *   work-type.publication.reject    Admin, with a reason. The object WorkType is left exactly as it was.
 * PostgreSQL enforces the same rules (infra/029): a scope change without an approved request, an alias without one, a cross-object use of an object
 * type, a unit change of a referenced type and any edit of a decided request are refused by triggers whatever path a write comes from.
 */
const ok = (resultIds: string[], aggregate: number | string | null, warnings: { code: string; path?: string }[] = []) =>
    ({ resultIds, appliedVersions: { aggregate: aggregate === null ? null : String(aggregate), scope: null }, warnings });

export async function createObjectWorkType(ctx: Gpr2CommandContext): Promise<CommandResult> {
    const d = parseR05Payload(workTypeCreatePayload, ctx.command.payload);
    return runCommandTx(async tx => {
        await coordinate(tx.c, 'gpr2-r05-catalog.ts#createObjectWorkType', ctx.actor.tenantId, { object: ctx.objectId! });
        const c = tx.c;
        return (await ledgered(c, ctx, async a => {
            if (!await one(c, 'SELECT id FROM work_categories WHERE tenant_id=$1 AND id=$2', [a.tenantId, d.categoryId]))
                throw new Gpr2Error('CROSS_SCOPE_REFERENCE', { violations: [{ path: 'categoryId', rule: 'REFERENCE_NOT_IN_SCOPE' }] });
            // Same name in the corporate catalogue or in this object: shown, never merged (D05 "no auto-merge by name").
            const same = await one(c, "SELECT count(*)::int AS n FROM work_types WHERE tenant_id=$1 AND lower(btrim(name))=lower($2) AND (scope='CORPORATE' OR object_id=$3)", [a.tenantId, d.name, ctx.objectId]);
            const row = await one(c, `INSERT INTO work_types(tenant_id,category_id,name,unit,requires_inspection,requires_executive_docs,requires_materials,is_active,scope,object_id,origin_object_id,created_by)
                VALUES($1,$2,$3,$4,$5,$6,$7,true,'OBJECT',$8,$8,$9) RETURNING *`,
                [a.tenantId, d.categoryId, d.name, d.unit, d.requiresInspection, d.requiresExecutiveDocs, d.requiresMaterials, ctx.objectId, a.id]);
            await audit(c, a, 'WorkType', row.id, 'CREATE_OBJECT_SCOPE', null, row);
            return ok([row.id], row.version, same.n > 0 ? [{ code: 'SAME_NAME_EXISTS', path: 'name' }] : []);
        })).result;
    }).catch(mapR05DbError);
}

export async function requestWorkTypePublication(ctx: Gpr2CommandContext): Promise<CommandResult> {
    const d = parseR05Payload(publicationRequestPayload, ctx.command.payload);
    const id = ctx.params.id.toLowerCase();
    return runCommandTx(async tx => {
        await coordinate(tx.c, 'gpr2-r05-catalog.ts#requestWorkTypePublication', ctx.actor.tenantId, { object: ctx.objectId! });
        const c = tx.c;
        return (await ledgered(c, ctx, async a => {
            const wt = await one(c, 'SELECT * FROM work_types WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id]);
            if (!wt || wt.scope !== 'OBJECT' || wt.objectId !== ctx.objectId)
                throw new Gpr2Error('RESOURCE_NOT_FOUND');
            assertAggregateVersion(ctx.command.expectedVersion as any, wt.version);
            if (wt.aliasOfWorkTypeId)
                throw new Gpr2Error('INVALID_TRANSITION', { machine: 'WORK_TYPE_PUBLICATION_REQUEST', from: 'APPROVED', command: 'work-type.publication.request' });
            const req = await one(c, `INSERT INTO work_type_publication_requests(tenant_id,object_id,work_type_id,work_type_version,proposed_name,proposed_category_id,proposed_unit,justification,requested_by)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [a.tenantId, ctx.objectId, wt.id, wt.version, wt.name, wt.categoryId, wt.unit, d.justification ?? null, a.id]);
            await audit(c, a, 'WorkTypePublicationRequest', req.id, 'REQUEST', null, req);
            return ok([req.id], req.version);
        })).result;
    }).catch(mapR05DbError);
}

async function decidedRequest(c: any, ctx: Gpr2CommandContext, tenantId: string) {
    const req = await one(c, 'SELECT * FROM work_type_publication_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, ctx.params.id.toLowerCase()]);
    if (!req)
        throw new Gpr2Error('RESOURCE_NOT_FOUND');
    assertAggregateVersion(ctx.command.expectedVersion as any, req.version);
    transitionForEndpoint(WORK_TYPE_PUBLICATION_REQUEST, req.status, ctx.endpoint.id); // only PENDING has a row; a decided request is final
    return req;
}

export async function approveWorkTypePublication(ctx: Gpr2CommandContext): Promise<CommandResult> {
    const alias: string | undefined = ctx.command.payload?.aliasOfWorkTypeId;
    return runCommandTx(async tx => {
        await coordinate(tx.c, 'gpr2-r05-catalog.ts#approveWorkTypePublication', ctx.actor.tenantId, { workTypePublicationRequest: ctx.params.id });
        const c = tx.c;
        return (await ledgered(c, ctx, async a => {
            const req = await decidedRequest(c, ctx, a.tenantId);
            const wt = await one(c, 'SELECT * FROM work_types WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, req.workTypeId]);
            if (wt.scope !== 'OBJECT')
                throw new Gpr2Error('INVALID_TRANSITION', { machine: 'WORK_TYPE_PUBLICATION_REQUEST', from: 'PENDING', command: ctx.endpoint.id });
            if (wt.version !== req.workTypeVersion)
                throw new Gpr2Error('STALE_SOURCE_VERSION'); // the type changed after the request snapshot: the decision would be about something else
            if (alias) {
                const target = await one(c, 'SELECT * FROM work_types WHERE tenant_id=$1 AND id=$2', [a.tenantId, alias]);
                if (!target || target.scope !== 'CORPORATE' || target.id === wt.id)
                    throw new Gpr2Error('CROSS_SCOPE_REFERENCE', { violations: [{ path: 'aliasOfWorkTypeId', rule: 'REFERENCE_NOT_IN_SCOPE' }] });
                if (target.unit !== wt.unit)
                    throw new Gpr2Error('INVALID_MEASUREMENT', { violations: [{ path: 'aliasOfWorkTypeId', rule: 'UNIT_MISMATCH' }] });
            }
            const decided = await one(c, `UPDATE work_type_publication_requests SET status='APPROVED', outcome=$3, alias_of_work_type_id=$4, decided_by=$5, decided_at=now(), version=version+1, updated_at=now()
                WHERE tenant_id=$1 AND id=$2 RETURNING *`, [a.tenantId, req.id, alias ? 'ALIASED' : 'PROMOTED', alias ?? null, a.id]);
            // PROMOTED keeps the id (TD §5.2 "Publication сохраняет ID"); ALIASED keeps the object type and its id. Neither touches a Work.
            const changed = alias
                ? await one(c, 'UPDATE work_types SET alias_of_work_type_id=$3, version=version+1, updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *', [a.tenantId, wt.id, alias])
                : await one(c, "UPDATE work_types SET scope='CORPORATE', object_id=NULL, version=version+1, updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *", [a.tenantId, wt.id]);
            await audit(c, a, 'WorkTypePublicationRequest', req.id, 'APPROVE', req, decided);
            await audit(c, a, 'WorkType', wt.id, alias ? 'ALIAS_TO_CORPORATE' : 'PROMOTE_TO_CORPORATE', wt, changed);
            return ok([req.id, wt.id], decided.version);
        })).result;
    }).catch(mapR05DbError);
}

export async function rejectWorkTypePublication(ctx: Gpr2CommandContext): Promise<CommandResult> {
    const reason: string = ctx.command.payload.reason;
    return runCommandTx(async tx => {
        await coordinate(tx.c, 'gpr2-r05-catalog.ts#rejectWorkTypePublication', ctx.actor.tenantId, { workTypePublicationRequest: ctx.params.id });
        const c = tx.c;
        return (await ledgered(c, ctx, async a => {
            const req = await decidedRequest(c, ctx, a.tenantId);
            const decided = await one(c, `UPDATE work_type_publication_requests SET status='REJECTED', decided_by=$3, decided_at=now(), decision_reason=$4, version=version+1, updated_at=now()
                WHERE tenant_id=$1 AND id=$2 RETURNING *`, [a.tenantId, req.id, a.id, reason]);
            await audit(c, a, 'WorkTypePublicationRequest', req.id, 'REJECT', req, decided);
            return ok([req.id], decided.version); // the WorkType row is not written: a rejection leaves the object type as it was (D05)
        })).result;
    }).catch(mapR05DbError);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// GPR-2 R05b — AreaScopes and the object finish registry (TD §4.1, §5.2; D03, D20).
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * area-scope.create — РП, own object. A stable spatial identity: any kind may sit under any kind (no fixed building → section → floor → room
 * hierarchy is imposed on an object), the parent must be an AreaScope of the SAME object, and a measured child can never make its parent's children
 * measure more of the same unit than the parent (PostgreSQL checks it under a lock on the parent row — infra/030).
 */
export async function createAreaScope(ctx: Gpr2CommandContext): Promise<CommandResult> {
    const d = parseR05Payload(areaScopeCreatePayload, ctx.command.payload);
    return runCommandTx(async tx => {
        await coordinate(tx.c, 'gpr2-r05-catalog.ts#createAreaScope', ctx.actor.tenantId, { object: ctx.objectId! });
        const c = tx.c;
        return (await ledgered(c, ctx, async a => {
            if (d.parentId && !await one(c, 'SELECT id FROM object_area_scopes WHERE tenant_id=$1 AND object_id=$2 AND id=$3', [a.tenantId, ctx.objectId, d.parentId]))
                throw new Gpr2Error('CROSS_SCOPE_REFERENCE', { violations: [{ path: 'parentId', rule: 'REFERENCE_NOT_IN_SCOPE' }] });
            const row = await one(c, `INSERT INTO object_area_scopes(tenant_id,object_id,parent_id,kind,code,name,measure_quantity,measure_unit,created_by)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [a.tenantId, ctx.objectId, d.parentId ?? null, d.kind, d.code, d.name, d.measureQuantity ?? null, d.measureUnit ?? null, a.id]);
            await audit(c, a, 'AreaScope', row.id, 'CREATE', null, row);
            return ok([row.id], row.version);
        })).result;
    }).catch(mapR05DbError);
}

/** Inside a caller's transaction: a new entry of the object's finish registry. The code is a stable identity, unique in the object for ever. */
export async function insertObjectFinishType(c: any, a: Actor, objectId: string, input: { code: string; name: string }) {
    const row = await one(c, 'INSERT INTO object_finish_types(tenant_id,object_id,code,name,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *', [a.tenantId, objectId, input.code, input.name, a.id]);
    await audit(c, a, 'ObjectFinishType', row.id, 'CREATE', null, row);
    return row;
}

/**
 * Service entry (no own route: the HTTP path is finish-system.upsert, R05c): register an object finish type on its own — "Тип №1", "Тип №2" … —
 * so a registry entry can exist before its first system version. Same authorisation as the object catalogue commands; idempotent with a key.
 */
export async function registerObjectFinishType(actor: Actor, objectId: string, input: { code: string; name: string }, idempotencyKey: string | null = null): Promise<CommandResult> {
    if (typeof input?.code !== 'string' || !CODE_PATTERN.test(input.code) || typeof input?.name !== 'string' || !input.name.trim())
        throw new Gpr2Error('VALIDATION_FAILED', { violations: [{ path: 'code', rule: 'FIELD_TYPE' }] });
    const payload = { code: input.code, name: input.name.trim() };
    return runCommandTx(async tx => {
        await coordinate(tx.c, 'gpr2-r05-catalog.ts#registerObjectFinishType', actor.tenantId, { object: objectId });
        const c = tx.c;
        let current: Actor;
        return (await runLedgered(c, {
            tenantId: actor.tenantId, actorId: actor.id, commandKind: 'finish-type.register', scopeId: objectId.toLowerCase(), idempotencyKey,
            fingerprint: commandFingerprint({ commandKind: 'finish-type.register', payload, expectedVersion: null, expectedScopeVersion: null, sourceVersions: {} })
        }, {
            authorize: async () => { current = await authorizeObjectCatalog(c, actor, objectId, true); },
            execute: async () => { const row = await insertObjectFinishType(c, current, objectId, payload); return ok([row.id], row.version); }
        })).result;
    }).catch(mapR05DbError);
}
