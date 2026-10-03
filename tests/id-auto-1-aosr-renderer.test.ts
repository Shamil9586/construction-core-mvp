import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { buildAosrRenderModel, NARROW_CHARS } from '../apps/backend/src/id-auto/aosr';
import { renderAosrDocx, fitHalfPoints, readAosrTemplate } from '../apps/backend/src/id-auto/aosr-docx';

/** ID-AUTO-1 — renderer product rules, pure (no database). The rendered pages were also inspected visually (docs/samples). */
const parties: any[] = [
  { partyRole: 'DEVELOPER', organizationName: 'ООО «Заказчик»', organizationDetails: 'ОГРН 1, ИНН 2\nСРО-Заказчик' },
  { partyRole: 'CONSTRUCTION_ENTITY', organizationName: 'ООО СЗ «Гор-Строй»' },
  { partyRole: 'DESIGNER', organizationName: 'ООО «Проект»', organizationDetails: 'ОГРН 3, ИНН 4\nСРО-Проект' },
  { partyRole: 'WORK_EXECUTOR', organizationName: 'ООО «Подрядчик»' },
  { partyRole: 'DEVELOPER_SC_REP', personName: 'Петров Пётр Петрович', position: 'Инженер СК', authorityDocument: 'Приказ 1' },
  { partyRole: 'CONSTRUCTION_REP', personName: 'Сидоров Сидор Сидорович', position: 'Прораб', authorityDocument: 'Приказ 2' },
  { partyRole: 'INTERNAL_SC', personName: 'Иванов Иван Иванович', position: 'Инженер СК', authorityDocument: 'Приказ 3' },
];
const content = { workDescription: 'Устройство штукатурки стен', startDate: '2026-09-14', endDate: '2026-09-25', actDate: '2026-09-26', projectDocumentation: 'АР-1', normativeReferences: 'СП 71', subsequentWork: 'Шпатлёвка' };
const source = (over: any = {}) => ({ officialNumber: 5, objectName: 'Объект', objectAddress: 'Адрес', content, parties, materials: [], schemes: [], ...over });
const paragraphs = (xml: string) => [...xml.matchAll(/<w:p[ >].*?<\/w:p>/gs)].map(m => ({ xml: m[0], text: [...m[0].matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map(t => t[1]).join('') }));
async function render(over: any = {}) {
  const zip = await JSZip.loadAsync(await renderAosrDocx(buildAosrRenderModel(source(over))));
  return paragraphs(await zip.file('word/document.xml')!.async('string'));
}
const SLOT = { developer: 10, developerSro: 12, designer: 24, designerSro: 28, month: [41, 96, 104], point3a: 79, point3b: 82, point4a: 86, point4b: 89 };

test('every Russian month fits its one-line date cell: the run is sized down, the word is never split or abbreviated', async () => {
  for (const month of ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']) {
    const p = await render({ content: { ...content, actDate: `2026-${month}-26`, startDate: `2026-${month}-01`, endDate: `2026-${month}-27` } });
    for (const i of SLOT.month) {
      const word = p[i].text;
      assert.match(word, /^[а-я]+$/, `month ${month} printed in full as one word`);
      const size = /<w:sz w:val="(\d+)"/.exec(p[i].xml)?.[1];
      const half = size ? Number(size) : 20;
      // the word's estimated width at its run size must not exceed the cell's usable width (972 − 216 twips)
      assert.ok(word.length * 0.56 * (half / 2) <= (972 - 216) / 20 + 0.01, `${word} fits at ${half / 2}pt`);
    }
  }
  assert.equal(fitHalfPoints('мая', 972 - 216), null, 'short months keep the form size');
  assert.ok(fitHalfPoints('сентября', 972 - 216)! < 20);
});

test('point 3: long materials / quality documents use the full-width continuation row, not the narrow first blank', async () => {
  const long = [
    { name: 'Грунтовка глубокого проникновения', qualityDocuments: [{ docType: 'PASSPORT', number: 'П-1', docDate: '2026-08-20' }] },
    { name: 'Штукатурная смесь гипсовая', qualityDocuments: [{ docType: 'CERTIFICATE', number: 'RU-1' }, { docType: 'DECLARATION', number: 'Д-2' }] },
  ];
  const p = await render({ materials: long });
  assert.equal(p[SLOT.point3a].text.trim(), '', 'narrow field stays empty');
  assert.ok(p[SLOT.point3b].text.includes('Грунтовка глубокого проникновения (паспорт № П-1 от 20.08.2026)'));
  assert.ok(p[SLOT.point3b].text.includes('Штукатурная смесь гипсовая (сертификат № RU-1; декларация № Д-2)'));
  // one short material: its name stays in the narrow blank, its requisites go to the continuation row
  const short = await render({ materials: [{ name: 'Грунтовка', qualityDocuments: [{ docType: 'PASSPORT', number: 'П-1' }] }] });
  assert.equal(short[SLOT.point3a].text, 'Грунтовка');
  assert.equal(short[SLOT.point3b].text, 'паспорт № П-1');
  assert.ok('Грунтовка'.length <= NARROW_CHARS);
});

test('point 4: executive-scheme references use the continuation row; several schemes are listed; the many-to-many link needs nothing per AOSR', async () => {
  const schemes = [{ id: 'a', title: 'Исполнительная схема ES-001: нанесение штукатурки стен санузлов, оси 1-12/А-Ж' }, { id: 'b', title: 'ES-002 схема грунтования' }];
  const p = await render({ schemes });
  assert.equal(p[SLOT.point4a].text.trim(), '');
  assert.ok(p[SLOT.point4b].text.includes('ES-001') && p[SLOT.point4b].text.includes('ES-002'));
  const one = await render({ schemes: [{ id: 'a', title: 'ES-001' }] });
  assert.equal(one[SLOT.point4a].text, 'ES-001');
});

test('project-design organization fills the header (and its SRO row); the designer representative signature stays blank when absent', async () => {
  const p = await render();
  assert.equal(p[SLOT.designer].text, 'ООО «Проект», ОГРН 3, ИНН 4');
  assert.equal(p[SLOT.designerSro].text, 'СРО-Проект');
  assert.equal(p[SLOT.developerSro].text, 'СРО-Заказчик');
  assert.equal(p[61].text.trim(), '', 'no designer representative text');
  assert.equal(p[152].text.trim(), '', 'no designer representative signature name');
});

test('no quantity is rendered, and the official form text is untouched', async () => {
  const p = await render({ materials: [{ name: 'Смесь', qualityDocuments: [{ docType: 'PASSPORT', number: 'П-1' }] }] });
  const tpl = paragraphs(await (await JSZip.loadAsync(readAosrTemplate()!)).file('word/document.xml')!.async('string'));
  assert.equal(p.length, tpl.length);
  tpl.forEach((t, i) => { if (t.text.replace(/ /g, '').trim()) assert.equal(p[i].text, t.text); });
  assert.ok(!Object.keys(buildAosrRenderModel(source())).some(k => /quant|volume|объ/i.test(k)));
  assert.ok(!/м²|м2|м³/.test(p.map(x => x.text).join('')));
});
