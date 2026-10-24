import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { one, rows } from './db';
import { Actor, objectAccess } from './security';
import { runCommandTx, runSnapshotRead } from './tx-context';
import { coordinate } from './coordination-lock';
import { runLedgered } from './command-ledger';
import { mapR05DbError } from './gpr2-r05-support';
import {
    CommandResult, Gpr2Error, Gpr2Permission, commandFingerprint, hasGpr2Permission, legacyFinishMappingInput, legacyWorkClassificationInput, parseR05Payload,
    permissionDenied, scopeSafeNotFound
} from '../../../packages/domain/gpr2';

/**
 * GPR-2 R05b — legacy compatibility (Technical Design §5.2 `legacy_finish_mappings` / `legacy_work_classifications`, §12.1, §13.2 I05; D01, C02, C13).
 *
 * The legacy tenant `finish_types` stay what they are. An object reaches one of them ONLY through an explicit mapping row:
 *   resolveLegacyFinish()          RESOLVED (with the object finish type the mapping names) | AMBIGUOUS (no target, on purpose) | UNRESOLVED (no row).
 *                                  It never matches by name, code or anything else: a same-named object finish type is NOT a mapping.
 *   recordLegacyFinishMapping()    an append-only decision about ONE (object, legacy finish); a correction supersedes the current row.
 *   legacyWorkFinishEvidence()     read-only: what the Work's execution units say about finishes (distinct legacy finish ids, units without one) and the
 *                                  classification that evidence would SUPPORT. It writes nothing and classifies nothing.
 *   recordLegacyWorkClassification() an append-only classification of a historical Work (SINGLE / MIXED / NON_FINISH / UNKNOWN) with its basis and the
 *                                  evidence observed at that moment. The Work, its WEUs, portions and facts are not touched and never split.
 * These are service entries without an HTTP route: deciding real legacy mappings is R19 after the LIVE inventory (Roadmap R05 LIVE gate). R05 provides
 * the model, the guards and the compatibility read; nothing here runs automatically.
 */
export async function authorizeObjectCatalog(c: any, actor: Actor, objectId: string, write: boolean): Promise<Actor> {
    const current: Actor | undefined = await one(c, `SELECT * FROM users WHERE tenant_id=$1 AND id=$2 ${write ? 'FOR SHARE' : ''}`, [actor.tenantId, actor.id]);
    if (!current || !(current as any).isActive || (write && !hasGpr2Permission(current.role, Gpr2Permission.OBJECT_CATALOG_MANAGE)))
        throw permissionDenied();
    try {
        await objectAccess(c, current, objectId, write);
    }
    catch (e) {
        if (e instanceof NotFoundException || e instanceof ForbiddenException)
            throw scopeSafeNotFound();
        throw e;
    }
    return current;
}

const fp = (commandKind: string, payload: unknown) => commandFingerprint({ commandKind, payload, expectedVersion: null, expectedScopeVersion: null, sourceVersions: {} });
const done = (id: string): Omit<CommandResult, 'commandId'> => ({ resultIds: [id], appliedVersions: { aggregate: null, scope: null }, warnings: [] });

