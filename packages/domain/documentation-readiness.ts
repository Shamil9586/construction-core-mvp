/**
 * Documentary readiness of a Documentation Package and of its Core AOSRs — pure rules (no database, no storage provider).
 *
 * ONE definition, read by every caller: the forward gate that guards «Предъявить заказчику» / the customer-accepted quantity
 * (apps/backend/src/documentation-evidence.ts) and the Object registry read model (documentation-registry-service.ts). The frontend renders the
 * result and never re-derives it.
 *
 * The rules are the ID-AUTO-1 final-corrective rules, unchanged:
 *   - the package has an explicit production scope;
 *   - the AOSR preparation method is declared (never inferred from "no AOSR");
 *   - CORE      -> at least one Core AOSR, and EVERY Core AOSR has a successfully generated CURRENT DOCX;
 *   - EXTERNAL  -> zero Core AOSRs / DOCX / numbers are valid (no placeholder, nothing "missing" because of their absence);
 *   - both      -> at least one executive scheme that is backed by a real file (a metadata-only record is not evidence), and — for a Core AOSR —
 *                  the AOSR is covered by at least one linked file-backed scheme.
 *
 * Facts are storage-provider-neutral: "a scheme has a file" is a boolean the caller derived from the existing document/version layer.
 */
import { SCOPE_NOT_SELECTED_MESSAGE } from './package-scope';

export type AosrMethod = 'CORE' | 'EXTERNAL';

export const METHOD_REQUIRED_MESSAGE = 'Сначала выберите способ подготовки АОСР по пакету: «АОСР формируются в Core» или «АОСР формируются вне Core»';
export const SCHEME_FILE_REQUIRED_MESSAGE = 'Для предъявления заказчику нужна хотя бы одна исполнительная схема с загруженным файлом';
export const NO_CORE_AOSR_MESSAGE = 'Выбрано «АОСР формируются в Core»: сформируйте хотя бы один АОСР в Core';

export type ReadinessCode =
    | 'SCOPE_NOT_SELECTED'
    | 'METHOD_UNSET'
    | 'NO_CORE_AOSR'
    | 'AOSR_NOT_GENERATED'
    | 'AOSR_DOCX_OUTDATED'
    | 'SCHEME_FILE_REQUIRED'
    | 'AOSR_SCHEME_MISSING';

/** Where the engineer goes to fix a blocker. The frontend maps a target to an existing screen/section; the server only names it. */
export type ReadinessTarget =
    | { kind: 'SCOPE' }
    | { kind: 'METHOD' }
    | { kind: 'AOSR_SECTION' }
    | { kind: 'AOSR'; aosrId: string }
    | { kind: 'SCHEMES' };

export interface ReadinessReason {
    code: ReadinessCode;
    message: string;
    target: ReadinessTarget;
    /** Set for the reasons that are about one Core AOSR. */
    aosrId?: string;
    aosrTitle?: string;
}

export interface DocumentaryReadiness { ready: boolean; reasons: ReadinessReason[] }

/** The facts of one Core AOSR that documentary readiness judges. */
export interface AosrDocumentFacts {
    id: string;
    title: string;
    officialNumber: number | null;
    revisionCount: number;
    generatedAtVersion: number | null;
    version: number;
    /** The executive schemes linked to THIS AOSR, each with whether a real file backs it. */
    linkedSchemes: { id: string; hasFile: boolean }[];
}

export interface PackageReadinessFacts {
    hasScope: boolean;
    /** The latest declaration, or null while none has been made. */
    method: AosrMethod | null;
    /** The package's Core AOSRs (creation order). Judged only when the method is CORE. */
    aosrs: AosrDocumentFacts[];
    /** All executive schemes of the package. */
    schemes: { hasFile: boolean }[];
}

/**
 * State of an AOSR's generated DOCX:
 *   NOT_GENERATED — draft: no official number / no successful generation yet;
 *   CURRENT       — generated and not edited since;
 *   OUTDATED      — generated once, then edited (content or links): the DOCX is no longer the current act.
 */
export type AosrDocxState = 'NOT_GENERATED' | 'CURRENT' | 'OUTDATED';

export function aosrDocxState(a: Pick<AosrDocumentFacts, 'officialNumber' | 'revisionCount' | 'generatedAtVersion' | 'version'>): AosrDocxState {
    if (a.officialNumber === null || a.revisionCount < 1) return 'NOT_GENERATED';
    return a.generatedAtVersion === a.version ? 'CURRENT' : 'OUTDATED';
}

