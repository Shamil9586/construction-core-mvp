import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { pool, one, rows, transaction } from './db';
import { coordinate } from './coordination-lock';
import { Actor, requirePermission, scoped, objectAccess, workAccess, audit, ensure, checkVersion, isCurrentPtoMember } from './security';
import { Permission as P, hasPermission } from '../../../packages/domain';
import {
    SCHEDULE_PROGRESS_SOURCE, DEFAULT_DELAY_REASON_CATEGORIES,
    PREDECESSOR_CYCLE_MESSAGE, PREDECESSOR_IN_USE_MESSAGE, PREDECESSOR_NOT_IN_DRAFT_MESSAGE, PREDECESSOR_SELF_MESSAGE,
    SCOPE_ALREADY_SCHEDULED_MESSAGE, WORK_HAS_UNITS_MESSAGE, WORK_SCHEDULED_AS_WHOLE_MESSAGE,
    aggregateScheduleStates, civilDayNumber, deriveScheduleEntryStatus, delayReasonViolation, diffScheduleEntries,
    effectiveDelayCategories, hasPredecessorCycle, isCivilDate, nextScheduleSequence, resolveObjectScheduleConclusion, scheduleApprovalViolations,
    scheduleDatesViolation, startsBeforePredecessorFinish, todayCivil,
    type DelayCategoryOverride, type ScheduleChange, type ScheduleEntrySnapshot, type ScheduleEntryStatus,
} from '../../../packages/domain/schedule';
import { loadObjectScopes, scopeKey, type ScopeFacts } from './schedule-scope';

/**
 * GPR-1 — Production Schedule («График производства работ»). See packages/domain/schedule.ts for the model and
 * docs/gpr-1-production-schedule.md for the decisions.
 *
 * Every method authorises in the same order the rest of the backend does: permission first (403 before anything about the data is
 * revealed), then the object (objectAccess — tenant, РП ownership, PTO scope), then the data. Every mutation runs in one transaction that
 * first locks the object row, so the mutations of one object's schedule are serialised and an approval always approves exactly the draft
 * (`version`) the approver was looking at.
 *
 * The schedule never writes production facts, never reads documentation / SDO / money, and stores none of the figures it shows:
 * planned quantity, unit, zone and executor are read from the production model on every request.
 */
const NOT_FOUND = 'Запись не найдена';
const NO_DRAFT_MESSAGE = 'Черновика графика нет: создайте черновик (страница могла устареть — обновите её).';
const DRAFT_EXISTS_MESSAGE = 'Черновик графика уже существует: продолжите его или отмените.';
const NOT_DRAFT_MESSAGE = 'Эта запись относится к утверждённой версии графика: изменить можно только черновик.';
const NO_BASELINE_MESSAGE = 'Утверждённого графика нет: причину отставания указывать не к чему.';
const NO_ACCESS_MESSAGE = 'Нет доступа к графику объекта';

type Db = any;
const label = (workName: string, zone: string | null) => (zone ? workName + ' · ' + zone : workName);
const snapshotOf = (e: any): ScheduleEntrySnapshot => ({ itemId: e.itemId, plannedStart: e.plannedStart, plannedFinish: e.plannedFinish, sequence: e.sequence, predecessorItemId: e.predecessorItemId ?? null });

async function revisionOf(c: Db, tenantId: string, objectId: string, status: 'DRAFT' | 'APPROVED', lock = false) {
    return one(c, `SELECT * FROM schedule_revisions WHERE tenant_id=$1 AND object_id=$2 AND status=$3 ${lock ? 'FOR UPDATE' : ''}`, [tenantId, objectId, status]);
}

/** Entries of the given revisions, each joined to its item (the scope it plans). */
async function entriesOf(c: Db, tenantId: string, revisionIds: string[]): Promise<any[]> {
    if (!revisionIds.length)
        return [];
    return rows(c, `SELECT e.*,i.object_work_id,i.execution_unit_id FROM schedule_revision_entries e JOIN schedule_items i ON i.tenant_id=e.tenant_id AND i.id=e.item_id
        WHERE e.tenant_id=$1 AND e.revision_id=ANY($2::uuid[]) ORDER BY e.sequence,e.planned_start,e.item_id`, [tenantId, revisionIds]);
}

async function namesOf(c: Db, table: 'users' | 'contractors', tenantId: string, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((v): v is string => !!v))];
    if (!unique.length)
        return new Map();
    return new Map((await rows(c, `SELECT id,name FROM ${table} WHERE tenant_id=$1 AND id=ANY($2::uuid[])`, [tenantId, unique])).map((r: any) => [r.id, r.name]));
}

async function categoryOverrides(c: Db, tenantId: string): Promise<DelayCategoryOverride[]> {
    return (await rows(c, 'SELECT code,name,is_active,sort_order FROM schedule_delay_categories WHERE tenant_id=$1', [tenantId])).map((r: any) => ({ code: r.code, name: r.name, isActive: r.isActive, sortOrder: r.sortOrder }));
}

/** Names of every known category, switched-off ones included — a recorded reason keeps a readable name after its category is retired. */
function categoryNames(overrides: DelayCategoryOverride[]): Map<string, string> {
    const names = new Map<string, string>(DEFAULT_DELAY_REASON_CATEGORIES.map(c => [c.code, c.name]));
    for (const o of overrides)
        names.set(o.code, o.name);
    return names;
}

