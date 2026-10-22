import Decimal from 'decimal.js';
import { rows } from './db';
import { loadPortionFigures, loadWorkFacts } from './fact-resolver';

/**
 * GPR-1 — the production scopes of one Object, read from the production model that already exists. The schedule owns none of these facts;
 * this is the single place that turns Work / Work Execution Unit / Quantity Portion / portion_quantity_confirmations into the figures a
 * schedule entry is measured against.
 *
 * Physical progress provenance (packages/domain/schedule.ts, SCHEDULE_PROGRESS_SOURCE): the RP fact, the very figure the Object overview's
 * «Физическая готовность» is built from —
 *   * an execution-unit scope: the sum of the unit's portions' LATEST RP_FACT confirmation (the derivation ReadService.snapshot() and
 *     ProductionService.transition() already apply); `null` when no portion has ever had a fact reported;
 *   * a whole-work scope: the Work's fact from the one resolver (GPR-2 R02) — by the Work's persisted source mode, not by whether a unit exists.
 * Internal СК accepted quantity rides along as its own figure and is never an input to the schedule's status.
 * Nothing here touches documentation packages, AOSR, SDO or money.
 */
export interface ScopeFacts {
    key: string;
    objectWorkId: string;
    workName: string;
    workStatus: string;
    executionUnitId: string | null;
    zone: string | null;
    finishType: string | null;
    conditions: string | null;
    contractorId: string | null;
    executor: string;
    unit: string;
    plannedQuantity: string;
    /** `null` = nothing was ever reported for this scope (a reported 0 is "0.0000") OR the fact is unknown — `factUnknown` tells the two apart. */
    rpFactQuantity: string | null;
    /**
     * GPR1-UNKNOWN-01: the resolver cannot state this scope's fact (an unorderable tie among its confirmations, history unavailable). Not "nothing
     * reported" and not a zero: the schedule makes no statement about delay, and the sum of the portions that ARE known is never offered as the fact.
     */
    factUnknown: boolean;
    /** Latest Internal СК confirmed quantity, summed over the scope's portions; `null` when none was ever accepted. */
    internalScAcceptedQuantity: string | null;
    /** The work has execution units: it is planned through them, so its own whole-work scope is not offered or counted as unscheduled. */
    workHasUnits: boolean;
    /** The work's legacy planned window — offered as the default dates when a scope is added to a draft; never an authority. */
    workPlannedStart: string | null;
    workPlannedFinish: string | null;
}

export const scopeKey = (objectWorkId: string, executionUnitId: string | null): string => (executionUnitId ? 'U:' + executionUnitId : 'W:' + objectWorkId);

/** The resolver's own verdicts that mean "no quantity can be stated" (as against NONE_REPORTED, a stated nothing). */
const UNKNOWN_FACT_STATES = new Set(['UNKNOWN_TIE', 'HISTORY_UNAVAILABLE', 'NOT_YET_KNOWN']);

const sumOrNull = (values: (string | null)[]): string | null => {
    const present = values.filter((v): v is string => v !== null && v !== undefined);
    return present.length ? present.reduce((s, v) => s.add(v), new Decimal(0)).toFixed(4) : null;
};

