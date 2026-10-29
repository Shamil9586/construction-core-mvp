import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { one, pool, rows } from './db';
import { Actor, objectAccess } from './security';
import { runSnapshotRead } from './tx-context';
import {
    AreaScopeRead, CursorBinding, CursorKey, FinishTemplateRead, FinishTypeRead, Gpr2Endpoint, Gpr2Permission, Page, ParsedReadQuery, PublicationRequestRead, StageRead,
    SystemStageRead, SystemVersionRead, TemplateVersionRead, VersionSummaryRead, WorkTypeRead, decodeCursor, encodeCursor, hasGpr2Permission, isAuthorized, parseReadQuery,
    permissionDenied, scopeSafeNotFound
} from '../../../packages/domain/gpr2';

/**
 * GPR-2 R05 / D1 — the five R05 reads (owner-authorised 29.10.2026). A read is NOT a command: it does not go through runGpr2Command, takes no
 * Idempotency-Key and writes nothing — not an audit row, not a ledger row, not a lock (one REPEATABLE READ READ ONLY snapshot: PostgreSQL itself
 * refuses any write in it, and every statement of a page sees the same committed state).
 *
 * Order, the same as a command's up to the envelope:
 *   1. authenticate      401  (the caller's route; the actor row is read from the database on every request, so a changed role takes effect at once)
 *   2. permission        403  from the CURRENT role, before any object is looked at
 *   3. path id + object  404  malformed, missing, another tenant's and another РП's object are one and the same answer
 *   4. query string      422  strict; after the scope check, so a caller outside the scope learns nothing from a validation message
 *   5. snapshot          the actor and the object scope are checked AGAIN on the snapshot's own rows, then the data is read
 * The tenant is always the actor's; no query parameter names a tenant, and every statement filters by it. Selected columns are an allow-list: no
 * `SELECT *`, no created_by / published_by, no origin_object_id (it can name another object), nothing the shape in r05-read.ts does not state.
 */
type Tx = { c: any };
type Mode = 'MANAGER' | 'ADMIN';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/;
/** `rows()` with an explicit row type: every statement below selects an explicit column list. */
const q = (c: any, sql: string, args: unknown[]): Promise<any[]> => rows(c, sql, args);
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));
const str = (v: unknown): string | null => (v == null ? null : String(v));

export async function runR05Read(endpoint: Gpr2Endpoint, input: { actor: Actor; params: Record<string, string>; query: unknown }): Promise<Page<unknown>> {
    const { actor, params } = input;
    const authorization = endpoint.authorization;
    if (endpoint.kind !== 'QUERY' || !endpoint.mounted || authorization.type !== 'ANY_PERMISSION' || !READERS[endpoint.id])
        throw new Error('runR05Read: ' + endpoint.id + ' is not a mounted R05 read');
    const subject = (a: { tenantId: string; id: string; role: string }) => ({ tenantId: a.tenantId, userId: a.id, role: a.role });
    // 2. permission — from the role as it is NOW.
    if (!isAuthorized(subject(actor), authorization, null))
        throw permissionDenied();
    // 3. path ids and scope.
    let objectId: string | null = null;
    if (endpoint.scope === 'OBJECT') {
        objectId = (params.objectId ?? '').toLowerCase();
        if (!UUID.test(objectId))
            throw scopeSafeNotFound();
    }
    const scopeCheck = async (c: any, a: Actor) => {
        if (!objectId) return;
        try { await objectAccess(c, a, objectId, false); }
        catch (e) {
            if (e instanceof NotFoundException || e instanceof ForbiddenException)
                throw scopeSafeNotFound();
            throw e;
        }
    };
    await scopeCheck(pool, actor);
    // 4. query string.
    const query = parseReadQuery(endpoint, input.query);
    // 5. one read-only snapshot.
    return runSnapshotRead(async (tx: Tx) => {
        const current: any = await one(tx.c, 'SELECT id, tenant_id, role, is_active, contractor_id FROM users WHERE tenant_id=$1 AND id=$2', [actor.tenantId, actor.id]);
        if (!current || !current.isActive || !isAuthorized(subject(current), authorization, null))
            throw permissionDenied();
        await scopeCheck(tx.c, current);
        const mode: Mode = hasGpr2Permission(current.role, Gpr2Permission.CORPORATE_PUBLICATION) ? 'ADMIN' : 'MANAGER';
        const ctx: ReadCtx = { c: tx.c, tenantId: current.tenantId, userId: current.id, objectId, mode, query, binding: { endpoint: endpoint.id, objectId, mode, state: query.state } };
        return READERS[endpoint.id](ctx);
    });
}