/**
 * Locks the object row (serialises this object's schedule mutations) after the access checks.
 *
 * FOR NO KEY UPDATE, deliberately not FOR UPDATE: a foreign-key insert elsewhere that references the object (an inspection request, say)
 * takes FOR KEY SHARE on its row, which FOR UPDATE would block — while this transaction, holding the object, may itself be waiting for a
 * work row that such a request already holds FOR UPDATE: a lock-order inversion PostgreSQL resolves by aborting one of the two. NO KEY
 * UPDATE still excludes every other schedule mutation (they take the same lock) and leaves those inserts untouched.
 */
async function lockObject(c: Db, a: Actor, objectId: string) {
    const o = await objectAccess(c, a, objectId, true);
    await c.query('SELECT id FROM objects WHERE tenant_id=$1 AND id=$2 FOR NO KEY UPDATE', [a.tenantId, objectId]);
    return o;
}

/** Read access to an object's schedule: the permission, the object, and — for a PTO engineer — object membership (a work-level handoff alone does not open the whole object's plan). */
async function ensureReadable(c: Db, a: Actor, objectId: string) {
    requirePermission(a, P.SCHEDULE_VIEW);
    const o = await objectAccess(c, a, objectId);
    if (a.role === 'PTO' && !(await isCurrentPtoMember(c, a.tenantId, objectId, a.id)))
        throw new ForbiddenException(NO_ACCESS_MESSAGE);
    return o;
}

/** Whether `ensureReadable` would let this actor open the object's whole schedule — the work-level view says so, so W01 never offers a door that is shut. */
async function canReadObjectSchedule(c: Db, a: Actor, objectId: string): Promise<boolean> {
    try {
        await ensureReadable(c, a, objectId);
        return true;
    }
    catch (e) {
        if (e instanceof ForbiddenException || e instanceof NotFoundException)
            return false;
        throw e;
    }
}

function resolveToday(asOf?: string): string {
    if (asOf === undefined)
        return todayCivil();
    ensure(isCivilDate(asOf), 'Некорректная дата расчёта');
    return asOf;
}

@Injectable()
export class ScheduleService {
    // =====================================================================================================================
    // Reads
    // =====================================================================================================================

    /** The schedule of ONE object: the current approved baseline measured against the production facts, plus — for those who prepare it — the draft. */
    async objectSchedule(a: Actor, objectId: string, asOf?: string) {
        const o = await ensureReadable(pool, a, objectId);
        const today = resolveToday(asOf);
        const t = a.tenantId;
        const canEdit = hasPermission(a.role, P.SCHEDULE_EDIT), canApprove = hasPermission(a.role, P.SCHEDULE_APPROVE);
        const canRecordDelayReason = hasPermission(a.role, P.SCHEDULE_DELAY_REASON);
        const revisions = await rows(pool, `SELECT * FROM schedule_revisions WHERE tenant_id=$1 AND object_id=$2 AND status<>'DISCARDED' ORDER BY revision_no`, [t, objectId]);
        const current = revisions.find((r: any) => r.status === 'APPROVED') ?? null;
        const draft = revisions.find((r: any) => r.status === 'DRAFT') ?? null;
        const scopes = await loadObjectScopes(pool, t, objectId);
        const allEntries = await entriesOf(pool, t, revisions.map((r: any) => r.id));
        const entriesByRevision = (id: string) => allEntries.filter((e: any) => e.revisionId === id);
        const overrides = await categoryOverrides(pool, t);
        const catNames = categoryNames(overrides);
        const reasons = await this.reasonViews(pool, t, objectId, catNames);

        // ---- the current baseline, measured -------------------------------------------------------------------------------------------
        const currentEntries = current ? entriesByRevision(current.id) : [];
        const firstApproved = new Map<string, any>(); // item -> its entry in the EARLIEST approved revision (how far corrections moved it)
        for (const r of revisions.filter((x: any) => x.status === 'APPROVED' || x.status === 'SUPERSEDED'))
            for (const e of entriesByRevision(r.id))
                if (!firstApproved.has(e.itemId))
                    firstApproved.set(e.itemId, e);
        const entryViews = currentEntries.map((e: any) => this.entryView(e, scopes, today, currentEntries, reasons, firstApproved.get(e.itemId), current.id));
        const statuses: ScheduleEntryStatus[] | null = current ? entryViews.map(v => v.status) : null;
        const scheduledKeys = new Set(currentEntries.map((e: any) => scopeKey(e.objectWorkId, e.executionUnitId)));
        const unscheduled = [...scopes.values()].filter(s => this.isSchedulable(s) && !scheduledKeys.has(s.key) && !this.coveredByWholeWork(s, scheduledKeys));
        const conclusion = { ...resolveObjectScheduleConclusion(statuses), unscheduledCount: unscheduled.length, openDelayReasonCount: entryViews.reduce((n, v) => n + v.view.delayReasons.filter((r: any) => r.status === 'OPEN').length, 0) };

        // ---- history: every approved revision with what it changed against the one it replaced ---------------------------------------
        const userIds = revisions.flatMap((r: any) => [r.createdBy, r.approvedBy]);
        const userNames = await namesOf(pool, 'users', t, userIds);
        const numberOf = new Map(revisions.map((r: any) => [r.id, r.revisionNo]));
        const labelOf = (itemId: string) => { const e = allEntries.find((x: any) => x.itemId === itemId); const s = e && scopes.get(scopeKey(e.objectWorkId, e.executionUnitId)); return s ? { workName: s.workName, zone: s.zone, label: label(s.workName, s.zone) } : { workName: '', zone: null, label: '' }; };
        const changeViews = (changes: ScheduleChange[]) => changes.map(c => ({ itemId: c.itemId, kind: c.kind, fields: c.fields, ...labelOf(c.itemId), before: c.before, after: c.after }));
        const history = revisions.filter((r: any) => r.status === 'APPROVED' || r.status === 'SUPERSEDED').map((r: any) => {
            const base = r.basedOnRevisionId ? entriesByRevision(r.basedOnRevisionId) : [];
            return {
                revisionId: r.id, revisionNo: r.revisionNo, status: r.status, basedOnRevisionNo: r.basedOnRevisionId ? numberOf.get(r.basedOnRevisionId) ?? null : null,
                createdByName: userNames.get(r.createdBy) ?? null, createdAt: r.createdAt, approvedByName: userNames.get(r.approvedBy) ?? null, approvedAt: r.approvedAt,
                approvalComment: r.approvalComment, correctionReason: r.correctionReason, supersededAt: r.supersededAt, supersededByRevisionNo: r.supersededByRevisionId ? numberOf.get(r.supersededByRevisionId) ?? null : null,
                entryCount: entriesByRevision(r.id).length, changes: changeViews(diffScheduleEntries(base.map(snapshotOf), entriesByRevision(r.id).map(snapshotOf))),
            };
        });

        // ---- the draft, for those who prepare / approve it ---------------------------------------------------------------------------
        let draftView: any = null;
        let availableScopes: any[] = [];
        if ((canEdit || canApprove) && draft) {
            const draftEntries = entriesByRevision(draft.id);
            const baseline = new Map(currentEntries.map((e: any) => [e.itemId, e]));
            draftView = {
                revisionId: draft.id, revisionNo: draft.revisionNo, version: draft.version, basedOnRevisionNo: draft.basedOnRevisionId ? numberOf.get(draft.basedOnRevisionId) ?? null : null,
                createdByName: userNames.get(draft.createdBy) ?? null, createdAt: draft.createdAt,
                entries: draftEntries.map((e: any) => this.draftEntryView(e, scopes, draftEntries, baseline.get(e.itemId))),
                changes: changeViews(diffScheduleEntries(currentEntries.map(snapshotOf), draftEntries.map(snapshotOf))),
            };
            availableScopes = this.availableScopes(scopes, draftEntries);
        }
        return {
            objectId, objectName: o.name, asOf: today, progressSource: SCHEDULE_PROGRESS_SOURCE,
            access: { canEdit, canApprove, canRecordDelayReason, canCreateDraft: canEdit && !draft, canManageCategories: hasPermission(a.role, P.ADMIN_DICTIONARIES) },
            hasDraft: !!draft,
            current: current ? { revisionId: current.id, revisionNo: current.revisionNo, approvedAt: current.approvedAt, approvedByName: userNames.get(current.approvedBy) ?? null, approvalComment: current.approvalComment, correctionReason: current.correctionReason, basedOnRevisionNo: current.basedOnRevisionId ? numberOf.get(current.basedOnRevisionId) ?? null : null } : null,
            conclusion, entries: entryViews.map(v => v.view), unscheduled: unscheduled.map(s => this.scopeView(s)),
            draft: draftView, availableScopes, history, delayReasonCategories: effectiveDelayCategories(overrides),
        };
    }

