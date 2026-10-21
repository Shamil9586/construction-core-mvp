import { rows } from './db';
import {
    ConfirmationRecord, ConfirmationSource, CustomerScResolution, LatestConfirmation, UnitEvidence, WorkFact, WorkFactEvidence,
    assertInstant, knownQuantityOrNull, resolveCustomerScGroup, resolveLatestConfirmation, resolveWorkFact
} from '../../../packages/domain/gpr2/fact-resolver';

/**
 * GPR-2 R02 — the SQL side of the one fact resolver. It FETCHES; every decision (latest, tie, source mode, known-at) is made by the pure
 * resolver in packages/domain/gpr2/fact-resolver.ts, so the read model, the guards and the readers cannot disagree.
 *
 * Instants travel as canonical microsecond UTC text (to_char), never as JS Dates: a Date has milliseconds only and would tie or reorder
 * instants PostgreSQL distinguishes (F12.1-R01). The "latest group" is selected INSIDE PostgreSQL on the native timestamptz (MAX() + join
 * on equality) — the idiom CUSTOMER_SC already used — so a current-state read pulls only the rows that can decide the answer. A history read
 * (known-at, completion) pulls every row of the portions asked about.
 *
 * Every function takes the caller's connection `c`: a business operation that needs several figures reads them all on its own transaction
 * or snapshot, not through independent pool reads (R03a).
 */
