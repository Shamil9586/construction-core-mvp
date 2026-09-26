import { Injectable, BadRequestException, ForbiddenException, NotFoundException, ConflictException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { pool, one, rows, insert, transaction } from './db';
import { Actor, requirePermission, checkVersion, scoped, objectAccess, audit, ensure } from './security';
import { Permission as P, ProgressCalculationService, ScheduleStatusService, WorkTransitionPolicy, PtoPackageValidationService, PotentialClosingService, ObjectHealthService, defaultRisk, AosrDraftEngine, QuantityPortionPolicy, resolveInternalScAccepted, resolveActualQuantity, isDocumentationStatusTransitionAllowed, canMutateDocumentationPackageContent, resolvePackageSdoReadiness, isSdoClosingStatusTransitionAllowed, isCustomerAcceptanceSnapshotCurrent, SdoClosingAllocationService } from '../../../packages/domain';
@Injectable()
export class ProductionService {
    async createObject(a: Actor, d: any) { requirePermission(a, P.OBJECT_CREATE); return transaction(async (c) => { ensure(d.plannedFinishDate >= d.startDate, 'Дата окончания раньше начала'); const pm = await scoped(c, 'users', d.projectManagerId, a); ensure(pm.role === 'PROJECT_MANAGER' && pm.isActive, 'Назначьте активного РП'); if (a.role === 'PROJECT_MANAGER')
        ensure(pm.id === a.id, 'РП может создать объект только для себя'); for (const id of d.contractorIds)
        await scoped(c, 'contractors', id, a); const { contractorIds, ...data } = d; const o = await insert(c, 'objects', a.tenantId, data); for (const contractorId of contractorIds)
        await insert(c, 'object_contractors', a.tenantId, { objectId: o.id, contractorId }); await audit(c, a, 'Object', o.id, 'CREATE', null, o); return o; }); }
    async assignContractor(a: Actor, objectId: string, contractorId: string) { requirePermission(a, P.OBJECT_MANAGE_CONTRACTORS); return transaction(async (c) => { await objectAccess(c, a, objectId, true); await scoped(c, 'contractors', contractorId, a); if (await one(c, 'SELECT id FROM object_contractors_active WHERE tenant_id=$1 AND object_id=$2 AND contractor_id=$3', [a.tenantId, objectId, contractorId]))
        throw new ConflictException('Подрядчик уже назначен на объект'); const row = await insert(c, 'object_contractors', a.tenantId, { objectId, contractorId }); await audit(c, a, 'ObjectContractor', row.id, 'ASSIGN', null, row); return row; }); }
    async removeContractor(a: Actor, objectId: string, contractorId: string, relationId: string, v: number) { requirePermission(a, P.OBJECT_MANAGE_CONTRACTORS); return transaction(async (c) => { await objectAccess(c, a, objectId, true); const row = await one(c, 'SELECT * FROM object_contractors_active WHERE tenant_id=$1 AND object_id=$2 AND contractor_id=$3 AND id=$4 FOR UPDATE', [a.tenantId, objectId, contractorId, relationId]); if (!row)
        throw new NotFoundException('Активное назначение подрядчика не найдено'); checkVersion(row, v); if (await one(c, "SELECT id FROM works WHERE tenant_id=$1 AND object_id=$2 AND contractor_id=$3 AND status IN ('PLANNED','ACTIVE')", [a.tenantId, objectId, contractorId]))
        throw new ConflictException('Нельзя снять подрядчика: на объекте есть его незавершённые работы'); const n = await one(c, 'UPDATE object_contractors SET removed_at=now(),removed_by=$3,version=version+1 WHERE tenant_id=$1 AND id=$2 AND removed_at IS NULL RETURNING *', [a.tenantId, relationId, a.id]); await audit(c, a, 'ObjectContractor', row.id, 'REMOVE', row, n); return n; }); }
    async editObject(a: Actor, id: string, d: any) { requirePermission(a, P.OBJECT_EDIT); return transaction(async (c) => { const o = await scoped(c, 'objects', id, a, true); await objectAccess(c, a, id, true); checkVersion(o, d.version); if ('projectManagerId' in d) {
        if (!['TECHNICAL_DIRECTOR', 'ADMIN'].includes(a.role))
            throw new ForbiddenException('Только технический директор или администратор может переназначить РП');
        if (d.projectManagerId !== o.projectManagerId) {
            const pm = await scoped(c, 'users', d.projectManagerId, a);
            ensure(pm.role === 'PROJECT_MANAGER' && pm.isActive, 'Назначьте активного РП');
        }
    } const name = d.name ?? o.name, address = d.address ?? o.address, customerName = 'customerName' in d ? d.customerName : o.customerName, startDate = d.startDate ?? o.startDate, plannedFinishDate = d.plannedFinishDate ?? o.plannedFinishDate, projectManagerId = d.projectManagerId ?? o.projectManagerId; ensure(plannedFinishDate >= startDate, 'Дата окончания раньше начала'); const n = await one(c, 'UPDATE objects SET name=$3,address=$4,customer_name=$5,start_date=$6,planned_finish_date=$7,project_manager_id=$8,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *', [a.tenantId, id, name, address, customerName ?? null, startDate, plannedFinishDate, projectManagerId]); await audit(c, a, 'Object', id, 'EDIT', o, n); return n; }); }
    async createWork(a: Actor, d: any) { requirePermission(a, P.WORK_CREATE); return transaction(async (c) => { await objectAccess(c, a, d.objectId, true); await scoped(c, 'work_types', d.workTypeId, a); await scoped(c, 'users', d.responsibleUserId, a); ensure(!!await one(c, 'SELECT id FROM object_contractors_active WHERE tenant_id=$1 AND object_id=$2 AND contractor_id=$3 FOR UPDATE', [a.tenantId, d.objectId, d.contractorId]), 'Субподрядчик не назначен на объект'); ensure(d.plannedFinishDate >= d.plannedStartDate, 'Некорректные сроки'); const work = await insert(c, 'works', a.tenantId, d); await audit(c, a, 'Work', work.id, 'CREATE', null, work); return work; }); }
    // F8.1-03 corrective (Independent Review, not accepted first pass): this
    // used to decide "predecessor accepted" via its own raw-SQL
    // any-inspection-ACCEPTED EXISTS check — a different computation from
    // ReadService.snapshot()'s blockers, which already went through
    // PortionCompletionService. The two could disagree about the very same
    // work: a predecessor with one accepted portion out of three would read
    // as blocking on the read model (correct) but as accepted here (wrong).
    // Both now call the shared resolveInternalScAccepted()/
    // resolveActualQuantity() (packages/domain) with the same shape, so they
    // cannot diverge again — not "produce the same answer by construction",
    // literally the same function. A predecessor with no execution units is
    // completely unaffected: resolveInternalScAccepted/resolveActualQuantity
    // both fall back to exactly its pre-F8.1 figures.
    //
    // F8.1 Final corrective (Independent Re-Review, pass 3): the shape fed
    // into resolveInternalScAccepted() changed from an accepted/not boolean
    // to each portion's own latest INTERNAL_SC confirmation quantity — this
    // is the second, independent SQL path (ReadService.snapshot() is the
    // other) that has to fetch and shape it the same way, or the two would
    // silently diverge again despite calling the same shared function.
    async transition(c: any, a: Actor, id: string) { const work = await scoped(c, 'works', id, a); await objectAccess(c, a, work.objectId); ensure(a.role !== 'CONTRACTOR_VIEWER' || a.contractorId === work.contractorId, 'Работа другого подрядчика'); const dependencies = await rows(c, `SELECT w.*, d.requires_acceptance,d.requires_document, EXISTS(SELECT 1 FROM inspections i WHERE i.tenant_id=w.tenant_id AND i.object_work_id=w.id AND i.portion_id IS NULL AND i.status='ACCEPTED') AS whole_work_accepted,EXISTS(SELECT 1 FROM issues x JOIN inspections i ON i.id=x.inspection_id AND i.tenant_id=x.tenant_id WHERE i.tenant_id=w.tenant_id AND i.object_work_id=w.id AND x.severity='CRITICAL' AND x.status<>'CLOSED') AS critical_issue,EXISTS(SELECT 1 FROM executive_documents e WHERE e.tenant_id=w.tenant_id AND e.object_work_id=w.id AND e.status='APPROVED') AS document_approved FROM work_dependencies d JOIN works w ON w.id=d.predecessor_work_id AND w.tenant_id=d.tenant_id WHERE d.tenant_id=$1 AND d.successor_work_id=$2`, [a.tenantId, id]); const predecessorIds = dependencies.map(p => p.id); const units = predecessorIds.length ? await rows(c, 'SELECT * FROM work_execution_units WHERE tenant_id=$1 AND object_work_id=ANY($2::uuid[])', [a.tenantId, predecessorIds]) : []; const unitIds = units.map((u: any) => u.id); const portions = unitIds.length ? await rows(c, 'SELECT * FROM quantity_portions WHERE tenant_id=$1 AND execution_unit_id=ANY($2::uuid[])', [a.tenantId, unitIds]) : []; const portionIds = portions.map((p: any) => p.id); const internalScConfirmations = portionIds.length ? await rows(c, "SELECT DISTINCT ON (portion_id) portion_id,quantity FROM portion_quantity_confirmations WHERE tenant_id=$1 AND portion_id=ANY($2::uuid[]) AND source='INTERNAL_SC' ORDER BY portion_id,recorded_at DESC", [a.tenantId, portionIds]) : []; const rpFacts = portionIds.length ? await rows(c, "SELECT DISTINCT ON (portion_id) portion_id,quantity FROM portion_quantity_confirmations WHERE tenant_id=$1 AND portion_id=ANY($2::uuid[]) AND source='RP_FACT' ORDER BY portion_id,recorded_at DESC", [a.tenantId, portionIds]) : []; const unitsFor = (predecessorId: string) => units.filter((u: any) => u.objectWorkId === predecessorId).map((u: any) => { const ownPortions = portions.filter((p: any) => p.executionUnitId === u.id); return { unit: u.unit, plannedQuantity: u.plannedQuantity, actualQuantity: ownPortions.reduce((s: Decimal, p: any) => s.add(rpFacts.find((f: any) => f.portionId === p.id)?.quantity ?? 0), new Decimal(0)).toFixed(4), portions: ownPortions.map((p: any) => ({ internalScConfirmedQuantity: internalScConfirmations.find((f: any) => f.portionId === p.id)?.quantity ?? null })) }; }); return new WorkTransitionPolicy().canStartWork(dependencies.map(p => { const predecessorUnits = unitsFor(p.id); return { name: p.name, complete: new Decimal(resolveActualQuantity(p.actualQuantity, p.unit, predecessorUnits.map(u => ({ unit: u.unit, actualQuantity: u.actualQuantity })))).gte(p.plannedQuantity), requiresAcceptance: p.requiresAcceptance, accepted: resolveInternalScAccepted(p.wholeWorkAccepted, predecessorUnits), criticalIssue: p.criticalIssue, documentRequired: p.requiresDocument, documentApproved: p.documentApproved }; })); }
    async dependency(a: Actor, d: any) { requirePermission(a, P.WORK_CREATE); return transaction(async (c) => { const before = await scoped(c, 'works', d.predecessorWorkId, a), after = await scoped(c, 'works', d.successorWorkId, a); await objectAccess(c, a, after.objectId, true); ensure(before.objectId === after.objectId, 'Работы должны относиться к одному объекту'); await c.query('SELECT id FROM objects WHERE id=$1 FOR UPDATE', [after.objectId]); ensure(Number(after.actualQuantity) === 0 && after.status === 'PLANNED', 'Нельзя добавлять зависимость к начатой работе'); const cycle = await one(c, 'WITH RECURSIVE chain AS (SELECT successor_work_id FROM work_dependencies WHERE tenant_id=$1 AND predecessor_work_id=$2 UNION SELECT d.successor_work_id FROM work_dependencies d JOIN chain x ON d.predecessor_work_id=x.successor_work_id WHERE d.tenant_id=$1) SELECT 1 FROM chain WHERE successor_work_id=$3', [a.tenantId, d.successorWorkId, d.predecessorWorkId]); ensure(!cycle && before.id !== after.id, 'Циклическая зависимость'); const dep = await insert(c, 'work_dependencies', a.tenantId, d); await audit(c, a, 'Work', after.id, 'DEPENDENCY', null, dep); return dep; }); }
    async start(a: Actor, id: string, v: number) { requirePermission(a, P.WORK_UPDATE_PROGRESS); return transaction(async (c) => { const w = await scoped(c, 'works', id, a, true); checkVersion(w, v); const policy = await this.transition(c, a, id); ensure(policy.allowed, policy.reasons.join('; ')); ensure(w.status === 'PLANNED', 'Работа уже начата'); const n = await one(c, "UPDATE works SET status='ACTIVE',actual_start_date=CURRENT_DATE,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *", [a.tenantId, id]); await audit(c, a, 'Work', id, 'START', w, n); return n; }); }
    // F8.1-04 corrective (Independent Review, not accepted first pass): once
    // a work has any execution unit, that unit/portion model is its sole
    // production fact source — this legacy, whole-work fact entry is refused
    // outright rather than left free to write a second, competing
    // works.actual_quantity/work_progress figure nothing else derives from
    // any more (ReadService.snapshot() and transition() both now read such a
    // work's actual quantity via resolveActualQuantity(), which ignores this
    // column the moment a unit exists). A work with no execution units is
    // completely unaffected — this is a no-op EXISTS check against a table
    // that has no rows for it, so F7 behaviour is unchanged.
    async progress(a: Actor, id: string, d: any) { requirePermission(a, P.WORK_UPDATE_PROGRESS); return transaction(async (c) => { const w = await scoped(c, 'works', id, a, true); await objectAccess(c, a, w.objectId, true); checkVersion(w, d.version); ensure(!await one(c, 'SELECT id FROM work_execution_units WHERE tenant_id=$1 AND object_work_id=$2', [a.tenantId, id]), 'Для работ с единицами исполнения используйте предъявление факта по участкам'); const allowed = await this.transition(c, a, id); ensure(allowed.allowed, allowed.reasons.join('; ')); ensure(!await one(c, "SELECT id FROM inspections WHERE tenant_id=$1 AND object_work_id=$2 AND status NOT IN ('REJECTED','NOT_SUBMITTED')", [a.tenantId, id]), 'После предъявления СК факт заблокирован. Требуется отдельная корректировка'); const percent = new ProgressCalculationService().calculate(d.totalQuantity, w.plannedQuantity); const status = percent === 100 ? 'COMPLETED' : 'ACTIVE'; if (status !== 'COMPLETED' && !await one(c, 'SELECT id FROM object_contractors_active WHERE tenant_id=$1 AND object_id=$2 AND contractor_id=$3 FOR UPDATE', [a.tenantId, w.objectId, w.contractorId]))
        throw new ConflictException('Подрядчик больше не назначен на объект'); const n = await one(c, "UPDATE works SET actual_quantity=$3,status=$4,actual_start_date=coalesce(actual_start_date,CURRENT_DATE),actual_finish_date=CASE WHEN $4='COMPLETED' THEN CURRENT_DATE ELSE NULL END,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *", [a.tenantId, id, d.totalQuantity, status]); await insert(c, 'work_progress', a.tenantId, { objectWorkId: id, quantityDelta: new Decimal(d.totalQuantity).minus(w.actualQuantity).toString(), totalQuantity: d.totalQuantity, progressPercent: percent, reportedBy: a.id, comment: d.comment }); await audit(c, a, 'Work', id, 'PROGRESS', w, n, 'WorkProgressUpdated'); return { ...n, progressPercent: percent, isOverperformed: new ProgressCalculationService().isOverperformed(d.totalQuantity, w.plannedQuantity), ...new ScheduleStatusService().calculate(n.plannedStartDate, n.plannedFinishDate, percent) }; }); }
    async requestInspection(a: Actor, id: string, v: number) { requirePermission(a, P.INSPECTION_REQUEST); return transaction(async (c) => { const w = await scoped(c, 'works', id, a, true); await objectAccess(c, a, w.objectId, true); checkVersion(w, v); ensure(new Decimal(w.actualQuantity).gte(w.plannedQuantity), 'Для MVP предъявляется полный объём работы'); ensure(!await one(c, "SELECT id FROM inspections WHERE tenant_id=$1 AND object_work_id=$2 AND status='ACCEPTED'", [a.tenantId, id]), 'Работа уже принята'); const i = await insert(c, 'inspections', a.tenantId, { objectId: w.objectId, objectWorkId: id, requestedBy: a.id }); await c.query('UPDATE works SET version=version+1 WHERE tenant_id=$1 AND id=$2', [a.tenantId, id]); await audit(c, a, 'Inspection', i.id, 'REQUEST', null, i, 'InspectionRequested'); return i; }); }
    async addIssue(a: Actor, id: string, d: any) { requirePermission(a, P.ISSUE_CREATE); return transaction(async (c) => { const i = await scoped(c, 'inspections', id, a, true); await objectAccess(c, a, i.objectId); checkVersion(i, d.version); ensure(['WAITING', 'IN_REVIEW', 'REINSPECTION', 'ISSUES_FOUND'].includes(i.status), 'Проверка завершена'); await scoped(c, 'users', d.responsibleUserId, a); const { version, ...data } = d; const issue = await insert(c, 'issues', a.tenantId, { inspectionId: id, ...data }); await c.query("UPDATE inspections SET status='ISSUES_FOUND',inspector_id=$3,version=version+1 WHERE tenant_id=$1 AND id=$2", [a.tenantId, id, a.id]); await audit(c, a, 'Issue', issue.id, 'CREATE', null, issue, 'IssueCreated'); return issue; }); }
    async issueAction(a: Actor, id: string, v: number, action: string) { requirePermission(a, action === 'resolve' ? P.ISSUE_RESOLVE : P.ISSUE_VERIFY); return transaction(async (c) => { const first = await scoped(c, 'issues', id, a); const i = await scoped(c, 'inspections', first.inspectionId, a, true); const issue = await scoped(c, 'issues', id, a, true); await objectAccess(c, a, i.objectId, true); checkVersion(issue, v); if (action === 'resolve')
        ensure(['OPEN', 'IN_PROGRESS', 'REJECTED'].includes(issue.status), 'Замечание не ожидает устранения');
    else
        ensure(issue.status === 'READY_FOR_VERIFICATION', 'Сначала РП должен устранить замечание'); const n = action === 'resolve' ? await one(c, "UPDATE issues SET status='READY_FOR_VERIFICATION',resolved_at=now(),resolved_by=$3,version=version+1 WHERE tenant_id=$1 AND id=$2 RETURNING *", [a.tenantId, id, a.id]) : await one(c, "UPDATE issues SET status='CLOSED',verified_at=now(),verified_by=$3,version=version+1 WHERE tenant_id=$1 AND id=$2 RETURNING *", [a.tenantId, id, a.id]); await c.query("UPDATE inspections SET status='REINSPECTION',version=version+1 WHERE tenant_id=$1 AND id=$2", [a.tenantId, i.id]); await audit(c, a, 'Issue', id, action.toUpperCase(), issue, n, action === 'resolve' ? 'IssueResolved' : undefined); return n; }); }
    async inspectionAction(a: Actor, id: string, v: number, action: string, comment: string, quantity?: any) { requirePermission(a, action === 'accept' ? P.INSPECTION_ACCEPT : P.INSPECTION_REJECT); return transaction(async (c) => { const i = await scoped(c, 'inspections', id, a, true); await objectAccess(c, a, i.objectId); checkVersion(i, v); ensure(['WAITING', 'IN_REVIEW', 'ISSUES_FOUND', 'REINSPECTION'].includes(i.status), 'Проверка уже завершена'); if (action === 'accept') {
        ensure(!await one(c, "SELECT id FROM issues WHERE tenant_id=$1 AND inspection_id=$2 AND status<>'CLOSED'", [a.tenantId, id]), 'Не все замечания проверены и закрыты');
        ensure(!!await one(c, 'SELECT id FROM inspection_photos WHERE tenant_id=$1 AND inspection_id=$2', [a.tenantId, id]), 'Необходима фотофиксация проверки');
        // F8.1-01 corrective, second pass (Independent Re-Review, Patch 2):
        // the confirmed quantity must be the inspector's own independent
        // figure — never copied or defaulted from the portion's RP_FACT, so
        // Internal SC (498) and Customer SC (496) can genuinely disagree
        // with RP's own 500 and with each other. Required exactly when there
        // is a portion to confirm a quantity against; a whole-work
        // inspection has none, so none is asked for or stored.
        ensure(!i.portionId || (quantity !== undefined && quantity !== null), 'Укажите подтверждённый объём');
    } const n = await one(c, "UPDATE inspections SET status=$3,decision=$3,comment=$4,inspector_id=$5,inspection_date=now(),accepted_at=CASE WHEN $3='ACCEPTED' THEN now() ELSE NULL END,version=version+1 WHERE tenant_id=$1 AND id=$2 RETURNING *", [a.tenantId, id, action === 'accept' ? 'ACCEPTED' : 'REJECTED', comment, a.id]); await c.query('UPDATE works SET version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2', [a.tenantId, i.objectWorkId]);
    // F8.1-01 (Independent Review): an ACCEPTED portion-scoped inspection —
    // Internal SC or Customer SC alike, one workflow, decision 5 — leaves
    // its own confirmation record, never only the inspection row's own
    // status. `source` is the inspection's own type; `quantity` is the
    // caller-supplied, independently confirmed figure above. Insert-only:
    // RP_FACT and any prior confirmation are never touched, so all three
    // sources stay independently readable (F8.1 "Quantity confirmation
    // history" — no overwrite). A whole-work inspection (portion_id NULL,
    // every pre-F8.1 row) has nowhere to attach a portion confirmation and
    // is left exactly as before.
    if (action === 'accept' && i.portionId) {
        await insert(c, 'portion_quantity_confirmations', a.tenantId, { portionId: i.portionId, source: i.inspectionType, quantity, inspectionId: id, recordedBy: a.id, comment: comment ?? null });
    } await audit(c, a, 'Inspection', id, action.toUpperCase(), i, n, action === 'accept' ? 'InspectionAccepted' : 'InspectionRejected'); return n; }); }
    async createPackage(a: Actor, workId: string) { requirePermission(a, P.PTO_EDIT); return transaction(async (c) => { const w = await scoped(c, 'works', workId, a); await objectAccess(c, a, w.objectId); const p = await insert(c, 'executive_packages', a.tenantId, { objectId: w.objectId, objectWorkId: workId, createdBy: a.id }); await audit(c, a, 'Package', p.id, 'CREATE', null, p); return p; }); }
    async createDocument(a: Actor, d: any) { requirePermission(a, P.PTO_EDIT); return transaction(async (c) => { const p = await scoped(c, 'executive_packages', d.packageId, a, true); await objectAccess(c, a, p.objectId); ensure(!['TRANSFERRED_TO_SDO'].includes(p.status), 'Пакет уже передан'); const w = await scoped(c, 'works', p.objectWorkId, a), o = await scoped(c, 'objects', p.objectId, a); if (d.fileId)
        await scoped(c, 'attachments', d.fileId, a); const draft = new AosrDraftEngine().render({ Объект: o.name, Адрес: o.address, Работа: w.name, Начало: w.actualStartDate, Окончание: w.actualFinishDate }); const doc = await insert(c, 'executive_documents', a.tenantId, { objectId: p.objectId, objectWorkId: p.objectWorkId, type: d.type, number: d.number, documentDate: d.documentDate, status: 'DRAFT', fileId: d.fileId ?? null, draftContent: draft.content, createdBy: a.id }); await insert(c, 'package_documents', a.tenantId, { packageId: p.id, documentId: doc.id }); await c.query("UPDATE executive_packages SET status='IN_PROGRESS',version=version+1 WHERE tenant_id=$1 AND id=$2", [a.tenantId, p.id]); await audit(c, a, 'Document', doc.id, 'DRAFT', null, doc); return doc; }); }
    async approveDocument(a: Actor, id: string, v: number) { requirePermission(a, P.PTO_EDIT); return transaction(async (c) => { const doc = await scoped(c, 'executive_documents', id, a, true); await objectAccess(c, a, doc.objectId); checkVersion(doc, v); ensure(doc.status !== 'APPROVED', 'Документ уже подтверждён'); ensure(!!doc.fileId, 'Прикрепите проверенный документ; текст черновика не заменяет файл'); const n = await one(c, "UPDATE executive_documents SET status='APPROVED',approved_by=$3,approved_at=now(),version=version+1 WHERE tenant_id=$1 AND id=$2 RETURNING *", [a.tenantId, id, a.id]); await audit(c, a, 'Document', id, 'APPROVE', doc, n); return n; }); }
    async packageValidation(c: any, a: Actor, id: string) { const p = await scoped(c, 'executive_packages', id, a); await objectAccess(c, a, p.objectId); const w = await one(c, 'SELECT w.*,t.requires_inspection,t.requires_materials FROM works w JOIN work_types t ON t.id=w.work_type_id AND t.tenant_id=w.tenant_id WHERE w.tenant_id=$1 AND w.id=$2', [a.tenantId, p.objectWorkId]); const docs = await rows(c, 'SELECT d.* FROM package_documents p JOIN executive_documents d ON d.id=p.document_id AND d.tenant_id=p.tenant_id WHERE p.tenant_id=$1 AND p.package_id=$2', [a.tenantId, id]); const materials = await rows(c, `SELECT wm.id,EXISTS(SELECT 1 FROM material_documents d WHERE d.tenant_id=wm.tenant_id AND d.material_batch_id=wm.material_batch_id AND d.type IN ('CERTIFICATE','PASSPORT','DECLARATION','QUALITY_DOCUMENT') AND (d.valid_from IS NULL OR d.valid_from<=CURRENT_DATE) AND (d.valid_until IS NULL OR d.valid_until>=CURRENT_DATE)) AS valid FROM work_materials wm WHERE wm.tenant_id=$1 AND wm.object_work_id=$2`, [a.tenantId, w.id]); const accepted = !!await one(c, "SELECT id FROM inspections WHERE tenant_id=$1 AND object_work_id=$2 AND status='ACCEPTED'", [a.tenantId, w.id]); return new PtoPackageValidationService().validate({ accepted, requiresInspection: w.requiresInspection, documents: docs, requiresMaterials: w.requiresMaterials, materialsValid: materials.length > 0 && materials.every(x => x.valid) }); }
    async packageAction(a: Actor, id: string, v: number, action: string) { requirePermission(a, action === 'transfer-sdo' ? P.PTO_TRANSFER_SDO : P.PTO_EDIT); return transaction(async (c) => { const p = await scoped(c, 'executive_packages', id, a, true); checkVersion(p, v); ensure(p.status !== 'TRANSFERRED_TO_SDO', 'Пакет уже передан'); const validation = await this.packageValidation(c, a, id); ensure(validation.allowed, validation.reasons.join('; ')); if (action === 'ready') {
        const n = await one(c, "UPDATE executive_packages SET status='READY',completed_at=now(),version=version+1 WHERE tenant_id=$1 AND id=$2 RETURNING *", [a.tenantId, id]);
        await audit(c, a, 'Package', id, 'READY', p, n, 'ExecutivePackageReady');
        return n;
    } ensure(p.status === 'READY', 'Сначала отметьте готовность пакета'); await insert(c, 'pto_transfers', a.tenantId, { packageId: id, transferredBy: a.id }); const w = await scoped(c, 'works', p.objectWorkId, a); ensure(!await one(c, 'SELECT id FROM sdo_cases WHERE tenant_id=$1 AND object_work_id=$2', [a.tenantId, w.id]), 'Для работы уже создано дело СДО'); const sdo = await insert(c, 'sdo_cases', a.tenantId, { objectId: p.objectId, objectWorkId: p.objectWorkId, executiveDocumentPackageId: id, ptoTransferredBy: a.id, estimatedValue: w.estimatedCost }); await c.query("UPDATE executive_packages SET status='TRANSFERRED_TO_SDO',version=version+1 WHERE tenant_id=$1 AND id=$2", [a.tenantId, id]); await audit(c, a, 'Package', id, 'TRANSFER_SDO', p, sdo, 'TransferredToSdo'); return sdo; }); }
    async calculateSdo(a: Actor, id: string, d: any) { requirePermission(a, P.SDO_EDIT); return transaction(async (c) => { const s = await scoped(c, 'sdo_cases', id, a, true); await objectAccess(c, a, s.objectId); checkVersion(s, d.version); ensure(['TRANSFERRED', 'IN_PROGRESS', 'NEEDS_CLARIFICATION', 'CALCULATED'].includes(s.status), 'Дело уже закрывается'); const n = await one(c, "UPDATE sdo_cases SET calculated_value=$3,accepted_closing_value=$3,status='CALCULATED',sdo_responsible_id=$4,calculated_at=now(),version=version+1 WHERE tenant_id=$1 AND id=$2 RETURNING *", [a.tenantId, id, d.calculatedValue, a.id]); await audit(c, a, 'SdoCase', id, 'CALCULATE', s, n, 'SdoCalculated'); return n; }); }
    async close(a: Actor, d: any) { requirePermission(a, P.SDO_CLOSE); requirePermission(a, P.FINANCE_EDIT); return transaction(async (c) => { const s = await scoped(c, 'sdo_cases', d.sdoCaseId, a, true); await objectAccess(c, a, s.objectId); const existing = await one(c, 'SELECT * FROM financial_closings WHERE tenant_id=$1 AND idempotency_key=$2', [a.tenantId, d.idempotencyKey]); if (existing) {
        ensure(existing.sdoCaseId === s.id && new Decimal(existing.amount).eq(d.amount) && existing.period === d.period && new Date(existing.closingDate).toISOString().slice(0, 10) === d.closingDate, 'Idempotency key уже использован с другими данными');
        return existing;
    } checkVersion(s, d.version); ensure(['CALCULATED', 'READY_TO_CLOSE'].includes(s.status), 'Стоимость ещё не рассчитана или дело закрыто'); const sum = await one(c, 'SELECT coalesce(sum(amount),0) AS amount FROM financial_closings WHERE tenant_id=$1 AND sdo_case_id=$2', [a.tenantId, s.id]); ensure(new Decimal(sum.amount).add(d.amount).lte(s.acceptedClosingValue), 'Сумма превышает доступное закрытие'); ensure(d.closingDate.slice(0, 7) === d.period, 'Период не соответствует дате закрытия'); const f = await insert(c, 'financial_closings', a.tenantId, { objectId: s.objectId, sdoCaseId: s.id, period: d.period, amount: d.amount, closingDate: d.closingDate, createdBy: a.id, idempotencyKey: d.idempotencyKey }); const all = new Decimal(sum.amount).add(d.amount).eq(s.acceptedClosingValue); await c.query("UPDATE sdo_cases SET status=$3,closed_at=CASE WHEN $3='CLOSED' THEN now() ELSE NULL END,version=version+1 WHERE tenant_id=$1 AND id=$2", [a.tenantId, s.id, all ? 'CLOSED' : 'READY_TO_CLOSE']); await audit(c, a, 'FinancialClosing', f.id, 'CREATE', null, f, 'FinancialClosingCreated'); return f; }); }
    // ---------------------------------------------------------------------
    // F8.1 Production Execution + Construction Control Foundation.
    //
    // Every method below is new; nothing above this line is touched. progress(),
    // requestInspection() and inspectionAction() keep their exact F7 source, so a
    // non-portioned work's behaviour cannot regress — there is no shared branch
    // for a portion-aware path to leak into. inspectionAction() is also what
    // Customer SC decisions go through unchanged (F8.1 decision 5: one
    // inspections table, one workflow, distinguished only by inspection_type);
    // it does not yet distinguish INTERNAL_SC from CUSTOMER_SC in its own body,
    // so a Customer SC row is currently held to the exact same issues-closed and
    // photo-required requirements as Internal SC — flagged in the F8.1 handoff
    // as a point a later phase may need to branch, not silently assumed away.
    // ---------------------------------------------------------------------
    // F8.1-04 corrective, second pass (Independent Re-Review, Patch 2): an
    // execution unit's own measurement unit and work type must agree with
    // its parent work's — the primary prevention for "м² + м³" or an
    // unrelated execution unit ever being able to form one actual quantity;
    // resolveActualQuantity() (packages/domain) carries a matching defence
    // of its own for anything that reaches it regardless of this check.
    async createExecutionUnit(a: Actor, d: any) { requirePermission(a, P.EXECUTION_UNIT_MANAGE); return transaction(async (c) => { const w = await scoped(c, 'works', d.objectWorkId, a); await objectAccess(c, a, w.objectId, true); await scoped(c, 'work_types', d.workTypeId, a); if (d.finishTypeId)
        await scoped(c, 'finish_types', d.finishTypeId, a); ensure(d.unit === w.unit, 'Единица измерения единицы исполнения должна совпадать с единицей измерения работы'); ensure(d.workTypeId === w.workTypeId, 'Вид работ единицы исполнения должен совпадать с видом работ'); ensure(!!await one(c, 'SELECT id FROM object_contractors_active WHERE tenant_id=$1 AND object_id=$2 AND contractor_id=$3', [a.tenantId, w.objectId, d.contractorId]), 'Субподрядчик не назначен на объект'); const unit = await insert(c, 'work_execution_units', a.tenantId, d); await audit(c, a, 'ExecutionUnit', unit.id, 'CREATE', null, unit, 'ExecutionUnitCreated'); return unit; }); }
    async addExecutionUnitLayer(a: Actor, unitId: string, d: any) { requirePermission(a, P.EXECUTION_UNIT_MANAGE); return transaction(async (c) => { const unit = await scoped(c, 'work_execution_units', unitId, a); const w = await scoped(c, 'works', unit.objectWorkId, a); await objectAccess(c, a, w.objectId, true); const layer = await insert(c, 'execution_unit_layers', a.tenantId, { executionUnitId: unitId, ...d }); await audit(c, a, 'ExecutionUnitLayer', layer.id, 'CREATE', null, layer); return layer; }); }
    // D4: a candidate portion is rejected — never silently clamped — if it would
    // push the unit's portion total past the unit's own planned_quantity. The
    // unit row is locked FOR UPDATE for the duration of the sum-and-insert so two
    // concurrent portion creations cannot both pass the check against the same
    // stale sum.
    async createQuantityPortion(a: Actor, unitId: string, d: any) { requirePermission(a, P.EXECUTION_UNIT_MANAGE); return transaction(async (c) => { const unit = await scoped(c, 'work_execution_units', unitId, a, true); const w = await scoped(c, 'works', unit.objectWorkId, a); await objectAccess(c, a, w.objectId, true); const sum = await one(c, 'SELECT coalesce(sum(planned_quantity),0) AS total FROM quantity_portions WHERE tenant_id=$1 AND execution_unit_id=$2', [a.tenantId, unitId]); ensure(new QuantityPortionPolicy().fits(unit.plannedQuantity, sum.total, d.plannedQuantity), 'Сумма объёма участков превышает плановый объём единицы исполнения'); const portion = await insert(c, 'quantity_portions', a.tenantId, { executionUnitId: unitId, ...d }); await audit(c, a, 'QuantityPortion', portion.id, 'CREATE', null, portion); return portion; }); }
    // "RP enters fact" (F8.1 decision 7) — the portion-scoped analogue of
    // progress(), on portion_quantity_confirmations (source RP_FACT) rather than
    // work_progress/works.actual_quantity, which this leaves untouched. The
    // freeze-after-submission rule from business rule 6 is preserved at the new
    // granularity: once the portion has a non-rejected INTERNAL_SC inspection,
    // its own fact is locked, exactly as a whole work's is today — but a
    // sibling portion, or the work's own whole-work tracking, is never affected.
    async recordPortionFact(a: Actor, portionId: string, d: any) { requirePermission(a, P.WORK_UPDATE_PROGRESS); return transaction(async (c) => { const portion = await scoped(c, 'quantity_portions', portionId, a, true); const unit = await scoped(c, 'work_execution_units', portion.executionUnitId, a); const w = await scoped(c, 'works', unit.objectWorkId, a); await objectAccess(c, a, w.objectId, true); checkVersion(portion, d.version);
    // F8.1-03 corrective, second pass (Independent Re-Review, Patch 2): the
    // portion-level freeze guard below only ever knew about *this* portion's
    // own inspection history — it had nothing to say about the work's own
    // production dependencies, so a portion could still take fact while the
    // work itself was blocked on an unaccepted predecessor, silently
    // bypassing the exact gate progress() already enforces for a
    // non-portioned work. Calling the same transition() (as progress() does)
    // makes recordPortionFact() subject to the identical rule, not a
    // separately-maintained approximation of it. A work with no
    // dependencies is unaffected — canStartWork([]) is vacuously allowed.
    const allowed = await this.transition(c, a, w.id); ensure(allowed.allowed, allowed.reasons.join('; ')); ensure(!await one(c, "SELECT id FROM inspections WHERE tenant_id=$1 AND portion_id=$2 AND inspection_type='INTERNAL_SC' AND status NOT IN ('REJECTED','NOT_SUBMITTED')", [a.tenantId, portionId]), 'После предъявления СК факт участка заблокирован. Требуется отдельная корректировка'); const confirmation = await insert(c, 'portion_quantity_confirmations', a.tenantId, { portionId, source: 'RP_FACT', quantity: d.quantity, recordedBy: a.id, comment: d.comment ?? null }); await c.query('UPDATE quantity_portions SET version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2', [a.tenantId, portionId]); await audit(c, a, 'QuantityPortion', portionId, 'RP_FACT', null, confirmation, 'WorkProgressUpdated'); return confirmation; }); }
    // Internal SC and Customer SC both request through this one method (F8.1
    // decision 5 — one workflow, not two): only inspectionType differs. "Для
    // MVP предъявляется полный объём" (business rule 6) is preserved at the
    // portion granularity, read from this portion's own latest RP_FACT
    // confirmation — a sibling portion's fact never satisfies it. A previously
    // REJECTED inspection of the same type does not block a fresh request; any
    // other existing status does.
    async requestPortionInspection(a: Actor, portionId: string, v: number, inspectionType: 'INTERNAL_SC' | 'CUSTOMER_SC') { requirePermission(a, P.INSPECTION_REQUEST); return transaction(async (c) => { const portion = await scoped(c, 'quantity_portions', portionId, a, true); checkVersion(portion, v); const unit = await scoped(c, 'work_execution_units', portion.executionUnitId, a); const w = await scoped(c, 'works', unit.objectWorkId, a); await objectAccess(c, a, w.objectId, true); const fact = await one(c, "SELECT quantity FROM portion_quantity_confirmations WHERE tenant_id=$1 AND portion_id=$2 AND source='RP_FACT' ORDER BY recorded_at DESC LIMIT 1", [a.tenantId, portionId]); ensure(!!fact && new Decimal(fact.quantity).gte(portion.plannedQuantity), 'Для MVP предъявляется полный объём участка'); ensure(!await one(c, "SELECT id FROM inspections WHERE tenant_id=$1 AND portion_id=$2 AND inspection_type=$3 AND status<>'REJECTED'", [a.tenantId, portionId, inspectionType]), 'Проверка уже предъявлена или принята'); const i = await insert(c, 'inspections', a.tenantId, { objectId: w.objectId, objectWorkId: w.id, portionId, inspectionType, requestedBy: a.id }); await c.query('UPDATE quantity_portions SET version=version+1 WHERE tenant_id=$1 AND id=$2', [a.tenantId, portionId]); await audit(c, a, 'Inspection', i.id, 'REQUEST', null, i, 'InspectionRequested'); return i; }); }
    // ---------------------------------------------------------------------
    // F8.2 PTO / Executive Documentation Foundation. A Documentation Package
    // hangs off an existing work, exactly like an execution unit does — it
    // never reads works.actual_quantity/planned_quantity, never touches
    // portion_quantity_confirmations, and never feeds
    // ProgressCalculationService/ScheduleStatusService/ObjectHealthService
    // (BR-01/BR-02/BR-03: a package may exist before completion, and neither
    // physical readiness nor quantity confirmation is this model's concern).
    // No eventType is passed to audit() below for any F8.2 method — that
    // fan-out notifies PTO/TECHNICAL_DIRECTOR/GENERAL_DIRECTOR/
    // CONSTRUCTION_CONTROL/SDO/PROJECT_MANAGER indiscriminately
    // (security.ts's audit()), and SDO must not be notified about
    // documentation it has no access to at all.
    async createDocumentationPackage(a: Actor, d: any) { requirePermission(a, P.DOCUMENTATION_MANAGE); return transaction(async (c) => { const w = await scoped(c, 'works', d.objectWorkId, a); await objectAccess(c, a, w.objectId, true); const responsible = await scoped(c, 'users', d.responsibleUserId, a); ensure(responsible.role === 'PTO' && responsible.isActive, 'Назначьте активного сотрудника ПТО'); const pkg = await insert(c, 'documentation_packages', a.tenantId, { objectId: w.objectId, objectWorkId: d.objectWorkId, responsibleUserId: d.responsibleUserId, createdBy: a.id }); await audit(c, a, 'DocumentationPackage', pkg.id, 'CREATE', null, pkg); return pkg; }); }
    async editDocumentationPackage(a: Actor, id: string, d: any) { requirePermission(a, P.DOCUMENTATION_MANAGE); return transaction(async (c) => { const pkg = await scoped(c, 'documentation_packages', id, a, true); const w = await scoped(c, 'works', pkg.objectWorkId, a); await objectAccess(c, a, w.objectId, true); checkVersion(pkg, d.version); const responsible = await scoped(c, 'users', d.responsibleUserId, a); ensure(responsible.role === 'PTO' && responsible.isActive, 'Назначьте активного сотрудника ПТО'); const n = await one(c, 'UPDATE documentation_packages SET responsible_user_id=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *', [a.tenantId, id, d.responsibleUserId]); await audit(c, a, 'DocumentationPackage', id, 'EDIT', pkg, n); return n; }); }
    // A portion may only be linked into a package that covers its own work —
    // the same "does this cross-entity reference actually belong together"
    // discipline createExecutionUnit() applies to unit/workType, checked here
    // in application code because it spans documentation_package_portions,
    // quantity_portions and work_execution_units, wider than any single-table
    // CHECK constraint could express.
    // F8.3-17/18 corrective: the Package is locked FOR UPDATE first (the
    // canonical lock order this whole subsystem now uses — Package, then
    // Case, then Document), before either evaluating its content-mutation
    // policy or writing the new link — a concurrent handoff/return-to-PTO
    // (both Package-first too) cannot interleave through this transaction.
    // canMutateDocumentationPackageContent() (packages/domain) is the one
    // shared policy — content-editable statuses only, and never while an
    // SDO Case holds the Package locked (including CLOSED) — replacing the
    // narrower, package_locked-only check this used to run on its own.
    async linkDocumentationPackagePortion(a: Actor, packageId: string, d: any) { requirePermission(a, P.DOCUMENTATION_MANAGE); return transaction(async (c) => { const pkg = await scoped(c, 'documentation_packages', packageId, a, true); const w = await scoped(c, 'works', pkg.objectWorkId, a); await objectAccess(c, a, w.objectId, true); const sdoCase = await one(c, 'SELECT package_locked FROM sdo_closing_cases WHERE tenant_id=$1 AND documentation_package_id=$2', [a.tenantId, packageId]); const policy = canMutateDocumentationPackageContent({ packageStatus: pkg.status, sdoCaseExists: !!sdoCase, sdoCasePackageLocked: !!sdoCase?.packageLocked }); ensure(policy.allowed, policy.reason!); const portion = await scoped(c, 'quantity_portions', d.quantityPortionId, a); const unit = await scoped(c, 'work_execution_units', portion.executionUnitId, a); ensure(unit.objectWorkId === pkg.objectWorkId, 'Участок относится к другой работе'); ensure(!await one(c, 'SELECT id FROM documentation_package_portions WHERE tenant_id=$1 AND documentation_package_id=$2 AND quantity_portion_id=$3', [a.tenantId, packageId, d.quantityPortionId]), 'Участок уже привязан к пакету'); const link = await insert(c, 'documentation_package_portions', a.tenantId, { documentationPackageId: packageId, quantityPortionId: d.quantityPortionId }); await audit(c, a, 'DocumentationPackagePortion', link.id, 'CREATE', null, link); return link; }); }
    async createDocumentationDocument(a: Actor, packageId: string, d: any) { requirePermission(a, P.DOCUMENTATION_MANAGE); return transaction(async (c) => { const pkg = await scoped(c, 'documentation_packages', packageId, a, true); const w = await scoped(c, 'works', pkg.objectWorkId, a); await objectAccess(c, a, w.objectId, true); const sdoCase = await one(c, 'SELECT package_locked FROM sdo_closing_cases WHERE tenant_id=$1 AND documentation_package_id=$2', [a.tenantId, packageId]); const policy = canMutateDocumentationPackageContent({ packageStatus: pkg.status, sdoCaseExists: !!sdoCase, sdoCasePackageLocked: !!sdoCase?.packageLocked }); ensure(policy.allowed, policy.reason!); const doc = await insert(c, 'documentation_documents', a.tenantId, { documentationPackageId: packageId, type: d.type, createdBy: a.id }); await audit(c, a, 'DocumentationDocument', doc.id, 'CREATE', null, doc); return doc; }); }
    // Version history (F8.2 Decision Lock): a version is only ever inserted,
    // never edited — the document row locked FOR UPDATE for the duration of
    // the max-then-insert so two concurrent version creations on the same
    // document cannot both compute the same next version_number, the same
    // race createQuantityPortion() already guards against for its own sum.
    // F8.3-18 corrective: this begins from a Document id, but the canonical
    // lock order is Package, then Case, then Document — so the parent
    // Package id is resolved with a plain (non-locking) read first, the
    // Package itself is locked FOR UPDATE, and only then is the Document
    // locked/re-read — never the reverse, which used to let this take the
    // Document's lock while holding no lock on its Package at all.
    // F8.3-17 corrective: canMutateDocumentationPackageContent() (packages/domain)
    // — a new version is content, refused once the Package is frozen
    // (PRESENTED/ACCEPTED_BY_CUSTOMER/RETURNED) or its SDO Case holds it locked.
    async createDocumentationVersion(a: Actor, documentId: string, d: any) { requirePermission(a, P.DOCUMENTATION_MANAGE); return transaction(async (c) => { const docRef = await one(c, 'SELECT documentation_package_id FROM documentation_documents WHERE tenant_id=$1 AND id=$2', [a.tenantId, documentId]); if (!docRef)
        throw new NotFoundException('Документ не найден'); const pkg = await scoped(c, 'documentation_packages', docRef.documentationPackageId, a, true); await scoped(c, 'documentation_documents', documentId, a, true); const w = await scoped(c, 'works', pkg.objectWorkId, a); await objectAccess(c, a, w.objectId, true); const sdoCase = await one(c, 'SELECT package_locked FROM sdo_closing_cases WHERE tenant_id=$1 AND documentation_package_id=$2', [a.tenantId, pkg.id]); const policy = canMutateDocumentationPackageContent({ packageStatus: pkg.status, sdoCaseExists: !!sdoCase, sdoCasePackageLocked: !!sdoCase?.packageLocked }); ensure(policy.allowed, policy.reason!); ensure((d.storageProvider === 'EXTERNAL_REFERENCE') === (d.storageReference !== undefined && d.storageReference !== null), 'Ссылка на документ обязательна только для EXTERNAL_REFERENCE'); const max = await one(c, 'SELECT coalesce(max(version_number),0) AS n FROM documentation_document_versions WHERE tenant_id=$1 AND documentation_document_id=$2', [a.tenantId, documentId]); const version = await insert(c, 'documentation_document_versions', a.tenantId, { documentationDocumentId: documentId, versionNumber: Number(max.n) + 1, storageProvider: d.storageProvider, storageReference: d.storageReference ?? null, comment: d.comment ?? null, createdBy: a.id }); await audit(c, a, 'DocumentationDocumentVersion', version.id, 'CREATE', null, version); return version; }); }
    // Status history (F8.2 Decision Lock): every change is appended, never
    // overwritten — see documentation_package_status_history's own
    // immutable_history() trigger.
    //
    // F8.2.1 Decision 5: the transition graph is now enforced —
    // isDocumentationStatusTransitionAllowed() (packages/domain) is the one
    // allow-list, so a disallowed move (DRAFT -> PRESENTED, any backward or
    // skip-ahead step, anything touching CORRECTING/ACCEPTED_BY_CUSTOMER) is
    // refused before the UPDATE runs, not merely restricted by the CHECK's
    // set membership.
    async changeDocumentationPackageStatus(a: Actor, id: string, d: any) { requirePermission(a, P.DOCUMENTATION_MANAGE); return transaction(async (c) => { const pkg = await scoped(c, 'documentation_packages', id, a, true); const w = await scoped(c, 'works', pkg.objectWorkId, a); await objectAccess(c, a, w.objectId, true); checkVersion(pkg, d.version); ensure(isDocumentationStatusTransitionAllowed(pkg.status, d.status), `Недопустимый переход статуса: ${pkg.status} → ${d.status}`); const n = await one(c, 'UPDATE documentation_packages SET status=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *', [a.tenantId, id, d.status]); await insert(c, 'documentation_package_status_history', a.tenantId, { documentationPackageId: id, fromStatus: pkg.status, toStatus: d.status, changedBy: a.id, comment: d.comment ?? null }); await audit(c, a, 'DocumentationPackage', id, 'STATUS_CHANGE', pkg, n); return n; }); }
    // F8.3-17.2: PTO-only pre-handoff correction — the ACCEPTED_BY_CUSTOMER
    // -> CORRECTING edge for a Package that has never been handed off to SDO
    // (no sdo_closing_cases row exists for it at all yet). Deliberately its
    // own dedicated operation, bypassing isDocumentationStatusTransitionAllowed's
    // own allow-list exactly as registerDocumentationCustomerAcceptance()/
    // handoffDocumentationPackageToSdo() already do for their own edges —
    // never a generic free status transition. The moment any SDO Case row
    // exists for the Package (even one already returned and currently
    // unlocked — "Вернуть в ПТО" was already used once), this operation is
    // refused outright: the only correction-start route from then on is
    // SDO/ADMIN's own returnSdoCaseToPto() ("Вернуть в ПТО"), so the two
    // correction-start routes never overlap and the Case can never be
    // silently bypassed. Old customer acceptance records and their version
    // snapshots are untouched — this never writes to either table.
    async returnDocumentationPackageToCorrection(a: Actor, packageId: string, d: any) { requirePermission(a, P.DOCUMENTATION_MANAGE); if (a.role !== 'PTO')
        throw new ForbiddenException('Вернуть пакет на корректировку до передачи в СДО может только ПТО'); return transaction(async (c) => { const pkg = await scoped(c, 'documentation_packages', packageId, a, true); const w = await scoped(c, 'works', pkg.objectWorkId, a); await objectAccess(c, a, w.objectId, true); checkVersion(pkg, d.version); ensure(pkg.status === 'ACCEPTED_BY_CUSTOMER', 'Вернуть на корректировку можно только пакет в статусе «Принято заказчиком»'); ensure(!await one(c, 'SELECT id FROM sdo_closing_cases WHERE tenant_id=$1 AND documentation_package_id=$2', [a.tenantId, packageId]), 'Пакет уже передан в СДО — используйте «Вернуть в ПТО» из дела СДО'); const n = await one(c, "UPDATE documentation_packages SET status='CORRECTING',version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *", [a.tenantId, packageId]); await insert(c, 'documentation_package_status_history', a.tenantId, { documentationPackageId: packageId, fromStatus: 'ACCEPTED_BY_CUSTOMER', toStatus: 'CORRECTING', changedBy: a.id, comment: d.comment ?? null }); await audit(c, a, 'DocumentationPackage', packageId, 'PRE_HANDOFF_CORRECTION', pkg, n); return n; }); }
    // ---------------------------------------------------------------------
    // F8.3 SDO / Closing. Hangs off documentation_packages/quantity_portions
    // — never the pre-existing executive_packages/sdo_cases/financial_closings
    // pipeline (packageAction()/calculateSdo()/close() above; see
    // infra/008_sdo_closing.sql for why). No method below writes
    // works/quantity_portions/portion_quantity_confirmations: Customer SC
    // confirmations are read-only input to readiness, and the closing
    // amount never feeds ProgressCalculationService/ScheduleStatusService/
    // ObjectHealthService.
    // ---------------------------------------------------------------------
    // F8.3 decisions 8-10: a dedicated, audited external-result
    // registration — deliberately bypassing isDocumentationStatusTransitionAllowed's
    // own allow-list (which has, and keeps, no inbound edge for
    // ACCEPTED_BY_CUSTOMER) so this can never become an ordinary free PTO
    // status transition. documentation_customer_acceptances.documentation_package_version
    // ties the registration to "the relevant presented documentation
    // version" — the package's own version at the moment of registration.
    // F8.3-R01 corrective: DOCUMENTATION_MANAGE alone is too wide a gate here
    // — ADMIN holds it too (superuser grant, packages/domain), but the
    // accepted contract reserves registering the external customer-acceptance
    // fact to PTO specifically ("ONLY PTO may register customer documentation
    // acceptance"). ADMIN keeps every other DOCUMENTATION_MANAGE capability
    // (package/document/version/status management, F8.2.1's own accepted
    // scope) — this is an additional role check on top of the permission
    // bit, not a narrowing of the grant itself.
    // F8.3-R02 corrective: alongside the acceptance row itself, snapshot the
    // actual documentation_document_versions currently presented — one row
    // per Documentation Document the Package holds, its own current highest
    // version_number (DISTINCT ON, the same "latest per group" idiom
    // read-service.ts's own INTERNAL_SC/RP_FACT confirmation lookups already
    // use) — into documentation_customer_acceptance_versions
    // (infra/009_sdo_closing_corrective.sql). This is what lets a later
    // readiness/handoff check tell whether the acceptance is still current
    // (isCustomerAcceptanceSnapshotCurrent, packages/domain) instead of
    // trusting documentation_package_version, which is not a document
    // version at all. Both inserts share this transaction with the
    // acceptance row itself, so the snapshot can never exist partially.
    async registerDocumentationCustomerAcceptance(a: Actor, packageId: string, d: any) { requirePermission(a, P.DOCUMENTATION_MANAGE); if (a.role !== 'PTO')
        throw new ForbiddenException('Согласие заказчика по документации регистрирует только ПТО'); return transaction(async (c) => { const pkg = await scoped(c, 'documentation_packages', packageId, a, true); const w = await scoped(c, 'works', pkg.objectWorkId, a); await objectAccess(c, a, w.objectId, true); checkVersion(pkg, d.version); ensure(pkg.status === 'PRESENTED', 'Согласие заказчика можно зарегистрировать только для предъявленного пакета'); const documentIds = (await rows(c, 'SELECT id FROM documentation_documents WHERE tenant_id=$1 AND documentation_package_id=$2', [a.tenantId, packageId])).map((x: any) => x.id);
        // F8.3-R02b corrective: a partial snapshot (some documents with no
        // version at all) can never prove "what was actually presented" —
        // reject the whole registration before any row is written, rather
        // than silently accepting fewer version links than the Package has
        // documents. A Package with zero documents has nothing to accept either.
        ensure(documentIds.length > 0, 'В пакете нет ни одного документа — согласие заказчика нельзя зарегистрировать'); const latestVersions = await rows(c, 'SELECT DISTINCT ON (documentation_document_id) documentation_document_id,id FROM documentation_document_versions WHERE tenant_id=$1 AND documentation_document_id=ANY($2::uuid[]) ORDER BY documentation_document_id,version_number DESC', [a.tenantId, documentIds]); ensure(latestVersions.length === documentIds.length, 'Не у всех документов пакета есть версия — согласие заказчика нельзя зарегистрировать'); const acceptance = await insert(c, 'documentation_customer_acceptances', a.tenantId, { documentationPackageId: packageId, documentationPackageVersion: pkg.version, acceptedDate: d.acceptedDate, reference: d.reference ?? null, comment: d.comment ?? null, registeredBy: a.id }); for (const v of latestVersions)
        await insert(c, 'documentation_customer_acceptance_versions', a.tenantId, { customerAcceptanceId: acceptance.id, documentationDocumentVersionId: v.id }); const n = await one(c, "UPDATE documentation_packages SET status='ACCEPTED_BY_CUSTOMER',version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *", [a.tenantId, packageId]); await insert(c, 'documentation_package_status_history', a.tenantId, { documentationPackageId: packageId, fromStatus: 'PRESENTED', toStatus: 'ACCEPTED_BY_CUSTOMER', changedBy: a.id, comment: d.comment ?? null }); await audit(c, a, 'DocumentationCustomerAcceptance', acceptance.id, 'CREATE', null, acceptance); return n; }); }
    // F8.3 decisions 3-4,6-13: the one and only path that creates or
    // resumes an SDO Case. First handoff (no case exists yet for this
    // package) creates it — ON_RECONCILIATION, locked, its own first
    // HANDED_OFF history row. Re-handoff after "Вернуть в ПТО" (a case
    // already exists with package_locked=false) re-locks that *same* case
    // and appends a further HANDED_OFF row — "same SDO Case resumes", never
    // a second case (sdo_closing_cases_unique, infra/008_sdo_closing.sql, is
    // the database's own backstop for the same rule). Readiness
    // (resolvePackageSdoReadiness, packages/domain) is re-checked every
    // time, first handoff or re-handoff alike — the same function
    // ReadService.snapshot() computes for what Package Detail/the SDO
    // workspace display, so the two cannot diverge.
    // F8.3-R01 corrective: same reasoning as registerDocumentationCustomerAcceptance
    // above — "Передать в СДО" is explicitly PTO's own action ("PTO explicitly
    // performs handoff"), not anything ADMIN's superuser DOCUMENTATION_MANAGE
    // grant should also open. ADMIN's other package-management capabilities
    // are untouched.
    // F8.3-17.3/18: the one place that resolves a Documentation Package's SDO
    // readiness from raw tables inside an already-open transaction/lock
    // scope. Called identically by handoffDocumentationPackageToSdo() below
    // and by changeSdoClosingStatus()'s own CLOSED revalidation (F8.3-17.3:
    // CLOSED must not accept a Package whose acceptance snapshot has gone
    // stale since handoff) — the same discipline ReadService.snapshot()
    // already keeps in step via the shared pure resolvePackageSdoReadiness()/
    // isCustomerAcceptanceSnapshotCurrent() functions; this is the shared
    // *glue* around them for every write-path caller, never a third,
    // independently-drifting readiness implementation. Callers already hold
    // `pkg` FOR UPDATE (the canonical Package-first lock), so this reads a
    // consistent, race-free snapshot of the Package's own content/acceptance
    // state — no concurrent content mutation or re-acceptance can interleave.
    async resolvePackageReadiness(c: any, a: Actor, pkg: any) {
        const covered = await rows(c, 'SELECT quantity_portion_id FROM documentation_package_portions WHERE tenant_id=$1 AND documentation_package_id=$2', [a.tenantId, pkg.id]); const coveredPortionIds = covered.map((p: any) => p.quantityPortionId); const confirmed = coveredPortionIds.length ? await rows(c, "SELECT DISTINCT portion_id FROM portion_quantity_confirmations WHERE tenant_id=$1 AND portion_id=ANY($2::uuid[]) AND source='CUSTOMER_SC'", [a.tenantId, coveredPortionIds]) : []; const latestAcceptance = await one(c, 'SELECT * FROM documentation_customer_acceptances WHERE tenant_id=$1 AND documentation_package_id=$2 ORDER BY created_at DESC LIMIT 1', [a.tenantId, pkg.id]); const acceptedVersionIds = latestAcceptance ? (await rows(c, 'SELECT documentation_document_version_id FROM documentation_customer_acceptance_versions WHERE tenant_id=$1 AND customer_acceptance_id=$2', [a.tenantId, latestAcceptance.id])).map((x: any) => x.documentationDocumentVersionId) : []; const currentDocumentIds = (await rows(c, 'SELECT id FROM documentation_documents WHERE tenant_id=$1 AND documentation_package_id=$2', [a.tenantId, pkg.id])).map((x: any) => x.id); const currentVersionIds = currentDocumentIds.length ? (await rows(c, 'SELECT DISTINCT ON (documentation_document_id) documentation_document_id,id FROM documentation_document_versions WHERE tenant_id=$1 AND documentation_document_id=ANY($2::uuid[]) ORDER BY documentation_document_id,version_number DESC', [a.tenantId, currentDocumentIds])).map((x: any) => x.id) : []; const hasCustomerAcceptance = pkg.status === 'ACCEPTED_BY_CUSTOMER' && !!latestAcceptance && isCustomerAcceptanceSnapshotCurrent({ acceptedVersionIds, currentDocumentCount: currentDocumentIds.length, currentVersionIds }); return resolvePackageSdoReadiness({ hasCustomerAcceptance, coveredPortionIds, customerScConfirmedPortionIds: confirmed.map((x: any) => x.portionId) });
    }
    async handoffDocumentationPackageToSdo(a: Actor, packageId: string, d: any) { requirePermission(a, P.DOCUMENTATION_MANAGE); if (a.role !== 'PTO')
        throw new ForbiddenException('Передать в СДО может только ПТО'); return transaction(async (c) => { const pkg = await scoped(c, 'documentation_packages', packageId, a, true); const w = await scoped(c, 'works', pkg.objectWorkId, a); await objectAccess(c, a, w.objectId, true); checkVersion(pkg, d.version); const readiness = await this.resolvePackageReadiness(c, a, pkg); ensure(readiness.ready, readiness.missingReasons.join('; ')); const existing = await one(c, 'SELECT * FROM sdo_closing_cases WHERE tenant_id=$1 AND documentation_package_id=$2 FOR UPDATE', [a.tenantId, packageId]); ensure(!existing || !existing.packageLocked, 'Пакет уже передан в СДО'); const sdoCase = existing ? await one(c, 'UPDATE sdo_closing_cases SET package_locked=true,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *', [a.tenantId, existing.id]) : await insert(c, 'sdo_closing_cases', a.tenantId, { objectId: pkg.objectId, objectWorkId: pkg.objectWorkId, documentationPackageId: packageId, createdBy: a.id }); await insert(c, 'sdo_closing_handoff_history', a.tenantId, { sdoClosingCaseId: sdoCase.id, event: 'HANDED_OFF', actorId: a.id, comment: d.comment ?? null }); await audit(c, a, 'SdoClosingCase', sdoCase.id, existing ? 'RE_HANDOFF' : 'HANDOFF', existing ?? null, sdoCase); return sdoCase; }); }
    // F8.3 decision 13: "Вернуть в ПТО" — SDO/ADMIN only (SDO_CASE_MANAGE),
    // never PTO. Unlocks Package composition and moves the package back to
    // CORRECTING (a dedicated transition, bypassing
    // isDocumentationStatusTransitionAllowed exactly as
    // registerDocumentationCustomerAcceptance() already does for its own
    // inbound edge) so PTO can correct composition and re-present. The case
    // itself is retained untouched — its own reconciliation status
    // (sdo_closing_status_history) is a separate axis from package
    // lock/handoff (sdo_closing_handoff_history) and "resumes" exactly
    // where it was on re-handoff, never reset.
    // F8.3-18 corrective: this begins from a Case id, but the canonical lock
    // order is Package, then Case — `caseRef` resolves documentation_package_id
    // with a plain (non-locking) read, the Package is locked FOR UPDATE
    // first, and only then is the Case itself locked/re-read — the exact
    // reverse of what this used to do (Case first, Package second), which
    // was a lock-order inversion against handoffDocumentationPackageToSdo()'s
    // own Package-first order and could deadlock against it.
    async returnSdoCaseToPto(a: Actor, id: string, d: any) { requirePermission(a, P.SDO_CASE_MANAGE); return transaction(async (c) => { const caseRef = await scoped(c, 'sdo_closing_cases', id, a); const pkg = await scoped(c, 'documentation_packages', caseRef.documentationPackageId, a, true); const sdoCase = await scoped(c, 'sdo_closing_cases', id, a, true); const w = await scoped(c, 'works', sdoCase.objectWorkId, a); await objectAccess(c, a, w.objectId); checkVersion(sdoCase, d.version);
        // F8.3-R04 corrective: a CLOSED case must first go through the
        // dedicated CLOSED -> ON_CORRECTION step (changeSdoClosingStatus,
        // mandatory non-empty reason) before it can be returned to PTO — this
        // guard is what actually enforces that "no direct edit" route, since
        // package_locked alone said nothing about the case's own status.
        ensure(sdoCase.status !== 'CLOSED', 'Закрытое дело нельзя вернуть в ПТО напрямую — сначала переведите его на корректировку с указанием причины'); ensure(sdoCase.packageLocked, 'Пакет уже возвращён в ПТО'); ensure(pkg.status === 'ACCEPTED_BY_CUSTOMER', 'Пакет должен находиться в статусе «Принято заказчиком»'); const n = await one(c, 'UPDATE sdo_closing_cases SET package_locked=false,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *', [a.tenantId, id]); await one(c, "UPDATE documentation_packages SET status='CORRECTING',version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *", [a.tenantId, pkg.id]); await insert(c, 'documentation_package_status_history', a.tenantId, { documentationPackageId: pkg.id, fromStatus: 'ACCEPTED_BY_CUSTOMER', toStatus: 'CORRECTING', changedBy: a.id, comment: d.comment ?? null }); await insert(c, 'sdo_closing_handoff_history', a.tenantId, { sdoClosingCaseId: id, event: 'RETURNED_TO_PTO', actorId: a.id, comment: d.comment ?? null }); await audit(c, a, 'SdoClosingCase', id, 'RETURN_TO_PTO', sdoCase, n); return n; }); }
    // F8.3 RESPONSIBILITY: assigned by SDO or ADMIN only (SDO_CASE_MANAGE —
    // PTO holds no such permission: "PTO does NOT assign work inside the
    // SDO department"); the target must be an active SDO user, the same
    // active-role validation createDocumentationPackage() already applies
    // to its own PTO responsible (the repository's existing role model,
    // never a new role name).
    // F8.3-18: Package-first lock order, see returnSdoCaseToPto's own
    // comment — this never writes to the Package, but still takes its lock
    // first so it cannot interleave with a concurrent content mutation/
    // handoff/return, keeping one canonical order throughout F8.3 rather
    // than an exception for this one route.
    async assignSdoResponsible(a: Actor, id: string, d: any) { requirePermission(a, P.SDO_CASE_MANAGE); return transaction(async (c) => { const caseRef = await scoped(c, 'sdo_closing_cases', id, a); await scoped(c, 'documentation_packages', caseRef.documentationPackageId, a, true); const sdoCase = await scoped(c, 'sdo_closing_cases', id, a, true); const w = await scoped(c, 'works', sdoCase.objectWorkId, a); await objectAccess(c, a, w.objectId); checkVersion(sdoCase, d.version); const responsible = await scoped(c, 'users', d.responsibleUserId, a); ensure(responsible.role === 'SDO' && responsible.isActive, 'Назначьте активного сотрудника СДО'); const n = await one(c, 'UPDATE sdo_closing_cases SET responsible_user_id=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *', [a.tenantId, id, d.responsibleUserId]); await audit(c, a, 'SdoClosingCase', id, 'ASSIGN_RESPONSIBLE', sdoCase, n); return n; }); }
    // F8.3 SDO STATUS WORKFLOW: isSdoClosingStatusTransitionAllowed()
    // (packages/domain) is the one allow-list — no free arbitrary
    // transition graph. CLOSED -> ON_CORRECTION requires a non-empty
    // reason; every other transition's reason stays optional. Entering
    // CLOSED requires a total amount and, if any Portion allocations exist,
    // their exact sum (SdoClosingAllocationService, packages/domain).
    // F8.3-18: Package-first lock order (see returnSdoCaseToPto's comment) —
    // `pkg` is what makes the F8.3-17.3 CLOSED revalidation below possible
    // without a second, separately-ordered lookup.
    async changeSdoClosingStatus(a: Actor, id: string, d: any) { requirePermission(a, P.SDO_CASE_MANAGE); return transaction(async (c) => { const caseRef = await scoped(c, 'sdo_closing_cases', id, a); const pkg = await scoped(c, 'documentation_packages', caseRef.documentationPackageId, a, true); const sdoCase = await scoped(c, 'sdo_closing_cases', id, a, true); const w = await scoped(c, 'works', sdoCase.objectWorkId, a); await objectAccess(c, a, w.objectId); checkVersion(sdoCase, d.version);
        // F8.3-R03 corrective: while custody is with PTO (package_locked=false,
        // set by returnSdoCaseToPto()), no SDO operational work may progress —
        // package_locked alone did nothing to stop it before this guard.
        // Re-handoff (handoffDocumentationPackageToSdo()) re-locks the same
        // case and restores this.
        ensure(sdoCase.packageLocked, 'Дело приостановлено: пакет возвращён в ПТО'); ensure(isSdoClosingStatusTransitionAllowed(sdoCase.status, d.status), `Недопустимый переход статуса: ${sdoCase.status} → ${d.status}`); ensure(sdoCase.status !== 'CLOSED' || !!d.reason?.trim(), 'Укажите причину возврата закрытого дела на корректировку'); if (d.status === 'CLOSED') {
        // F8.3-17.3 corrective: revalidate the SAME readiness this Case's own
        // handoff already required, under the Package lock this method now
        // holds — a document/version change (or a re-acceptance gone stale)
        // after handoff must not let CLOSED go through on data that no
        // longer represents what was actually accepted. Reuses
        // resolvePackageReadiness() above — never a third, independent
        // readiness computation.
        const readiness = await this.resolvePackageReadiness(c, a, pkg);
        ensure(readiness.ready, 'Закрытие невозможно: несогласованное состояние документации — ' + readiness.missingReasons.join('; '));
        // F8.3-19: CLOSED validates against ACTIVE allocations only — a
        // cancelled allocation (cancelled_at set) no longer counts toward
        // either "no allocations, total alone is enough" or the exact-sum rule.
        const allocations = await rows(c, 'SELECT amount FROM sdo_closing_portion_allocations WHERE tenant_id=$1 AND sdo_closing_case_id=$2 AND cancelled_at IS NULL', [a.tenantId, id]);
        const closeCheck = new SdoClosingAllocationService().canClose(sdoCase.totalAmount, allocations);
        ensure(closeCheck.allowed, closeCheck.reason ?? 'Закрытие невозможно');
    } const n = await one(c, "UPDATE sdo_closing_cases SET status=$3,closed_at=CASE WHEN $3='CLOSED' THEN now() ELSE NULL END,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *", [a.tenantId, id, d.status]); await insert(c, 'sdo_closing_status_history', a.tenantId, { sdoClosingCaseId: id, fromStatus: sdoCase.status, toStatus: d.status, reason: d.reason ?? null, changedBy: a.id }); await audit(c, a, 'SdoClosingCase', id, 'STATUS_CHANGE', sdoCase, n); return n; }); }
    // F8.3 CLOSING AMOUNT: total amount only — never payment, invoice,
    // accounting or KS-2/KS-3. History is append-only
    // (sdo_closing_amount_history, immutable by trigger — "Do not overwrite
    // history... Record the prior and new value with actor and timestamp").
    // A CLOSED case refuses this outright: it must first go back to
    // ON_CORRECTION via changeSdoClosingStatus() — "must not allow silent
    // amount editing".
    // F8.3-18: Package-first lock order, see returnSdoCaseToPto's own comment.
    async setSdoClosingAmount(a: Actor, id: string, d: any) { requirePermission(a, P.SDO_CASE_MANAGE); return transaction(async (c) => { const caseRef = await scoped(c, 'sdo_closing_cases', id, a); await scoped(c, 'documentation_packages', caseRef.documentationPackageId, a, true); const sdoCase = await scoped(c, 'sdo_closing_cases', id, a, true); const w = await scoped(c, 'works', sdoCase.objectWorkId, a); await objectAccess(c, a, w.objectId); checkVersion(sdoCase, d.version);
        // F8.3-R03 corrective: see changeSdoClosingStatus's own comment.
        ensure(sdoCase.packageLocked, 'Дело приостановлено: пакет возвращён в ПТО'); ensure(sdoCase.status !== 'CLOSED', 'Дело закрыто. Верните на корректировку, чтобы изменить сумму'); await insert(c, 'sdo_closing_amount_history', a.tenantId, { sdoClosingCaseId: id, previousAmount: sdoCase.totalAmount ?? null, newAmount: d.amount, changedBy: a.id }); const n = await one(c, 'UPDATE sdo_closing_cases SET total_amount=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *', [a.tenantId, id, d.amount]); await audit(c, a, 'SdoClosingCase', id, 'SET_AMOUNT', sdoCase, n); return n; }); }
    // F8.3-R05 corrective, extended by F8.3-19: Portion allocation now has a
    // correction path — set/update the existing allocation for that Portion
    // (never a second row for the same Portion: sdo_closing_portion_allocations_unique
    // remains the database's own backstop, now serving the "at most one
    // current row per Portion" rule rather than "create-only"), with the
    // prior value preserved append-only in sdo_closing_portion_allocation_history
    // (previous_amount NULL exactly the first time, the same convention
    // sdo_closing_amount_history already uses for the case's own total).
    // `operation` distinguishes CREATE (no existing row) from CORRECT (an
    // active row's amount changes) from RESTORE (a previously *cancelled*
    // row — see cancelSdoClosingPortionAllocation() below — becomes active
    // again with a fresh amount); the write itself is identical for all
    // three, always clearing cancelled_at/cancelled_by. A Portion outside
    // the linked Documentation Package's own coverage is still rejected —
    // the same "does this cross-entity reference actually belong together"
    // discipline linkDocumentationPackagePortion() itself applies to its own
    // cross-table rule. F8.3-R03: no allocation work while custody is with
    // PTO (package_locked=false). F8.3-R04/pre-existing: a CLOSED case must
    // return to ON_CORRECTION first, exactly as setSdoClosingAmount()
    // already requires for the total amount. F8.3-18: Package-first lock
    // order, see returnSdoCaseToPto's own comment.
    async setSdoClosingPortionAllocation(a: Actor, id: string, d: any) { requirePermission(a, P.SDO_CASE_MANAGE); return transaction(async (c) => { const caseRef = await scoped(c, 'sdo_closing_cases', id, a); await scoped(c, 'documentation_packages', caseRef.documentationPackageId, a, true); const sdoCase = await scoped(c, 'sdo_closing_cases', id, a, true); const w = await scoped(c, 'works', sdoCase.objectWorkId, a); await objectAccess(c, a, w.objectId); ensure(sdoCase.packageLocked, 'Дело приостановлено: пакет возвращён в ПТО'); ensure(sdoCase.status !== 'CLOSED', 'Дело закрыто. Верните на корректировку, чтобы изменить распределение'); ensure(!!await one(c, 'SELECT id FROM documentation_package_portions WHERE tenant_id=$1 AND documentation_package_id=$2 AND quantity_portion_id=$3', [a.tenantId, sdoCase.documentationPackageId, d.quantityPortionId]), 'Участок не входит в состав пакета'); const existing = await one(c, 'SELECT * FROM sdo_closing_portion_allocations WHERE tenant_id=$1 AND sdo_closing_case_id=$2 AND quantity_portion_id=$3 FOR UPDATE', [a.tenantId, id, d.quantityPortionId]); if (existing)
        checkVersion(existing, d.version); const operation = !existing ? 'CREATE' : existing.cancelledAt ? 'RESTORE' : 'CORRECT'; await insert(c, 'sdo_closing_portion_allocation_history', a.tenantId, { sdoClosingCaseId: id, quantityPortionId: d.quantityPortionId, previousAmount: existing ? existing.amount : null, newAmount: d.amount, operation, changedBy: a.id }); const allocation = existing ? await one(c, 'UPDATE sdo_closing_portion_allocations SET amount=$3,cancelled_at=NULL,cancelled_by=NULL,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *', [a.tenantId, existing.id, d.amount]) : await insert(c, 'sdo_closing_portion_allocations', a.tenantId, { sdoClosingCaseId: id, quantityPortionId: d.quantityPortionId, amount: d.amount, createdBy: a.id }); await audit(c, a, 'SdoClosingPortionAllocation', allocation.id, operation, existing ?? null, allocation); return allocation; }); }
    // F8.3-19: explicit audited cancellation — the accepted semantics are
    // "Portion allocation is OPTIONAL", so a mistaken allocation must be able
    // to return to "no active allocation for this Portion" while preserving
    // history. Not solved with amount=0: a zero-valued row would still be a
    // present allocation and could wrongly force the exact-sum rule in
    // changeSdoClosingStatus() above. The row is marked cancelled, never
    // deleted, and sdo_closing_portion_allocations_unique still guarantees
    // at most one row per (Case, Portion) — cancelling never creates a
    // second row, and setSdoClosingPortionAllocation() above is what
    // reactivates (RESTOREs) this exact row later if needed.
    async cancelSdoClosingPortionAllocation(a: Actor, id: string, quantityPortionId: string, d: any) { requirePermission(a, P.SDO_CASE_MANAGE); return transaction(async (c) => { const caseRef = await scoped(c, 'sdo_closing_cases', id, a); await scoped(c, 'documentation_packages', caseRef.documentationPackageId, a, true); const sdoCase = await scoped(c, 'sdo_closing_cases', id, a, true); const w = await scoped(c, 'works', sdoCase.objectWorkId, a); await objectAccess(c, a, w.objectId); ensure(sdoCase.packageLocked, 'Дело приостановлено: пакет возвращён в ПТО'); ensure(sdoCase.status !== 'CLOSED', 'Дело закрыто. Верните на корректировку, чтобы изменить распределение'); const existing = await one(c, 'SELECT * FROM sdo_closing_portion_allocations WHERE tenant_id=$1 AND sdo_closing_case_id=$2 AND quantity_portion_id=$3 FOR UPDATE', [a.tenantId, id, quantityPortionId]); ensure(!!existing, 'Для этого участка нет распределения суммы'); ensure(!existing.cancelledAt, 'Распределение уже отменено'); checkVersion(existing, d.version); await insert(c, 'sdo_closing_portion_allocation_history', a.tenantId, { sdoClosingCaseId: id, quantityPortionId, previousAmount: existing.amount, newAmount: null, operation: 'CANCEL', changedBy: a.id }); const allocation = await one(c, 'UPDATE sdo_closing_portion_allocations SET cancelled_at=now(),cancelled_by=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *', [a.tenantId, existing.id, a.id]); await audit(c, a, 'SdoClosingPortionAllocation', allocation.id, 'CANCEL', existing, allocation); return allocation; }); }
}
