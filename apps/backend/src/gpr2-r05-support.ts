import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { one } from './db';
import { Actor, objectAccess } from './security';
import { Executed, LedgerOutcome, ledgerCommandOf, runLedgered } from './command-ledger';
import type { Gpr2CommandContext } from './gpr2-command-guard';
import { Permission, hasPermission } from '../../../packages/domain';
import {
    CommandResult, Gpr2Error, Gpr2ResourceOwnership, Gpr2ResourceRef, isAuthorized, ownershipPermits, permissionDenied, resourceRefsOf, scopeSafeNotFound, validationFailed
} from '../../../packages/domain/gpr2';

/**
 * GPR-2 R05 — what every R05 command does the same way (Technical Design §11.1, §12.3–12.4; R01 guard order, R03 transaction / lock / ledger).
 *
 * The HTTP guard (gpr2-command-guard.ts) has already done authenticate → permission → object scope → nested resource → envelope → replay before an
 * R05 handler runs. Inside the handler's OWN transaction the order is:
 *   1. coordinate()      the object coordination lock, FIRST statement (R03b: before any row lock; the registry decides SHARED / EXCLUSIVE)
 *   2. runLedgered()     authorize → claim → compare → replay | execute → complete (R03c)
 *        authorize = reauthorize(): the actor's CURRENT row (FOR SHARE, active), the endpoint's GPR-2 grant from the current role, the object scope and
 *        the nested resource's owner — re-read on THIS transaction, so a role revoked, an object reassigned or a resource moved between the guard and
 *        the lock is refused, and a stored result is never replayed to a caller who could not issue the command now (A19).
 *   3. the mutation, its audit rows and the ledger result commit together, or nothing does (A30).
 */
export const OWNER_SQL: Partial<Record<Gpr2ResourceRef['kind'], string>> = {
    WORK_TYPE: 'SELECT tenant_id, object_id FROM work_types WHERE id=$1',
    WORK_TYPE_PUBLICATION_REQUEST: 'SELECT tenant_id, NULL::uuid AS object_id FROM work_type_publication_requests WHERE id=$1',
    FINISH_SYSTEM: 'SELECT tenant_id, object_id FROM object_finish_types WHERE id=$1',
    FINISH_TEMPLATE: 'SELECT tenant_id, NULL::uuid AS object_id FROM finish_templates WHERE id=$1'
};

/** Who owns an R05 aggregate. Read-only, one plain SELECT; any other kind is unknown here (and therefore unaddressable). */
export async function resolveR05Owner(db: any, ref: Gpr2ResourceRef): Promise<Gpr2ResourceOwnership> {
    const sql = OWNER_SQL[ref.kind];
    if (!sql || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ref.id))
        return { found: false };
    const row = (await db.query(sql, [ref.id])).rows[0];
    return row ? { found: true, tenantId: row.tenant_id, objectId: row.object_id ?? null } : { found: false };
}

/** The caller as the database knows them NOW, re-checked against everything the guard checked before the lock. Returns the current actor row. */
export async function reauthorize(c: any, ctx: Gpr2CommandContext, extra: { legacy?: Permission[]; readOnly?: boolean } = {}): Promise<Actor> {
    // A READ ONLY snapshot (a pure preview) cannot take a row lock; it reads the same rows in its one snapshot instead.
    const current: Actor | undefined = await one(c, `SELECT * FROM users WHERE tenant_id=$1 AND id=$2 ${extra.readOnly ? '' : 'FOR SHARE'}`, [ctx.actor.tenantId, ctx.actor.id]);
    if (!current || !(current as any).isActive)
        throw permissionDenied();
    if (ctx.endpoint.authorization.type === 'EXISTING_RULES' || !isAuthorized({ tenantId: current.tenantId, userId: current.id, role: current.role }, ctx.endpoint.authorization, ctx.objectId))
        throw permissionDenied();
    for (const p of extra.legacy ?? [])
        if (!hasPermission(current.role, p))
            throw permissionDenied();
    if (ctx.objectId)
        try {
            await objectAccess(c, current, ctx.objectId, true);
        }
        catch (e) {
            if (e instanceof NotFoundException || e instanceof ForbiddenException)
                throw scopeSafeNotFound();
            throw e;
        }
    for (const ref of resourceRefsOf(ctx.endpoint, ctx.params))
        if (!ownershipPermits(await resolveR05Owner(c, ref), { tenantId: current.tenantId }, { scope: ctx.endpoint.scope, objectId: ctx.objectId }))
            throw scopeSafeNotFound();
    return current;
}

