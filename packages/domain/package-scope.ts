/**
 * Documentation Package scope — pure rules and presentation facts (no database).
 *
 * A Documentation Package documents a production SCOPE: one or more Quantity Portions of ONE Work. Several packages per Work are fine
 * when their scopes do not overlap (1 этаж / 2 этаж); two packages may never both claim the same Quantity Portion. (Several AOSRs
 * inside one package MAY reuse the same portion — that is a different relation, see aosr_portion_links.)
 */
import Decimal from 'decimal.js';
import { resolveCurrentAcceptedQuantity, type CurrentQuantitySource } from './aosr';

export const PORTION_ALREADY_COVERED_MESSAGE = 'Этот участок уже включён в активный пакет исполнительной документации.';
export const SCOPE_REQUIRED_MESSAGE = 'Выберите участок производства для пакета ИД: пакет без участка не создаётся.';
export const SCOPE_NOT_SELECTED_MESSAGE = 'Участок не выбран: выберите участок производства для пакета ИД, прежде чем продолжать работу с пакетом.';
export const ALL_SCOPE_COVERED_MESSAGE = 'Все доступные участки уже включены в активные пакеты ИД.';
export const NO_PORTIONS_MESSAGE = 'У работы нет участков производства: пакет ИД создаётся на участок (создайте его на карточке работы).';

/**
 * Whether a package still claims its scope. The PTO lifecycle has no cancelled state: every package is active from creation through
 * acceptance and SDO — a portion stays claimed. The ONLY way out of the working set is the orthogonal soft archive
 * (documentation_packages.archived_at, packages/domain/package-archive.ts): an archived package reserves nothing. This is the one predicate
 * behind the service overlap check, the eligible-scope query, and (restated in SQL) the database trigger of migration 023.
 */
export function isPackageActive(pkg: { archivedAt?: unknown | null }): boolean {
    return !pkg.archivedAt;
}

export interface ScopePortionInput {
    id: string;
    label: string;
    location?: string | null;
    unit: string;
    plannedQuantity?: string | number | null;
    rpFact: string | null;
    internalSc: string | null;
    customerAccepted: string | null;
}
export interface ScopePortionView { id: string; label: string; zone: string; unit: string; plannedQuantity: string | null; currentQuantity: string | null; quantitySource: CurrentQuantitySource | null }
export interface PackageScopeView {
    hasScope: boolean;
    portions: ScopePortionView[];
    /** Short card text: "1 этаж", "1 этаж, 2 этаж" or "3 участка". Null when the package has no scope. */
    zoneSummary: string | null;
    /** The CURRENT business quantity of the scope (customer-accepted, else internal SC, else RP fact) — never a history. */
    currentQuantity: { quantity: string; unit: string; source: CurrentQuantitySource } | null;
}

/** The meaningful zone name of a portion: its execution-unit location and its own label, without repeating one inside the other. */
export function zoneName(label: string, location?: string | null): string {
    const l = (label ?? '').trim(), loc = (location ?? '').trim();
    if (!loc) return l;
    if (!l) return loc;
    const a = l.toLowerCase(), b = loc.toLowerCase();
    return a === b || a.includes(b) ? l : b.includes(a) ? loc : `${loc} · ${l}`;
}

const plural = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'участок' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'участка' : 'участков');

export function buildPackageScope(portions: ScopePortionInput[]): PackageScopeView {
    const views: ScopePortionView[] = portions.map(p => {
        const one = resolveCurrentAcceptedQuantity([{ portionId: p.id, rpFact: p.rpFact, internalSc: p.internalSc, customerAccepted: p.customerAccepted, unit: p.unit }]);
        return { id: p.id, label: p.label, zone: zoneName(p.label, p.location), unit: p.unit, plannedQuantity: p.plannedQuantity === null || p.plannedQuantity === undefined ? null : new Decimal(p.plannedQuantity).toFixed(4), currentQuantity: one?.quantity ?? null, quantitySource: one?.source ?? null };
    });
    views.sort((a, b) => a.zone.localeCompare(b.zone, 'ru', { numeric: true }) || a.id.localeCompare(b.id)); // stable, human order: 1 этаж, 2 этаж, 10 этаж
    const names = [...new Set(views.map(v => v.zone).filter(Boolean))];
    const zoneSummary = !views.length ? null : names.length > 0 && names.length <= 2 && names.join(', ').length <= 48 ? names.join(', ') : `${views.length} ${plural(views.length)}`;
    const current = resolveCurrentAcceptedQuantity(portions.map(p => ({ portionId: p.id, rpFact: p.rpFact, internalSc: p.internalSc, customerAccepted: p.customerAccepted, unit: p.unit })));
    return { hasScope: views.length > 0, portions: views, zoneSummary, currentQuantity: current };
}