export async function recordLegacyFinishMapping(actor: Actor, objectId: string, input: unknown, idempotencyKey: string | null = null): Promise<CommandResult> {
    const d = parseR05Payload(legacyFinishMappingInput, input);
    return runCommandTx(async tx => {
        await coordinate(tx.c, 'gpr2-r05-legacy.ts#recordLegacyFinishMapping', actor.tenantId, { object: objectId });
        const c = tx.c;
        let a: Actor;
        return (await runLedgered(c, { tenantId: actor.tenantId, actorId: actor.id, commandKind: 'legacy.finish-mapping.record', scopeId: objectId.toLowerCase(), idempotencyKey, fingerprint: fp('legacy.finish-mapping.record', d) }, {
            authorize: async () => { a = await authorizeObjectCatalog(c, actor, objectId, true); },
            execute: async () => {
                if (!await one(c, 'SELECT id FROM finish_types WHERE tenant_id=$1 AND id=$2', [a.tenantId, d.legacyFinishTypeId]))
                    throw new Gpr2Error('CROSS_SCOPE_REFERENCE', { violations: [{ path: 'legacyFinishTypeId', rule: 'REFERENCE_NOT_IN_SCOPE' }] });
                if (d.targetFinishTypeId && !await one(c, 'SELECT id FROM object_finish_types WHERE tenant_id=$1 AND object_id=$2 AND id=$3', [a.tenantId, objectId, d.targetFinishTypeId]))
                    throw new Gpr2Error('CROSS_SCOPE_REFERENCE', { violations: [{ path: 'targetFinishTypeId', rule: 'REFERENCE_NOT_IN_SCOPE' }] });
                const row = await one(c, `INSERT INTO legacy_finish_mappings(tenant_id,object_id,legacy_finish_type_id,resolution_state,target_finish_type_id,basis,supersedes_mapping_id,recorded_by)
                    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [a.tenantId, objectId, d.legacyFinishTypeId, d.resolutionState, d.targetFinishTypeId ?? null, d.basis, d.supersedesMappingId ?? null, a.id]);
                return done(row.id);
            }
        })).result;
    }).catch(e => {
        if (e?.code === '23505' && /legacy_finish_mappings_(root_uq|superseded_once)/.test(e.constraint ?? ''))
            throw new Gpr2Error('INVALID_TRANSITION', { machine: 'LEGACY_FINISH_MAPPING', from: 'CURRENT', command: 'record' }); // supersede the CURRENT row, once
        return mapR05DbError(e);
    });
}

export interface LegacyFinishResolution { state: 'UNRESOLVED' | 'RESOLVED' | 'AMBIGUOUS'; objectFinishTypeId: string | null; mappingId: string | null }
/** The compatibility read. One snapshot; only the CURRENT row of the chain counts; no row is UNRESOLVED; a name is never evidence. */
export function resolveLegacyFinish(actor: Actor, objectId: string, legacyFinishTypeId: string): Promise<LegacyFinishResolution> {
    return runSnapshotRead(async tx => {
        await authorizeObjectCatalog(tx.c, actor, objectId, false);
        const head = await one(tx.c, `SELECT * FROM legacy_finish_mappings m WHERE m.tenant_id=$1 AND m.object_id=$2 AND m.legacy_finish_type_id=$3
            AND NOT EXISTS (SELECT 1 FROM legacy_finish_mappings n WHERE n.tenant_id=m.tenant_id AND n.supersedes_mapping_id=m.id)`, [actor.tenantId, objectId, legacyFinishTypeId]);
        if (!head)
            return { state: 'UNRESOLVED', objectFinishTypeId: null, mappingId: null };
        return { state: head.resolutionState, objectFinishTypeId: head.targetFinishTypeId ?? null, mappingId: head.id };
    });
}

export interface LegacyWorkEvidence {
    workId: string; executionUnits: number; legacyFinishTypeIds: string[]; unitsWithoutFinish: number;
    /** What the evidence SUPPORTS; never applied. Two or more distinct legacy finishes = MIXED; one and no gap = SINGLE; anything else = UNKNOWN. */
    supported: 'MIXED_FINISH' | 'SINGLE_FINISH' | 'UNKNOWN';
    current: { id: string; classification: string; basis: string } | null;
}
async function evidenceOf(c: any, tenantId: string, workId: string): Promise<Omit<LegacyWorkEvidence, 'current'>> {
    const units = await rows(c, 'SELECT id, finish_type_id FROM work_execution_units WHERE tenant_id=$1 AND object_work_id=$2 ORDER BY id', [tenantId, workId]);
    const ids = [...new Set(units.map((u: any) => u.finishTypeId).filter(Boolean))].sort() as string[];
    const gaps = units.filter((u: any) => !u.finishTypeId).length;
    return { workId, executionUnits: units.length, legacyFinishTypeIds: ids, unitsWithoutFinish: gaps, supported: ids.length >= 2 ? 'MIXED_FINISH' : ids.length === 1 && gaps === 0 ? 'SINGLE_FINISH' : 'UNKNOWN' };
}
export function legacyWorkFinishEvidence(actor: Actor, workId: string): Promise<LegacyWorkEvidence> {
    return runSnapshotRead(async tx => {
        const work = await one(tx.c, 'SELECT id, object_id FROM works WHERE tenant_id=$1 AND id=$2', [actor.tenantId, workId]);
        if (!work)
            throw scopeSafeNotFound();
        await authorizeObjectCatalog(tx.c, actor, work.objectId, false);
        const head = await one(tx.c, `SELECT id, classification, basis FROM legacy_work_classifications w WHERE w.tenant_id=$1 AND w.work_id=$2
            AND NOT EXISTS (SELECT 1 FROM legacy_work_classifications n WHERE n.tenant_id=w.tenant_id AND n.supersedes_classification_id=w.id)`, [actor.tenantId, workId]);
        return { ...(await evidenceOf(tx.c, actor.tenantId, workId)), current: head ?? null };
    });
}

export async function recordLegacyWorkClassification(actor: Actor, input: unknown, idempotencyKey: string | null = null): Promise<CommandResult> {
    const d = parseR05Payload(legacyWorkClassificationInput, input);
    return runCommandTx(async tx => {
        await coordinate(tx.c, 'gpr2-r05-legacy.ts#recordLegacyWorkClassification', actor.tenantId, { work: d.workId });
        const c = tx.c;
        const work = await one(c, 'SELECT id, object_id FROM works WHERE tenant_id=$1 AND id=$2', [actor.tenantId, d.workId]);
        if (!work)
            throw scopeSafeNotFound();
        let a: Actor;
        return (await runLedgered(c, { tenantId: actor.tenantId, actorId: actor.id, commandKind: 'legacy.work-classification.record', scopeId: d.workId, idempotencyKey, fingerprint: fp('legacy.work-classification.record', d) }, {
            authorize: async () => { a = await authorizeObjectCatalog(c, actor, work.objectId, true); },
            execute: async () => {
                const evidence = await evidenceOf(c, a.tenantId, d.workId);
                const row = await one(c, `INSERT INTO legacy_work_classifications(tenant_id,object_id,work_id,classification,evidence,basis,supersedes_classification_id,recorded_by)
                    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [a.tenantId, work.objectId, d.workId, d.classification, JSON.stringify(evidence), d.basis, d.supersedesClassificationId ?? null, a.id]);
                return done(row.id);
            }
        })).result;
    }).catch(e => {
        if (e?.code === '23505' && /legacy_work_classifications_(root_uq|superseded_once)/.test(e.constraint ?? ''))
            throw new Gpr2Error('INVALID_TRANSITION', { machine: 'LEGACY_WORK_CLASSIFICATION', from: 'CURRENT', command: 'record' });
        return mapR05DbError(e);
    });
}