const quoted = (title: string) => `«${title}»`;

function docxReason(a: AosrDocumentFacts): ReadinessReason | null {
    const state = aosrDocxState(a);
    if (state === 'CURRENT') return null;
    const target: ReadinessTarget = { kind: 'AOSR', aosrId: a.id };
    return state === 'NOT_GENERATED'
        ? { code: 'AOSR_NOT_GENERATED', message: `АОСР ${quoted(a.title)} не сформирован`, target, aosrId: a.id, aosrTitle: a.title }
        : { code: 'AOSR_DOCX_OUTDATED', message: `АОСР ${quoted(a.title)} изменён после формирования: нужен новый актуальный DOCX`, target, aosrId: a.id, aosrTitle: a.title };
}

function schemeReason(a: AosrDocumentFacts): ReadinessReason | null {
    if (a.linkedSchemes.some(s => s.hasFile)) return null;
    // A linked scheme without a file is metadata only; an AOSR with no linked scheme at all is not covered either.
    return { code: 'AOSR_SCHEME_MISSING', message: `Для АОСР ${quoted(a.title)} отсутствует исполнительная схема с файлом`, target: { kind: 'AOSR', aosrId: a.id }, aosrId: a.id, aosrTitle: a.title };
}

/** Documentary readiness of ONE Core AOSR: a current generated DOCX and a file-backed scheme that covers it. */
export function resolveAosrDocumentaryReadiness(a: AosrDocumentFacts): DocumentaryReadiness {
    const reasons = [docxReason(a), schemeReason(a)].filter((r): r is ReadinessReason => r !== null);
    return { ready: reasons.length === 0, reasons };
}

/**
 * Documentary readiness of a package. Reasons come in the order the forward gate has always checked them — scope, method, Core AOSR / DOCX,
 * package scheme file — followed by per-AOSR scheme coverage, so the gate's first message is unchanged while the registry sees every blocker.
 */
export function resolvePackageReadiness(f: PackageReadinessFacts): DocumentaryReadiness {
    const reasons: ReadinessReason[] = [];
    if (!f.hasScope) reasons.push({ code: 'SCOPE_NOT_SELECTED', message: SCOPE_NOT_SELECTED_MESSAGE, target: { kind: 'SCOPE' } });
    if (f.method === null) reasons.push({ code: 'METHOD_UNSET', message: METHOD_REQUIRED_MESSAGE, target: { kind: 'METHOD' } });
    const core = f.method === 'CORE';
    if (core) {
        if (!f.aosrs.length) reasons.push({ code: 'NO_CORE_AOSR', message: NO_CORE_AOSR_MESSAGE, target: { kind: 'AOSR_SECTION' } });
        for (const a of f.aosrs) { const r = docxReason(a); if (r) reasons.push(r); }
    }
    if (!f.schemes.some(s => s.hasFile)) reasons.push({ code: 'SCHEME_FILE_REQUIRED', message: SCHEME_FILE_REQUIRED_MESSAGE, target: { kind: 'SCHEMES' } });
    if (core) for (const a of f.aosrs) { const r = schemeReason(a); if (r) reasons.push(r); }
    return { ready: reasons.length === 0, reasons };
}

/**
 * The single business message the forward gate refuses with: the FIRST failing stage, exactly as before. The stage "a Core AOSR has no current
 * DOCX" lists every such AOSR in one sentence (the wording the engineer already knows).
 */
export function forwardGateMessage(readiness: DocumentaryReadiness): string | null {
    const first = readiness.reasons[0];
    if (!first) return null;
    if (first.code === 'AOSR_NOT_GENERATED' || first.code === 'AOSR_DOCX_OUTDATED') {
        const titles = readiness.reasons.filter(r => r.code === 'AOSR_NOT_GENERATED' || r.code === 'AOSR_DOCX_OUTDATED').map(r => quoted(r.aosrTitle ?? ''));
        return `Не сформирован актуальный DOCX у АОСР: ${titles.join(', ')}. Сформируйте его (или удалите черновик, если АОСР в Core не нужен)`;
    }
    if (first.code === 'AOSR_SCHEME_MISSING') {
        const titles = readiness.reasons.filter(r => r.code === 'AOSR_SCHEME_MISSING').map(r => quoted(r.aosrTitle ?? ''));
        return `Нет исполнительной схемы с файлом у АОСР: ${titles.join(', ')}. Привяжите схему с файлом и сформируйте АОСР заново`;
    }
    return first.message;
}
