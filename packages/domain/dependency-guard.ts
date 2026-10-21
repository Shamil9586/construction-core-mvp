import Decimal from 'decimal.js';
import { knownQuantityOrNull, resolveLatestConfirmation, resolveWorkFact, type WorkFactEvidence } from './gpr2/fact-resolver';

/**
 * R04 CP02 — may a technological dependency still be added in front of this Work?
 *
 * Only while production has provably not started. The Work's figure comes from the one R02 resolver (resolveWorkFact over the evidence
 * loadWorkEvidence() read on the caller's transaction) — never from works.actual_quantity alone, which stays 0 while the fact is recorded per
 * portion (the CP02 defect: portion 500, legacy 0 passed). Fail-closed: a fact the resolver cannot state (UNKNOWN_TIE, …) is not a confirmed
 * zero, so the dependency is refused rather than added silently.
 *
 * A start is any positive figure the resolver reports — the figure in force, the legacy whole-Work figure or the portion sum — or any portion
 * whose latest RP fact (resolveLatestConfirmation, the same rule) is positive or an unorderable tie, including a portion measured in a unit the
 * Work's quantity does not add in (F8.1-04 keeps it out of the sum, not out of "work has begun").
 */
export interface DependencyAdditionVerdict {
    allowed: boolean;
    rule: 'WORK_NOT_PLANNED' | 'PRODUCTION_STARTED' | 'FACT_UNKNOWN' | null;
    message: string | null;
}

export const DEPENDENCY_STARTED_MESSAGE = 'Нельзя добавлять зависимость к начатой работе';
export const DEPENDENCY_FACT_UNKNOWN_MESSAGE = 'Нельзя добавлять зависимость: факт выполнения работы не определён, отсутствие начала работ не подтверждено';

const refuse = (rule: DependencyAdditionVerdict['rule'], message: string): DependencyAdditionVerdict => ({ allowed: false, rule, message });

export function dependencyAdditionVerdict(work: { status: string }, evidence: WorkFactEvidence | undefined): DependencyAdditionVerdict {
    if (work.status !== 'PLANNED')
        return refuse('WORK_NOT_PLANNED', DEPENDENCY_STARTED_MESSAGE);
    if (!evidence)
        return refuse('FACT_UNKNOWN', DEPENDENCY_FACT_UNKNOWN_MESSAGE);
    const fact = resolveWorkFact(evidence);
    const quantity = knownQuantityOrNull(fact);
    if (quantity === null)
        return refuse('FACT_UNKNOWN', DEPENDENCY_FACT_UNKNOWN_MESSAGE);
    const positive = (q: string | null) => q !== null && new Decimal(q).gt(0);
    if ([quantity, fact.legacyQuantity, fact.portionQuantity].some(positive))
        return refuse('PRODUCTION_STARTED', DEPENDENCY_STARTED_MESSAGE);
    for (const unit of evidence.units)
        for (const portion of unit.portions) {
            const latest = resolveLatestConfirmation(portion.rpFacts);
            if (latest.state === 'UNKNOWN_TIE')
                return refuse('FACT_UNKNOWN', DEPENDENCY_FACT_UNKNOWN_MESSAGE);
            if (latest.state === 'RESOLVED' && positive(latest.quantity))
                return refuse('PRODUCTION_STARTED', DEPENDENCY_STARTED_MESSAGE);
        }
    return { allowed: true, rule: null, message: null };
}