/** runLedgered() with the R05 authorize step and the ledger scope the replay hook uses (ledgerCommandOf: the same key → the same row). */
export function ledgered(c: any, ctx: Gpr2CommandContext, execute: (current: Actor, commandId: string) => Promise<Executed>, extra: { legacy?: Permission[] } = {}): Promise<LedgerOutcome> {
    let current: Actor | null = null;
    return runLedgered(c, ledgerCommandOf(ctx), {
        authorize: async () => { current = await reauthorize(c, ctx, extra); },
        execute: commandId => execute(current!, commandId)
    });
}

const DB_CODES: Record<string, Gpr2Error['code']> = {
    CROSS_SCOPE_REFERENCE: 'CROSS_SCOPE_REFERENCE', ONE_PRODUCER_CONFLICT: 'ONE_PRODUCER_CONFLICT', AREA_SCOPE_CONFLICT: 'AREA_SCOPE_CONFLICT',
    INVALID_MEASUREMENT: 'INVALID_MEASUREMENT', UNIT_IMMUTABLE: 'INVALID_MEASUREMENT', VERSION_IMMUTABLE: 'VERSION_IMMUTABLE', DECIDED_IMMUTABLE: 'INVALID_TRANSITION',
    SCOPE_CHANGE_FORBIDDEN: 'INVALID_TRANSITION', ALIAS_FORBIDDEN: 'INVALID_TRANSITION', MISSING_REQUIRED_DATA: 'MISSING_REQUIRED_DATA', STALE_SOURCE_VERSION: 'STALE_SOURCE_VERSION',
    PROVENANCE_MISMATCH: 'VALIDATION_FAILED', APPEND_ONLY: 'VERSION_IMMUTABLE', IDENTITY_IMMUTABLE: 'INVALID_TRANSITION', HISTORICAL_WORK: 'INVALID_TRANSITION'
};
/** Unique indexes whose violation is a business answer, not a 409 "data conflict". */
const UNIQUE_CODES: Record<string, () => Gpr2Error> = {
    work_scope_bindings_one_producer: () => new Gpr2Error('ONE_PRODUCER_CONFLICT'),
    work_type_publication_requests_one_pending: () => new Gpr2Error('INVALID_TRANSITION', { machine: 'WORK_TYPE_PUBLICATION_REQUEST', from: 'PENDING', command: 'work-type.publication.request' }),
    work_type_publication_requests_one_approved: () => new Gpr2Error('INVALID_TRANSITION', { machine: 'WORK_TYPE_PUBLICATION_REQUEST', from: 'APPROVED', command: 'work-type.publication.request' }),
    object_area_scopes_code_uq: () => validationFailed([{ path: 'code', rule: 'DUPLICATE_VALUE' }]),
    object_finish_types_code_uq: () => validationFailed([{ path: 'finishType.code', rule: 'DUPLICATE_VALUE' }]),
    finish_templates_code_uq: () => validationFailed([{ path: 'code', rule: 'DUPLICATE_VALUE' }]),
    finish_template_versions_one_draft: () => new Gpr2Error('INVALID_TRANSITION', { machine: 'FINISH_TEMPLATE_VERSION', from: 'DRAFT', command: 'finish-template.draft' }),
    object_finish_system_versions_one_draft: () => new Gpr2Error('INVALID_TRANSITION', { machine: 'FINISH_SYSTEM_VERSION', from: 'DRAFT', command: 'finish-system.upsert' }),
    finish_template_versions_tenant_id_template_id_version_number_key: () => new Gpr2Error('STALE_VERSION', { token: 'expectedVersion' }),
    object_finish_system_versions_tenant_id_finish_type_id_version_number_key: () => new Gpr2Error('STALE_SOURCE_VERSION')
};

/**
 * A refusal raised by an R05 trigger carries `GPR2_R05:<CODE>` (infra/029–035) and becomes the contract error; a violated R05 unique index becomes its
 * business answer. Anything else propagates unchanged. Never echoes the database message to the caller.
 */
export function mapR05DbError(e: any): never {
    if (e instanceof Gpr2Error)
        throw e;
    const m = typeof e?.message === 'string' ? /GPR2_R05:([A-Z_]+)/.exec(e.message) : null;
    if (m && DB_CODES[m[1]])
        throw new Gpr2Error(DB_CODES[m[1]]);
    if (e?.code === '23505' && UNIQUE_CODES[e.constraint])
        throw UNIQUE_CODES[e.constraint]();
    throw e;
}

export const resultOf = (outcome: LedgerOutcome): CommandResult => outcome.result;