export async function loadObjectScopes(c: any, tenantId: string, objectId: string): Promise<Map<string, ScopeFacts>> {
    const works = await rows(c, `SELECT w.id,w.name,w.unit,w.status,w.planned_quantity,w.actual_quantity,w.contractor_id,w.planned_start_date,w.planned_finish_date,k.name AS contractor_name,
        EXISTS(SELECT 1 FROM work_progress p WHERE p.tenant_id=w.tenant_id AND p.object_work_id=w.id) AS has_progress
        FROM works w LEFT JOIN contractors k ON k.tenant_id=w.tenant_id AND k.id=w.contractor_id
        WHERE w.tenant_id=$1 AND w.object_id=$2 ORDER BY w.planned_start_date,w.name,w.id`, [tenantId, objectId]);
    const workIds = works.map((w: any) => w.id);
    const units = workIds.length ? await rows(c, `SELECT u.id,u.object_work_id,u.location,u.execution_conditions,u.contractor_id,u.unit,u.planned_quantity,k.name AS contractor_name,f.name AS finish_type_name
        FROM work_execution_units u JOIN contractors k ON k.tenant_id=u.tenant_id AND k.id=u.contractor_id
        LEFT JOIN finish_types f ON f.tenant_id=u.tenant_id AND f.id=u.finish_type_id
        WHERE u.tenant_id=$1 AND u.object_work_id=ANY($2::uuid[]) ORDER BY u.created_at,u.id`, [tenantId, workIds]) : [];
    const unitIds = units.map((u: any) => u.id);
    // Latest RP fact / Internal СК confirmation per portion and the Work's actual quantity — from the ONE fact resolver (GPR-2 R02), the same
    // figures the read model and the guards use, so the schedule is never measured against a different "latest" than the Work card.
    const portions = unitIds.length ? await rows(c, 'SELECT p.id,p.execution_unit_id FROM quantity_portions p WHERE p.tenant_id=$1 AND p.execution_unit_id=ANY($2::uuid[])', [tenantId, unitIds]) : [];
    const figures = await loadPortionFigures(c, tenantId, portions.map((p: any) => p.id));
    for (const p of portions) { p.rpFact = figures.get(p.id)?.rpFact ?? null; p.internalSc = figures.get(p.id)?.internalSc ?? null; }
    const workFacts = await loadWorkFacts(c, tenantId, workIds);

    const scopes = new Map<string, ScopeFacts>();
    const unitFacts = new Map<string, { rpFact: string | null; internalSc: string | null; factUnknown: boolean }>();
    for (const u of units) {
        const own = portions.filter((p: any) => p.executionUnitId === u.id);
        // A unit with one portion in UNKNOWN_TIE has no stated fact: the other portions' sum is a partial figure and is never passed off as the unit's.
        const factUnknown = own.some((p: any) => figures.get(p.id)?.rp.state === 'UNKNOWN_TIE');
        unitFacts.set(u.id, { rpFact: factUnknown ? null : sumOrNull(own.map((p: any) => p.rpFact)), internalSc: sumOrNull(own.map((p: any) => p.internalSc)), factUnknown });
    }
    for (const w of works) {
        const ownUnits = units.filter((u: any) => u.objectWorkId === w.id);
        const base = { objectWorkId: w.id, workName: w.name, workStatus: w.status, workHasUnits: ownUnits.length > 0, workPlannedStart: w.plannedStartDate, workPlannedFinish: w.plannedFinishDate };
        // Whole-work scope (the only scope of a work with no units; kept addressable for a work that has units so its history stays readable).
        // The Work's source mode decides where its figure comes from (GPR-2 R02b): a Work on the legacy source keeps its legacy figure whether or not it
        // has execution units (creating one never takes 300 away); a Work on the portion source reports the portions' sum, null while nothing is reported.
        const fact = workFacts.get(w.id)!;
        const legacyFact = w.hasProgress || new Decimal(w.actualQuantity).gt(0) ? new Decimal(w.actualQuantity).toFixed(4) : null;
        // Whatever the mode, a verdict of "cannot state" from the resolver is honoured: it is never replaced by the works.actual_quantity column.
        const wholeUnknown = UNKNOWN_FACT_STATES.has(fact.state);
        const wholeFact = wholeUnknown ? null : fact.mode === 'LEGACY_WORK' ? legacyFact : fact.state === 'NONE_REPORTED' ? null : fact.quantity;
        scopes.set(scopeKey(w.id, null), {
            ...base, key: scopeKey(w.id, null), executionUnitId: null, zone: null, finishType: null, conditions: null,
            contractorId: w.contractorId, executor: w.contractorName ?? 'Не назначен', unit: w.unit, plannedQuantity: new Decimal(w.plannedQuantity).toFixed(4),
            rpFactQuantity: wholeFact, factUnknown: wholeUnknown,
            internalScAcceptedQuantity: ownUnits.length ? sumOrNull(ownUnits.filter((u: any) => u.unit === w.unit).map((u: any) => unitFacts.get(u.id)!.internalSc)) : null,
        });
        for (const u of ownUnits) {
            const facts = unitFacts.get(u.id)!;
            scopes.set(scopeKey(w.id, u.id), {
                ...base, key: scopeKey(w.id, u.id), executionUnitId: u.id, zone: u.location ?? null, finishType: u.finishTypeName ?? null, conditions: u.executionConditions ?? null,
                contractorId: u.contractorId, executor: u.contractorName, unit: u.unit, plannedQuantity: new Decimal(u.plannedQuantity).toFixed(4),
                rpFactQuantity: facts.rpFact, factUnknown: facts.factUnknown, internalScAcceptedQuantity: facts.internalSc,
            });
        }
    }
    return scopes;
}