    /** The schedule of ONE work — what W01 shows: only that work's entries of the current baseline (no other work of the object is revealed). */
    async workSchedule(a: Actor, workId: string, asOf?: string) {
        requirePermission(a, P.SCHEDULE_VIEW);
        const w = await scoped(pool, 'works', workId, a);
        await workAccess(pool, a, w);
        const t = a.tenantId, today = resolveToday(asOf);
        const current = await revisionOf(pool, t, w.objectId, 'APPROVED');
        const scopes = await loadObjectScopes(pool, t, w.objectId);
        const currentEntries = current ? await entriesOf(pool, t, [current.id]) : [];
        const catNames = categoryNames(await categoryOverrides(pool, t));
        const reasons = await this.reasonViews(pool, t, w.objectId, catNames);
        const own = currentEntries.filter((e: any) => e.objectWorkId === workId);
        const views = own.map((e: any) => this.entryView(e, scopes, today, currentEntries, reasons, undefined, current.id, workId));
        const states = views.map(v => v.status.state);
        return {
            objectId: w.objectId, objectWorkId: workId, asOf: today, progressSource: SCHEDULE_PROGRESS_SOURCE,
            // A PTO engineer holding only this work's handoff may read the work's summary but not the object's whole plan (403): say so.
            canOpenObjectSchedule: await canReadObjectSchedule(pool, a, w.objectId),
            hasBaseline: !!current, revisionNo: current ? current.revisionNo : null,
            summary: views.length ? {
                plannedStart: views.map(v => v.view.plannedStart).sort()[0], plannedFinish: views.map(v => v.view.plannedFinish).sort().slice(-1)[0],
                state: aggregateScheduleStates(states), delayDays: views.reduce((m, v) => Math.max(m, v.status.delayDays), 0), entryCount: views.length,
            } : null,
            entries: views.map(v => v.view),
        };
    }

    // ---- read-model builders ---------------------------------------------------------------------------------------------------------

    private scopeView(s: ScopeFacts) {
        return { objectWorkId: s.objectWorkId, workName: s.workName, executionUnitId: s.executionUnitId, zone: s.zone, finishType: s.finishType, conditions: s.conditions, contractorId: s.contractorId, executor: s.executor, unit: s.unit, plannedQuantity: s.plannedQuantity };
    }