interface ReadCtx { c: any; tenantId: string; userId: string; objectId: string | null; mode: Mode; query: ParsedReadQuery; binding: CursorBinding }

/** The page: LIMIT+1 rows are read; the extra one only proves there is a next page and is never returned. */
function paged<T>(ctx: ReadCtx, fetched: any[], keyOf: (r: any) => CursorKey, map: (rs: any[]) => Promise<T[]>): Promise<Page<T>> {
    const more = fetched.length > ctx.query.limit;
    const rs = more ? fetched.slice(0, ctx.query.limit) : fetched;
    return map(rs).then(items => ({ items, nextCursor: more && rs.length ? encodeCursor(ctx.binding, keyOf(rs[rs.length - 1])) : null }));
}
const startKey = (ctx: ReadCtx, valid: (k: CursorKey) => boolean): CursorKey | null => (ctx.query.cursor ? decodeCursor(ctx.query.cursor, ctx.binding, valid) : null);
const textKey = (k: CursorKey) => UUID.test(k[1]);
const stampKey = (k: CursorKey) => STAMP.test(k[0]) && UUID.test(k[1]);

// ---------------------------------------------------------------------------------------------------------------------------------
async function workTypes(ctx: ReadCtx): Promise<Page<WorkTypeRead>> {
    const after = startKey(ctx, textKey);
    const args: unknown[] = [ctx.tenantId, ctx.objectId];
    let where = '';
    if (after) { args.push(after[0], after[1]); where = ' AND (name, id) > ($3::text, $4::uuid)'; }
    args.push(ctx.query.limit + 1);
    const fetched = await q(ctx.c, `SELECT id, scope, name, category_id, unit, requires_inspection, requires_executive_docs, requires_materials, is_active, alias_of_work_type_id, version, created_at, updated_at
        FROM work_types WHERE tenant_id=$1 AND (scope='CORPORATE' OR (scope='OBJECT' AND object_id=$2))${where} ORDER BY name, id LIMIT $${args.length}`, args);
    return paged(ctx, fetched, r => [r.name, r.id], async rs => rs.map(r => ({
        id: r.id, scope: r.scope, name: r.name, categoryId: r.categoryId, unit: r.unit, requiresInspection: r.requiresInspection, requiresExecutiveDocs: r.requiresExecutiveDocs,
        requiresMaterials: r.requiresMaterials, isActive: r.isActive, aliasOfWorkTypeId: r.aliasOfWorkTypeId ?? null, version: String(r.version), createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt)
    })));
}

async function areaScopes(ctx: ReadCtx): Promise<Page<AreaScopeRead>> {
    const after = startKey(ctx, textKey);
    const args: unknown[] = [ctx.tenantId, ctx.objectId];
    let where = '';
    if (after) { args.push(after[0], after[1]); where = ' AND (code, id) > ($3::text, $4::uuid)'; }
    args.push(ctx.query.limit + 1);
    const fetched = await q(ctx.c, `SELECT id, parent_id, kind, code, name, measure_quantity::text AS measure_quantity, measure_unit, lifecycle, version, created_at, updated_at
        FROM object_area_scopes WHERE tenant_id=$1 AND object_id=$2${where} ORDER BY code, id LIMIT $${args.length}`, args);
    return paged(ctx, fetched, r => [r.code, r.id], async rs => rs.map(r => ({
        id: r.id, parentId: r.parentId ?? null, kind: r.kind, code: r.code, name: r.name, measureQuantity: str(r.measureQuantity), measureUnit: r.measureUnit ?? null,
        lifecycle: r.lifecycle, version: String(r.version), createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt)
    })));
}

