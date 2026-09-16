import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { parseWorkbook } from '../apps/backend/src/importer';
test('Excel validation, organization mapping, qualified codes, plan types', async () => { const w = new ExcelJS.Workbook(); for (const source of ['ГПО', 'СПО']) {
    const s = w.addWorksheet(source);
    s.addRow(['УКО', 'Объект', 'Полный адрес объекта', 'СПО', 'Стоимость объекта', 'план выполнения', 'тип плана']);
    s.addRow(['DUP-1', 'Школа', 'ул. Тестовая, 1', 'ООО Подрядчик', 2, 1, 'FINAL']);
    s.addRow(['MISSING', 'Без адреса', null, null, 1]);
} const r = await parseWorkbook(Buffer.from(await w.xlsx.writeBuffer()), 1000000); assert.equal(r.rows.length, 2); assert.equal(r.errors.length, 2); assert.equal(r.rows[0].contractValue, '2000000.00'); assert.equal(r.rows[0].organizationName, 'ООО СЗ «Гор-Строй»'); assert.equal(r.rows[1].organizationName, 'ООО Подрядчик'); assert.equal(r.rows[0].planType, 'FINAL'); assert.ok(r.warnings.some(x => x.message.includes('другом листе'))); });
