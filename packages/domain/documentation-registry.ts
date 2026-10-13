/**
 * Object documentation registry («Реестр ИД») — pure shapes, filters and summary counts (no database).
 *
 * The registry is a READ MODEL over the existing production/documentation model — there is no register table. One row = one ACTIVE
 * Documentation Package of ONE Object; inside a Core package, one AOSR row = one AOSR. Readiness is the server's verdict
 * (documentation-readiness.ts); filters and counts here work on those rows, so a count can never disagree with the list it summarises.
 */
import type { AosrDocxState, AosrMethod, DocumentaryReadiness, ReadinessReason } from './documentation-readiness';
import type { CurrentQuantitySource } from './aosr';
import { resolveDocumentationAttention } from './index';

export type RegistryLastUpdateKind =
    | 'PACKAGE_CREATED' | 'PACKAGE_CHANGED' | 'STATUS_CHANGED' | 'METHOD_CHOSEN'
    | 'AOSR_CHANGED' | 'AOSR_GENERATED' | 'SCHEME_UPLOADED' | 'DOCUMENT_CHANGED' | 'CUSTOMER_QUANTITY_RECORDED';

export interface RegistryLastUpdate { at: string; kind: RegistryLastUpdateKind }

export interface RegistrySchemeRef { id: string; title: string; hasFile: boolean }

export interface RegistryAosrRow {
    id: string;
    /** Official number; null = «номер не присвоен» (draft that never consumed a number). */
    number: number | null;
    /** Hidden work / item 1 of the act. */
    title: string;
    workDescription: string | null;
    /** Production scope the act is provenance-linked to (zone names, not ids). */
    zones: string[];
    startDate: string | null;
    endDate: string | null;
    actDate: string | null;
    docx: { state: AosrDocxState; revisionCount: number };
    schemeCoverage: { covered: boolean; schemes: RegistrySchemeRef[] };
    /** Documentary readiness of this act: current DOCX + a file-backed scheme that covers it. */
    readiness: DocumentaryReadiness;
    /** What still prevents (re)generating the act (the existing AOSR content readiness). Empty = ready to generate. */
    generationIssues: { code: string; message: string }[];
    projectDocumentation: string | null;
    normativeReferences: string | null;
    subsequentWork: string | null;
    lastUpdateAt: string;
    version: number;
}

export interface RegistryPackageRow {
    packageId: string;
    workId: string;
    workName: string;
    scope: { hasScope: boolean; zoneSummary: string | null; zones: string[]; currentQuantity: { quantity: string; unit: string; source: CurrentQuantitySource } | null };
    responsible: { id: string; name: string };
    /** PTO lifecycle status (unchanged by this slice). */
    status: string;
    /** null = not declared yet (METHOD_UNSET). Never inferred from the absence of AOSRs. */
    aosrMethod: AosrMethod | null;
    /** Core AOSRs in this package; meaningful for CORE, 0 for an EXTERNAL package (not a defect). */
    aosrCount: number;
    aosrGeneratedCount: number;
    schemeCount: number;
    schemeFileBackedCount: number;
    readiness: DocumentaryReadiness;
    /** The next move belongs to the PTO engineer (the existing PTO attention classifier, not a new rule). */
    awaitingEngineerAction: boolean;
    lastUpdate: RegistryLastUpdate;
    aosrs: RegistryAosrRow[];
}

export interface RegistryArchivedRow {
    packageId: string;
    workId: string;
    workName: string;
    scope: RegistryPackageRow['scope'];
    responsible: { id: string; name: string };
    status: string;
    aosrMethod: AosrMethod | null;
    archivedAt: string;
    archivedByName: string | null;
    archiveReason: string | null;
}

export interface RegistrySummary {
    activePackages: number;
    ready: number;
    notReady: number;
    awaitingEngineerAction: number;
}

export type RegistryMethodFilter = AosrMethod | 'UNSET';

export interface RegistryFilters {
    responsibleUserId?: string;
    status?: string;
    ready?: boolean;
    method?: RegistryMethodFilter;
    /** Work / zone / AOSR title (case-insensitive substring). */
    q?: string;
}

export const REGISTRY_PACKAGE_STATUSES = ['DRAFT', 'PREPARING', 'READY_FOR_PRESENTATION', 'PRESENTED', 'RETURNED', 'CORRECTING', 'ACCEPTED_BY_CUSTOMER'] as const;

/** The PTO engineer is the one to act next — straight from the existing attention classifier (DRAFT / PREPARING / CORRECTING / RETURNED). */
export function awaitsEngineerAction(status: string): boolean {
    return resolveDocumentationAttention([status]).level !== 'NONE';
}

/**
 * The latest meaningful documentary event of a package. The newest timestamp wins; on an exact tie the EARLIER candidate in the given order
 * wins, so callers list the most descriptive event first (a status change is also a package update — the status change is what happened).
 */
export function pickLastUpdate(candidates: { at: Date | string | null | undefined; kind: RegistryLastUpdateKind }[]): RegistryLastUpdate | null {
    let best: { ms: number; kind: RegistryLastUpdateKind } | null = null;
    for (const c of candidates) {
        if (!c.at) continue;
        const ms = new Date(c.at).getTime();
        if (Number.isNaN(ms)) continue;
        if (!best || ms > best.ms) best = { ms, kind: c.kind };
    }
    return best ? { at: new Date(best.ms).toISOString(), kind: best.kind } : null;
}

const norm = (s: string) => s.toLocaleLowerCase('ru').trim();

export function rowMatchesFilters(row: RegistryPackageRow, f: RegistryFilters): boolean {
    if (f.responsibleUserId && row.responsible.id !== f.responsibleUserId) return false;
    if (f.status && row.status !== f.status) return false;
    if (f.ready !== undefined && row.readiness.ready !== f.ready) return false;
    if (f.method && (row.aosrMethod ?? 'UNSET') !== f.method) return false;
    if (f.q && norm(f.q)) {
        const needle = norm(f.q);
        const hay = [row.workName, row.scope.zoneSummary ?? '', ...row.scope.zones, ...row.aosrs.flatMap(a => [a.title, a.number === null ? '' : String(a.number)])].map(norm);
        if (!hay.some(h => h.includes(needle))) return false;
    }
    return true;
}

export function filterRegistryRows(rows: RegistryPackageRow[], f: RegistryFilters): RegistryPackageRow[] {
    return rows.filter(r => rowMatchesFilters(r, f));
}

/** Counts over the given rows — the very rows the registry returns, so the summary and the list share one source. */
export function summarizeRegistry(rows: RegistryPackageRow[]): RegistrySummary {
    const ready = rows.filter(r => r.readiness.ready).length;
    return { activePackages: rows.length, ready, notReady: rows.length - ready, awaitingEngineerAction: rows.filter(r => r.awaitingEngineerAction).length };
}

/** Human ordering of the working list: needs-attention first, then by work and zone — stable and independent of insertion order. */
export function sortRegistryRows(rows: RegistryPackageRow[]): RegistryPackageRow[] {
    return [...rows].sort((a, b) =>
        Number(a.readiness.ready) - Number(b.readiness.ready)
        || a.workName.localeCompare(b.workName, 'ru', { numeric: true })
        || (a.scope.zoneSummary ?? '').localeCompare(b.scope.zoneSummary ?? '', 'ru', { numeric: true })
        || a.packageId.localeCompare(b.packageId));
}

export type { ReadinessReason };
