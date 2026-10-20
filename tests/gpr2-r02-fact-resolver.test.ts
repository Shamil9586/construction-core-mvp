import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ConfirmationRecord, WorkFactEvidence, evaluatePortionFactModeTransition, instantOf, isInstant, resolveCompletionObservedAt, resolveCustomerScGroup, resolveLatestConfirmation,
    resolveWorkFact, resolveWorkFactEffectiveAt
} from '../packages/domain/gpr2/fact-resolver';
import { resolveActualQuantity, resolveCustomerScLatestGroup } from '../packages/domain';

/**
 * GPR-2 R02a/b/c — the pure resolver. No database. Decisions C13, C15, D19 (fact source); scenarios A05 and A24.
 * The SQL side and the production consumers are covered by gpr2-r02-fact-resolver-pg.test.ts / gpr2-r02-consumers.test.ts.
 */
const t = (micro: number, day = 1) => `2026-10-${String(day).padStart(2, '0')}T00:00:00.${String(micro).padStart(6, '0')}Z`;
let n = 0;
const conf = (source: ConfirmationRecord['source'], quantity: string, recordedAt: string, over: Partial<ConfirmationRecord> = {}): ConfirmationRecord =>
    ({ id: '00000000-0000-4000-8000-' + String(++n).padStart(12, '0'), portionId: 'p1', source, quantity, recordedAt, createdAt: recordedAt, sequence: null, ...over });
const permutations = <T>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map(p => [x, ...p])));

test('R02a instants are canonical microsecond text, so text order is time order', () => {
    assert.ok(isInstant(t(123456)));
    assert.ok(!isInstant('2026-10-01T00:00:00Z'), 'no fraction');
    assert.ok(!isInstant('2026-10-01T00:00:00.123Z'), 'milliseconds only');
    assert.ok(!isInstant('2026-13-01T00:00:00.000000Z'), 'impossible month');
    assert.ok(t(999999) < t(0, 2));
    assert.ok(t(1) < t(2), 'two instants a JS Date would call equal stay ordered');
    assert.equal(new Date(t(1)).getTime(), new Date(t(2)).getTime());
    assert.equal(instantOf(new Date('2026-10-01T00:00:00.123Z')), '2026-10-01T00:00:00.123000Z');
});

test('R02a latest RP_FACT / INTERNAL_SC: the newest recordedAt wins, whatever order the rows arrive in', () => {
    const rows = [conf('RP_FACT', '100', t(1)), conf('RP_FACT', '250', t(3)), conf('RP_FACT', '180', t(2))];
    for (const p of permutations(rows)) {
        const r = resolveLatestConfirmation(p);
        assert.equal(r.state, 'RESOLVED');
        assert.equal((r as any).quantity, '250.0000');
        assert.equal((r as any).basis, 'SOLE');
    }
    assert.deepEqual(resolveLatestConfirmation([]), { state: 'NONE' });
});

test('R02a a later correction to a LOWER figure is the figure (RP corrects downward), including zero', () => {
    const r = resolveLatestConfirmation([conf('RP_FACT', '500', t(1)), conf('RP_FACT', '0', t(2))]);
    assert.equal((r as any).quantity, '0.0000');
    assert.equal(r.state, 'RESOLVED', 'a reported 0 is a fact, not "none"');
});

test('R02a exact tie: the new confirmations order by sequence, deterministically', () => {
    const a = conf('RP_FACT', '100', t(5), { sequence: '41' }), b = conf('RP_FACT', '300', t(5), { sequence: '42' });
    for (const p of permutations([a, b])) {
        const r = resolveLatestConfirmation(p) as any;
        assert.equal(r.state, 'RESOLVED');
        assert.equal(r.basis, 'SEQUENCE');
        assert.equal(r.quantity, '300.0000');
        assert.equal(r.confirmationId, b.id);
    }
    // a sequence above 2^53 is compared as a BigInt, not as a float
    const big1 = conf('RP_FACT', '1', t(6), { sequence: '9007199254740993' }), big2 = conf('RP_FACT', '2', t(6), { sequence: '9007199254740992' });
    assert.equal((resolveLatestConfirmation([big2, big1]) as any).quantity, '1.0000');
});

