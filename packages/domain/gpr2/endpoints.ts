/**
 * GPR-2 R01 — the endpoint register (Technical Design §11.1–11.3; decisions D05/D11/D18, C10; acceptance A19).
 *
 * §11.2 lists the complete business API surface of the first implementation. This is that table as data, and it is the single source for
 * everything that has to agree about a command: its route, who may call it, whether it carries an Idempotency-Key / expectedVersion /
 * expectedScopeVersion, which lifecycle transition it performs, and which stage implements it. The HTTP layer mounts routes from it and the
 * tests check the matrix against it, so a command cannot gain a route without a permission or a permission without a row here.
 *
 *   mounted   R01 mounts a guarded, feature-gated route (authenticate → permission → validate → scope → 501). Every mounted route is a COMMAND
 *             whose authorization the design fixes. Queries and commands authorised by "existing rules" are catalogued, not mounted: R01 adds
 *             no read path and widens no existing right.
 *   stage     the roadmap stage that gives the command its behaviour; until then it answers COMMAND_NOT_ENABLED.
 *
 * Paths are relative to /api/v2. `{objectId}` is the object prefix of §11.1; the corporate publication commands are tenant-level and carry none.
 *
 * NOT IN THE REGISTER, ON PURPOSE: any "approve-suitability" route or permission (K03/D22 — suitability is an external decision the РП records,
 * there is no internal approval route), and any generic PATCH of a Work's current quantity, baseline, fact or suitability (§11.2 closing note).
 */
import { EndpointAuthorization, Gpr2Permission, ESTIMATE_MAPPING_REVIEW } from './permissions';
import type { Gpr2ResourceKind } from './resources';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT';
export type EndpointScope = 'OBJECT' | 'TENANT';
export type RegisterAuthorization = EndpointAuthorization | { type: 'EXISTING_RULES' };

export interface Gpr2Endpoint {
    id: string;
    method: HttpMethod;
    path: string;
    kind: 'COMMAND' | 'QUERY';
    scope: EndpointScope;
    authorization: RegisterAuthorization;
    /** Idempotency-Key header required (a pure preview and every query: no). */
    idempotent: boolean;
    /** `expectedVersion` — the optimistic token of the one aggregate the command changes. */
    aggregateVersion: boolean;
    /** `expectedScopeVersion` — the object-scope fence (§12.2) for scope-sensitive commands. */
    scopeFence: boolean;
    /** Previews and queries: must never mutate. */
    pure: boolean;
    stage: string;
    mounted: boolean;
    /**
     * The lifecycle rows this command can perform (lifecycle.ts), when it performs any. One endpoint may be several rows of the SAME machine,
     * told apart by the current state: PATCH quantity-change-requests/{id} is `edit` in DRAFT and `revise` in RETURNED (R01-B02). The row to
     * apply is chosen by transitionForEndpoint(machine, state, endpoint.id); a state with no row refuses (INVALID_TRANSITION).
     */
    transitions?: readonly { lifecycle: string; command: string }[];
    /**
     * The aggregate named by the path's `{id}`: its ownership is checked after object scope and BEFORE the envelope, replay and execute (resources.ts,
     * R01-B04). Present exactly when the path has an `{id}`.
     */
    resource?: { param: 'id'; kind: Gpr2ResourceKind };
    /** false when the design names the operation but not its route, so the path below is a proposal. */
    routeFixedByTd: boolean;
}

const P = Gpr2Permission;
const perm = (permission: Gpr2Permission): EndpointAuthorization => ({ type: 'PERMISSION', permission });
const EXISTING: RegisterAuthorization = { type: 'EXISTING_RULES' };
const O = '/objects/{objectId}';

interface Spec { id: string; method: HttpMethod; path: string; auth: RegisterAuthorization; stage: string; scope?: EndpointScope; idem?: boolean; version?: boolean; fence?: boolean;
                 pure?: boolean; transitions?: Gpr2Endpoint['transitions']; fixed?: boolean; mounted?: boolean; res?: Gpr2ResourceKind }