    /** A work with units is planned through its units; its own whole-work scope exists only to measure an entry that was planned as a whole. */
    private isSchedulable(s: ScopeFacts): boolean {
        return s.executionUnitId !== null || !s.workHasUnits;
    }

    /** A work scheduled as a whole covers its units: they are not "unscheduled". */
    private coveredByWholeWork(s: ScopeFacts, scheduledKeys: Set<string>): boolean {
        return s.executionUnitId !== null && scheduledKeys.has(scopeKey(s.objectWorkId, null));
    }

    private entryView(e: any, scopes: Map<string, ScopeFacts>, today: string, siblings: any[], reasons: Map<string, any[]>, first: any | undefined, currentRevisionId: string, onlyWork?: string) {
        const scope = scopes.get(scopeKey(e.objectWorkId, e.executionUnitId));
        if (!scope)
            throw new Error('Schedule entry without a production scope'); // unreachable: works / units are never deleted and the FK guards the item
        const status = deriveScheduleEntryStatus({ plannedStart: e.plannedStart, plannedFinish: e.plannedFinish, plannedQuantity: scope.plannedQuantity, rpFactQuantity: scope.rpFactQuantity }, today);
        const pred = e.predecessorItemId ? siblings.find((x: any) => x.itemId === e.predecessorItemId) : undefined;
        // The work-level view (W01, `onlyWork`) is scoped to ONE work: a predecessor that belongs to ANOTHER work is neither named nor
        // referenced — not its label, not its item id, not whether this entry starts before its finish. A PTO engineer holding only that
        // work's handoff reads this view and must not learn what else the object is building.
        const foreign = onlyWork !== undefined && !!pred && pred.objectWorkId !== onlyWork;
        const visiblePred = foreign ? undefined : pred;
        const predScope = visiblePred && scopes.get(scopeKey(visiblePred.objectWorkId, visiblePred.executionUnitId));
        const shifted = first && first.revisionId !== currentRevisionId
            ? { startDays: civilDayNumber(e.plannedStart) - civilDayNumber(first.plannedStart), finishDays: civilDayNumber(e.plannedFinish) - civilDayNumber(first.plannedFinish) }
            : null;
        const view = {
            entryId: e.id, itemId: e.itemId, revisionId: e.revisionId, sequence: e.sequence, ...this.scopeView(scope), plannedStart: e.plannedStart, plannedFinish: e.plannedFinish,
            predecessorItemId: foreign ? null : e.predecessorItemId ?? null, predecessorLabel: predScope ? label(predScope.workName, predScope.zone) : null,
            followsPredecessor: visiblePred ? !startsBeforePredecessorFinish(e.plannedStart, visiblePred.plannedFinish) : null,
            rpFactQuantity: scope.rpFactQuantity, internalScAcceptedQuantity: scope.internalScAcceptedQuantity,
            plannedProgress: status.plannedProgress, actualProgress: status.actualProgress, factReported: status.factReported, overperformed: status.overperformed,
            expectedPhase: status.expectedPhase, state: status.state, delayDays: status.delayDays, delayKind: status.delayKind,
            baselineShift: shifted && (shifted.startDays !== 0 || shifted.finishDays !== 0) ? shifted : null,
            workNowHasUnits: e.executionUnitId === null && scope.workHasUnits,
            delayReasons: reasons.get(e.itemId) ?? [],
        };
        return { view, status };
    }

    private draftEntryView(e: any, scopes: Map<string, ScopeFacts>, siblings: any[], baseline: any | undefined) {
        const scope = scopes.get(scopeKey(e.objectWorkId, e.executionUnitId));
        if (!scope)
            throw new Error('Schedule entry without a production scope');
        const pred = e.predecessorItemId ? siblings.find((x: any) => x.itemId === e.predecessorItemId) : undefined;
        const predScope = pred && scopes.get(scopeKey(pred.objectWorkId, pred.executionUnitId));
        return {
            entryId: e.id, itemId: e.itemId, version: e.version, sequence: e.sequence, ...this.scopeView(scope), plannedStart: e.plannedStart, plannedFinish: e.plannedFinish,
            predecessorItemId: e.predecessorItemId ?? null, predecessorLabel: predScope ? label(predScope.workName, predScope.zone) : null,
            followsPredecessor: pred ? !startsBeforePredecessorFinish(e.plannedStart, pred.plannedFinish) : null,
            baseline: baseline ? { plannedStart: baseline.plannedStart, plannedFinish: baseline.plannedFinish, sequence: baseline.sequence } : null,
            change: !baseline ? 'ADDED' : (baseline.plannedStart !== e.plannedStart || baseline.plannedFinish !== e.plannedFinish || baseline.sequence !== e.sequence || (baseline.predecessorItemId ?? null) !== (e.predecessorItemId ?? null)) ? 'CHANGED' : null,
        };
    }

    /** Production scopes that can still be added to a draft: not yet in it, and not contradicting a whole-work / per-unit choice already made for the work. */
    private availableScopes(scopes: Map<string, ScopeFacts>, draftEntries: any[]) {
        const inDraft = new Set(draftEntries.map((e: any) => scopeKey(e.objectWorkId, e.executionUnitId)));
        return [...scopes.values()].filter(s => {
            if (inDraft.has(s.key) || !this.isSchedulable(s))
                return false;
            return s.executionUnitId === null || !inDraft.has(scopeKey(s.objectWorkId, null)); // a work planned as a whole is not also planned through its units
        }).map(s => ({ ...this.scopeView(s), suggestedStart: s.workPlannedStart, suggestedFinish: s.workPlannedFinish }));
    }

