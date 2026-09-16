import { pool, transaction, insert, one } from '../apps/backend/src/db';
import { roles } from '../packages/domain';
import { randomUUID } from 'node:crypto';
// All names and construction scenarios below are synthetic demo fixtures.
export async function seed() {
    if (process.env.NODE_ENV === "production" || process.env.AUTH_MODE === "bitrix") throw Error("Demo seed is allowed only in local/mock test environments");
    return transaction(async (c) => {
        let tenant = await one(c, "SELECT * FROM tenants WHERE portal='demo.local'");
        if (tenant)
            return tenant;
        tenant = await one(c, "INSERT INTO tenants(portal,member_id,name) VALUES('demo.local','demo-member','Строительная группа • ТЕСТ') RETURNING *");
        const t = tenant.id;
        const contractors = [];
        for (const name of ['Монолит Профи', 'Град-Отделка', 'СтройИнженер', 'ФасадГрупп', 'Кровля Сервис', 'Основа', 'Окна Проект', 'БлагоСтрой'])
            contractors.push(await insert(c, 'contractors', t, { name: 'ООО «' + name + '»' }));
        const users = [];
        for (let j = 0; j < roles.length; j++)
            users.push(await insert(c, 'users', t, { bitrixUserId: String(j + 1), name: ['Александр Волков', 'Дмитрий Орлов', 'Михаил Соколов', 'Елена Крылова', 'Ольга Морозова', 'Андрей Зайцев', 'Ирина Белова', 'Администратор', 'Представитель подрядчика'][j], role: roles[j], contractorId: roles[j] === 'CONTRACTOR_VIEWER' ? contractors[0].id : null }));
        for (let j = 0; j < 4; j++)
            users.push(await insert(c, 'users', t, { bitrixUserId: String(20 + j), name: ['Сергей Павлов', 'Тимур Алексеев', 'Максим Кузнецов', 'Артём Смирнов'][j], role: 'PROJECT_MANAGER' }));
        const pm = users.filter(u => u.role === 'PROJECT_MANAGER'), admin = users.find(u => u.role === 'ADMIN'), pto = users.find(u => u.role === 'PTO'), sk = users.find(u => u.role === 'CONSTRUCTION_CONTROL'), sdoUser = users.find(u => u.role === 'SDO');
        const types = [];
        const root = await insert(c, 'work_categories', t, { name: 'Строительно-монтажные работы', code: 'SMR' });
        for (const [i, name] of ['Армирование фундамента', 'Бетонирование фундамента', 'Кладка наружных стен', 'Штукатурка стен', 'Монтаж инженерных сетей', 'Устройство кровли'].entries()) {
            const category = await insert(c, 'work_categories', t, { name: ['Конструктив', 'Фундаменты', 'Кладка', 'Отделка', 'Инженерные сети', 'Кровля'][i], code: 'C' + i, parentId: root.id });
            types.push(await insert(c, 'work_types', t, { categoryId: category.id, name, unit: ['т', 'м³', 'м³', 'м²', 'м', 'м²'][i], requiresInspection: true, requiresExecutiveDocs: true, requiresMaterials: true }));
        }
        await insert(c, 'risk_settings', t, {});
        const now = new Date();
        const dt = (delta: number) => new Date(+now + delta * 86400000).toISOString().slice(0, 10);
        const period = dt(0).slice(0, 7);
        for (let i = 0; i < 10; i++) {
            const contractor = contractors[i % 8];
            const object = await insert(c, 'objects', t, { externalCode: `DEMO-2026-${String(i + 1).padStart(3, '0')}`, name: ['Школа на 550 мест', 'ЖК «Северный», корпус 2', 'Поликлиника № 4', 'Спортивный комплекс', 'Детский сад «Радуга»', 'Административный корпус', 'ЖК «Парковый»', 'Культурный центр', 'Пожарное депо', 'Очистные сооружения'][i], address: `Тестовый город, ${['ул. Школьная, 12', 'пр. Строителей, 28', 'ул. Центральная, 7', 'ул. Спортивная, 3', 'ул. Садовая, 16', 'ул. Заводская, 9', 'ул. Парковая, 24', 'пл. Мира, 5', 'ул. Южная, 8', 'Промышленный проезд, 2'][i]}`, organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm[i % 5].id, startDate: dt(-30), plannedFinishDate: dt(60), contractValue: '60000000' });
            await insert(c, 'object_contractors', t, { objectId: object.id, contractorId: contractor.id });
            await insert(c, 'monthly_plans', t, { objectId: object.id, period, plannedValue: '8000000', planType: i % 3 === 0 ? 'FINAL' : 'INTERMEDIATE' });
            const works = [];
            for (let j = 0; j < 6; j++) {
                const actual = i === 3 ? 0 : i === 5 && j === 2 ? 0 : i === 1 ? 50 : i === 2 ? 15 : j < 2 ? 100 : 60;
                const w = await insert(c, 'works', t, { objectId: object.id, workTypeId: types[j].id, contractorId: contractor.id, responsibleUserId: pm[i % 5].id, name: types[j].name, unit: types[j].unit, plannedQuantity: j === 0 ? 20 : 1000, actualQuantity: (j === 0 ? 20 : 1000) * actual / 100, plannedStartDate: dt(-30), plannedFinishDate: dt(i === 1 ? 20 : 30), estimatedCost: '10000000', status: actual === 100 ? 'COMPLETED' : actual ? 'ACTIVE' : 'PLANNED' });
                works.push(w);
                if (i !== 3)
                    await insert(c, 'work_progress', t, { objectWorkId: w.id, quantityDelta: w.actualQuantity, totalQuantity: w.actualQuantity, progressPercent: actual, reportedBy: pm[i % 5].id, reportedAt: new Date(+now - (i === 4 ? 12 : 1) * 86400000), comment: 'Демонстрационный факт' });
                if (actual === 100) {
                    const inspection = await insert(c, 'inspections', t, { objectId: object.id, objectWorkId: w.id, requestedBy: pm[i % 5].id, inspectorId: sk.id, status: i === 5 ? 'ISSUES_FOUND' : 'ACCEPTED', acceptedAt: i === 5 ? null : new Date() });
                    if (i === 5)
                        await insert(c, 'issues', t, { inspectionId: inspection.id, title: 'Недостаточная толщина защитного слоя', severity: 'CRITICAL', responsibleUserId: pm[i % 5].id, dueDate: dt(-5) });
                    if (i >= 6) {
                        const p = await insert(c, 'executive_packages', t, { objectId: object.id, objectWorkId: w.id, createdBy: pto.id, status: i === 6 ? 'READY' : 'TRANSFERRED_TO_SDO', completedAt: new Date(+now - 14 * 86400000) });
                        const file = await insert(c, 'attachments', t, { fileName: 'demo-aosr.pdf', mimeType: 'application/pdf', content: Buffer.from('%PDF-1.4\n% DEMO ONLY\n%%EOF'), uploadedBy: pto.id });
                        const doc = await insert(c, 'executive_documents', t, { objectId: object.id, objectWorkId: w.id, type: 'AOSR', number: 'DEMO-' + i + '-' + j, documentDate: dt(-15), status: 'APPROVED', fileId: file.id, createdBy: pto.id, approvedBy: pto.id, approvedAt: new Date(), draftContent: 'Демонстрационный документ. Не использовать в реальном строительстве.' });
                        await insert(c, 'package_documents', t, { packageId: p.id, documentId: doc.id });
                        const material = await insert(c, 'materials', t, { name: 'Арматура А500С / демонстрационная партия', manufacturer: 'Тестовый завод' });
                        const batch = await insert(c, 'material_batches', t, { materialId: material.id, objectId: object.id, batchNumber: 'DEMO-' + i + '-' + j });
                        await insert(c, 'material_documents', t, { materialBatchId: batch.id, type: 'PASSPORT', number: 'ПС-DEMO', validUntil: dt(365), fileId: file.id });
                        await insert(c, 'work_materials', t, { objectWorkId: w.id, materialBatchId: batch.id, quantity: 1 });
                        if (i >= 7) {
                            const s = await insert(c, 'sdo_cases', t, { objectId: object.id, objectWorkId: w.id, executiveDocumentPackageId: p.id, ptoTransferredBy: pto.id, sdoResponsibleId: sdoUser.id, ptoTransferredAt: new Date(+now - 20 * 86400000), estimatedValue: '10000000', status: i === 8 ? 'CALCULATED' : i === 9 ? 'READY_TO_CLOSE' : 'TRANSFERRED', calculatedValue: i >= 8 ? '10000000' : null, acceptedClosingValue: i >= 8 ? '10000000' : null });
                            if (i === 9)
                                await insert(c, 'financial_closings', t, { objectId: object.id, sdoCaseId: s.id, period, amount: '3000000', closingDate: dt(0), createdBy: sdoUser.id, idempotencyKey: randomUUID() });
                        }
                    }
                }
            }
            if (i === 5)
                await insert(c, 'work_dependencies', t, { predecessorWorkId: works[0].id, successorWorkId: works[2].id, requiresAcceptance: true });
        }
        return tenant;
    });
}
if (require.main === module)
    seed().then(async () => { console.log('Seed: 10 objects, 8 contractors, 5 PM, 60 works'); await pool.end(); }).catch(e => { console.error(e); process.exit(1); });