const versionSummary = (v: any): VersionSummaryRead => ({ id: v.id, versionNumber: Number(v.versionNumber), state: v.state, contentHash: v.contentHash ?? null, publishedAt: isoOrNull(v.publishedAt), createdAt: iso(v.createdAt) });
const stageOf = (s: any): StageRead => ({
    id: s.id, occurrenceKey: s.occurrenceKey, position: Number(s.position), workTypeId: s.workTypeId, workTypeName: s.workTypeName ?? null, required: s.required, measureScope: s.measureScope,
    measureUnit: s.measureUnit, proposedHoldHours: str(s.proposedHoldHours), proposedHoldStatus: s.proposedHoldStatus
});
const group = <T>(list: T[], key: (t: T) => string): Map<string, T[]> => {
    const m = new Map<string, T[]>();
    for (const t of list) { const k = key(t); (m.get(k) ?? m.set(k, []).get(k)!).push(t); }
    return m;
};

async function finishSystems(ctx: ReadCtx): Promise<Page<FinishTypeRead>> {
    const after = startKey(ctx, textKey);
    const args: unknown[] = [ctx.tenantId, ctx.objectId];
    let where = '';
    if (after) { args.push(after[0], after[1]); where = ' AND (code, id) > ($3::text, $4::uuid)'; }
    args.push(ctx.query.limit + 1);
    const fetched = await q(ctx.c, `SELECT id, code, name, lifecycle, version, created_at, updated_at FROM object_finish_types WHERE tenant_id=$1 AND object_id=$2${where} ORDER BY code, id LIMIT $${args.length}`, args);
    return paged(ctx, fetched, r => [r.code, r.id], async rs => {
        const ids = rs.map(r => r.id);
        const versions = ids.length ? await q(ctx.c, `SELECT id, finish_type_id, version_number, source_template_version_id, state, content_hash, published_at, created_at
            FROM object_finish_system_versions WHERE tenant_id=$1 AND object_id=$2 AND finish_type_id = ANY($3::uuid[]) ORDER BY finish_type_id, version_number DESC`, [ctx.tenantId, ctx.objectId, ids]) : [];
        const byType = group(versions, v => v.finishTypeId);
        const currentOf = (typeId: string) => (byType.get(typeId) ?? []).find(v => v.state === 'PUBLISHED');
        const currentIds = ids.map(currentOf).filter(Boolean).map((v: any) => v.id);
        const stages = currentIds.length ? await q(ctx.c, `SELECT o.id, o.system_version_id, o.occurrence_key, o.position, o.work_type_id, w.name AS work_type_name, o.required, o.measure_scope, o.measure_unit,
                o.proposed_hold_hours::text AS proposed_hold_hours, o.proposed_hold_status, o.override_kind, o.override_reason, o.source_template_version_id, o.source_template_stage_id
            FROM finish_stage_occurrences o LEFT JOIN work_types w ON w.tenant_id=o.tenant_id AND w.id=o.work_type_id AND (w.scope='CORPORATE' OR w.object_id=o.object_id)
            WHERE o.tenant_id=$1 AND o.object_id=$2 AND o.system_version_id = ANY($3::uuid[]) ORDER BY o.system_version_id, o.position`, [ctx.tenantId, ctx.objectId, currentIds]) : [];
        const exclusions = currentIds.length ? await q(ctx.c, `SELECT system_version_id, template_stage_id, source_template_version_id, reason FROM finish_stage_exclusions
            WHERE tenant_id=$1 AND object_id=$2 AND system_version_id = ANY($3::uuid[]) ORDER BY system_version_id, template_stage_id`, [ctx.tenantId, ctx.objectId, currentIds]) : [];
        const stagesBy = group(stages, s => s.systemVersionId), exclBy = group(exclusions, e => e.systemVersionId);
        return rs.map((r): FinishTypeRead => {
            const cur = currentOf(r.id);
            const summary = (v: any) => ({ ...versionSummary(v), sourceTemplateVersionId: v.sourceTemplateVersionId ?? null });
            const currentVersion: SystemVersionRead | null = cur ? {
                ...summary(cur),
                stages: (stagesBy.get(cur.id) ?? []).map((s): SystemStageRead => ({ ...stageOf(s), overrideKind: s.overrideKind, overrideReason: s.overrideReason ?? null,
                    sourceTemplateVersionId: s.sourceTemplateVersionId ?? null, sourceTemplateStageId: s.sourceTemplateStageId ?? null })),
                exclusions: (exclBy.get(cur.id) ?? []).map(e => ({ templateStageId: e.templateStageId, sourceTemplateVersionId: e.sourceTemplateVersionId, reason: e.reason }))
            } : null;
            return { id: r.id, code: r.code, name: r.name, lifecycle: r.lifecycle, version: String(r.version), createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
                versions: (byType.get(r.id) ?? []).map(summary), currentVersion };
        });
    });
}