    private async reasonViews(c: Db, tenantId: string, objectId: string, catNames: Map<string, string>): Promise<Map<string, any[]>> {
        const list = await rows(c, 'SELECT * FROM schedule_delay_reasons WHERE tenant_id=$1 AND object_id=$2 ORDER BY recorded_at DESC,id', [tenantId, objectId]);
        const users = await namesOf(c, 'users', tenantId, list.flatMap((r: any) => [r.recordedBy, r.resolvedBy, r.responsibleUserId]));
        const contractors = await namesOf(c, 'contractors', tenantId, list.map((r: any) => r.responsibleContractorId));
        const byItem = new Map<string, any[]>();
        for (const r of list) {
            const view = {
                id: r.id, itemId: r.itemId, categoryCode: r.categoryCode, categoryName: catNames.get(r.categoryCode) ?? r.categoryCode, comment: r.comment,
                responsibleUserId: r.responsibleUserId, responsibleUserName: r.responsibleUserId ? users.get(r.responsibleUserId) ?? null : null,
                responsibleContractorId: r.responsibleContractorId, responsibleContractorName: r.responsibleContractorId ? contractors.get(r.responsibleContractorId) ?? null : null,
                delayDaysAtRecord: r.delayDaysAtRecord, recordedByName: users.get(r.recordedBy) ?? null, recordedAt: r.recordedAt,
                status: r.status, resolvedByName: r.resolvedBy ? users.get(r.resolvedBy) ?? null : null, resolvedAt: r.resolvedAt, resolutionComment: r.resolutionComment, version: r.version,
            };
            byItem.set(r.itemId, [...(byItem.get(r.itemId) ?? []), view]);
        }
        return byItem;
    }

    // =====================================================================================================================
    // Preparing the schedule (draft)
    // =====================================================================================================================

    /** Opens a draft: empty for the first schedule of an object, a copy of the current approved baseline for a correction. */
    async createDraft(a: Actor, objectId: string) {
        requirePermission(a, P.SCHEDULE_EDIT);
        return transaction(async (c) => {
            await coordinate(c, 'schedule-service.ts#createDraft', a.tenantId, { object: objectId });
            await lockObject(c, a, objectId);
            if (await revisionOf(c, a.tenantId, objectId, 'DRAFT'))
                throw new ConflictException(DRAFT_EXISTS_MESSAGE);
            const current = await revisionOf(c, a.tenantId, objectId, 'APPROVED', true);
            const next = (await one(c, 'SELECT coalesce(max(revision_no),0)+1 AS n FROM schedule_revisions WHERE tenant_id=$1 AND object_id=$2', [a.tenantId, objectId])).n;
            const draft = await one(c, 'INSERT INTO schedule_revisions(tenant_id,object_id,revision_no,based_on_revision_id,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *', [a.tenantId, objectId, next, current ? current.id : null, a.id]);
            if (current)
                await c.query(`INSERT INTO schedule_revision_entries(tenant_id,revision_id,item_id,planned_start,planned_finish,sequence,predecessor_item_id)
                    SELECT tenant_id,$3,item_id,planned_start,planned_finish,sequence,predecessor_item_id FROM schedule_revision_entries WHERE tenant_id=$1 AND revision_id=$2`, [a.tenantId, current.id, draft.id]);
            await audit(c, a, 'ScheduleRevision', draft.id, 'CREATE_DRAFT', null, { objectId, revisionNo: draft.revisionNo, basedOnRevisionId: draft.basedOnRevisionId });
            return draft;
        });
    }