test('R02a an unorderable legacy tie is UNKNOWN — never a guess, never a rewritten timestamp', () => {
    const a = conf('RP_FACT', '100', t(5)), b = conf('RP_FACT', '300', t(5));
    for (const p of permutations([a, b])) {
        const r = resolveLatestConfirmation(p) as any;
        assert.equal(r.state, 'UNKNOWN_TIE');
        assert.deepEqual(r.candidates.map((c: any) => c.quantity).sort(), ['100.0000', '300.0000']);
    }
    const mixed = resolveLatestConfirmation([conf('RP_FACT', '1', t(7)), conf('RP_FACT', '2', t(7), { sequence: '9' })]);
    assert.equal(mixed.state, 'UNKNOWN_TIE', 'one legacy row without a sequence: the tie cannot be proven');
    // the same sequence twice cannot be ordered either
    const dup = resolveLatestConfirmation([conf('RP_FACT', '1', t(8), { sequence: '5' }), conf('RP_FACT', '2', t(8), { sequence: '5' })]);
    assert.equal(dup.state, 'UNKNOWN_TIE');
});

test('R02a a tie whose candidates agree is harmless', () => {
    const r = resolveLatestConfirmation([conf('INTERNAL_SC', '120', t(9)), conf('INTERNAL_SC', '120.0000', t(9))]) as any;
    assert.equal(r.state, 'RESOLVED');
    assert.equal(r.basis, 'EQUAL_QUANTITIES');
    assert.equal(r.quantity, '120.0000');
});

test('R02a CUSTOMER_SC keeps the F12.1 grouped semantics (the group goes to resolveCustomerScLatestGroup unchanged)', () => {
    const cases: string[][] = [[], ['0'], ['5'], ['5', '5'], ['5', '7'], ['5', '0'], ['0', '0']];
    for (const quantities of cases) {
        const rows = quantities.map(q => conf('CUSTOMER_SC', q, t(4)));
        const expected = resolveCustomerScLatestGroup(quantities);
        const got = resolveCustomerScGroup(rows);
        assert.equal(got.ready, expected.ready, JSON.stringify(quantities));
        assert.equal(got.quantity, expected.quantity, JSON.stringify(quantities));
        assert.equal(got.groupSize, quantities.length);
    }
    // only the LATEST timestamp group counts: an older positive row never outranks a newer non-positive one
    const g = resolveCustomerScGroup([conf('CUSTOMER_SC', '9', t(1)), conf('CUSTOMER_SC', '0', t(2))]);
    assert.deepEqual({ ready: g.ready, quantity: g.quantity }, { ready: false, quantity: '0.0000' });
});

test('R02c known-at: a row created after T does not exist at T, even if it is recorded "for" an earlier instant', () => {
    const early = conf('RP_FACT', '100', t(1), { createdAt: t(1) });
    const retro = conf('RP_FACT', '400', t(2), { createdAt: t(9) }); // newest recordedAt, but the system learned it at t(9)
    const at = (knownAt: string | null) => resolveLatestConfirmation([early, retro], { knownAt }) as any;
    assert.equal(at(null).quantity, '400.0000');
    assert.equal(at(t(8)).quantity, '100.0000', 'future-known fact is invisible in the past');
    assert.equal(at(t(9)).quantity, '400.0000');
    assert.equal(at(t(0)).state, 'NONE');
    const customer = resolveCustomerScGroup([conf('CUSTOMER_SC', '5', t(1)), conf('CUSTOMER_SC', '8', t(2), { createdAt: t(9) })], { knownAt: t(8) });
    assert.equal(customer.quantity, '5.0000');
});

// ----------------------------------------------------------------------------------------------------------------------------------

const evidence = (over: Partial<WorkFactEvidence> = {}, rp: ConfirmationRecord[][] = []): WorkFactEvidence => ({
    workId: 'w1', workUnit: 'м2', createdAt: t(0), persistedMode: 'LEGACY_WORK', modeHistory: [], legacyActualQuantity: '0', legacyProgress: [],
    units: rp.map((facts, i) => ({ id: 'u' + i, unit: 'м2', createdAt: t(0), portions: [{ id: 'p' + i, createdAt: t(0), rpFacts: facts.map(f => ({ ...f, portionId: 'p' + i })) }] })),
    ...over
});
const progress = (total: string, createdAt: string, id = 'pr' + ++n) => ({ id, totalQuantity: total, createdAt });