/** Corporate templates only — no object column exists on them. A РП sees templates that have a PUBLISHED version, and only those versions; ADMIN sees DRAFT too. */
async function finishTemplates(ctx: ReadCtx): Promise<Page<FinishTemplateRead>> {
    const after = startKey(ctx, textKey);
    const admin = ctx.mode === 'ADMIN';
    const args: unknown[] = [ctx.tenantId];
    let where = admin ? '' : ` AND EXISTS (SELECT 1 FROM finish_template_versions pv WHERE pv.tenant_id=t.tenant_id AND pv.template_id=t.id AND pv.state='PUBLISHED')`;
    if (after) { args.push(after[0], after[1]); where += ` AND (t.code, t.id) > ($2::text, $3::uuid)`; }
    args.push(ctx.query.limit + 1);
    const fetched = await q(ctx.c, `SELECT t.id, t.code, t.name, t.lifecycle, t.version, t.created_at, t.updated_at FROM finish_templates t WHERE t.tenant_id=$1${where} ORDER BY t.code, t.id LIMIT $${args.length}`, args);
    return paged(ctx, fetched, r => [r.code, r.id], async rs => {
        const ids = rs.map(r => r.id);
        const versions = ids.length ? await q(ctx.c, `SELECT id, template_id, version_number, state, content_hash, published_at, created_at FROM finish_template_versions
            WHERE tenant_id=$1 AND template_id = ANY($2::uuid[])${admin ? '' : ` AND state='PUBLISHED'`} ORDER BY template_id, version_number DESC`, [ctx.tenantId, ids]) : [];
        const byTemplate = group(versions, v => v.templateId);
        const latest = (templateId: string, state: string) => (byTemplate.get(templateId) ?? []).find(v => v.state === state);
        const shown = ids.flatMap(id => [latest(id, 'PUBLISHED'), admin ? latest(id, 'DRAFT') : undefined]).filter(Boolean).map((v: any) => v.id);
        const stages = shown.length ? await q(ctx.c, `SELECT s.id, s.template_version_id, s.occurrence_key, s.position, s.work_type_id, w.name AS work_type_name, s.required, s.measure_scope, s.measure_unit,
                s.proposed_hold_hours::text AS proposed_hold_hours, s.proposed_hold_status
            FROM finish_template_stages s LEFT JOIN work_types w ON w.tenant_id=s.tenant_id AND w.id=s.work_type_id AND w.scope='CORPORATE'
            WHERE s.tenant_id=$1 AND s.template_version_id = ANY($2::uuid[]) ORDER BY s.template_version_id, s.position`, [ctx.tenantId, shown]) : [];
        const stagesBy = group(stages, s => s.templateVersionId);
        const withStages = (v: any): TemplateVersionRead | null => (v ? { ...versionSummary(v), stages: (stagesBy.get(v.id) ?? []).map(stageOf) } : null);
        return rs.map((r): FinishTemplateRead => ({
            id: r.id, code: r.code, name: r.name, lifecycle: r.lifecycle, version: String(r.version), createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
            versions: (byTemplate.get(r.id) ?? []).map(versionSummary), currentVersion: withStages(latest(r.id, 'PUBLISHED')), draftVersion: admin ? withStages(latest(r.id, 'DRAFT')) : null
        }));
    });
}

