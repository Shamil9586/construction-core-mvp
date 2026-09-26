import Decimal from 'decimal.js';
export const roles = ['GENERAL_DIRECTOR', 'TECHNICAL_DIRECTOR', 'PROJECT_MANAGER', 'CONSTRUCTION_CONTROL', 'PTO', 'SDO', 'DEPARTMENT_HEAD', 'ADMIN', 'CONTRACTOR_VIEWER'] as const;
export type Role = typeof roles[number];
export enum Permission {
    OBJECT_VIEW = 'OBJECT_VIEW',
    OBJECT_CREATE = 'OBJECT_CREATE',
    OBJECT_EDIT = 'OBJECT_EDIT',
    OBJECT_MANAGE_CONTRACTORS = 'OBJECT_MANAGE_CONTRACTORS',
    WORK_VIEW = 'WORK_VIEW',
    WORK_CREATE = 'WORK_CREATE',
    WORK_UPDATE_PROGRESS = 'WORK_UPDATE_PROGRESS',
    INSPECTION_REQUEST = 'INSPECTION_REQUEST',
    INSPECTION_ACCEPT = 'INSPECTION_ACCEPT',
    INSPECTION_REJECT = 'INSPECTION_REJECT',
    ISSUE_CREATE = 'ISSUE_CREATE',
    ISSUE_RESOLVE = 'ISSUE_RESOLVE',
    ISSUE_VERIFY = 'ISSUE_VERIFY',
    PTO_VIEW = 'PTO_VIEW',
    PTO_EDIT = 'PTO_EDIT',
    PTO_TRANSFER_SDO = 'PTO_TRANSFER_SDO',
    SDO_VIEW = 'SDO_VIEW',
    SDO_EDIT = 'SDO_EDIT',
    SDO_CLOSE = 'SDO_CLOSE',
    FINANCE_VIEW = 'FINANCE_VIEW',
    FINANCE_EDIT = 'FINANCE_EDIT',
    ADMIN_USERS = 'ADMIN_USERS',
    ADMIN_DICTIONARIES = 'ADMIN_DICTIONARIES',
    // F8.1 — covers creating a work's execution units, their layers and their
    // quantity portions (decision 7's "portions management", one bundle, one
    // permission). Requesting/recording Internal SC and Customer SC reuse the
    // existing INSPECTION_REQUEST/INSPECTION_ACCEPT/INSPECTION_REJECT below —
    // Customer SC has no UI in F8.1 and no stated actor of its own yet, so it is
    // gated by the same permission as Internal SC's own accept/reject rather than
    // inventing an unrequested role split.
    EXECUTION_UNIT_MANAGE = 'EXECUTION_UNIT_MANAGE',
    // F8.2 — covers every PTO mutation on a Documentation Package: create
    // package, edit package, link a portion, create a document, create a
    // version, change status (F8.2 Architecture Contract's own bundle,
    // mirroring EXECUTION_UNIT_MANAGE above). Deliberately its own permission,
    // not PTO_EDIT: PTO_EDIT is the pre-F8.1 executive_packages/SDO-transfer
    // pipeline (packageAction() 'transfer-sdo' in service.ts), which F8.2 must
    // not touch or extend. Read access has no permission of its own — every
    // viewing role already has OBJECT_VIEW; who is actually excluded (SDO,
    // CONTRACTOR_VIEWER — "SDO: No F8.2 access") is decided once by
    // canAccessDocumentation() below, not by a permission bit PTO_VIEW-style
    // grants would give SDO anyway (SDO already holds PTO_VIEW via `view`).
    DOCUMENTATION_MANAGE = 'DOCUMENTATION_MANAGE',
    // F8.3 — every SDO-side mutation on an SDO Case: status transitions,
    // amount/allocation entry, responsible assignment, "Вернуть в ПТО".
    // Deliberately its own permission, not SDO_EDIT/SDO_CLOSE/FINANCE_EDIT:
    // those gate the pre-existing sdo_cases/financial_closings pipeline
    // (packageAction() 'transfer-sdo', calculateSdo(), close() in
    // service.ts), a payment/accounting-adjacent workflow F8.3's own
    // Definition of Done explicitly excludes ("Closing is NOT payment and
    // NOT accounting") — the same reasoning DOCUMENTATION_MANAGE already
    // applied against reusing PTO_EDIT. PTO does not hold this permission
    // ("PTO does NOT assign work inside the SDO department").
    SDO_CASE_MANAGE = 'SDO_CASE_MANAGE'
}
const view = [Permission.OBJECT_VIEW, Permission.WORK_VIEW, Permission.PTO_VIEW, Permission.SDO_VIEW, Permission.FINANCE_VIEW];
const grants: Record<Role, Permission[]> = { ADMIN: Object.values(Permission), GENERAL_DIRECTOR: view, TECHNICAL_DIRECTOR: [...view, Permission.OBJECT_CREATE, Permission.OBJECT_EDIT, Permission.OBJECT_MANAGE_CONTRACTORS, Permission.WORK_CREATE, Permission.EXECUTION_UNIT_MANAGE], DEPARTMENT_HEAD: view, PROJECT_MANAGER: [...view, Permission.OBJECT_CREATE, Permission.OBJECT_EDIT, Permission.OBJECT_MANAGE_CONTRACTORS, Permission.WORK_CREATE, Permission.EXECUTION_UNIT_MANAGE, Permission.WORK_UPDATE_PROGRESS, Permission.INSPECTION_REQUEST, Permission.ISSUE_RESOLVE], CONSTRUCTION_CONTROL: [...view, Permission.INSPECTION_ACCEPT, Permission.INSPECTION_REJECT, Permission.ISSUE_CREATE, Permission.ISSUE_VERIFY], PTO: [...view, Permission.PTO_EDIT, Permission.PTO_TRANSFER_SDO, Permission.DOCUMENTATION_MANAGE], SDO: [...view, Permission.SDO_EDIT, Permission.SDO_CLOSE, Permission.FINANCE_EDIT, Permission.SDO_CASE_MANAGE], CONTRACTOR_VIEWER: [Permission.OBJECT_VIEW, Permission.WORK_VIEW] };
export const hasPermission = (role: Role, p: Permission) => grants[role]?.includes(p) ?? false;
// F8.2 Architecture Contract: "SDO: No F8.2 access" and no contractor portal
// — the one place that decides who may see Executive Documentation data at
// all, called identically by ReadService.snapshot() (what a role's payload
// actually contains) and the dedicated documentation-packages list route,
// so the two cannot independently drift on who this excludes (the same
// discipline resolveInternalScAccepted() already enforces for F8.1).
export function canAccessDocumentation(role: Role): boolean {
    return role !== 'SDO' && role !== 'CONTRACTOR_VIEWER';
}
// F8.2.1 Decision 5, extended by the F8.2.1-01 corrective patch — PTO drives
// DRAFT through PRESENTED, and a presented package the customer returns can
// be corrected and presented again: RETURNED -> CORRECTING -> PRESENTED
// closes that loop (repeatable — PRESENTED's own outbound edge is still
// RETURNED, so a second return re-enters the same loop). Nothing else is
// legal: no same-status no-op, no backward move, no skip-ahead, CORRECTING
// is reachable only from RETURNED and leads only to PRESENTED (never back to
// READY_FOR_PRESENTATION), and ACCEPTED_BY_CUSTOMER remains unreachable —
// still not a PTO user action, per the Decision Lock. One allow-list, so the
// backend's own gate and any UI enabling/disabling a status button read the
// identical rule.
const ALLOWED_DOCUMENTATION_STATUS_TRANSITIONS: Record<string, string[]> = {
    DRAFT: ['PREPARING'],
    PREPARING: ['READY_FOR_PRESENTATION'],
    READY_FOR_PRESENTATION: ['PRESENTED'],
    PRESENTED: ['RETURNED'],
    RETURNED: ['CORRECTING'],
    CORRECTING: ['PRESENTED'],
    ACCEPTED_BY_CUSTOMER: [],
};
export function isDocumentationStatusTransitionAllowed(from: string, to: string): boolean {
    return ALLOWED_DOCUMENTATION_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}