    async addEntry(a: Actor, objectId: string, d: { objectWorkId: string; executionUnitId?: string | null; plannedStart: string; plannedFinish: string; sequence?: number; predecessorItemId?: string | null }) {
        requirePermission(a, P.SCHEDULE_EDIT);
        return transaction(async (c) => {
            await coordinate(c, 'schedule-service.ts#addEntry', a.tenantId, { object: objectId });
            await lockObject(c, a, objectId);
            const draft = await revisionOf(c, a.tenantId, objectId, 'DRAFT', true);
            if (!draft)
                throw new ConflictException(NO_DRAFT_MESSAGE);
            // The scope must be a real production scope OF THIS OBJECT — a work or unit of another object is simply not found.
            const work = await scoped(c, 'works', d.objectWorkId, a);
            if (work.objectId !== objectId)
                throw new NotFoundException(NOT_FOUND);
            const unitId = d.executionUnitId ?? null;
            if (unitId) {
                const unit = await scoped(c, 'work_execution_units', unitId, a);
                if (unit.objectWorkId !== work.id)
                    throw new NotFoundException(NOT_FOUND);
            }
            const dateProblem = scheduleDatesViolation(d.plannedStart, d.plannedFinish);
            ensure(!dateProblem, dateProblem!);
            const existing = await entriesOf(c, a.tenantId, [draft.id]);
            if (unitId)
                ensure(!existing.some((e: any) => e.objectWorkId === work.id && e.executionUnitId === null), WORK_SCHEDULED_AS_WHOLE_MESSAGE);
            else
                ensure(!(await one(c, 'SELECT 1 AS x FROM work_execution_units WHERE tenant_id=$1 AND object_work_id=$2 LIMIT 1', [a.tenantId, work.id])), WORK_HAS_UNITS_MESSAGE);
            // One item per scope, ever: re-planning a scope re-uses its identity (delay reasons and history stay attached to it).
            let item = await one(c, unitId ? 'SELECT * FROM schedule_items WHERE tenant_id=$1 AND execution_unit_id=$2' : 'SELECT * FROM schedule_items WHERE tenant_id=$1 AND object_work_id=$2 AND execution_unit_id IS NULL', [a.tenantId, unitId ?? work.id]);
            if (!item)
                item = await one(c, 'INSERT INTO schedule_items(tenant_id,object_id,object_work_id,execution_unit_id,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *', [a.tenantId, objectId, work.id, unitId, a.id]);
            ensure(!existing.some((e: any) => e.itemId === item.id), SCOPE_ALREADY_SCHEDULED_MESSAGE);
            const predecessorItemId = d.predecessorItemId ?? null;
            if (predecessorItemId)
                ensure(existing.some((e: any) => e.itemId === predecessorItemId), PREDECESSOR_NOT_IN_DRAFT_MESSAGE);
            const sequence = d.sequence ?? nextScheduleSequence(existing.map((e: any) => e.sequence));
            const entry = await one(c, `INSERT INTO schedule_revision_entries(tenant_id,revision_id,item_id,planned_start,planned_finish,sequence,predecessor_item_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
                [a.tenantId, draft.id, item.id, d.plannedStart, d.plannedFinish, sequence, predecessorItemId]);
            await this.touchDraft(c, a.tenantId, draft.id);
            await audit(c, a, 'ScheduleEntry', entry.id, 'ADD', null, { revisionNo: draft.revisionNo, ...snapshotOf(entry), objectWorkId: work.id, executionUnitId: unitId });
            return entry;
        });
    }

    async editEntry(a: Actor, objectId: string, entryId: string, d: { version: number; plannedStart?: string; plannedFinish?: string; sequence?: number; predecessorItemId?: string | null }) {
        requirePermission(a, P.SCHEDULE_EDIT);
        return transaction(async (c) => {
            await coordinate(c, 'schedule-service.ts#editEntry', a.tenantId, { object: objectId });
            await lockObject(c, a, objectId);
            const { entry, draft } = await this.draftEntry(c, a, objectId, entryId);
            checkVersion(entry, d.version);
            const plannedStart = d.plannedStart ?? entry.plannedStart, plannedFinish = d.plannedFinish ?? entry.plannedFinish;
            const dateProblem = scheduleDatesViolation(plannedStart, plannedFinish);
            ensure(!dateProblem, dateProblem!);
            const sequence = d.sequence ?? entry.sequence;
            let predecessorItemId = entry.predecessorItemId ?? null;
            if ('predecessorItemId' in d) {
                predecessorItemId = d.predecessorItemId ?? null;
                if (predecessorItemId) {
                    ensure(predecessorItemId !== entry.itemId, PREDECESSOR_SELF_MESSAGE);
                    const all = await entriesOf(c, a.tenantId, [draft.id]);
                    ensure(all.some((e: any) => e.itemId === predecessorItemId), PREDECESSOR_NOT_IN_DRAFT_MESSAGE);
                    ensure(!hasPredecessorCycle(all.map((e: any) => ({ itemId: e.itemId, predecessorItemId: e.itemId === entry.itemId ? predecessorItemId : e.predecessorItemId ?? null }))), PREDECESSOR_CYCLE_MESSAGE);
                }
            }
            const updated = await one(c, `UPDATE schedule_revision_entries SET planned_start=$3,planned_finish=$4,sequence=$5,predecessor_item_id=$6,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
                [a.tenantId, entryId, plannedStart, plannedFinish, sequence, predecessorItemId]);
            await this.touchDraft(c, a.tenantId, draft.id);
            await audit(c, a, 'ScheduleEntry', entryId, 'EDIT', { revisionNo: draft.revisionNo, ...snapshotOf(entry) }, { revisionNo: draft.revisionNo, ...snapshotOf(updated) });
            return updated;
        });
    }

    async removeEntry(a: Actor, objectId: string, entryId: string, d: { version: number }) {
        requirePermission(a, P.SCHEDULE_EDIT);
        return transaction(async (c) => {
            await coordinate(c, 'schedule-service.ts#removeEntry', a.tenantId, { object: objectId });
            await lockObject(c, a, objectId);
            const { entry, draft } = await this.draftEntry(c, a, objectId, entryId);
            checkVersion(entry, d.version);
            ensure(!(await one(c, 'SELECT 1 AS x FROM schedule_revision_entries WHERE tenant_id=$1 AND revision_id=$2 AND predecessor_item_id=$3 LIMIT 1', [a.tenantId, draft.id, entry.itemId])), PREDECESSOR_IN_USE_MESSAGE);
            await c.query('DELETE FROM schedule_revision_entries WHERE tenant_id=$1 AND id=$2', [a.tenantId, entryId]);
            await this.touchDraft(c, a.tenantId, draft.id);
            await audit(c, a, 'ScheduleEntry', entryId, 'REMOVE', { revisionNo: draft.revisionNo, ...snapshotOf(entry) }, null);
            return { removed: true, entryId };
        });
    }