/** ONE object's requests. A РП reads the requests that РП filed; ADMIN (CORPORATE_PUBLICATION) reads the requests of the explicitly chosen object — never several objects. */
async function publicationRequests(ctx: ReadCtx): Promise<Page<PublicationRequestRead>> {
    const after = startKey(ctx, k => STAMP.test(k[0]) && UUID.test(k[1]));
    const args: unknown[] = [ctx.tenantId, ctx.objectId];
    let where = '';
    if (ctx.mode === 'MANAGER') { args.push(ctx.userId); where += ` AND r.requested_by=$${args.length}`; }
    if (ctx.query.state) { args.push(ctx.query.state); where += ` AND r.status=$${args.length}`; }
    if (after) { args.push(after[0], after[1]); where += ` AND (r.created_at, r.id) < ($${args.length - 1}::timestamptz, $${args.length}::uuid)`; }
    args.push(ctx.query.limit + 1);
    const fetched = await q(ctx.c, `SELECT r.id, r.work_type_id, r.work_type_version, r.proposed_name, r.proposed_category_id, r.proposed_unit, r.justification, r.requested_by, r.status, r.outcome,
            r.alias_of_work_type_id, r.decided_by, r.decided_at, r.decision_reason, r.version, r.created_at, r.updated_at,
            to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_key,
            w.scope AS wt_scope, w.name AS wt_name, w.unit AS wt_unit, w.version AS wt_version, w.alias_of_work_type_id AS wt_alias
        FROM work_type_publication_requests r JOIN work_types w ON w.tenant_id=r.tenant_id AND w.id=r.work_type_id
        WHERE r.tenant_id=$1 AND r.object_id=$2${where} ORDER BY r.created_at DESC, r.id DESC LIMIT $${args.length}`, args);
    return paged(ctx, fetched, r => [r.createdKey, r.id], async rs => rs.map((r): PublicationRequestRead => ({
        id: r.id, workTypeId: r.workTypeId, workTypeVersion: String(r.workTypeVersion), proposedName: r.proposedName, proposedCategoryId: r.proposedCategoryId, proposedUnit: r.proposedUnit,
        justification: r.justification ?? null, requestedById: r.requestedBy, status: r.status, outcome: r.outcome ?? null, aliasOfWorkTypeId: r.aliasOfWorkTypeId ?? null,
        decidedById: r.decidedBy ?? null, decidedAt: isoOrNull(r.decidedAt), decisionReason: r.decisionReason ?? null, version: String(r.version), createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
        workType: { id: r.workTypeId, scope: r.wtScope, name: r.wtName, unit: r.wtUnit, version: String(r.wtVersion), aliasOfWorkTypeId: r.wtAlias ?? null }
    })));
}

const READERS: Readonly<Record<string, (ctx: ReadCtx) => Promise<Page<any>>>> = Object.freeze({
    'work-types.list': workTypes, 'area-scopes.list': areaScopes, 'finish-systems.list': finishSystems, 'finish-templates.list': finishTemplates,
    'work-type-publication-requests.list': publicationRequests
});
