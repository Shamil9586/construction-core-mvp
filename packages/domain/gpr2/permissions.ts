/**
 * GPR-2 R01 — who may do what with the new functions (Technical Design §11.3, §14; decisions D05/D11/D18, C10; acceptance A19).
 *
 * WHY A SEPARATE ENUM. packages/domain/index.ts grants ADMIN `Object.values(Permission)`: every member added to that enum is handed to ADMIN
 * automatically. The design forbids exactly that for the new functions ("new permissions are listed explicitly, not through
 * Object.values(Permission) for ADMIN" — C10, E10). The GPR-2 permissions therefore live HERE, outside that enum: nothing that enumerates
 * `Permission` can ever see them, and the only way a role holds one is a line in GPR2_GRANTS below. The existing ADMIN line is untouched —
 * its set is exactly what it was, and tests pin that.
 *
 * ONE PERMISSION PER ROW OF THE §11.3 MATRIX, so the matrix can be checked row by row:
 *   SCHEDULE_AUTHOR          GPR draft / edit / submit            РП (project manager) only — the deputy and ADMIN do NOT edit
 *   SCHEDULE_REVIEW          GPR approve / return                 DEPUTY_DIRECTOR only
 *   QUANTITY_AUTHOR          quantity propose / submit            РП only
 *   QUANTITY_REVIEW          quantity approve / return            DEPUTY_DIRECTOR only
 *   QUANTITY_REVIEW_NOTE     optional PTO review note             NOBODY by default — "PTO by an explicit review grant" (§11.2, §11.3
 *                                                                 «если разрешена»): who holds it is not fixed by the design
 *   EXTERNAL_OUTCOME_RECORD  record external suitability / reuse  РП only — a registration of an external decision, never an approval
 *   OBJECT_CATALOG_MANAGE    object WorkType / finish-system adaptation and publication PROPOSALS      РП
 *   CORPORATE_PUBLICATION    corporate WorkType / template publication (approve / reject)             ADMIN — the one explicit Admin grant
 *   IMPORT_MANAGE            BoQ and estimate-labor upload / allocate / commit                         РП
 *
 * The existing GPR-1 grants (SCHEDULE_EDIT held by the deputy, ADMIN holding all) belong to the legacy contour and are NOT changed here:
 * that contour stays operative until the cutover stages. These permissions guard only the new /v2 commands.
 *
 * N01 — ESTIMATE_MAPPING_REVIEW is not a role permission at all. It is an object-scoped capability assigned to a named employee through a
 * procedure the owner has not yet defined. Until then NOBODY holds it: no role (ADMIN included) implies it, and with no assignment on
 * record the answer is always "no".
 */
import { roles, Role } from '../index';

export enum Gpr2Permission {
    SCHEDULE_AUTHOR = 'GPR2_SCHEDULE_AUTHOR',
    SCHEDULE_REVIEW = 'GPR2_SCHEDULE_REVIEW',
    QUANTITY_AUTHOR = 'GPR2_QUANTITY_AUTHOR',
    QUANTITY_REVIEW = 'GPR2_QUANTITY_REVIEW',
    QUANTITY_REVIEW_NOTE = 'GPR2_QUANTITY_REVIEW_NOTE',
    EXTERNAL_OUTCOME_RECORD = 'GPR2_EXTERNAL_OUTCOME_RECORD',
    OBJECT_CATALOG_MANAGE = 'GPR2_OBJECT_CATALOG_MANAGE',
    CORPORATE_PUBLICATION = 'GPR2_CORPORATE_PUBLICATION',
    IMPORT_MANAGE = 'GPR2_IMPORT_MANAGE'
}
export const GPR2_PERMISSIONS: readonly Gpr2Permission[] = Object.freeze(Object.values(Gpr2Permission));