// F8.3-17: Documentation Package *content* — its Documents, Document
// Versions, and Quantity Portion coverage — is a different axis from the
// Package's own status transitions above, but content mutation must obey
// its own freeze rule: DRAFT/PREPARING/READY_FOR_PRESENTATION/CORRECTING are
// content-editable; PRESENTED/ACCEPTED_BY_CUSTOMER/RETURNED are frozen
// snapshots of what was (or will be) shown externally and must never be
// silently mutated underneath them ("PRESENTED means this exact Package
// content was externally presented"). An SDO Case that currently holds the
// Package locked (package_locked=true — including a CLOSED case, which
// never unlocks on its own) freezes content too, regardless of the
// Package's own status column: belt-and-suspenders against any future path
// that might otherwise leave the two disagreeing. The one shared policy,
// called identically by every content mutation route
// (linkDocumentationPackagePortion, createDocumentationDocument,
// createDocumentationVersion, service.ts) so none can drift from the
// others — the same discipline every other F8.2/F8.3 shared predicate in
// this file already applies. Backend enforcement is authoritative; a
// frontend control being hidden is never itself the security boundary.
const DOCUMENTATION_CONTENT_EDITABLE_STATUSES = ['DRAFT', 'PREPARING', 'READY_FOR_PRESENTATION', 'CORRECTING'];
export interface DocumentationContentMutationResult {
    allowed: boolean;
    reason: string | null;
}
export function canMutateDocumentationPackageContent(input: {
    packageStatus: string;
    sdoCaseExists: boolean;
    sdoCasePackageLocked: boolean;
}): DocumentationContentMutationResult {
    if (!DOCUMENTATION_CONTENT_EDITABLE_STATUSES.includes(input.packageStatus))
        return { allowed: false, reason: `Состав пакета нельзя изменить в статусе «${input.packageStatus}»` };
    if (input.sdoCaseExists && input.sdoCasePackageLocked)
        return { allowed: false, reason: 'Состав пакета заблокирован: пакет передан в СДО' };
    return { allowed: true, reason: null };
}
// F8.2.1 Decision 4 — PTO Attention Queue: the one place that classifies a
// work's documentation readiness into the three-tier signal the queue
// shows, called identically by ReadService.snapshot() (what the queue
// displays) and — if a future pass needs it — any other caller, so the
// rule cannot be re-derived differently in two places (the same discipline
// resolveInternalScAccepted() already enforces for F8.1). A work is
// classified by the worst (most urgent) of its own packages' individual
// levels: one still-preparing or returned package keeps the whole work in
// the queue even if a sibling package is already presented. A work with no
// package at all is RED, the same urgency as one returned by the customer —
// both need PTO to start work now.
export type DocumentationAttentionLevel = 'RED' | 'YELLOW' | 'NONE';
export interface DocumentationAttentionResult {
    level: DocumentationAttentionLevel;
    reason: string | null;
}
function packageStatusAttention(status: string): DocumentationAttentionResult {
    switch (status) {
        case 'DRAFT':
        case 'PREPARING':
            return { level: 'YELLOW', reason: 'Документы формируются' };
        case 'CORRECTING':
            return { level: 'YELLOW', reason: 'Устраняются замечания' };
        case 'RETURNED':
            return { level: 'RED', reason: 'Возвращено заказчиком' };
        case 'READY_FOR_PRESENTATION':
        case 'PRESENTED':
        case 'ACCEPTED_BY_CUSTOMER':
            return { level: 'NONE', reason: null };
        default:
            return { level: 'NONE', reason: null };
    }
}
const DOCUMENTATION_ATTENTION_RANK: Record<DocumentationAttentionLevel, number> = { RED: 0, YELLOW: 1, NONE: 2 };
export function resolveDocumentationAttention(packageStatuses: string[]): DocumentationAttentionResult {
    if (packageStatuses.length === 0)
        return { level: 'RED', reason: 'Нет пакета ИД' };
    return packageStatuses
        .map(packageStatusAttention)
        .reduce((worst, current) => (DOCUMENTATION_ATTENTION_RANK[current.level] < DOCUMENTATION_ATTENTION_RANK[worst.level] ? current : worst));
}
// ---------------------------------------------------------------------
// F8.3 SDO / Closing. Hangs off documentation_packages/quantity_portions,
// exactly as F8.2 itself hangs off works — never the pre-existing
// executive_packages/sdo_cases/financial_closings pipeline (see
// infra/008_sdo_closing.sql). SDO status here never feeds
// ProgressCalculationService/ScheduleStatusService/ObjectHealthService, and
// nothing below reads or writes portion_quantity_confirmations/
// quantity_portions/works — F8.3 only ever reads Customer SC confirmations
// to decide readiness, never writes production facts.
// ---------------------------------------------------------------------
// F8.3 decision: SDO's own operational workspace (/sdo) — status
// transitions, amount/allocation entry, "Вернуть в ПТО" — is SDO/ADMIN
// only. Every other internal role gets read-only SDO state elsewhere
// (Work Card), never this predicate.
export function canAccessSdoWorkspace(role: Role): boolean {
    return role === 'SDO' || role === 'ADMIN';
}
// F8.3 SDO status workflow — the one allow-list, mirroring
// isDocumentationStatusTransitionAllowed's own discipline: ON_RECONCILIATION
// ("На выверке") <-> ON_CORRECTION and -> VERIFICATION_PASSED ("Выверка
// пройдена"); VERIFICATION_PASSED -> CLOSED ("Закрытие") or back to
// ON_CORRECTION; CLOSED -> ON_CORRECTION only (never a direct edit — a
// closed case must re-open through correction first). No same-status
// no-op, no other edge.
export const SDO_CLOSING_STATUSES = ['ON_RECONCILIATION', 'VERIFICATION_PASSED', 'ON_CORRECTION', 'CLOSED'] as const;
export type SdoClosingStatus = typeof SDO_CLOSING_STATUSES[number];
const ALLOWED_SDO_CLOSING_STATUS_TRANSITIONS: Record<string, string[]> = {
    ON_RECONCILIATION: ['VERIFICATION_PASSED', 'ON_CORRECTION'],
    VERIFICATION_PASSED: ['CLOSED', 'ON_CORRECTION'],
    ON_CORRECTION: ['ON_RECONCILIATION'],
    CLOSED: ['ON_CORRECTION'],
};
export function isSdoClosingStatusTransitionAllowed(from: string, to: string): boolean {
    return ALLOWED_SDO_CLOSING_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}