test('R02b A05: legacy 300 stays 300 when an EMPTY execution unit is created — persisted and unclassified alike', () => {
    for (const persistedMode of ['LEGACY_WORK', null] as const) {
        const ev = evidence({ persistedMode, legacyActualQuantity: '300', legacyProgress: [progress('300', t(1))] }, [[]]);
        const f = resolveWorkFact(ev);
        assert.equal(f.quantity, '300.0000', String(persistedMode));
        assert.equal(f.mode, 'LEGACY_WORK');
        assert.equal(f.state, 'KNOWN');
        assert.equal(f.modeProvenance, persistedMode ? 'PERSISTED' : 'DERIVED_UNCLASSIFIED');
    }
    // the OLD reading is the defect this replaces: units exist -> the legacy figure was dropped
    assert.equal(resolveActualQuantity('300', 'м2', [{ unit: 'м2', actualQuantity: '0' }]), '0.0000');
});

test('R02b a Work never reads "the legacy figure plus the portion figure"', () => {
    const f = resolveWorkFact(evidence({ persistedMode: 'PORTION', legacyActualQuantity: '300' }, [[conf('RP_FACT', '120', t(2))]]));
    assert.equal(f.mode, 'PORTION');
    assert.equal(f.quantity, '120.0000');
    assert.equal(f.legacyQuantity, '300.0000', 'the legacy figure stays visible, never summed');
    assert.notEqual(f.quantity, '420.0000');
});

test('R02b PORTION: portions of a differently-measured unit are never added in; nothing reported is NONE_REPORTED, not a quiet 0', () => {
    const ev = evidence({ persistedMode: 'PORTION' }, [[conf('RP_FACT', '50', t(1))], [conf('RP_FACT', '40', t(1))]]);
    ev.units[1].unit = 'м3';
    assert.equal(resolveWorkFact(ev).quantity, '50.0000');
    const none = resolveWorkFact(evidence({ persistedMode: 'PORTION' }, [[]]));
    assert.equal(none.state, 'NONE_REPORTED');
    assert.equal(none.quantity, '0.0000');
    const reportedZero = resolveWorkFact(evidence({ persistedMode: 'PORTION' }, [[conf('RP_FACT', '0', t(1))]]));
    assert.equal(reportedZero.state, 'KNOWN', 'a reported 0 is a fact');
});

test('R02b two portions sum; an unorderable tie makes the Work figure unknown rather than wrong', () => {
    const ok = resolveWorkFact(evidence({ persistedMode: 'PORTION' }, [[conf('RP_FACT', '70', t(1))], [conf('RP_FACT', '30.5', t(1))]]));
    assert.equal(ok.quantity, '100.5000');
    const tie = resolveWorkFact(evidence({ persistedMode: 'PORTION' }, [[conf('RP_FACT', '70', t(1)), conf('RP_FACT', '71', t(1))], [conf('RP_FACT', '30', t(1))]]));
    assert.equal(tie.state, 'UNKNOWN_TIE');
    assert.equal(tie.quantity, null);
    assert.deepEqual(tie.unknownPortionIds, ['p0']);
});

test('R02b an unclassified Work (a row older than the persisted mode) is read from its evidence and flagged; nothing is written back', () => {
    // units exist and portions report, no legacy figure: portions (what the code did before R02)
    const portionOnly = resolveWorkFact(evidence({ persistedMode: null }, [[conf('RP_FACT', '60', t(1))]]));
    assert.deepEqual([portionOnly.mode, portionOnly.modeProvenance, portionOnly.state, portionOnly.quantity], ['PORTION', 'DERIVED_UNCLASSIFIED', 'KNOWN', '60.0000']);
    // no units at all: the legacy figure (F7 behaviour)
    const noUnits = resolveWorkFact(evidence({ persistedMode: null, legacyActualQuantity: '12' }));
    assert.deepEqual([noUnits.mode, noUnits.quantity], ['LEGACY_WORK', '12.0000']);
    // both a legacy figure and portion facts: the overlap is reported, the pre-R02 reading (portions) is kept, the legacy figure stays visible
    const overlap = resolveWorkFact(evidence({ persistedMode: null, legacyActualQuantity: '300', legacyProgress: [progress('300', t(1))] }, [[conf('RP_FACT', '60', t(2))]]));
    assert.equal(overlap.state, 'OVERLAP_UNRECONCILED');
    assert.equal(overlap.quantity, '60.0000');
    assert.equal(overlap.legacyQuantity, '300.0000');
});

