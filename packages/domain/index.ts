import Decimal from 'decimal.js';
export const roles = ['GENERAL_DIRECTOR', 'TECHNICAL_DIRECTOR', 'PROJECT_MANAGER', 'CONSTRUCTION_CONTROL', 'PTO', 'SDO', 'DEPARTMENT_HEAD', 'ADMIN', 'CONTRACTOR_VIEWER'] as const;
export type Role = typeof roles[number];
export enum Permission {
    OBJECT_VIEW = 'OBJECT_VIEW',
    OBJECT_CREATE = 'OBJECT_CREATE',
    OBJECT_EDIT = 'OBJECT_EDIT',
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
    ADMIN_DICTIONARIES = 'ADMIN_DICTIONARIES'
}
const view = [Permission.OBJECT_VIEW, Permission.WORK_VIEW, Permission.PTO_VIEW, Permission.SDO_VIEW, Permission.FINANCE_VIEW];
const grants: Record<Role, Permission[]> = { ADMIN: Object.values(Permission), GENERAL_DIRECTOR: view, TECHNICAL_DIRECTOR: [...view, Permission.OBJECT_CREATE, Permission.OBJECT_EDIT, Permission.WORK_CREATE], DEPARTMENT_HEAD: view, PROJECT_MANAGER: [...view, Permission.OBJECT_CREATE, Permission.OBJECT_EDIT, Permission.WORK_CREATE, Permission.WORK_UPDATE_PROGRESS, Permission.INSPECTION_REQUEST, Permission.ISSUE_RESOLVE], CONSTRUCTION_CONTROL: [...view, Permission.INSPECTION_ACCEPT, Permission.INSPECTION_REJECT, Permission.ISSUE_CREATE, Permission.ISSUE_VERIFY], PTO: [...view, Permission.PTO_EDIT, Permission.PTO_TRANSFER_SDO], SDO: [...view, Permission.SDO_EDIT, Permission.SDO_CLOSE, Permission.FINANCE_EDIT], CONTRACTOR_VIEWER: [Permission.OBJECT_VIEW, Permission.WORK_VIEW] };
export const hasPermission = (role: Role, p: Permission) => grants[role]?.includes(p) ?? false;
export const defaultRisk = { yellowVariance: -5, redVariance: -15, staleDays: 7, ptoDays: 5, sdoDays: 10, escalateTechnicalDays: 3, escalateDirectorDays: 7 };
export class ProgressCalculationService {
    calculate(actual: any, planned: any) { return new Decimal(planned).gt(0) ? Decimal.min(100, Decimal.max(0, new Decimal(actual).div(planned).mul(100))).toNumber() : null; }
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
export const domainEvents = ['WorkProgressUpdated', 'WorkDelayed', 'InspectionRequested', 'InspectionAccepted', 'InspectionRejected', 'IssueCreated', 'IssueResolved', 'ExecutivePackageReady', 'TransferredToSdo', 'SdoCalculated', 'FinancialClosingCreated', 'ObjectHealthChanged'] as const;
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