const P = Gpr2Permission;
// Every role is listed, with an empty array where it holds nothing: a role added to `roles` later fails to compile here until someone decides.
export const GPR2_GRANTS: Readonly<Record<Role, readonly Gpr2Permission[]>> = Object.freeze({
    ADMIN: Object.freeze([P.CORPORATE_PUBLICATION]),
    GENERAL_DIRECTOR: Object.freeze([]),
    DEPUTY_DIRECTOR: Object.freeze([P.SCHEDULE_REVIEW, P.QUANTITY_REVIEW]),
    PROJECT_MANAGER: Object.freeze([P.SCHEDULE_AUTHOR, P.QUANTITY_AUTHOR, P.EXTERNAL_OUTCOME_RECORD, P.OBJECT_CATALOG_MANAGE, P.IMPORT_MANAGE]),
    CONSTRUCTION_CONTROL: Object.freeze([]),
    CONSTRUCTION_CONTROL_HEAD: Object.freeze([]),
    PTO: Object.freeze([]),
    PTO_HEAD: Object.freeze([]),
    SDO: Object.freeze([]),
    SDO_HEAD: Object.freeze([]),
    CONTRACTOR_VIEWER: Object.freeze([])
});

export function hasGpr2Permission(role: string | null | undefined, permission: Gpr2Permission): boolean {
    return typeof role === 'string' && Object.prototype.hasOwnProperty.call(GPR2_GRANTS, role) && GPR2_GRANTS[role as Role].includes(permission);
}

/** The whole matrix as data: role → permissions held. Used by the A19 tests and by anything that must render the matrix. */
export const gpr2RoleMatrix = (): Record<Role, Gpr2Permission[]> =>
    Object.fromEntries(roles.map(r => [r, [...GPR2_GRANTS[r]]])) as Record<Role, Gpr2Permission[]>;

// ---------------------------------------------------------------------------------------------------------------------------------
// N01 — the object-scoped estimate-mapping review capability. Default deny.
// ---------------------------------------------------------------------------------------------------------------------------------

export const ESTIMATE_MAPPING_REVIEW = 'ESTIMATE_MAPPING_REVIEW' as const;
export type EstimateMappingReviewCapability = typeof ESTIMATE_MAPPING_REVIEW;

/** A named employee holding the capability on ONE object. Created only by the (still undefined) N01 procedure; R01 defines the shape. */
export interface CapabilityAssignment {
    tenantId: string;
    objectId: string;
    userId: string;
    capability: EstimateMappingReviewCapability;
    assignedBy: string;
    assignedAt: string;
    revokedAt: string | null;
}
export const NO_CAPABILITY_ASSIGNMENTS: readonly CapabilityAssignment[] = Object.freeze([]);

/**
 * True only for an active, exactly-matching assignment of THIS user on THIS object in THIS tenant. The caller's role is not an input: no
 * role grants the capability, and there is nothing to default it from.
 */
export function hasEstimateMappingReviewCapability(subject: { tenantId: string; userId: string }, objectId: string | null,
                                                    assignments: readonly CapabilityAssignment[] = NO_CAPABILITY_ASSIGNMENTS): boolean {
    if (!objectId)
        return false;
    return assignments.some(a => a.capability === ESTIMATE_MAPPING_REVIEW && a.tenantId === subject.tenantId && a.objectId === objectId
        && a.userId === subject.userId && a.revokedAt === null);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// How an endpoint states who may call it, and the one function that decides.
// ---------------------------------------------------------------------------------------------------------------------------------

export type EndpointAuthorization =
    | { type: 'PERMISSION'; permission: Gpr2Permission }
    // "PM / designated specialist by N01" (§11.2 mapping-proposals): either the import grant or the object capability.
    | { type: 'PERMISSION_OR_CAPABILITY'; permission: Gpr2Permission; capability: EstimateMappingReviewCapability }
    // "Only an N01-approved scoped specialist capability" (§11.2 mapping-reviews): no role path exists.
    | { type: 'CAPABILITY'; capability: EstimateMappingReviewCapability };

export interface AuthorizationSubject { tenantId: string; userId: string; role: string }
export function isAuthorized(subject: AuthorizationSubject, authorization: EndpointAuthorization, objectId: string | null,
                             assignments: readonly CapabilityAssignment[] = NO_CAPABILITY_ASSIGNMENTS): boolean {
    const capability = () => hasEstimateMappingReviewCapability(subject, objectId, assignments);
    switch (authorization.type) {
        case 'PERMISSION': return hasGpr2Permission(subject.role, authorization.permission);
        case 'PERMISSION_OR_CAPABILITY': return hasGpr2Permission(subject.role, authorization.permission) || capability();
        case 'CAPABILITY': return capability();
        default: return false;
    }
}