test('R02b a persisted LEGACY_WORK Work that holds portion facts is an integrity anomaly: shown as such, never summed', () => {
    const f = resolveWorkFact(evidence({ persistedMode: 'LEGACY_WORK', legacyActualQuantity: '10' }, [[conf('RP_FACT', '5', t(1))]]));
    assert.equal(f.state, 'OVERLAP_UNRECONCILED');
    assert.equal(f.quantity, '10.0000');
    assert.equal(f.portionQuantity, '5.0000');
});

test('R02b the guarded edge: a CLASSIFIED legacy Work refuses a portion fact while a legacy fact exists; creating a unit is not an edge', () => {
    const legacy = { legacyActualQuantity: '300', hasLegacyProgress: true };
    assert.deepEqual(evaluatePortionFactModeTransition({ persistedMode: 'LEGACY_WORK', ...legacy }), { allowed: false, rule: 'LEGACY_FACT_PRESENT' });
    assert.deepEqual(evaluatePortionFactModeTransition({ persistedMode: 'LEGACY_WORK', legacyActualQuantity: '0', hasLegacyProgress: true }), { allowed: false, rule: 'LEGACY_FACT_PRESENT' });
    assert.deepEqual(evaluatePortionFactModeTransition({ persistedMode: 'LEGACY_WORK', legacyActualQuantity: '0.0000', hasLegacyProgress: false }), { allowed: true, action: 'PERSIST_PORTION', basis: 'NO_LEGACY_FACT_AT_FIRST_PORTION_FACT' });
    assert.deepEqual(evaluatePortionFactModeTransition({ persistedMode: 'PORTION', ...legacy }), { allowed: true, action: 'NONE', basis: 'ALREADY_PORTION' });
});

test('R02b an UNCLASSIFIED Work keeps the pre-R02 recording behaviour (protected F8.x / F12.x flows) and flags the overlap; nothing is written', () => {
    assert.deepEqual(evaluatePortionFactModeTransition({ persistedMode: null, legacyActualQuantity: '300', hasLegacyProgress: true }), { allowed: true, action: 'NONE', basis: 'UNCLASSIFIED_PRE_R02_BEHAVIOUR', overlap: true });
    assert.deepEqual(evaluatePortionFactModeTransition({ persistedMode: null, legacyActualQuantity: '0', hasLegacyProgress: false }), { allowed: true, action: 'NONE', basis: 'UNCLASSIFIED_PRE_R02_BEHAVIOUR', overlap: false });
});

// ----------------------------------------------------------------------------------------------------------------------------------

test('R02c known-at over a Work: it does not exist before it was created; the legacy history answers for the past', () => {
    const ev = evidence({ createdAt: t(10), legacyActualQuantity: '300', legacyProgress: [progress('100', t(11)), progress('300', t(13))] });
    assert.equal(resolveWorkFact(ev, { knownAt: t(9) }).state, 'NOT_YET_KNOWN');
    assert.equal(resolveWorkFact(ev, { knownAt: t(10) }).quantity, '0.0000');
    assert.equal(resolveWorkFact(ev, { knownAt: t(12) }).quantity, '100.0000');
    assert.equal(resolveWorkFact(ev, { knownAt: t(13) }).quantity, '300.0000');
    assert.equal(resolveWorkFact(ev).quantity, '300.0000');
});

test('R02c known-at: a positive legacy figure with NO history cannot be placed in time — explicit, not 0 and not the present value', () => {
    const ev = evidence({ createdAt: t(10), legacyActualQuantity: '300', legacyProgress: [] });
    const f = resolveWorkFact(ev, { knownAt: t(20) });
    assert.equal(f.state, 'HISTORY_UNAVAILABLE');
    assert.equal(f.quantity, null);
    assert.equal(resolveWorkFact(ev).quantity, '300.0000', 'the CURRENT figure is unaffected');
});

