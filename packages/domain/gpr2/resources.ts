/**
 * GPR-2 R01 — nested-resource ownership preflight (Technical Design §11.1, §12.4; acceptance A19; finding R01-B04).
 *
 * A path such as /objects/{objectId}/quantity-change-requests/{id} names TWO things. `objectId` is the object the caller's scope is checked against
 * (objectAccess). `{id}` is an aggregate inside it, and a UUID that is merely well formed proves nothing about it: it may not exist, may belong to
 * another object of the same tenant, or to another tenant altogether. The tenant-level corporate publication requests have no `objectId` at all, so
 * their only protection is that the request belongs to the caller's tenant.
 *
 * The persistence of these aggregates arrives with later stages (R03 ledger, R05 catalogues, R07 quantity, R11 revisions, R15–R17 imports), and R01
 * adds no table. What it fixes is the CONTRACT every one of those stages implements, in this position of the pipeline:
 *
 *   authenticate → permission → object scope → nested resource preflight → envelope → replay → execute
 *
 * `Gpr2ResourceResolver` answers one question — "who owns this aggregate?" — and the guard, not the resolver, decides what the answer permits:
 *
 *   found, same tenant, and (object-scoped route) the SAME object / (tenant-level route) no object      → proceed
 *   anything else: not found, other object, other tenant, malformed answer, a resolver that says nothing → the one scope-safe 404
 *
 * It is mandatory (Gpr2Hooks.resources has no optional form) and the default, DENY_ALL_RESOURCES, knows no aggregate — so until a stage supplies a
 * resolver that has verified its owner, a command addressed to an aggregate never reaches replay or execute. A command with no `{id}` (create, upload)
 * addresses no existing aggregate and needs no preflight. IDs carried INSIDE a payload (workId, calendarVersionId …) are not path resources: their
 * syntax is the envelope's, their ownership is the owning stage's under its own transaction (listed as a deferred extension in the contract document).
 */
import type { Gpr2Endpoint } from './endpoints';
import { pathParamsOf } from './endpoints';

export const GPR2_RESOURCE_KINDS = [
    'WORK', 'WORK_TYPE', 'WORK_TYPE_PUBLICATION_REQUEST', 'FINISH_SYSTEM', 'FINISH_TEMPLATE', 'QUANTITY_CHANGE_REQUEST', 'CALENDAR_VERSION',
    'SCHEDULE_REVISION', 'FINISH_CHANGE_RECORD', 'BOQ_IMPORT', 'ESTIMATE_LABOR_IMPORT', 'IMPORT_BATCH'
] as const;
export type Gpr2ResourceKind = typeof GPR2_RESOURCE_KINDS[number];
/** Kinds that belong to the tenant, not to an object: their routes carry no `{objectId}` (corporate publication). */
export const TENANT_LEVEL_RESOURCE_KINDS: readonly Gpr2ResourceKind[] = ['WORK_TYPE_PUBLICATION_REQUEST', 'FINISH_TEMPLATE'];

export interface Gpr2ResourceRef {
    kind: Gpr2ResourceKind;
    /** A well-formed UUID, lower-cased. */
    id: string;
}
export type Gpr2ResourceOwnership = { found: false } | { found: true; tenantId: string; objectId: string | null };
export interface Gpr2ResourceResolver {
    /** Who owns this aggregate. Read-only: it must not create, lock for update, or write anything. */
    resolve(ref: Gpr2ResourceRef): Promise<Gpr2ResourceOwnership>;
}
/** The default until a stage supplies a verified owner lookup: no aggregate is known, so none is addressable. */
export const DENY_ALL_RESOURCES: Gpr2ResourceResolver = Object.freeze({ resolve: async () => ({ found: false as const }) });

/** The resource refs a call addresses, one per `{id}` of the path. */
export function resourceRefsOf(endpoint: Gpr2Endpoint, params: Record<string, string>): Gpr2ResourceRef[] {
    if (!endpoint.resource)
        return [];
    return pathParamsOf(endpoint).filter(name => name === endpoint.resource!.param).map(name => ({ kind: endpoint.resource!.kind, id: String(params[name]).toLowerCase() }));
}

const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.length > 0 && a.toLowerCase() === b.toLowerCase();

/** Whether an ownership answer permits THIS caller on THIS route. Strict about the shape of the answer: a doubtful one is a refusal. */
export function ownershipPermits(answer: unknown, caller: { tenantId: string }, route: { scope: 'OBJECT' | 'TENANT'; objectId: string | null }): boolean {
    const o = answer as { found?: unknown; tenantId?: unknown; objectId?: unknown } | null | undefined;
    if (!o || typeof o !== 'object' || o.found !== true || !same(o.tenantId, caller.tenantId))
        return false;
    return route.scope === 'OBJECT' ? route.objectId !== null && same(o.objectId, route.objectId) : o.objectId === null;
}