const command = (s: Spec): Gpr2Endpoint => ({
    id: s.id, method: s.method, path: s.path, kind: 'COMMAND', scope: s.scope ?? 'OBJECT', authorization: s.auth,
    idempotent: s.pure ? false : s.idem ?? true, aggregateVersion: s.version ?? false, scopeFence: s.fence ?? false, pure: !!s.pure, stage: s.stage,
    mounted: s.mounted ?? s.auth.type !== 'EXISTING_RULES', transitions: s.transitions, resource: resourceOf(s.path, s.res), routeFixedByTd: s.fixed ?? true
});
const query = (id: string, path: string, stage: string, res?: Gpr2ResourceKind): Gpr2Endpoint => ({
    id, method: 'GET', path, kind: 'QUERY', scope: 'OBJECT', authorization: EXISTING, idempotent: false, aggregateVersion: false, scopeFence: false,
    pure: true, stage, mounted: false, resource: resourceOf(path, res), routeFixedByTd: true
});
/** `res` is declared exactly where the path has an `{id}` — a register that breaks that rule does not load. */
const resourceOf = (path: string, kind?: Gpr2ResourceKind): Gpr2Endpoint['resource'] => {
    if (path.includes('{id}') !== (kind !== undefined))
        throw new Error('endpoint register: ' + path + (kind ? ' declares a resource but has no {id}' : ' has an {id} but declares no resource kind'));
    return kind ? { param: 'id', kind } : undefined;
};

const R = { gpr: 'GPR_REVISION', qty: 'QUANTITY_CHANGE_REQUEST', wt: 'WORK_TYPE_PUBLICATION_REQUEST', fc: 'FINISH_CHANGE_RECORD', ru: 'RESULT_USE' };