    async discardDraft(a: Actor, objectId: string, d: { version: number }) {
        requirePermission(a, P.SCHEDULE_EDIT);
        return transaction(async (c) => {
            await coordinate(c, 'schedule-service.ts#discardDraft', a.tenantId, { object: objectId });
            await lockObject(c, a, objectId);
            const draft = await revisionOf(c, a.tenantId, objectId, 'DRAFT', true);
            if (!draft)
                throw new ConflictException(NO_DRAFT_MESSAGE);
            checkVersion(draft, d.version);
            const discarded = await one(c, `UPDATE schedule_revisions SET status='DISCARDED',discarded_by=$3,discarded_at=now(),version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`, [a.tenantId, draft.id, a.id]);
            await audit(c, a, 'ScheduleRevision', draft.id, 'DISCARD', { revisionNo: draft.revisionNo, status: 'DRAFT' }, { revisionNo: draft.revisionNo, status: 'DISCARDED' });
            return discarded;
        });
    }

    // =====================================================================================================================
    // Approval — the draft becomes the current baseline
    // =====================================================================================================================

    /**
     * Approves the draft the approver was looking at (`version`). The first approval needs nothing but the draft; every later one is a
     * CORRECTION of an approved plan and needs a reason and at least one real change. The replaced revision is marked SUPERSEDED and is never
     * rewritten (a database trigger refuses it). The whole before/after goes to the audit log in the same transaction.
     */
    async approveDraft(a: Actor, objectId: string, d: { version: number; comment?: string; correctionReason?: string }) {
        requirePermission(a, P.SCHEDULE_APPROVE);
        return transaction(async (c) => {
            await coordinate(c, 'schedule-service.ts#approveDraft', a.tenantId, { object: objectId });
            await lockObject(c, a, objectId);
            const draft = await revisionOf(c, a.tenantId, objectId, 'DRAFT', true);
            if (!draft)
                throw new ConflictException(NO_DRAFT_MESSAGE);
            checkVersion(draft, d.version);
            const current = await revisionOf(c, a.tenantId, objectId, 'APPROVED', true);
            const draftEntries = await entriesOf(c, a.tenantId, [draft.id]);
            const currentEntries = current ? await entriesOf(c, a.tenantId, [current.id]) : [];
            const changes = diffScheduleEntries(currentEntries.map(snapshotOf), draftEntries.map(snapshotOf));
            const problems = scheduleApprovalViolations({ entries: draftEntries.map((e: any) => ({ ...snapshotOf(e), objectWorkId: e.objectWorkId, executionUnitId: e.executionUnitId })), hasCurrentBaseline: !!current, changeCount: changes.length, correctionReason: d.correctionReason });
            // A work planned as a whole must still have no units: if units appeared since, the plan would double-count the work.
            const wholeWorkIds = [...new Set(draftEntries.filter((e: any) => e.executionUnitId === null).map((e: any) => e.objectWorkId))];
            if (wholeWorkIds.length && (await one(c, 'SELECT 1 AS x FROM work_execution_units WHERE tenant_id=$1 AND object_work_id=ANY($2::uuid[]) LIMIT 1', [a.tenantId, wholeWorkIds])))
                problems.push(WORK_HAS_UNITS_MESSAGE);
            ensure(problems.length === 0, problems.join(' '));
            if (current)
                await c.query(`UPDATE schedule_revisions SET status='SUPERSEDED',superseded_at=now(),superseded_by_revision_id=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2`, [a.tenantId, current.id, draft.id]);
            const approved = await one(c, `UPDATE schedule_revisions SET status='APPROVED',approved_by=$3,approved_at=now(),approval_comment=$4,correction_reason=$5,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
                [a.tenantId, draft.id, a.id, d.comment?.trim() || null, current ? d.correctionReason!.trim() : null]);
            await audit(c, a, 'ScheduleRevision', approved.id, current ? 'APPROVE_CORRECTION' : 'APPROVE',
                current ? { revisionNo: current.revisionNo, status: 'APPROVED', entries: currentEntries.map(snapshotOf) } : null,
                { revisionNo: approved.revisionNo, status: 'APPROVED', approvedBy: a.id, comment: approved.approvalComment, correctionReason: approved.correctionReason, supersedesRevisionNo: current ? current.revisionNo : null, entries: draftEntries.map(snapshotOf), changes });
            return approved;
        });
    }

    private async touchDraft(c: Db, tenantId: string, revisionId: string) {
        await c.query('UPDATE schedule_revisions SET version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2', [tenantId, revisionId]);
    }

    /** A draft entry of THIS object, locked — an entry of an approved revision, or of another object, is never editable here. */
    private async draftEntry(c: Db, a: Actor, objectId: string, entryId: string) {
        const entry = await one(c, `SELECT e.*,i.object_id,i.object_work_id,i.execution_unit_id FROM schedule_revision_entries e JOIN schedule_items i ON i.tenant_id=e.tenant_id AND i.id=e.item_id
            WHERE e.tenant_id=$1 AND e.id=$2 FOR UPDATE OF e`, [a.tenantId, entryId]);
        if (!entry || entry.objectId !== objectId)
            throw new NotFoundException(NOT_FOUND);
        const revision = await one(c, 'SELECT * FROM schedule_revisions WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, entry.revisionId]);
        if (revision.status !== 'DRAFT')
            throw new ConflictException(NOT_DRAFT_MESSAGE);
        return { entry, draft: revision };
    }

    // =====================================================================================================================
    // Delay reasons — WHY a scope is late
    // =====================================================================================================================

    async recordDelayReason(a: Actor, objectId: string, d: { itemId: string; categoryCode: string; comment: string; responsibleUserId?: string; responsibleContractorId?: string }) {
        requirePermission(a, P.SCHEDULE_DELAY_REASON);
        return transaction(async (c) => {
            await coordinate(c, 'schedule-service.ts#recordDelayReason', a.tenantId, { object: objectId });
            await lockObject(c, a, objectId);
            const current = await revisionOf(c, a.tenantId, objectId, 'APPROVED');
            if (!current)
                throw new ConflictException(NO_BASELINE_MESSAGE);
            const entry = (await entriesOf(c, a.tenantId, [current.id])).find((e: any) => e.itemId === d.itemId);
            if (!entry)
                throw new NotFoundException(NOT_FOUND); // not in this object's approved baseline (another object's scope included)
            const scope = (await loadObjectScopes(c, a.tenantId, objectId)).get(scopeKey(entry.objectWorkId, entry.executionUnitId));
            if (!scope)
                throw new NotFoundException(NOT_FOUND);
            const status = deriveScheduleEntryStatus({ plannedStart: entry.plannedStart, plannedFinish: entry.plannedFinish, plannedQuantity: scope.plannedQuantity, rpFactQuantity: scope.rpFactQuantity }, todayCivil());
            const violation = delayReasonViolation(status.state);
            ensure(!violation, violation!);
            ensure(effectiveDelayCategories(await categoryOverrides(c, a.tenantId)).some(cat => cat.code === d.categoryCode), 'Неизвестная или отключённая категория причины отставания');
            if (d.responsibleUserId) {
                const u = await scoped(c, 'users', d.responsibleUserId, a);
                ensure(u.isActive && u.role !== 'CONTRACTOR_VIEWER', 'Ответственным может быть только действующий сотрудник');
            }
            if (d.responsibleContractorId) {
                await scoped(c, 'contractors', d.responsibleContractorId, a);
                ensure(!!(await one(c, 'SELECT 1 AS x FROM object_contractors_active WHERE tenant_id=$1 AND object_id=$2 AND contractor_id=$3', [a.tenantId, objectId, d.responsibleContractorId])), 'Подрядчик не назначен на объект');
            }
            const reason = await one(c, `INSERT INTO schedule_delay_reasons(tenant_id,object_id,item_id,revision_id,category_code,comment,responsible_user_id,responsible_contractor_id,delay_days_at_record,recorded_by)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [a.tenantId, objectId, d.itemId, current.id, d.categoryCode, d.comment.trim(), d.responsibleUserId ?? null, d.responsibleContractorId ?? null, status.delayDays, a.id]);
            await audit(c, a, 'ScheduleDelayReason', reason.id, 'RECORD', null, { itemId: d.itemId, revisionNo: current.revisionNo, categoryCode: d.categoryCode, comment: reason.comment, responsibleUserId: reason.responsibleUserId, responsibleContractorId: reason.responsibleContractorId, delayDaysAtRecord: status.delayDays });
            return reason;
        });
    }