test('R02c known-at: portion facts known later are invisible earlier; the mode history says when LEGACY_WORK became PORTION', () => {
    const f1 = conf('RP_FACT', '40', t(12)), f2 = conf('RP_FACT', '90', t(15));
    const ev = evidence({ createdAt: t(10), persistedMode: 'PORTION', modeHistory: [{ toMode: 'PORTION', at: t(12) }] }, [[f1, f2]]);
    assert.equal(resolveWorkFact(ev, { knownAt: t(11) }).mode, 'LEGACY_WORK');
    assert.equal(resolveWorkFact(ev, { knownAt: t(13) }).quantity, '40.0000');
    assert.equal(resolveWorkFact(ev, { knownAt: t(13) }).mode, 'PORTION');
    assert.equal(resolveWorkFact(ev, { knownAt: t(16) }).quantity, '90.0000');
    assert.equal(resolveWorkFact(ev).quantity, '90.0000');
});

test('R02c a unit or portion created after T does not take part in the past figure', () => {
    const ev = evidence({ persistedMode: 'PORTION', createdAt: t(0) }, [[conf('RP_FACT', '40', t(5))]]);
    ev.units[0].portions[0].createdAt = t(4);
    ev.units[0].createdAt = t(4);
    assert.equal(resolveWorkFact(ev, { knownAt: t(3) }).state, 'NONE_REPORTED');
});

test('R02c EFFECTIVE-AT is not recorded — answered explicitly, never aliased to known-at', () => {
    const a = resolveWorkFactEffectiveAt(evidence(), t(3));
    assert.equal(a.state, 'EFFECTIVE_DATE_NOT_RECORDED');
});

test('R02c completionObservedAt: the instant that STARTED the present uninterrupted run at/above the target, with its provenance', () => {
    const f1 = conf('RP_FACT', '400', t(1)), f2 = conf('RP_FACT', '1000', t(2)), f3 = conf('RP_FACT', '900', t(3)), f4 = conf('RP_FACT', '1000', t(4));
    const reached = resolveCompletionObservedAt(evidence({ persistedMode: 'PORTION' }, [[f1, f2]]), '1000');
    assert.deepEqual(reached, { state: 'OBSERVED', at: t(2), provenance: 'SYSTEM_RECORDED_CREATED_AT' });
    // completed, then corrected below, then completed again: the run that is true now started at t(4)
    const again = resolveCompletionObservedAt(evidence({ persistedMode: 'PORTION' }, [[f1, f2, f3, f4]]), '1000');
    assert.deepEqual(again, { state: 'OBSERVED', at: t(4), provenance: 'SYSTEM_RECORDED_CREATED_AT' });
    assert.deepEqual(resolveCompletionObservedAt(evidence({ persistedMode: 'PORTION' }, [[f1]]), '1000'), { state: 'NOT_COMPLETED' });
    assert.deepEqual(resolveCompletionObservedAt(evidence({ persistedMode: 'PORTION' }, [[f1, f2, f3]]), '1000'), { state: 'NOT_COMPLETED' });
});

test('R02c completionObservedAt: legacy completion with no history, or an unorderable tie, is UNKNOWN — not "on time"', () => {
    assert.deepEqual(resolveCompletionObservedAt(evidence({ legacyActualQuantity: '1000' }), '1000'), { state: 'UNKNOWN', reason: 'HISTORY_UNAVAILABLE' });
    const tied = resolveCompletionObservedAt(evidence({ persistedMode: 'PORTION' }, [[conf('RP_FACT', '1000', t(2)), conf('RP_FACT', '5', t(2))]]), '1000');
    assert.deepEqual(tied, { state: 'UNKNOWN', reason: 'CURRENT_FACT_UNKNOWN' });
    const legacyWithHistory = resolveCompletionObservedAt(evidence({ legacyActualQuantity: '1000', legacyProgress: [progress('600', t(1)), progress('1000', t(3))] }), '1000');
    assert.deepEqual(legacyWithHistory, { state: 'OBSERVED', at: t(3), provenance: 'SYSTEM_RECORDED_CREATED_AT' });
});

test('R02a determinism: any arrangement of the same evidence resolves identically', () => {
    const rows = [conf('RP_FACT', '10', t(1)), conf('RP_FACT', '25', t(3), { sequence: '2' }), conf('RP_FACT', '30', t(3), { sequence: '3' }), conf('RP_FACT', '5', t(2))];
    const expected = JSON.stringify(resolveLatestConfirmation(rows));
    for (const p of permutations(rows))
        assert.equal(JSON.stringify(resolveLatestConfirmation(p)), expected);
});
