/** R04 / D09: money and provisional dates do not grant or prevent production. */
export function earlyWorkEligibility(work: { contractorId: string | null; responsibleUserId: string | null }) {
    const reasons: string[] = [];
    if (!work.contractorId) reasons.push('Не назначен подрядчик');
    if (!work.responsibleUserId) reasons.push('Не назначен ответственный');
    return { state: reasons.length ? 'MISSING_ASSIGNMENTS' as const : 'READY' as const, allowed: reasons.length === 0, reasons };
}