const INSTANT_SQL = (col: string) => `to_char(${col} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface FactQueryOptions {
    /** KNOWN-AT (immutable `created_at` of each row). Absent = current state. */
    knownAt?: string | null;
    /** Load the whole history of the rows asked about instead of only the latest group (needed for known-at over time and completion). */
    history?: boolean;
}

const toRecord = (r: any): ConfirmationRecord => ({
    id: r.id, portionId: r.portionId, source: r.source, quantity: r.quantity, recordedAt: assertInstant(r.recordedAtUs, 'recorded_at'),
    createdAt: assertInstant(r.createdAtUs, 'created_at'), sequence: r.confirmationSeq === null || r.confirmationSeq === undefined ? null : String(r.confirmationSeq)
});

/** The confirmation rows that can decide the latest answer for the given portions and sources. */
export async function loadConfirmations(c: any, tenantId: string, portionIds: string[], sources: readonly ConfirmationSource[], opts: FactQueryOptions = {}): Promise<ConfirmationRecord[]> {
    if (!portionIds.length)
        return [];
    const knownAt = opts.knownAt ? assertInstant(opts.knownAt, 'knownAt') : null;
    const cols = `c.id,c.portion_id,c.source,c.quantity,c.confirmation_seq,${INSTANT_SQL('c.recorded_at')} AS recorded_at_us,${INSTANT_SQL('c.created_at')} AS created_at_us`;
    const params: any[] = [tenantId, portionIds, [...sources]];
    if (knownAt)
        params.push(knownAt);
    const known = knownAt ? ' AND created_at<=$4::timestamptz' : '';
    const sql = opts.history
        ? `SELECT ${cols} FROM portion_quantity_confirmations c WHERE c.tenant_id=$1 AND c.portion_id=ANY($2::uuid[]) AND c.source=ANY($3::text[])${knownAt ? ' AND c.created_at<=$4::timestamptz' : ''}`
        : `SELECT ${cols} FROM portion_quantity_confirmations c JOIN (SELECT portion_id,source,MAX(recorded_at) AS max_at FROM portion_quantity_confirmations WHERE tenant_id=$1 AND portion_id=ANY($2::uuid[]) AND source=ANY($3::text[])${known} GROUP BY portion_id,source) m ON m.portion_id=c.portion_id AND m.source=c.source AND m.max_at=c.recorded_at WHERE c.tenant_id=$1${knownAt ? ' AND c.created_at<=$4::timestamptz' : ''}`;
    return (await rows(c, sql, params)).map(toRecord);
}

export interface PortionFigures {
    portionId: string;
    rp: LatestConfirmation;
    internal: LatestConfirmation;
    customer: CustomerScResolution;
    /** Plain figures for the readers: the resolved quantity, or null for "none" AND for an unorderable tie (a guard treats null as not satisfied). */
    rpFact: string | null;
    internalSc: string | null;
    customerAccepted: string | null;
}
const plain = (l: LatestConfirmation) => (l.state === 'RESOLVED' ? l.quantity : null);

/** Latest RP_FACT, INTERNAL_SC and the CUSTOMER_SC group of each portion — the one place the readers and the guards get them from. */
export async function loadPortionFigures(c: any, tenantId: string, portionIds: string[], opts: FactQueryOptions = {}): Promise<Map<string, PortionFigures>> {
    const records = await loadConfirmations(c, tenantId, portionIds, ['RP_FACT', 'INTERNAL_SC', 'CUSTOMER_SC'], opts);
    const out = new Map<string, PortionFigures>();
    for (const portionId of portionIds) {
        const own = records.filter(r => r.portionId === portionId);
        const of = (s: ConfirmationSource) => own.filter(r => r.source === s);
        const rp = resolveLatestConfirmation(of('RP_FACT'), opts), internal = resolveLatestConfirmation(of('INTERNAL_SC'), opts), customer = resolveCustomerScGroup(of('CUSTOMER_SC'), opts);
        out.set(portionId, { portionId, rp, internal, customer, rpFact: plain(rp), internalSc: plain(internal), customerAccepted: customer.quantity });
    }
    return out;
}

/** Everything the resolver needs about the given Works, read on the caller's connection. */
export async function loadWorkEvidence(c: any, tenantId: string, workIds: string[], opts: FactQueryOptions = {}): Promise<Map<string, WorkFactEvidence>> {
    const out = new Map<string, WorkFactEvidence>();
    if (!workIds.length)
        return out;
    const knownAt = opts.knownAt ? assertInstant(opts.knownAt, 'knownAt') : null;
    const history = !!opts.history || !!knownAt;
    const works = await rows(c, `SELECT id,unit,actual_quantity,fact_source_mode,${INSTANT_SQL('created_at')} AS created_at_us FROM works WHERE tenant_id=$1 AND id=ANY($2::uuid[])`, [tenantId, workIds]);
    const modeHistory = await rows(c, `SELECT work_id,to_mode,${INSTANT_SQL('created_at')} AS at_us FROM work_fact_source_mode_history WHERE tenant_id=$1 AND work_id=ANY($2::uuid[]) ORDER BY created_at,id`, [tenantId, workIds]);
    // The current legacy reading needs only "is there any progress row"; the history reads need every row.
    const progress = history
        ? await rows(c, `SELECT id,object_work_id,total_quantity,${INSTANT_SQL('created_at')} AS created_at_us FROM work_progress WHERE tenant_id=$1 AND object_work_id=ANY($2::uuid[])`, [tenantId, workIds])
        : await rows(c, `SELECT DISTINCT ON (object_work_id) id,object_work_id,total_quantity,${INSTANT_SQL('created_at')} AS created_at_us FROM work_progress WHERE tenant_id=$1 AND object_work_id=ANY($2::uuid[]) ORDER BY object_work_id,created_at DESC,id`, [tenantId, workIds]);
    const units = await rows(c, `SELECT id,object_work_id,unit,${INSTANT_SQL('created_at')} AS created_at_us FROM work_execution_units WHERE tenant_id=$1 AND object_work_id=ANY($2::uuid[]) ORDER BY created_at,id`, [tenantId, workIds]);
    const portions = units.length ? await rows(c, `SELECT id,execution_unit_id,${INSTANT_SQL('created_at')} AS created_at_us FROM quantity_portions WHERE tenant_id=$1 AND execution_unit_id=ANY($2::uuid[]) ORDER BY created_at,id`, [tenantId, units.map((u: any) => u.id)]) : [];
    const confirmations = await loadConfirmations(c, tenantId, portions.map((p: any) => p.id), ['RP_FACT'], { knownAt, history });
    for (const w of works) {
        const unitEvidence: UnitEvidence[] = units.filter((u: any) => u.objectWorkId === w.id).map((u: any) => ({
            id: u.id, unit: u.unit, createdAt: assertInstant(u.createdAtUs, 'unit.created_at'),
            portions: portions.filter((p: any) => p.executionUnitId === u.id).map((p: any) => ({
                id: p.id, createdAt: assertInstant(p.createdAtUs, 'portion.created_at'), rpFacts: confirmations.filter(r => r.portionId === p.id)
            }))
        }));
        out.set(w.id, {
            workId: w.id, workUnit: w.unit, createdAt: assertInstant(w.createdAtUs, 'work.created_at'), persistedMode: w.factSourceMode ?? null,
            modeHistory: modeHistory.filter((h: any) => h.workId === w.id).map((h: any) => ({ toMode: h.toMode, at: assertInstant(h.atUs, 'mode.at') })),
            legacyActualQuantity: w.actualQuantity,
            legacyProgress: progress.filter((p: any) => p.objectWorkId === w.id).map((p: any) => ({ id: p.id, totalQuantity: p.totalQuantity, createdAt: assertInstant(p.createdAtUs, 'progress.created_at') })),
            units: unitEvidence
        });
    }
    return out;
}

/** The actual quantity of each Work, resolved by the one resolver. A Work id that does not exist is absent from the map. */
export async function loadWorkFacts(c: any, tenantId: string, workIds: string[], opts: FactQueryOptions = {}): Promise<Map<string, WorkFact>> {
    const evidence = await loadWorkEvidence(c, tenantId, workIds, opts);
    const out = new Map<string, WorkFact>();
    for (const [id, ev] of evidence)
        out.set(id, resolveWorkFact(ev, { knownAt: opts.knownAt ?? null }));
    return out;
}

/** The fail-closed quantity a guard compares with: null when the resolver cannot state one. */
export const guardQuantity = (f: WorkFact | undefined): string | null => (f ? knownQuantityOrNull(f) : null);