export const GPR2_ENDPOINTS: readonly Gpr2Endpoint[] = Object.freeze([
    // --- Work (R04) — authorised by the rules that already govern Works; R01 neither widens nor narrows them -------------------------------
    query('works.list', O + '/works', 'R04'),
    query('works.get', O + '/works/{id}', 'R04', 'WORK'),
    command({ id: 'works.create', method: 'POST', path: O + '/works', auth: EXISTING, stage: 'R04' }),
    command({ id: 'works.assignments.patch', method: 'PATCH', path: O + '/works/{id}/assignments', auth: EXISTING, stage: 'R04', version: true, res: 'WORK' }),

    // --- WorkType (D05, R05a) ----------------------------------------------------------------------------------------------------------
    command({ id: 'work-type.create', method: 'POST', path: O + '/work-types', auth: perm(P.OBJECT_CATALOG_MANAGE), stage: 'R05' }),
    command({ id: 'work-type.publication.request', method: 'POST', path: O + '/work-types/{id}/publication-requests', auth: perm(P.OBJECT_CATALOG_MANAGE), stage: 'R05', version: true, res: 'WORK_TYPE' }),
    command({ id: 'work-type.publication.approve', method: 'POST', path: '/work-type-publication-requests/{id}/approve', scope: 'TENANT', auth: perm(P.CORPORATE_PUBLICATION), stage: 'R05', version: true,
              transitions: [{ lifecycle: R.wt, command: 'approve' }], res: 'WORK_TYPE_PUBLICATION_REQUEST' }),
    command({ id: 'work-type.publication.reject', method: 'POST', path: '/work-type-publication-requests/{id}/reject', scope: 'TENANT', auth: perm(P.CORPORATE_PUBLICATION), stage: 'R05', version: true,
              transitions: [{ lifecycle: R.wt, command: 'reject' }], res: 'WORK_TYPE_PUBLICATION_REQUEST' }),

    // --- Finish systems and templates (D06, R05c–d) ------------------------------------------------------------------------------------
    query('finish-systems.list', O + '/finish-systems', 'R05'),
    command({ id: 'finish-system.upsert', method: 'POST', path: O + '/finish-systems', auth: perm(P.OBJECT_CATALOG_MANAGE), stage: 'R05' }),
    command({ id: 'finish-system.preview', method: 'POST', path: O + '/finish-systems/{id}/preview', auth: perm(P.OBJECT_CATALOG_MANAGE), stage: 'R05', pure: true, version: true, res: 'FINISH_SYSTEM' }),
    command({ id: 'finish-system.confirm', method: 'POST', path: O + '/finish-systems/{id}/confirm', auth: perm(P.OBJECT_CATALOG_MANAGE), stage: 'R05', version: true, fence: true, res: 'FINISH_SYSTEM' }),
    // §11.2 / §11.3 name "corporate template publication — Admin dictionary grant" but give it no route: the path is a proposal, not mounted.
    command({ id: 'finish-template.publish', method: 'POST', path: '/finish-templates/{id}/publish', scope: 'TENANT', auth: perm(P.CORPORATE_PUBLICATION), stage: 'R05', version: true,
              fixed: false, mounted: false, res: 'FINISH_TEMPLATE' }),

    // --- Quantity (D17, D18, D19, R07) -------------------------------------------------------------------------------------------------
    command({ id: 'quantity.request.create', method: 'POST', path: O + '/quantity-change-requests', auth: perm(P.QUANTITY_AUTHOR), stage: 'R07', fence: true }),
    // R01-B02: one PATCH, two rows of the machine. In DRAFT it edits the draft in place; in RETURNED it is the correction that reopens the request
    // as DRAFT. SUBMITTED and APPROVED have no row, so the PATCH is refused there (a submitted version is immutable, an approved request final).
    command({ id: 'quantity.request.patch', method: 'PATCH', path: O + '/quantity-change-requests/{id}', auth: perm(P.QUANTITY_AUTHOR), stage: 'R07', version: true,
              transitions: [{ lifecycle: R.qty, command: 'edit' }, { lifecycle: R.qty, command: 'revise' }], res: 'QUANTITY_CHANGE_REQUEST' }),
    command({ id: 'quantity.request.submit', method: 'POST', path: O + '/quantity-change-requests/{id}/submit', auth: perm(P.QUANTITY_AUTHOR), stage: 'R07', version: true, fence: true,
              transitions: [{ lifecycle: R.qty, command: 'submit' }], res: 'QUANTITY_CHANGE_REQUEST' }),
    command({ id: 'quantity.request.review-note', method: 'POST', path: O + '/quantity-change-requests/{id}/review-notes', auth: perm(P.QUANTITY_REVIEW_NOTE), stage: 'R07', version: true, res: 'QUANTITY_CHANGE_REQUEST' }),
    command({ id: 'quantity.request.approve', method: 'POST', path: O + '/quantity-change-requests/{id}/approve', auth: perm(P.QUANTITY_REVIEW), stage: 'R07', version: true, fence: true,
              transitions: [{ lifecycle: R.qty, command: 'approve' }], res: 'QUANTITY_CHANGE_REQUEST' }),
    command({ id: 'quantity.request.return', method: 'POST', path: O + '/quantity-change-requests/{id}/return', auth: perm(P.QUANTITY_REVIEW), stage: 'R07', version: true,
              transitions: [{ lifecycle: R.qty, command: 'return' }], res: 'QUANTITY_CHANGE_REQUEST' }),
    query('quantities.history', O + '/quantities/history', 'R06'),

    // --- Calendars (D07, K04, R10) -----------------------------------------------------------------------------------------------------
    query('calendars.list', O + '/calendars/versions', 'R10'),
    command({ id: 'calendar.version.create', method: 'POST', path: O + '/calendars/versions', auth: perm(P.SCHEDULE_AUTHOR), stage: 'R10' }),
    command({ id: 'calendar.version.patch', method: 'PATCH', path: O + '/calendars/versions/{id}', auth: perm(P.SCHEDULE_AUTHOR), stage: 'R10', version: true, res: 'CALENDAR_VERSION' }),

    // --- Schedule (D11–D17, K02, R11–R14) ----------------------------------------------------------------------------------------------
    query('schedule.current', O + '/schedule/current', 'R13'),
    query('schedule.revision.get', O + '/schedule/revisions/{id}', 'R11', 'SCHEDULE_REVISION'),
    query('schedule.evaluation', O + '/schedule/evaluation', 'R13'),
    command({ id: 'schedule.revision.create', method: 'POST', path: O + '/schedule/revisions', auth: perm(P.SCHEDULE_AUTHOR), stage: 'R11' }),
    command({ id: 'schedule.changes.preview', method: 'POST', path: O + '/schedule/revisions/{id}/changes/preview', auth: perm(P.SCHEDULE_AUTHOR), stage: 'R14', pure: true, version: true, res: 'SCHEDULE_REVISION' }),
    command({ id: 'schedule.changes.apply', method: 'POST', path: O + '/schedule/revisions/{id}/changes/apply', auth: perm(P.SCHEDULE_AUTHOR), stage: 'R14', version: true, res: 'SCHEDULE_REVISION' }),
    command({ id: 'schedule.backplan.preview', method: 'POST', path: O + '/schedule/revisions/{id}/backplan-preview', auth: perm(P.SCHEDULE_AUTHOR), stage: 'R14', pure: true, version: true, res: 'SCHEDULE_REVISION' }),
    command({ id: 'schedule.revision.submit', method: 'POST', path: O + '/schedule/revisions/{id}/submit', auth: perm(P.SCHEDULE_AUTHOR), stage: 'R12', version: true, fence: true,
              transitions: [{ lifecycle: R.gpr, command: 'submit' }], res: 'SCHEDULE_REVISION' }),
    command({ id: 'schedule.revision.discard', method: 'POST', path: O + '/schedule/revisions/{id}/discard', auth: perm(P.SCHEDULE_AUTHOR), stage: 'R11', version: true,
              transitions: [{ lifecycle: R.gpr, command: 'discard' }], res: 'SCHEDULE_REVISION' }),
    command({ id: 'schedule.revision.approve', method: 'POST', path: O + '/schedule/revisions/{id}/approve', auth: perm(P.SCHEDULE_REVIEW), stage: 'R12', version: true, fence: true,
              transitions: [{ lifecycle: R.gpr, command: 'approve' }], res: 'SCHEDULE_REVISION' }),
    command({ id: 'schedule.revision.return', method: 'POST', path: O + '/schedule/revisions/{id}/return', auth: perm(P.SCHEDULE_REVIEW), stage: 'R12', version: true,
              transitions: [{ lifecycle: R.gpr, command: 'return' }], res: 'SCHEDULE_REVISION' }),

    // --- Production release (C07, R08) -------------------------------------------------------------------------------------------------
    query('works.release', O + '/works/{id}/release', 'R08', 'WORK'),

    // --- External outcome and ResultUse (K03, D21–D23, R09) ----------------------------------------------------------------------------
    command({ id: 'finish-change.record-external-outcome', method: 'POST', path: O + '/finish-changes/record-external-outcome', auth: perm(P.EXTERNAL_OUTCOME_RECORD), stage: 'R09' }),
    command({ id: 'finish-change.record-correction', method: 'POST', path: O + '/finish-changes/{id}/record-correction', auth: perm(P.EXTERNAL_OUTCOME_RECORD), stage: 'R09', version: true,
              transitions: [{ lifecycle: R.fc, command: 'record-correction' }], res: 'FINISH_CHANGE_RECORD' }),
    query('finish-changes.get', O + '/finish-changes/{id}', 'R09', 'FINISH_CHANGE_RECORD'),
    query('finish-changes.result-uses', O + '/finish-changes/{id}/result-uses', 'R09', 'FINISH_CHANGE_RECORD'),

    // --- Imports (K01, D02, R15–R17) ---------------------------------------------------------------------------------------------------
    command({ id: 'imports.boq.upload', method: 'POST', path: O + '/imports/boq', auth: perm(P.IMPORT_MANAGE), stage: 'R15' }),
    command({ id: 'imports.estimate-labor.upload', method: 'POST', path: O + '/imports/estimate-labor', auth: perm(P.IMPORT_MANAGE), stage: 'R16' }),
    query('imports.preview', O + '/imports/{id}/preview', 'R15', 'IMPORT_BATCH'),
    query('imports.issues', O + '/imports/{id}/issues', 'R15', 'IMPORT_BATCH'),
    command({ id: 'imports.boq.allocations', method: 'PUT', path: O + '/imports/boq/{id}/allocations', auth: perm(P.IMPORT_MANAGE), stage: 'R15', version: true, res: 'BOQ_IMPORT' }),
    command({ id: 'imports.boq.commit', method: 'POST', path: O + '/imports/boq/{id}/commit', auth: perm(P.IMPORT_MANAGE), stage: 'R15', version: true, fence: true, res: 'BOQ_IMPORT' }),
    command({ id: 'imports.estimate-labor.mapping-proposals', method: 'POST', path: O + '/imports/estimate-labor/{id}/mapping-proposals',
              auth: { type: 'PERMISSION_OR_CAPABILITY', permission: P.IMPORT_MANAGE, capability: ESTIMATE_MAPPING_REVIEW }, stage: 'R17', version: true, res: 'ESTIMATE_LABOR_IMPORT' }),
    command({ id: 'imports.estimate-labor.mapping-reviews', method: 'POST', path: O + '/imports/estimate-labor/{id}/mapping-reviews',
              auth: { type: 'CAPABILITY', capability: ESTIMATE_MAPPING_REVIEW }, stage: 'R17', version: true, res: 'ESTIMATE_LABOR_IMPORT' }),
    command({ id: 'imports.estimate-labor.commit', method: 'POST', path: O + '/imports/estimate-labor/{id}/commit', auth: perm(P.IMPORT_MANAGE), stage: 'R17', version: true, res: 'ESTIMATE_LABOR_IMPORT' }),

    // --- Read projections (R13, R17) ---------------------------------------------------------------------------------------------------
    query('physical-readiness', O + '/physical-readiness', 'R17'),
    query('labor-coverage', O + '/labor-coverage', 'R17')
]);

export const API_V2_PREFIX = '/api/v2';
export const endpointById = (id: string) => GPR2_ENDPOINTS.find(e => e.id === id);
export const mountedEndpoints = () => GPR2_ENDPOINTS.filter(e => e.mounted);
/** `/objects/{objectId}/x/{id}` → the `objects/:objectId/x/:id` form a route table uses, without the leading slash. */
export const routeOf = (e: Gpr2Endpoint) => e.path.replace(/^\//, '').replace(/\{(\w+)\}/g, ':$1');
export const pathParamsOf = (e: Gpr2Endpoint) => Array.from(e.path.matchAll(/\{(\w+)\}/g), m => m[1]);