    async resolveDelayReason(a: Actor, objectId: string, reasonId: string, d: { version: number; comment?: string }) {
        requirePermission(a, P.SCHEDULE_DELAY_REASON);
        return transaction(async (c) => {
            await coordinate(c, 'schedule-service.ts#resolveDelayReason', a.tenantId, { object: objectId });
            await lockObject(c, a, objectId);
            const reason = await one(c, 'SELECT * FROM schedule_delay_reasons WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, reasonId]);
            if (!reason || reason.objectId !== objectId)
                throw new NotFoundException(NOT_FOUND);
            checkVersion(reason, d.version);
            if (reason.status !== 'OPEN')
                throw new ConflictException('Причина отставания уже закрыта.');
            const resolved = await one(c, `UPDATE schedule_delay_reasons SET status='RESOLVED',resolved_by=$3,resolved_at=now(),resolution_comment=$4,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
                [a.tenantId, reasonId, a.id, d.comment?.trim() || null]);
            await audit(c, a, 'ScheduleDelayReason', reasonId, 'RESOLVE', { status: 'OPEN' }, { status: 'RESOLVED', resolutionComment: resolved.resolutionComment });
            return resolved;
        });
    }

    /** Adds, renames, reorders or switches off a delay-reason category of the tenant (the open part of the delay-reason model). */
    async saveDelayCategory(a: Actor, d: { code: string; name: string; sortOrder?: number; isActive?: boolean }) {
        requirePermission(a, P.ADMIN_DICTIONARIES);
        return transaction(async (c) => {
            const existing = await one(c, 'SELECT * FROM schedule_delay_categories WHERE tenant_id=$1 AND code=$2 FOR UPDATE', [a.tenantId, d.code]);
            const builtIn = DEFAULT_DELAY_REASON_CATEGORIES.find(x => x.code === d.code);
            const sortOrder = d.sortOrder ?? existing?.sortOrder ?? builtIn?.sortOrder ?? 100;
            const row = await one(c, `INSERT INTO schedule_delay_categories(tenant_id,code,name,is_active,sort_order,created_by) VALUES($1,$2,$3,$4,$5,$6)
                ON CONFLICT (tenant_id,code) DO UPDATE SET name=EXCLUDED.name,is_active=EXCLUDED.is_active,sort_order=EXCLUDED.sort_order,version=schedule_delay_categories.version+1,updated_at=now() RETURNING *`,
                [a.tenantId, d.code, d.name, d.isActive ?? existing?.isActive ?? true, sortOrder, a.id]);
            await audit(c, a, 'ScheduleDelayCategory', row.id, existing ? 'UPDATE' : 'CREATE', existing ?? null, row);
            return { category: { code: row.code, name: row.name, isActive: row.isActive, sortOrder: row.sortOrder }, categories: effectiveDelayCategories(await categoryOverrides(c, a.tenantId)) };
        });
    }
}

