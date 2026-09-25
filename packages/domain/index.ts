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
    EXECUTION_UNIT_MANAGE = 'EXECUTION_UNIT_MANAGE'
}
const view = [Permission.OBJECT_VIEW, Permission.WORK_VIEW, Permission.PTO_VIEW, Permission.SDO_VIEW, Permission.FINANCE_VIEW];
const grants: Record<Role, Permission[]> = { ADMIN: Object.values(Permission), GENERAL_DIRECTOR: view, TECHNICAL_DIRECTOR: [...view, Permission.OBJECT_CREATE, Permission.OBJECT_EDIT, Permission.OBJECT_MANAGE_CONTRACTORS, Permission.WORK_CREATE, Permission.EXECUTION_UNIT_MANAGE], DEPARTMENT_HEAD: view, PROJECT_MANAGER: [...view, Permission.OBJECT_CREATE, Permission.OBJECT_EDIT, Permission.OBJECT_MANAGE_CONTRACTORS, Permission.WORK_CREATE, Permission.EXECUTION_UNIT_MANAGE, Permission.WORK_UPDATE_PROGRESS, Permission.INSPECTION_REQUEST, Permission.ISSUE_RESOLVE], CONSTRUCTION_CONTROL: [...view, Permission.INSPECTION_ACCEPT, Permission.INSPECTION_REJECT, Permission.ISSUE_CREATE, Permission.ISSUE_VERIFY], PTO: [...view, Permission.PTO_EDIT, Permission.PTO_TRANSFER_SDO], SDO: [...view, Permission.SDO_EDIT, Permission.SDO_CLOSE, Permission.FINANCE_EDIT], CONTRACTOR_VIEWER: [Permission.OBJECT_VIEW, Permission.WORK_VIEW] };
export const hasPermission = (role: Role, p: Permission) => grants[role]?.includes(p) ?? false;
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
export type ScCoverageStatus = 'NONE' | 'PARTIAL' | 'COMPLETE';
export class PortionCompletionService {
    // NONE: nothing accepted (including no portions at all — an empty sum is
    // zero, not "vacuously covered"). PARTIAL: some accepted quantity exists
    // but does not yet reach the unit's own planned quantity — D4 already
    // forbids portions summing past it, so "reaches" and "equals" coincide.
    // COMPLETE: the accepted portions' own planned quantities cover it.
    unitCoverage(unitPlannedQuantity: any, portions: { plannedQuantity: any; accepted: boolean }[]): ScCoverageStatus {
        const acceptedQuantity = portions.filter(p => p.accepted).reduce((s, p) => s.add(p.plannedQuantity), new Decimal(0));
        if (acceptedQuantity.lte(0))
            return 'NONE';
        return acceptedQuantity.gte(unitPlannedQuantity) ? 'COMPLETE' : 'PARTIAL';
    }
    private aggregate(statuses: ScCoverageStatus[]): ScCoverageStatus {
        if (statuses.length === 0)
            return 'NONE';
        if (statuses.every(s => s === 'COMPLETE'))
            return 'COMPLETE';
        return statuses.every(s => s === 'NONE') ? 'NONE' : 'PARTIAL';
    }
    // F8.1 decision 8: acceptance aggregates from portions — never any-portion-
    // accepted, and never any-created-portion-accepted either (the bug above).
    // Internal SC completion and Customer SC acceptance are two separate
    // methods over two separate booleans, kept structurally apart rather than
    // merged into one generic "accepted" (F8.1 final clarification 2) — a
    // caller cannot conflate them without deliberately reading the wrong
    // field, because there is no shared field to misread. A work with zero
    // units is never vacuously complete either — the same guard one level up.
    internalScStatus(units: { plannedQuantity: any; portions: { plannedQuantity: any; internalScAccepted: boolean }[] }[]): ScCoverageStatus {
        return this.aggregate(units.map(u => this.unitCoverage(u.plannedQuantity, u.portions.map(p => ({ plannedQuantity: p.plannedQuantity, accepted: p.internalScAccepted })))));
    }
    customerScStatus(units: { plannedQuantity: any; portions: { plannedQuantity: any; customerScAccepted: boolean }[] }[]): ScCoverageStatus {
        return this.aggregate(units.map(u => this.unitCoverage(u.plannedQuantity, u.portions.map(p => ({ plannedQuantity: p.plannedQuantity, accepted: p.customerScAccepted })))));
    }
    internalScComplete(units: { plannedQuantity: any; portions: { plannedQuantity: any; internalScAccepted: boolean }[] }[]): boolean {
        return this.internalScStatus(units) === 'COMPLETE';
    }
    customerScAccepted(units: { plannedQuantity: any; portions: { plannedQuantity: any; customerScAccepted: boolean }[] }[]): boolean {
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
export function resolveInternalScAccepted(wholeWorkAccepted: boolean, units: { plannedQuantity: any; portions: { plannedQuantity: any; internalScAccepted: boolean }[] }[]): boolean {
    return units.length === 0 ? wholeWorkAccepted : new PortionCompletionService().internalScComplete(units);
}
// F8.1-04 corrective: the one place that decides a work's actual quantity —
// legacy `works.actual_quantity`/`work_progress` for a work with no execution
// units (F7 behaviour, unchanged); the sum of the execution units' own
// (portion-derived) totals once any exist, ignoring the legacy figure
// entirely so the two can never compete as two different "true" answers for
// the same work. `unitActualQuantities` is each unit's own already-derived
// total (ReadService.snapshot()'s executionUnitsWithTotals, or the
// equivalent computed inline wherever a single work's units are fetched).
export function resolveActualQuantity(legacyActualQuantity: any, unitActualQuantities: any[]): string {
    if (unitActualQuantities.length === 0)
        return new Decimal(legacyActualQuantity).toFixed(4);
    return unitActualQuantities.reduce((sum, q) => sum.add(q ?? 0), new Decimal(0)).toFixed(4);
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