// F8.3 readiness (decision 7): (a) every Quantity Portion this package
// covers has at least one Customer SC quantity confirmation recorded —
// existence, exactly the contract's own wording ("confirmation exists"),
// never a magnitude/coverage match against planned quantity, which the
// contract never asks for; (b) a dedicated, audited customer documentation
// acceptance record exists (F8.3 decisions 9-10's own registration
// operation, never a free PTO status transition — see
// registerDocumentationCustomerAcceptance(), service.ts).
//
// `hasCustomerAcceptance` is deliberately not "documentation status ==
// ACCEPTED_BY_CUSTOMER" — the caller (service.ts/read-service.ts) computes
// it as "current status is ACCEPTED_BY_CUSTOMER AND at least one row exists
// in documentation_customer_acceptances for this package". The status flip
// alone is never sufficient on its own: it is the ordinary derived/display
// state that already happens to move in lockstep with the dedicated record
// today (the only code path that can set it also inserts the record, in the
// same transaction), but this function's own contract does not trust that
// coupling — it requires the audited fact to be independently true, so a
// hypothetical future bug that flips the status through some other path
// (skipping the dedicated operation) reads NOT ready rather than silently
// granting it. The status transitioning away on "Вернуть в ПТО"
// (returnSdoCaseToPto(), service.ts, moves it to CORRECTING) is what makes a
// *stale* acceptance record from a prior cycle correctly stop counting —
// combining both conditions, not the record's bare existence alone, is what
// keeps the correction cycle correct.
//
// A package with no covered portions at all is never ready — there is
// nothing for an SDO Case to close against. Called identically by
// ReadService.snapshot() (what Package Detail and the SDO workspace both
// display) and handoffDocumentationPackageToSdo()'s own server-side gate, so
// the two cannot diverge.
export interface SdoPackageReadinessResult {
    ready: boolean;
    missingReasons: string[];
}
export function resolvePackageSdoReadiness(input: {
    hasCustomerAcceptance: boolean;
    coveredPortionIds: string[];
    customerScConfirmedPortionIds: string[];
}): SdoPackageReadinessResult {
    const reasons: string[] = [];
    if (!input.hasCustomerAcceptance)
        reasons.push('Не зарегистрировано согласие заказчика по документации');
    if (input.coveredPortionIds.length === 0) {
        reasons.push('К пакету не привязан ни один участок объёма');
    }
    else {
        const confirmed = new Set(input.customerScConfirmedPortionIds);
        if (input.coveredPortionIds.some(id => !confirmed.has(id)))
            reasons.push('Не по всем участкам объёма есть подтверждение количества заказчиком (СК заказчика)');
    }
    return { ready: reasons.length === 0, missingReasons: reasons };
}
// F8.3-R02 corrective: documentation_customer_acceptances.documentation_package_version
// is the Package's own optimistic-lock row version, never a Documentation
// Document Version — a Package can hold several independently versioned
// documents (documentation_documents/documentation_document_versions,
// 007_documentation_foundation.sql), and createDocumentationVersion() never
// bumps the package's own version. The bare existence of an acceptance row
// (what hasCustomerAcceptance used to mean) cannot prove which actual
// document content the customer accepted, and cannot detect a document
// version added or changed *after* that acceptance — the old record would
// keep "covering" content the customer never saw.
//
// documentation_customer_acceptance_versions (infra/009_sdo_closing_corrective.sql)
// is the fix: an immutable snapshot, one row per Documentation Document
// Version that was current at the moment of registration, linked to that
// acceptance. This function is the one place that decides whether the
// *latest* acceptance's snapshot is still current: every Documentation
// Document the Package presently has must have a version, and that exact
// version id must appear in the snapshot — nothing missing, nothing extra
// (an extra id would mean the snapshot covers a document/version that no
// longer represents the package's current content either). Called
// identically by handoffDocumentationPackageToSdo()'s own gate and
// ReadService.snapshot()'s readiness computation (service.ts/read-service.ts),
// so the two cannot diverge — the same discipline resolvePackageSdoReadiness
// itself already applies.
//
// F8.3-R02b corrective: comparing acceptedVersionIds against
// currentVersionIds alone cannot detect a document with NO version at all —
// such a document contributes nothing to either array, so a package with
// "Document A (has v1), Document B (no version yet)" could read as current
// against a snapshot that only ever covered A, and adding a brand-new,
// versionless Document B after acceptance would not change either array
// either. `currentDocumentCount` is the fix: the caller passes the Package's
// *total* current document count (not merely how many happen to have a
// version), so a document with no version — whether present at registration
// (never actually reachable: registerDocumentationCustomerAcceptance()
// itself now refuses to register in that case) or added afterwards — makes
// `currentVersionIds.length !== currentDocumentCount` and this returns false.
// A Package with zero documents is never current either — there is nothing
// for an accepted snapshot to represent.
export function isCustomerAcceptanceSnapshotCurrent(input: {
    acceptedVersionIds: string[];
    /** Every Documentation Document the Package currently holds — including one with no version yet, unlike `currentVersionIds` below. */
    currentDocumentCount: number;
    /** The Package's current highest version id, one per document that actually has a version — shorter than `currentDocumentCount` exactly when some document has none. */
    currentVersionIds: string[];
}): boolean {
    if (input.currentDocumentCount === 0)
        return false;
    if (input.currentVersionIds.length !== input.currentDocumentCount)
        return false;
    if (input.acceptedVersionIds.length !== input.currentVersionIds.length)
        return false;
    const accepted = new Set(input.acceptedVersionIds);
    return input.currentVersionIds.every(id => accepted.has(id));
}
// F8.3 closing amount rule: "If no allocations exist, CLOSED is allowed
// using the total amount. If at least one Portion allocation exists, their
// sum must equal the total closing amount." A pure function over values the
// service layer already fetched, the same discipline QuantityPortionPolicy/
// PtoPackageValidationService already apply to their own cross-row rules.
export class SdoClosingAllocationService {
    canClose(totalAmount: any, allocations: { amount: any }[]): { allowed: boolean; reason: string | null } {
        if (totalAmount === null || totalAmount === undefined)
            return { allowed: false, reason: 'Не указана итоговая сумма закрытия' };
        if (allocations.length === 0)
            return { allowed: true, reason: null };
        const sum = allocations.reduce((s, a) => s.add(a.amount), new Decimal(0));
        return sum.eq(totalAmount) ? { allowed: true, reason: null } : { allowed: false, reason: 'Сумма распределения по участкам не совпадает с итоговой суммой закрытия' };
    }
}
export const defaultRisk = { yellowVariance: -5, redVariance: -15, staleDays: 7, ptoDays: 5, sdoDays: 10, escalateTechnicalDays: 3, escalateDirectorDays: 7 };
export class ProgressCalculationService {
    calculate(actual: any, planned: any) { return new Decimal(planned).gt(0) ? Decimal.min(100, Decimal.max(0, new Decimal(actual).div(planned).mul(100))).toNumber() : null; }
    // Core 2.0 decision log, п.3: явный сигнал "факт превышает план", отдельный от
    // calculate() (который намеренно клампит в [0,100] для светофора/UI) — не хранится
    // в БД, вычисляется транзиентно там же, где и остальные производные поля прогресса.
    isOverperformed(actual: any, planned: any) { return new Decimal(planned).gt(0) && new Decimal(actual).gt(planned); }
}
const day = (v: any) => new Date(v).getTime() / 86400000;
export class ScheduleStatusService {
    calculate(start: any, finish: any, actual: number | null, now = new Date(), risk = defaultRisk) { if (!start || !finish || actual === null || day(finish) < day(start))
        return { plannedProgress: null, actualProgress: actual, variance: null, delayDays: 0, scheduleStatus: 'GRAY' }; const duration = day(finish) - day(start); const planned = duration === 0 ? (day(now) >= day(finish) ? 100 : 0) : Math.min(100, Math.max(0, (day(now) - day(start)) / duration * 100)); const variance = actual - planned; return { plannedProgress: planned, actualProgress: actual, variance, delayDays: actual >= 100 ? 0 : Math.max(0, Math.ceil(day(now) - (day(start) + duration * actual / 100))), scheduleStatus: variance < risk.redVariance ? 'RED' : variance < risk.yellowVariance ? 'YELLOW' : 'GREEN' }; }
}
export class ObjectHealthService {
    calculate(signals: {
        statuses: string[];
        criticalIssues: number;
        overdueIssues: number;
        stale: boolean;
        ptoLate: boolean;
        sdoLate: boolean;
        blocked: boolean;
    }) { if (signals.criticalIssues || signals.overdueIssues || signals.blocked || signals.statuses.includes('RED'))
        return 'RED'; if (signals.statuses.includes('YELLOW') || signals.ptoLate || signals.sdoLate)
        return 'YELLOW'; if (!signals.statuses.length || signals.statuses.includes('GRAY') || signals.stale)
        return 'GRAY'; return 'GREEN'; }
}
export class WorkTransitionPolicy {
    canStartWork(inputs: {
        name: string;
        complete: boolean;
        requiresAcceptance: boolean;
        accepted: boolean;
        criticalIssue: boolean;
        documentRequired?: boolean;
        documentApproved?: boolean;
    }[]) { const reasons: string[] = []; for (const p of inputs) {
        if (!p.complete)
            reasons.push(`${p.name}: предшествующая работа не завершена`);
        if (p.requiresAcceptance && !p.accepted)
            reasons.push(`${p.name}: нет приёмки строительного контроля`);
        if (p.criticalIssue)
            reasons.push(`${p.name}: открыто критическое замечание`);
        if (p.documentRequired && !p.documentApproved)
            reasons.push(`${p.name}: не подтверждён обязательный документ`);
    } return { allowed: reasons.length === 0, reasons }; }
}
export class PtoPackageValidationService {
    validate(x: {
        accepted: boolean;
        requiresInspection: boolean;
        documents: {
            status: string;
            type: string;
        }[];
        requiresMaterials: boolean;
        materialsValid: boolean;
    }) { const reasons: string[] = []; if (x.requiresInspection && !x.accepted)
        reasons.push('Работа не принята СК'); if (!x.documents.length || x.documents.some(d => d.status !== 'APPROVED'))
        reasons.push('Все документы пакета должны быть подтверждены ПТО'); if (!x.documents.some(d => d.type === 'AOSR'))
        reasons.push('В пакете отсутствует АОСР'); if (x.requiresMaterials && !x.materialsValid)
        reasons.push('Не указаны материалы или действующие паспорта/сертификаты партий'); return { allowed: !reasons.length, reasons }; }
}
export class PotentialClosingService {
    calculate(works: {
        cost: any;
        actual: any;
        planned: any;
        closed: any;
        accepted: boolean;
        requiresInspection: boolean;
        docsReady: boolean;
        transferred: boolean;
        calculated: boolean;
    }[]) { const buckets = { notAccepted: new Decimal(0), pto: new Decimal(0), ready: new Decimal(0), sdo: new Decimal(0), calculated: new Decimal(0) }; let physical = new Decimal(0), closed = new Decimal(0); for (const w of works) {
        const value = new Decimal(w.cost).mul(new ProgressCalculationService().calculate(w.actual, w.planned) ?? 0).div(100);
        physical = physical.add(value);
        closed = closed.add(w.closed);
        const remainder = Decimal.max(0, value.minus(w.closed));
        const key = w.calculated ? 'calculated' : w.transferred ? 'sdo' : w.docsReady ? 'ready' : (w.accepted || !w.requiresInspection) ? 'pto' : 'notAccepted';
        buckets[key] = buckets[key].add(remainder);
    } return { physical: physical.toFixed(2), closed: closed.toFixed(2), potential: Decimal.max(0, physical.minus(closed)).toFixed(2), buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.toFixed(2)])) }; }
}
export class EscalationService {
    recipient(days: number, risk = defaultRisk) { return days >= risk.escalateDirectorDays ? 'GENERAL_DIRECTOR' : days >= risk.escalateTechnicalDays ? 'TECHNICAL_DIRECTOR' : 'PROJECT_MANAGER'; }
}
export class ContractorPerformanceService {
    calculate(works: any[]) { return { works: works.length, delayed: works.filter(w => w.delayDays > 0).length, actualProgress: works.length ? works.reduce((s, w) => s + (w.actualProgress ?? 0), 0) / works.length : null }; }
}
// F8.1 Production Execution + Construction Control Foundation. Work stays the
// central object (Construction Core Production Workflow Model v1.2.1, F8.1
// Domain Contract v1.0): every service below hangs off an existing work, never
// replaces it. No PTO/SDO/document/financial logic lives here — that stays out
// of F8.1's scope, same as everywhere else in this file.
export class QuantityPortionPolicy {
    // F8.1 decision 4: a portion may cover only part of its unit's planned
    // quantity; the sum of a unit's portions must never exceed it. A cross-row
    // invariant (sums across sibling rows), so — like every other cross-row rule
    // in this codebase — it is checked here as a pure function over values the
    // service layer already fetched under a row lock, not as a SQL CHECK.
    fits(unitPlannedQuantity: any, existingPortionsSum: any, candidateQuantity: any) { return new Decimal(existingPortionsSum).add(candidateQuantity).lte(unitPlannedQuantity); }
}
export class InternalScPolicy {
    // F8.1 Domain Contract: "Mandatory for ООО СЗ «Гор-Строй» objects." No call
    // site inside F8.1 itself — this is what a later PTO-preparation gate checks
    // before allowing PTO prep to start on such an object; PTO stays out of
    // F8.1's scope, so this is foundation for that gate, not a gate on its own
    // yet. The literal organization name already appears in
    // apps/backend/src/importer.ts for ГПО-sourced imports.
    required(organizationName: string | null) { return organizationName === 'ООО СЗ «Гор-Строй»'; }
}
// F8.1-02 corrective (Independent Review, not accepted first pass): a unit's
// coverage by accepted portions, never merely "every portion that happens to
// exist is accepted". A unit's planned quantity can be portioned gradually
// (F8.1 decision 4), so a single 100 m² portion out of a 500 m² unit, itself
// fully accepted, is real progress but not completion — the remaining 400 m²
// was never portioned at all, and treating an incomplete portion set as
// satisfied is the same shape of bug as an empty `.every()`, one level up.
//
// F8.1 Final corrective (Independent Re-Review, pass 3): coverage used to sum
// an accepted portion's own *planned* quantity, not what SC actually
// confirmed. Once Internal SC and Customer SC record their own independently
// confirmed figure (F8.1-01 v2, never a copy of RP_FACT or of the plan), a
// portion accepted at 100 of its own 500 planned must count as 100 toward
// its unit, not 500 — the exact "500 planned / 500 RP fact / Internal SC
// confirms only 100" example the Review gave. `accepted` (a boolean) is gone
// from this shape entirely: a portion with no applicable confirmation
// contributes `confirmedQuantity: null`, read as zero, same treatment a
// portion that was never created already got.
export type ScCoverageStatus = 'NONE' | 'PARTIAL' | 'COMPLETE';
export class PortionCompletionService {
    // NONE: nothing confirmed (including no portions at all — an empty sum is
    // zero, not "vacuously covered"). PARTIAL: some confirmed quantity exists
    // but does not yet reach the unit's own planned quantity. COMPLETE: the
    // portions' own latest applicable confirmations sum to at least the
    // unit's planned quantity.
    unitCoverage(unitPlannedQuantity: any, portions: { confirmedQuantity: any }[]): ScCoverageStatus {
        const confirmedQuantity = portions.reduce((s, p) => s.add(p.confirmedQuantity ?? 0), new Decimal(0));
        if (confirmedQuantity.lte(0))
            return 'NONE';
        return confirmedQuantity.gte(unitPlannedQuantity) ? 'COMPLETE' : 'PARTIAL';
    }
    private aggregate(statuses: ScCoverageStatus[]): ScCoverageStatus {
        if (statuses.length === 0)
            return 'NONE';
        if (statuses.every(s => s === 'COMPLETE'))
            return 'COMPLETE';
        return statuses.every(s => s === 'NONE') ? 'NONE' : 'PARTIAL';
    }
    // F8.1 decision 8: acceptance aggregates from portions — never any-portion-
    // accepted, never any-created-portion-accepted (the bug above), and never
    // a confirmed portion's own planned quantity either (the Final corrective
    // bug above that). Internal SC completion and Customer SC acceptance are
    // two separate methods over two separate confirmation sources, kept
    // structurally apart rather than merged into one generic "accepted" (F8.1
    // final clarification 2) — a caller cannot conflate them without
    // deliberately reading the wrong field, because there is no shared field
    // to misread. A work with zero units is never vacuously complete either —
    // the same guard one level up.
    internalScStatus(units: { plannedQuantity: any; portions: { internalScConfirmedQuantity: any }[] }[]): ScCoverageStatus {
        return this.aggregate(units.map(u => this.unitCoverage(u.plannedQuantity, u.portions.map(p => ({ confirmedQuantity: p.internalScConfirmedQuantity })))));
    }
    customerScStatus(units: { plannedQuantity: any; portions: { customerScConfirmedQuantity: any }[] }[]): ScCoverageStatus {
        return this.aggregate(units.map(u => this.unitCoverage(u.plannedQuantity, u.portions.map(p => ({ confirmedQuantity: p.customerScConfirmedQuantity })))));
    }
    internalScComplete(units: { plannedQuantity: any; portions: { internalScConfirmedQuantity: any }[] }[]): boolean {
        return this.internalScStatus(units) === 'COMPLETE';
    }
    customerScAccepted(units: { plannedQuantity: any; portions: { customerScConfirmedQuantity: any }[] }[]): boolean {
        return this.customerScStatus(units) === 'COMPLETE';
    }
}
// F8.1-03 corrective: the one place that decides "is this work's Internal SC
// complete" — a work with no execution units keeps exactly its pre-F8.1
// whole-work-inspection flag (F7 behaviour, unchanged); a work with execution
// units ignores that flag entirely (it can only ever be stale once units
// exist — nothing keeps it in sync) and reads coverage instead. Called
// identically by ReadService.snapshot() (the blockers a user sees) and
// ProductionService.transition() (the gate a backend mutation is actually
// held to), so the two can no longer diverge — they call the same function,
// not two independent re-derivations of the same rule.
export function resolveInternalScAccepted(wholeWorkAccepted: boolean, units: { plannedQuantity: any; portions: { internalScConfirmedQuantity: any }[] }[]): boolean {
    return units.length === 0 ? wholeWorkAccepted : new PortionCompletionService().internalScComplete(units);
}
// F8.1-04 corrective: the one place that decides a work's actual quantity —
// legacy `works.actual_quantity`/`work_progress` for a work with no execution
// units (F7 behaviour, unchanged); the sum of the execution units' own
// (portion-derived) totals once any exist, ignoring the legacy figure
// entirely so the two can never compete as two different "true" answers for
// the same work.
//
// F8.1-04 corrective, second pass (Independent Re-Review, Patch 2): summing
// every unit's total assumed every unit shared the work's own measurement
// unit — nothing enforced that, so an execution unit created in м³ under a
// work measured in м² would have silently combined into one meaningless
// figure. `units` now carries each unit's own `unit` string alongside its
// total, and only units whose `unit` matches `workUnit` are summed; a
// mismatched one is excluded, never added in. createExecutionUnit()
// (service.ts) is the primary prevention — a unit cannot be created with a
// different measurement unit or work type than its parent work — this is
// the aggregate's own defence regardless of how a unit reached it. Units
// exist but none are compatible reads as zero, not the (necessarily stale,
// once any execution unit exists — see progress()'s own guard) legacy
// figure — resurfacing it would be exactly the "two competing truths" this
// function exists to prevent.
export function resolveActualQuantity(legacyActualQuantity: any, workUnit: string, units: { unit: string; actualQuantity: any }[]): string {
    if (units.length === 0)
        return new Decimal(legacyActualQuantity).toFixed(4);
    return units.filter(u => u.unit === workUnit).reduce((sum, u) => sum.add(u.actualQuantity ?? 0), new Decimal(0)).toFixed(4);
}
export const domainEvents = ['WorkProgressUpdated', 'WorkDelayed', 'InspectionRequested', 'InspectionAccepted', 'InspectionRejected', 'IssueCreated', 'IssueResolved', 'ExecutivePackageReady', 'TransferredToSdo', 'SdoCalculated', 'FinancialClosingCreated', 'ObjectHealthChanged', 'ExecutionUnitCreated'] as const;
export interface BitrixUserProvider {
    currentUser(token: string): Promise<any>;
}
export interface OrganizationProvider {
    departments(token: string): Promise<any>;
}
export interface NotificationProvider {
    notify(token: string, userId: string, message: string): Promise<any>;
}
export interface TaskProvider {
    createTask(token: string, userId: string, title: string): Promise<any>;
}
export interface FileStorageProvider {
    upload(token: string, folder: string, name: string, base64: string): Promise<any>;
}
export interface ExecutiveTemplateEngine {
    render(context: Record<string, unknown>): {
        status: 'DRAFT';
        content: string;
    };
}
export class AosrDraftEngine implements ExecutiveTemplateEngine {
    render(context: Record<string, unknown>) { return { status: 'DRAFT' as const, content: 'ЧЕРНОВИК АОСР — требуется проверка ПТО\n' + Object.entries(context).map(([k, v]) => `${k}: ${v}`).join('\n') }; }
}
