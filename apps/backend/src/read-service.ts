import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { pool, rows, one } from './db';
import { Actor, requirePermission, objectAccess } from './security';
import { Permission as P, ProgressCalculationService, ScheduleStatusService, PotentialClosingService, ObjectHealthService, defaultRisk } from '../../../packages/domain';
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
        const saved = await one(pool, 'SELECT * FROM risk_settings WHERE tenant_id=$1', [t]);
        const risk = { ...defaultRisk, ...saved };
        const today = new Date();
        const age = (d: any) => d ? Math.max(0, Math.floor((+today - +new Date(d)) / 86400000)) : 0;
        const enriched = works.map(w => { const accepted = inspections.some(i => i.objectWorkId === w.id && i.status === 'ACCEPTED'); const docsReady = packages.some(p => p.objectWorkId === w.id && ['READY', 'TRANSFERRED_TO_SDO'].includes(p.status)); const cases = sdo.filter(s => s.objectWorkId === w.id); const closed = closings.filter(f => cases.some(s => s.id === f.sdoCaseId)).reduce((x, f) => x.add(f.amount), new Decimal(0)).toFixed(2); const financial = new PotentialClosingService().calculate([{ cost: w.estimatedCost, actual: w.actualQuantity, planned: w.plannedQuantity, closed, accepted, requiresInspection: w.requiresInspection, docsReady, transferred: cases.length > 0, calculated: cases.some(s => ['CALCULATED', 'READY_TO_CLOSE', 'CLOSED'].includes(s.status)) }]); const status = new ScheduleStatusService().calculate(w.plannedStartDate, w.plannedFinishDate, (!w.lastReportedAt && Number(w.actualQuantity) === 0) ? null : new ProgressCalculationService().calculate(w.actualQuantity, w.plannedQuantity), today, risk); const blockers = dependencies.filter(d => d.successorWorkId === w.id).flatMap(d => { const before = works.find(x => x.id === d.predecessorWorkId); const reasons = []; if (before && Number(before.actualQuantity) < Number(before.plannedQuantity))
            reasons.push(`${before.name}: не завершена`); if (d.requiresAcceptance && !inspections.some(i => i.objectWorkId === d.predecessorWorkId && i.status === 'ACCEPTED'))
            reasons.push('Нет допуска строительного контроля'); if (issues.some(i => i.objectWorkId === d.predecessorWorkId && i.severity === 'CRITICAL' && i.status !== 'CLOSED'))
            reasons.push('Критическое замечание'); if (d.requiresDocument && !documents.some(x => x.objectWorkId === d.predecessorWorkId && x.status === 'APPROVED'))
            reasons.push('Не подтверждён обязательный документ'); return reasons; }); return { ...w, ...status, accepted, docsReady, closed, financial, blockers, stale: !w.lastReportedAt || age(w.lastReportedAt) > Number(risk.staleDays) }; });
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
        return { objects: objectList, works: enriched, inspections, issues, packages, documents, sdo, closings, contractors, dependencies, dashboard, monthlyPlans: monthly, risk, photos };
    }
}
