import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { pool, rows, one } from './db';
import { Actor, requirePermission, objectAccess } from './security';
import { Permission as P, ProgressCalculationService, ScheduleStatusService, PotentialClosingService, ObjectHealthService, PortionCompletionService, defaultRisk, resolveInternalScAccepted, resolveActualQuantity } from '../../../packages/domain';
@Injectable()
export class ReadService {
    async snapshot(a: Actor, filters: { contractorId?: string } = {}) {
        requirePermission(a, P.OBJECT_VIEW);
        const t = a.tenantId;
        const params: any[] = [t]; let objectFilter = '';
        if (a.role === 'PROJECT_MANAGER') { params.push(a.id); objectFilter += ` AND o.project_manager_id=$${params.length}`; }
        if (a.role === 'CONTRACTOR_VIEWER') { params.push(a.contractorId ?? null); objectFilter += ` AND EXISTS(SELECT 1 FROM object_contractors_active oc WHERE oc.tenant_id=o.tenant_id AND oc.object_id=o.id AND oc.contractor_id=$${params.length})`; }
        if (filters.contractorId) { params.push(filters.contractorId); objectFilter += ` AND EXISTS(SELECT 1 FROM object_contractors_active oc2 WHERE oc2.tenant_id=o.tenant_id AND oc2.object_id=o.id AND oc2.contractor_id=$${params.length})`; }
        const objects = await rows(pool, 'SELECT o.*,u.name AS responsible FROM objects o JOIN users u ON u.tenant_id=o.tenant_id AND u.id=o.project_manager_id WHERE o.tenant_id=$1' + objectFilter + ' ORDER BY o.name', params);
        const ids = objects.map(o => o.id);
        // Active object_contractors (object_contractors_active — единый read source,
        // infra/005) — current assignment, used for objectList.contractorIds/
        // contractors below. Distinct from works.contractor_id (historical/actual
        // attribution) and from CONTRACTOR_VIEWER's own-work filter above, which is
        // unaffected by this and stays keyed off works directly.
        const activeAssignments = await rows(pool, 'SELECT oc.object_id,oc.contractor_id,c.name AS contractor_name FROM object_contractors_active oc JOIN contractors c ON c.id=oc.contractor_id AND c.tenant_id=oc.tenant_id WHERE oc.tenant_id=$1 AND oc.object_id=ANY($2::uuid[])', [t, ids]);
        const works = await rows(pool, `SELECT w.*,t.requires_inspection,t.requires_materials,t.category_id,c.name AS contractor,u.name AS responsible,(SELECT max(reported_at) FROM work_progress p WHERE p.tenant_id=w.tenant_id AND p.object_work_id=w.id) AS last_reported_at FROM works w JOIN work_types t ON t.id=w.work_type_id AND t.tenant_id=w.tenant_id JOIN contractors c ON c.id=w.contractor_id AND c.tenant_id=w.tenant_id JOIN users u ON u.id=w.responsible_user_id AND u.tenant_id=w.tenant_id WHERE w.tenant_id=$1 AND w.object_id=ANY($2::uuid[]) ${a.role === 'CONTRACTOR_VIEWER' ? 'AND w.contractor_id=$3' : ''} ORDER BY w.planned_start_date,w.name`, a.role === 'CONTRACTOR_VIEWER' ? [t, ids, a.contractorId ?? null] : [t, ids]);
        const inspections = await rows(pool, 'SELECT * FROM inspections WHERE tenant_id=$1 AND object_id=ANY($2::uuid[]) ORDER BY created_at DESC', [t, ids]);
        const issues = await rows(pool, 'SELECT x.*,i.object_id,i.object_work_id,u.name AS responsible FROM issues x JOIN inspections i ON i.id=x.inspection_id AND i.tenant_id=x.tenant_id JOIN users u ON u.id=x.responsible_user_id AND u.tenant_id=x.tenant_id WHERE x.tenant_id=$1 AND i.object_id=ANY($2::uuid[])', [t, ids]);
        const packages = await rows(pool, 'SELECT * FROM executive_packages WHERE tenant_id=$1 AND object_id=ANY($2::uuid[])', [t, ids]);
        const documents = await rows(pool, 'SELECT * FROM executive_documents WHERE tenant_id=$1 AND object_id=ANY($2::uuid[])', [t, ids]);
        const sdo = await rows(pool, 'SELECT * FROM sdo_cases WHERE tenant_id=$1 AND object_id=ANY($2::uuid[])', [t, ids]);
        const closings = await rows(pool, 'SELECT * FROM financial_closings WHERE tenant_id=$1 AND object_id=ANY($2::uuid[])', [t, ids]);
        // Фото приёмок (inspection_photos) — добавлено для вкладки «Фото» карточки
        // объекта (перенос сильной стороны construction-erp, ХАРДЕНИНГ этой
        // итерации): раньше строился только POST-эндпоинт загрузки, без
        // возможности прочитать уже загруженные фото. Список берём по тем же
        // inspections, что уже выбраны выше — без новых прав/эндпоинтов.
        const photos = await rows(pool, 'SELECT * FROM inspection_photos WHERE tenant_id=$1 AND inspection_id=ANY($2::uuid[])', [t, inspections.map(i => i.id)]);
        const contractors = await rows(pool, 'SELECT * FROM contractors WHERE tenant_id=$1' + (a.role === 'CONTRACTOR_VIEWER' ? ' AND id=$2' : ''), a.role === 'CONTRACTOR_VIEWER' ? [t, a.contractorId ?? null] : [t]);
        const dependencies = await rows(pool, 'SELECT d.* FROM work_dependencies d JOIN works w ON w.id=d.successor_work_id AND w.tenant_id=d.tenant_id WHERE d.tenant_id=$1 AND w.object_id=ANY($2::uuid[])', [t, ids]);
        // F8.1 Production Execution + Construction Control Foundation. Scoped by
        // work id, not directly by object id — work_execution_units joins to
        // works, quantity_portions/portion_quantity_confirmations chain from
        // there. Omitted from the CONTRACTOR_VIEWER branch below, the same
        // treatment inspections/issues already get for that role.
        const workIds = works.map(w => w.id);
        const executionUnits = await rows(pool, 'SELECT * FROM work_execution_units WHERE tenant_id=$1 AND object_work_id=ANY($2::uuid[])', [t, workIds]);
        const unitIds = executionUnits.map(u => u.id);
        const executionUnitLayers = await rows(pool, 'SELECT * FROM execution_unit_layers WHERE tenant_id=$1 AND execution_unit_id=ANY($2::uuid[]) ORDER BY sort_order', [t, unitIds]);
        const portions = await rows(pool, 'SELECT * FROM quantity_portions WHERE tenant_id=$1 AND execution_unit_id=ANY($2::uuid[])', [t, unitIds]);
        const portionConfirmations = await rows(pool, 'SELECT * FROM portion_quantity_confirmations WHERE tenant_id=$1 AND portion_id=ANY($2::uuid[]) ORDER BY recorded_at', [t, portions.map(p => p.id)]);
        const saved = await one(pool, 'SELECT * FROM risk_settings WHERE tenant_id=$1', [t]);
        const risk = { ...defaultRisk, ...saved };
        const today = new Date();
        const age = (d: any) => d ? Math.max(0, Math.floor((+today - +new Date(d)) / 86400000)) : 0;
        // F8.1 decision 8: acceptance aggregates from portions, never
        // any-portion-accepted, and (F8.1-02/03 corrective, Independent Review
        // not accepted first pass) never any-created-portion-accepted either —
        // computed once per work here, via the same resolveInternalScAccepted()
        // ProductionService.transition() now also calls (packages/domain), so
        // the read model's blockers and a real mutation's own gate cannot
        // disagree about the same work. A work with no execution units keeps
        // today's exact .some() computation, portion_id IS NULL — decision 6:
        // Internal SC completion and Customer SC acceptance are kept apart as
        // two separately-named results, never merged into one generic
        // "accepted".
        const latestConfirmation = (portionId: string, source: string) => { const own = portionConfirmations.filter(c => c.portionId === portionId && c.source === source); return own.length ? own[own.length - 1] : undefined; };
        const portionAccepted = (portionId: string, inspectionType: string) => inspections.some(i => i.portionId === portionId && i.inspectionType === inspectionType && i.status === 'ACCEPTED');
        const scCompletion = new PortionCompletionService();
        // Each portion's own current figures (latest per source — RP fact never
        // overwritten by either SC figure, the three stay separately readable)
        // plus whether it has a real ACCEPTED inspection of each type (an
        // acceptance boolean must come from inspections.status, not merely from
        // a confirmation row existing). Each unit's actualQuantity is derived,
        // never stored (F8.1 decision 2) — the sum of its portions' own latest
        // RP fact, so a unit with quantity not yet portioned under-reports
        // rather than silently borrowing the work's own actualQuantity.
        // internalScStatus/customerScStatus (F8.1-02 corrective) are the
        // literal PARTIAL/COMPLETE/NONE distinction the Independent Review
        // required be visible, not merely correctly computed internally.
        const portionsWithStatus = portions.map(p => ({ ...p, rpFactQuantity: latestConfirmation(p.id, 'RP_FACT')?.quantity ?? null, internalScAccepted: portionAccepted(p.id, 'INTERNAL_SC'), internalScConfirmedQuantity: latestConfirmation(p.id, 'INTERNAL_SC')?.quantity ?? null, customerScAccepted: portionAccepted(p.id, 'CUSTOMER_SC'), customerScConfirmedQuantity: latestConfirmation(p.id, 'CUSTOMER_SC')?.quantity ?? null }));
        const executionUnitsWithTotals = executionUnits.map(u => { const ownPortions = portionsWithStatus.filter(p => p.executionUnitId === u.id); return { ...u, actualQuantity: ownPortions.reduce((s, p) => s.add(p.rpFactQuantity ?? 0), new Decimal(0)).toFixed(4), internalScStatus: scCompletion.unitCoverage(u.plannedQuantity, ownPortions.map(p => ({ plannedQuantity: p.plannedQuantity, accepted: p.internalScAccepted }))), customerScStatus: scCompletion.unitCoverage(u.plannedQuantity, ownPortions.map(p => ({ plannedQuantity: p.plannedQuantity, accepted: p.customerScAccepted }))) }; });
        // F8.1-04 corrective (Independent Review, not accepted first pass): a
        // work with any execution unit treats them as its sole production fact
        // source — resolveActualQuantity() (packages/domain), the same function
        // ProductionService.transition() now calls, ignores works.actual_quantity
        // entirely once a unit exists (progress() itself now refuses to write it
        // for such a work, so it would only ever be a stale zero here).
        // lastReportedAt gets the equivalent treatment so buildW01ViewModel's
        // `factReported` stays a true statement instead of freezing at "never
        // reported" the moment a work adopts the unit/portion model. A work with
        // no execution units is unaffected — both read exactly its own row.
        const productionFactByWork = new Map<string, { actualQuantity: string; lastReportedAt: string | null }>(works.map(w => {
            const units = executionUnitsWithTotals.filter(u => u.objectWorkId === w.id);
            if (!units.length)
                return [w.id, { actualQuantity: w.actualQuantity, lastReportedAt: w.lastReportedAt }];
            const ownPortionIds = new Set(portionsWithStatus.filter(p => units.some(u => u.id === p.executionUnitId)).map(p => p.id));
            const factTimestamps = portionConfirmations.filter(c => c.source === 'RP_FACT' && ownPortionIds.has(c.portionId)).map(c => c.recordedAt).sort();
            return [w.id, { actualQuantity: resolveActualQuantity(w.actualQuantity, units.map(u => u.actualQuantity)), lastReportedAt: factTimestamps.length ? factTimestamps[factTimestamps.length - 1] : null }];
        }));
        const workScStatus = new Map<string, { internalScComplete: boolean; customerScAccepted: boolean | null }>(works.map(w => {
            const units = executionUnitsWithTotals.filter(u => u.objectWorkId === w.id);
            const wholeWorkAccepted = inspections.some(i => i.objectWorkId === w.id && i.portionId === null && i.inspectionType === 'INTERNAL_SC' && i.status === 'ACCEPTED');
            if (!units.length)
                return [w.id, { internalScComplete: wholeWorkAccepted, customerScAccepted: null }];
            const shape = units.map(u => ({ plannedQuantity: u.plannedQuantity, portions: portionsWithStatus.filter(p => p.executionUnitId === u.id).map(p => ({ plannedQuantity: p.plannedQuantity, internalScAccepted: p.internalScAccepted, customerScAccepted: p.customerScAccepted })) }));
            return [w.id, { internalScComplete: resolveInternalScAccepted(wholeWorkAccepted, shape), customerScAccepted: scCompletion.customerScAccepted(shape) }];
        }));
        const enriched = works.map(w => { const accepted = workScStatus.get(w.id)!.internalScComplete; const customerScAccepted = workScStatus.get(w.id)!.customerScAccepted; const productionFact = productionFactByWork.get(w.id)!; const actualQuantity = productionFact.actualQuantity; const lastReportedAt = productionFact.lastReportedAt; const docsReady = packages.some(p => p.objectWorkId === w.id && ['READY', 'TRANSFERRED_TO_SDO'].includes(p.status)); const cases = sdo.filter(s => s.objectWorkId === w.id); const closed = closings.filter(f => cases.some(s => s.id === f.sdoCaseId)).reduce((x, f) => x.add(f.amount), new Decimal(0)).toFixed(2); const financial = new PotentialClosingService().calculate([{ cost: w.estimatedCost, actual: actualQuantity, planned: w.plannedQuantity, closed, accepted, requiresInspection: w.requiresInspection, docsReady, transferred: cases.length > 0, calculated: cases.some(s => ['CALCULATED', 'READY_TO_CLOSE', 'CLOSED'].includes(s.status)) }]); const status = new ScheduleStatusService().calculate(w.plannedStartDate, w.plannedFinishDate, (!lastReportedAt && Number(actualQuantity) === 0) ? null : new ProgressCalculationService().calculate(actualQuantity, w.plannedQuantity), today, risk); const blockers = dependencies.filter(d => d.successorWorkId === w.id).flatMap(d => { const before = works.find(x => x.id === d.predecessorWorkId); const beforeActual = before ? productionFactByWork.get(before.id)!.actualQuantity : null; const reasons = []; if (before && Number(beforeActual) < Number(before.plannedQuantity))
            reasons.push(`${before.name}: не завершена`); if (d.requiresAcceptance && !workScStatus.get(d.predecessorWorkId)?.internalScComplete)
            reasons.push('Нет допуска строительного контроля'); if (issues.some(i => i.objectWorkId === d.predecessorWorkId && i.severity === 'CRITICAL' && i.status !== 'CLOSED'))
            reasons.push('Критическое замечание'); if (d.requiresDocument && !documents.some(x => x.objectWorkId === d.predecessorWorkId && x.status === 'APPROVED'))
            reasons.push('Не подтверждён обязательный документ'); return reasons; }); return { ...w, ...status, actualQuantity, lastReportedAt, accepted, customerScAccepted, docsReady, closed, financial, blockers, stale: !lastReportedAt || age(lastReportedAt) > Number(risk.staleDays) }; });
        const attentionRequired: any[] = [];
        for (const w of enriched) {
            const o = objects.find(x => x.id === w.objectId);
            const add = (title: string, reason: string, severity: string, days: number, action: string) => attentionRequired.push({ entityType: 'Work', entityId: w.id, objectId: w.objectId, objectName: o.name, contractor: w.contractor, title, reason, severity, daysOverdue: days, moneyImpact: w.financial.potential, responsible: w.responsible, recommendedAction: action });
            if (w.scheduleStatus === 'RED' || w.scheduleStatus === 'YELLOW')
                add('Отставание работ', `Факт ${w.actualProgress.toFixed(0)}%, план ${w.plannedProgress.toFixed(0)}%`, w.scheduleStatus, w.delayDays, 'РП: уточнить ресурсы и план восстановления');
            if (w.blockers.length)
                add('Технологическая блокировка', w.blockers.join('; '), 'RED', w.delayDays, 'Закрыть замечания и получить допуск СК');
            if (w.stale && w.actualProgress < 100)
                add('Нет актуального факта', 'Требуется отчёт РП', 'GRAY', age(w.lastReportedAt ?? w.createdAt), 'Внести выполненный физический объём');
        }
        for (const i of issues.filter(i => i.status !== 'CLOSED')) {
            const w = enriched.find(w => w.id === i.objectWorkId);
            if (w)
                attentionRequired.push({ entityType: 'Issue', entityId: i.id, objectId: i.objectId, objectName: objects.find(o => o.id === i.objectId)?.name, contractor: w.contractor, title: i.title, reason: 'Замечание строительного контроля', severity: i.severity === 'CRITICAL' ? 'RED' : 'YELLOW', daysOverdue: age(i.dueDate), moneyImpact: w.financial.potential, responsible: i.responsible, recommendedAction: 'Устранить и предъявить на повторную проверку' });
        }
        for (const p of packages.filter(p => p.status === 'READY' && age(p.completedAt) > Number(risk.ptoDays))) {
            const w = enriched.find(w => w.id === p.objectWorkId);
            if (w)
                attentionRequired.push({ entityType: 'Package', entityId: p.id, objectId: p.objectId, objectName: objects.find(o => o.id === p.objectId)?.name, contractor: w.contractor, title: 'Готовая ИД не передана', reason: 'Задержка ПТО', severity: 'YELLOW', daysOverdue: age(p.completedAt) - Number(risk.ptoDays), moneyImpact: w.financial.potential, responsible: 'ПТО', recommendedAction: 'Передать проверенный пакет в СДО' });
        }
        for (const s of sdo.filter(s => s.status !== 'CLOSED' && age(s.ptoTransferredAt) > Number(risk.sdoDays))) {
            const w = enriched.find(w => w.id === s.objectWorkId);
            if (w)
                attentionRequired.push({ entityType: 'SdoCase', entityId: s.id, objectId: s.objectId, objectName: objects.find(o => o.id === s.objectId)?.name, contractor: w.contractor, title: 'Задержка в СДО', reason: 'Не завершено осмечивание/закрытие', severity: 'YELLOW', daysOverdue: age(s.ptoTransferredAt) - Number(risk.sdoDays), moneyImpact: w.financial.potential, responsible: 'СДО', recommendedAction: 'Получить расчёт и зафиксировать закрытие' });
        }
        const objectList = objects.map(o => { const ws = enriched.filter(w => w.objectId === o.id); const cost = ws.reduce((s, w) => s + Number(w.estimatedCost), 0); const weighted = (field: string) => cost ? ws.reduce((s, w) => s + Number(w.estimatedCost) * (w[field] ?? 0), 0) / cost : ws.length ? ws.reduce((s, w) => s + (w[field] ?? 0), 0) / ws.length : null; const sum = (field: string) => ws.reduce((s, w) => s.add(w.financial[field]), new Decimal(0)).toFixed(2); const active = activeAssignments.filter(x => x.objectId === o.id); return { ...o, contractorIds: active.map(x => x.contractorId), contractors: active.map(x => x.contractorName), actualProgress: weighted('actualProgress'), plannedProgress: weighted('plannedProgress'), closed: sum('closed'), potential: sum('potential'), healthStatus: new ObjectHealthService().calculate({ statuses: ws.map(w => w.scheduleStatus), criticalIssues: issues.filter(i => i.objectId === o.id && i.severity === 'CRITICAL' && i.status !== 'CLOSED').length, overdueIssues: issues.filter(i => i.objectId === o.id && i.status !== 'CLOSED' && age(i.dueDate) > 0).length, stale: ws.some(w => w.stale && w.actualProgress < 100), blocked: ws.some(w => w.blockers.length && w.delayDays > 0), ptoLate: attentionRequired.some(x => x.objectId === o.id && x.entityType === 'Package'), sdoLate: attentionRequired.some(x => x.objectId === o.id && x.entityType === 'SdoCase') }) }; });
        const total = (field: string) => objectList.reduce((s, o) => s.add(o[field]), new Decimal(0)).toFixed(2);
        const monthly = await rows(pool, 'SELECT * FROM monthly_plans WHERE tenant_id=$1 AND object_id=ANY($2::uuid[])', [t, ids]);
        const period = today.toISOString().slice(0, 7);
        const closedThisMonth = closings.filter(f => f.period === period).reduce((s, f) => s.add(f.amount), new Decimal(0));
        const available = sdo.filter(s => ['CALCULATED', 'READY_TO_CLOSE'].includes(s.status)).reduce((sum, s) => sum.add(Decimal.max(0, new Decimal(s.acceptedClosingValue ?? 0).minus(closings.filter(f => f.sdoCaseId === s.id).reduce((v, f) => v.add(f.amount), new Decimal(0))))), new Decimal(0));
        const dashboard = { activeObjects: objects.filter(o => !['ARCHIVED', 'COMPLETED'].includes(o.status)).length, ...Object.fromEntries(['GREEN', 'YELLOW', 'RED', 'GRAY'].map(x => [x.toLowerCase() + 'Objects', objectList.filter(o => o.healthStatus === x).length])), delayedWorks: enriched.filter(w => w.delayDays > 0).length, openInspectionIssues: issues.filter(i => i.status !== 'CLOSED').length, criticalInspectionIssues: issues.filter(i => i.status !== 'CLOSED' && i.severity === 'CRITICAL').length, awaitingInspection: inspections.filter(i => ['WAITING', 'REINSPECTION'].includes(i.status)).length, ptoBacklog: enriched.filter(w => w.accepted && !w.docsReady).length, sdoBacklog: sdo.filter(s => s.status !== 'CLOSED').length, plannedClosing: monthly.filter(p => p.period === period).reduce((s, p) => s.add(p.plannedValue), new Decimal(0)).toFixed(2), closedThisMonth: closedThisMonth.toFixed(2), potentialClosing: total('potential'), forecastClosing: closedThisMonth.add(available).toFixed(2), readyToClose: available.toFixed(2), buckets: Object.fromEntries(['notAccepted', 'pto', 'ready', 'sdo', 'calculated'].map(k => [k, enriched.reduce((s, w) => s.add(w.financial.buckets[k]), new Decimal(0)).toFixed(2)])), attentionRequired: attentionRequired.sort((a, b) => ({ RED: 0, YELLOW: 1, GRAY: 2 }[a.severity] - { RED: 0, YELLOW: 1, GRAY: 2 }[b.severity]) || b.daysOverdue - a.daysOverdue) };
        if (a.role === 'CONTRACTOR_VIEWER') {
            const allowed = new Set(enriched.map(w => w.id));
            return { objects: objectList.map(({ contractValue, closed, potential, ...o }) => o), works: enriched.map(({ estimatedCost, closed, financial, ...w }) => w), contractors, dependencies: dependencies.filter(d => allowed.has(d.successorWorkId) && allowed.has(d.predecessorWorkId)) };
        }
        return { objects: objectList, works: enriched, inspections, issues, packages, documents, sdo, closings, contractors, dependencies, dashboard, monthlyPlans: monthly, risk, photos, executionUnits: executionUnitsWithTotals, executionUnitLayers, portions: portionsWithStatus, portionConfirmations };
    }
}
