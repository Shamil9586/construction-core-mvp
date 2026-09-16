import ExcelJS from 'exceljs';
import { z } from 'zod';
import { ProductionService } from './service';
import { Actor, requirePermission, scoped, ensure, audit } from './security';
import { Permission as P } from '../../../packages/domain';
import { pool, insert, transaction } from './db';
const rowSchema = z.object({ source: z.enum(['ГПО', 'СПО', 'РКС-НР']), externalCode: z.string().min(1), name: z.string().min(1), address: z.string().min(1), organizationName: z.string().min(1), contractValue: z.string().regex(/^\d+(\.\d{1,2})?$/), plannedValue: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(), planType: z.enum(['INTERMEDIATE', 'FINAL']).optional() });
const cell = (v: any): any => v && typeof v === 'object' && 'result' in v ? v.result : v && typeof v === 'object' && 'richText' in v ? v.richText.map(x => x.text).join('') : v;
export async function parseWorkbook(bytes: Buffer, multiplier: number) { ensure(bytes.length < 8 * 1024 * 1024, 'Файл больше 8 МБ'); ensure([1, 1000, 1000000].includes(multiplier), 'Выберите масштаб сумм'); const zip = await require('jszip').loadAsync(bytes); const entries: any[] = Object.values(zip.files); ensure(entries.length <= 2000 && entries.reduce((sum, e) => sum + (e._data?.uncompressedSize ?? 0), 0) <= 64 * 1024 * 1024, 'Распакованный Excel превышает лимит'); const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes as any); const report: any = { rows: [], errors: [], warnings: [], moneyMultiplier: multiplier }; const seen = new Map<string, string>(); for (const source of ['ГПО', 'СПО', 'РКС-НР']) {
    const s = book.getWorksheet(source);
    if (!s)
        continue;
    ensure(s.rowCount <= 5000, 'Слишком много строк');
    const headers: any = {};
    s.getRow(1).eachCell((c, col) => headers[String(cell(c.value)).replace(/\s+/g, ' ').trim().toLowerCase()] = col);
    const get = (r: any, ...names: string[]) => { const k = names.find(n => headers[n.toLowerCase()]); return k ? cell(r.getCell(headers[k.toLowerCase()]).value) : null; };
    s.eachRow((r, n) => { if (n === 1)
        return; const externalCode = String(get(r, 'УКО') ?? '').trim(), name = String(get(r, 'Объект') ?? '').trim(); if (!externalCode && !name)
        return; const amount = get(r, 'Стоимость объекта'); const plan = get(r, 'план выполнения', 'План Сентябрь'); const type = get(r, 'тип плана'); const d: any = { source, externalCode, name, address: String(get(r, 'Полный адрес объекта', 'Адрес') ?? '').trim(), organizationName: source === 'ГПО' ? 'ООО СЗ «Гор-Строй»' : String(get(r, 'СПО') ?? '').trim(), contractValue: typeof amount === 'number' ? (amount * multiplier).toFixed(2) : '' }; if (plan !== null && plan !== undefined) {
        d.plannedValue = typeof plan === 'number' ? (plan * multiplier).toFixed(2) : '';
        d.planType = ['FINAL', 'Итоговый', 'синий'].includes(type) ? 'FINAL' : ['INTERMEDIATE', 'Промежуточный', 'серый'].includes(type) ? 'INTERMEDIATE' : undefined;
        if (!d.planType)
            report.warnings.push({ source, row: n, message: 'Тип плана не указан явно. План не будет импортирован до уточнения.' });
    } const checked = rowSchema.safeParse(d); if (!checked.success) {
        report.errors.push({ source, row: n, messages: checked.error.issues.map(i => `${i.path}: ${i.message}`) });
        return;
    } const identity = source + ':' + externalCode; if (seen.has(identity)) {
        report.errors.push({ source, row: n, messages: ['Повторный ключ источник + УКО'] });
        return;
    } if ([...seen.values()].includes(externalCode))
        report.warnings.push({ source, row: n, message: 'УКО встречается на другом листе. Объекты сохранятся отдельно.' }); seen.set(identity, externalCode); report.rows.push({ ...checked.data, sourceRow: n }); });
} report.warnings.push({ message: 'Физический процент не выводится из денежных сумм. РП, сроки и виды работ назначаются отдельно. Исторические закрытия не импортируются без сверки.' }); return report; }
export async function previewImport(a: Actor, d: any) { requirePermission(a, P.ADMIN_DICTIONARIES); const report = await parseWorkbook(Buffer.from(d.base64, 'base64'), d.multiplier); return insert(pool, 'import_reports', a.tenantId, { createdBy: a.id, fileName: d.fileName, report: JSON.stringify(report) }); }
export async function commitImport(a: Actor, id: string, d: any) { requirePermission(a, P.OBJECT_CREATE); requirePermission(a, P.ADMIN_DICTIONARIES); return transaction(async (c) => { const stored = await scoped(c, 'import_reports', id, a, true); ensure(stored.status === 'PREVIEW', 'Импорт уже выполнен'); const pm = await scoped(c, 'users', d.projectManagerId, a); ensure(pm.role === 'PROJECT_MANAGER', 'Выберите РП'); await scoped(c, 'contractors', d.contractorId, a); ensure(d.plannedFinishDate >= d.startDate, 'Неверные сроки'); const selected = stored.report.rows.filter(r => d.sourceRows.includes(r.source + ':' + r.sourceRow)); ensure(selected.length > 0, 'Выберите строки'); const imported = []; for (const r of selected) {
    const o = await insert(c, 'objects', a.tenantId, { source: r.source, externalCode: r.externalCode, name: r.name, address: r.address, organizationName: r.organizationName, contractValue: r.contractValue, projectManagerId: d.projectManagerId, startDate: d.startDate, plannedFinishDate: d.plannedFinishDate });
    await insert(c, 'object_contractors', a.tenantId, { objectId: o.id, contractorId: d.contractorId });
    if (r.plannedValue && r.planType)
        await insert(c, 'monthly_plans', a.tenantId, { objectId: o.id, period: d.period, plannedValue: r.plannedValue, planType: r.planType });
    await audit(c, a, 'Object', o.id, 'IMPORT', null, o);
    imported.push(o.id);
} await c.query("UPDATE import_reports SET status='IMPORTED',report=report||$3::jsonb,version=version+1 WHERE tenant_id=$1 AND id=$2", [a.tenantId, id, JSON.stringify({ imported })]); return { imported, skipped: stored.report.rows.length - selected.length, errors: stored.report.errors }; }); }
