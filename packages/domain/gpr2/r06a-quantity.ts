import Decimal from 'decimal.js';

export interface QuantityRead {
    workId: string;
    objectId: string;
    originalQuantity: string | null;
    originalProvenance: 'PROVEN_CREATION' | 'UNKNOWN_LEGACY';
    originalSource: { kind: string; ref: string | null; version: string | null } | null;
    currentQuantity: string | null;
    currentProvenance: 'INITIAL_VERSION' | 'APPROVED_VERSION' | 'OBSERVED_LEGACY' | 'UNKNOWN';
    currentVersionId: string | null;
    currentSequence: number | null;
    unit: string | null;
    factQuantity: string | null;
    factState: string;
    factSourceMode: string;
    baselineQuantity: null;
    baselineState: 'NOT_CAPTURED';
    integrityState: 'CONSISTENT' | 'UNKNOWN' | 'INTEGRITY_CONFLICT' | 'NOT_APPLICABLE';
}

const decimal = (value: unknown): string | null => value == null ? null : new Decimal(String(value)).toFixed(4);

export function shapeQuantityRead(input: {
    workId: string; objectId: string;
    origin: { provenanceStatus: string; sourceKind: string; sourceRef: string | null; sourceVersion: string | null; originalQuantity: string | null; unit: string } | null;
    pointer: { id: string; sequence: number; quantity: string; unit: string; sourceKind?: string } | null;
    observedQuantity: string | null; observedUnit: string | null;
    factQuantity: string | null; factState: string; factSourceMode: string;
}): QuantityRead {
    const { origin, pointer } = input;
    // Absence of a sidecar is an unproven preexisting Work, not an implicit successful migration or a zero.
    const proven = origin?.provenanceStatus === 'PROVEN_CREATION';
    const originalQuantity = proven ? decimal(origin.originalQuantity) : null;
    const currentQuantity = decimal(pointer?.quantity ?? (proven ? null : input.observedQuantity));
    const factQuantity = decimal(input.factQuantity);
    let integrityState: QuantityRead['integrityState'] = currentQuantity === null || factQuantity === null ? 'UNKNOWN' : 'CONSISTENT';
    if (currentQuantity !== null && factQuantity !== null) {
        if (new Decimal(factQuantity).gt(currentQuantity)) integrityState = 'INTEGRITY_CONFLICT';
        else if (new Decimal(currentQuantity).isZero() && new Decimal(factQuantity).isZero()) integrityState = 'NOT_APPLICABLE';
    }
    return {
        workId: input.workId, objectId: input.objectId,
        originalQuantity, originalProvenance: proven ? 'PROVEN_CREATION' : 'UNKNOWN_LEGACY',
        originalSource: proven ? { kind: origin!.sourceKind, ref: origin!.sourceRef, version: origin!.sourceVersion } : null,
        currentQuantity, currentProvenance: pointer ? (pointer.sourceKind === 'OBSERVED_LEGACY' ? 'OBSERVED_LEGACY' : pointer.sourceKind === 'APPROVED_REQUEST' ? 'APPROVED_VERSION' : 'INITIAL_VERSION') : (currentQuantity === null ? 'UNKNOWN' : 'OBSERVED_LEGACY'),
        currentVersionId: pointer?.id ?? null, currentSequence: pointer ? Number(pointer.sequence) : null,
        unit: pointer?.unit ?? (proven ? origin!.unit : input.observedUnit),
        factQuantity, factState: input.factState, factSourceMode: input.factSourceMode,
        baselineQuantity: null, baselineState: 'NOT_CAPTURED', integrityState
    };
}
