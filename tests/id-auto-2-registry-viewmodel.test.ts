import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  blockerLink, buildRegistryViewModel, isFiltered, packagesCountText, readRegistryQuery, writeRegistryQuery, NO_NUMBER_TEXT, READY_LABEL, NOT_READY_LABEL, EXTERNAL_NO_AOSR_TEXT,
} from '../apps/frontend/src/view-models/documentationRegistry';
import { documentationRegistryPath, packagePath } from '../apps/frontend/src/app/routePaths';
import { registryQueryString } from '../apps/frontend/src/data/documentationRegistryApi';
import type { DocumentationRegistryPayload, RegistryAosrItem, RegistryPackageItem } from '../apps/frontend/src/data/documentationRegistryApi';

/**
 * ID-AUTO-2 — the registry screen's data chain. It formats and links what the server decided and decides nothing itself:
 * these tests feed it payloads whose readiness DISAGREES with the surrounding data and require the server's word to win.
 */
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const aosr = (over: Partial<RegistryAosrItem> = {}): RegistryAosrItem => ({
  id: ID(11), number: 1, title: 'Устройство штукатурки стен', workDescription: null, zones: ['1 этаж'], startDate: '2026-10-01', endDate: '2026-10-03', actDate: '2026-10-04',
  docx: { state: 'CURRENT', revisionCount: 1 }, schemeCoverage: { covered: true, schemes: [{ id: ID(21), title: 'PILOT-W01-ES-001', hasFile: true }] },
  readiness: { ready: true, reasons: [] }, generationIssues: [], projectDocumentation: 'Раздел АР', normativeReferences: null, subsequentWork: 'Окраска', lastUpdateAt: '2026-10-05T10:00:00.000Z', version: 3, ...over,
});
const pkg = (over: Partial<RegistryPackageItem> = {}): RegistryPackageItem => ({
  packageId: ID(1), workId: ID(2), workName: 'Штукатурка стен',
  scope: { hasScope: true, zoneSummary: '1 этаж', zones: ['1 этаж'], currentQuantity: { quantity: '498.0000', unit: 'м²', source: 'INTERNAL_SC' } },
  responsible: { id: ID(3), name: '«Гор-Строй» ООО СЗ' }, status: 'DRAFT', aosrMethod: 'CORE', aosrCount: 2, aosrGeneratedCount: 1, schemeCount: 1, schemeFileBackedCount: 1,
  readiness: { ready: false, reasons: [
    { code: 'AOSR_NOT_GENERATED', message: 'АОСР «Грунтовка основания» не сформирован', target: { kind: 'AOSR', aosrId: ID(12) }, aosrId: ID(12), aosrTitle: 'Грунтовка основания' },
    { code: 'AOSR_SCHEME_MISSING', message: 'Для АОСР «Грунтовка основания» отсутствует исполнительная схема с файлом', target: { kind: 'AOSR', aosrId: ID(12) }, aosrId: ID(12), aosrTitle: 'Грунтовка основания' },
    { code: 'SCHEME_FILE_REQUIRED', message: 'Для предъявления заказчику нужна хотя бы одна исполнительная схема с загруженным файлом', target: { kind: 'SCHEMES' } },
  ] },
  awaitingEngineerAction: true, lastUpdate: { at: '2026-10-05T10:00:00.000Z', kind: 'AOSR_GENERATED' },
  aosrs: [aosr(), aosr({ id: ID(12), number: null, title: 'Грунтовка основания', zones: [], docx: { state: 'NOT_GENERATED', revisionCount: 0 }, schemeCoverage: { covered: false, schemes: [] }, readiness: { ready: false, reasons: [] }, generationIssues: [{ code: 'POINT1_MISSING', message: 'Не заполнен пункт 1' }] })],
  ...over,
});
const payload = (rows: RegistryPackageItem[], over: Partial<DocumentationRegistryPayload> = {}): DocumentationRegistryPayload => ({
  objectId: ID(100), objectName: 'Тест после удаления ролей', objectAddress: 'г. Москва', worksScope: 'ALL_WORKS',
  summary: { activePackages: rows.length, ready: rows.filter(r => r.readiness.ready).length, notReady: rows.filter(r => !r.readiness.ready).length, awaitingEngineerAction: rows.filter(r => r.awaitingEngineerAction).length },
  matchedCount: rows.length, filterOptions: { responsible: [{ id: ID(3), name: '«Гор-Строй» ООО СЗ' }] }, rows, archivedCount: 0, ...over,
});

test('a package row speaks business scope: work, zone, current quantity, responsible, method, status — not ids', () => {
  const vm = buildRegistryViewModel(payload([pkg()]), {}, true);
  const row = vm.rows[0]!;
  assert.equal(row.workName, 'Штукатурка стен');
  assert.equal(row.scopeText, '1 этаж');
  assert.match(row.quantityText!, /^498 м²$/);
  assert.equal(row.quantitySourceText, 'подтверждено строительным контролем');
  assert.equal(row.responsible, '«Гор-Строй» ООО СЗ');
  assert.equal(row.methodText, 'Формируются в Core');
  assert.equal(row.status.label, 'Черновик');
  assert.equal(row.aosrCountText, '2 АОСР · сформировано 1');
  assert.equal(JSON.stringify(row).includes(ID(1)), true, 'the id is carried for navigation only');
  assert.equal([row.workName, row.scopeText, row.quantityText, row.responsible, row.methodText].some(t => t && /[0-9a-f]{8}-[0-9a-f]{4}/.test(t)), false, 'no UUID is ever displayed');
  assert.equal(vm.description, 'Тест после удаления ролей · г. Москва');
});

test('readiness is rendered from the server verdict, never recomputed from the surrounding data', () => {
  // `ready: true` while every other fact looks broken -> still «Готово»
  const liar = pkg({ aosrMethod: null, scope: { hasScope: false, zoneSummary: null, zones: [], currentQuantity: null }, aosrs: [aosr({ number: null, docx: { state: 'NOT_GENERATED', revisionCount: 0 }, schemeCoverage: { covered: false, schemes: [] } })], readiness: { ready: true, reasons: [] } });
  const a = buildRegistryViewModel(payload([liar]), {}, true).rows[0]!;
  assert.equal(a.ready, true);
  assert.equal(a.readinessLabel, READY_LABEL);
  assert.deepEqual(a.reasons, []);
  assert.equal(a.expandable, true, 'the act register is still there to open');
  // and the reverse: a spotless package the server calls not ready stays «Не готово» with the server's reasons
  const strict = pkg({ aosrs: [aosr()], aosrCount: 1, aosrGeneratedCount: 1, readiness: { ready: false, reasons: [{ code: 'X', message: 'Причина от сервера', target: { kind: 'METHOD' } }] } });
  const b = buildRegistryViewModel(payload([strict]), {}, true).rows[0]!;
  assert.equal(b.ready, false);
  assert.equal(b.readinessLabel, NOT_READY_LABEL);
  assert.deepEqual(b.reasons.map(r => r.text), ['Причина от сервера']);
});

test('blockers keep the server\'s order and wording, show a concise preview, and each leads to the place that fixes it', () => {
  const row = buildRegistryViewModel(payload([pkg()]), {}, true).rows[0]!;
  assert.deepEqual(row.reasons.map(r => r.text), [
    'АОСР «Грунтовка основания» не сформирован',
    'Для АОСР «Грунтовка основания» отсутствует исполнительная схема с файлом',
    'Для предъявления заказчику нужна хотя бы одна исполнительная схема с загруженным файлом',
  ]);
  assert.equal(row.previewReasons.length, 2);
  assert.equal(row.hiddenReasonCount, 1);
  assert.deepEqual(row.reasons.map(r => r.link), [
    { label: 'Открыть АОСР', focus: 'aosr', aosrId: ID(12) },
    { label: 'Открыть АОСР', focus: 'aosr', aosrId: ID(12) },
    { label: 'К исполнительным схемам', focus: 'schemes' },
  ]);
  for (const [target, expected] of [
    [{ kind: 'SCOPE' }, 'scope'], [{ kind: 'METHOD' }, 'method'], [{ kind: 'AOSR_SECTION' }, 'aosr'], [{ kind: 'SCHEMES' }, 'schemes'],
  ] as const) assert.equal(blockerLink(target).focus, expected);
  assert.equal(blockerLink({ kind: 'AOSR', aosrId: 'x' }).aosrId, 'x');
});

test('when the screen offers no package links (no actions) the reasons are still shown, without links', () => {
  const row = buildRegistryViewModel(payload([pkg()]), {}, false).rows[0]!;
  assert.equal(row.reasons.length, 3);
  assert.ok(row.reasons.every(r => r.link === null));
});

test('AOSR register: number or «номер не присвоен», DOCX state, scheme coverage, work dates, zone — one row per act', () => {
  const vm = buildRegistryViewModel(payload([pkg()]), {}, true).rows[0]!;
  assert.equal(vm.aosrs.length, 2);
  const [done, draft] = vm.aosrs as [typeof vm.aosrs[number], typeof vm.aosrs[number]];
  assert.equal(done.numberText, '№ 1');
  assert.equal(done.hasNumber, true);
  assert.equal(draft.numberText, NO_NUMBER_TEXT);
  assert.equal(draft.hasNumber, false);
  assert.deepEqual([done.docx.label, done.docx.variant], ['Актуальный DOCX', 'OnTrack']);
  assert.deepEqual([draft.docx.label, draft.docx.variant], ['Не сформирован', 'Neutral']);
  assert.equal(done.workDatesText, '01.10.2026 — 03.10.2026');
  assert.equal(done.zonesText, '1 этаж');
  assert.equal(draft.zonesText, 'Участок не привязан');
  assert.equal(done.schemeText, 'PILOT-W01-ES-001');
  assert.equal(draft.schemeText, 'Схема с файлом не привязана');
  assert.deepEqual(draft.generationIssues, ['Не заполнен пункт 1']);
  assert.deepEqual(done.details.map(d => d.label), ['Проектная и рабочая документация', 'Последующие работы'], 'only the texts that exist are offered');
  const outdated = buildRegistryViewModel(payload([pkg({ aosrs: [aosr({ docx: { state: 'OUTDATED', revisionCount: 2 } })] })]), {}, true).rows[0]!.aosrs[0]!;
  assert.deepEqual([outdated.docx.label, outdated.docx.variant], ['Изменён после формирования', 'Attention']);
});

test('EXTERNAL package: no Core AOSRs is the method, not a defect — no count, no invented rows; METHOD_UNSET is its own wording', () => {
  const external = pkg({ aosrMethod: 'EXTERNAL', aosrCount: 0, aosrGeneratedCount: 0, aosrs: [], readiness: { ready: true, reasons: [] } });
  const row = buildRegistryViewModel(payload([external]), {}, true).rows[0]!;
  assert.equal(row.methodText, 'Формируются вне Core');
  assert.equal(row.aosrCountText, null);
  assert.equal(row.externalNoAosr, true);
  assert.equal(row.aosrs.length, 0);
  assert.equal(row.expandable, false, 'ready and nothing to list');
  assert.equal(EXTERNAL_NO_AOSR_TEXT, 'АОСР ведутся вне Core');
  const unset = buildRegistryViewModel(payload([pkg({ aosrMethod: null, aosrCount: 0, aosrs: [], readiness: { ready: false, reasons: [{ code: 'METHOD_UNSET', message: 'Сначала выберите способ', target: { kind: 'METHOD' } }] } })]), {}, true).rows[0]!;
  assert.equal(unset.methodText, 'Способ подготовки АОСР не выбран');
  assert.equal(unset.methodDeclared, false);
  assert.equal(unset.externalNoAosr, false, 'an undeclared method is never presented as external');
  assert.deepEqual(unset.reasons[0]!.link, { label: 'Выбрать способ подготовки', focus: 'method' });
});

test('a package with no scope says so; summary tiles come straight from the server counts', () => {
  const vm = buildRegistryViewModel(payload([pkg({ scope: { hasScope: false, zoneSummary: null, zones: [], currentQuantity: null } })]), {}, true);
  assert.equal(vm.rows[0]!.scopeText, 'Участок не выбран');
  assert.equal(vm.rows[0]!.scopeMissing, true);
  assert.equal(vm.rows[0]!.quantityText, null);
  const tiles = buildRegistryViewModel(payload([pkg()], { summary: { activePackages: 7, ready: 3, notReady: 4, awaitingEngineerAction: 5 } }), {}, true).summary;
  assert.deepEqual(tiles.map(t => [t.key, t.value]), [['active', '7'], ['ready', '3'], ['notReady', '4'], ['awaiting', '5']]);
});

test('archived packages: only on request, read-only identity + who/when/why, never counted', () => {
  const archived = { packageId: ID(9), workId: ID(2), workName: 'Штукатурка стен', scope: pkg().scope, responsible: { id: ID(3), name: 'Иванов' }, status: 'DRAFT', aosrMethod: null, archivedAt: '2026-10-06T09:00:00.000Z', archivedByName: 'Петров', archiveReason: 'Тестовый пакет' };
  const without = buildRegistryViewModel(payload([pkg()], { archivedCount: 2 }), {}, true);
  assert.equal(without.archivedRows, null);
  assert.equal(without.archivedCount, 2);
  const withIt = buildRegistryViewModel(payload([pkg()], { archivedCount: 1, archivedRows: [archived] }), { archived: true }, true);
  assert.equal(withIt.archivedRows!.length, 1);
  assert.match(withIt.archivedRows![0]!.archivedText, /^Архивирован: Петров, /);
  assert.equal(withIt.archivedRows![0]!.reasonText, 'Причина: Тестовый пакет');
  assert.equal(withIt.totalCount, 1, 'the archive does not enter the active total');
});

test('filters live in the URL: round-trip, garbage ignored, the archive view is not a filter', () => {
  const query = { responsibleUserId: ID(3), status: 'PREPARING', ready: false, method: 'UNSET' as const, q: ' штукатурка ', archived: true };
  const params = writeRegistryQuery(query);
  assert.deepEqual(readRegistryQuery(params), { ...query, q: 'штукатурка' });
  assert.deepEqual(readRegistryQuery(new URLSearchParams('responsible=nope&status=HACK&ready=maybe&method=ALL&q=%20%20&archived=0')), {});
  assert.equal(isFiltered({ archived: true }), false);
  assert.equal(isFiltered({ ready: false }), true);
  assert.equal(isFiltered({ q: '  ' }), false);
  assert.equal(registryQueryString({ ready: true, method: 'CORE', q: 'грунт', archived: true, responsibleUserId: ID(3), status: 'DRAFT' }), `?responsibleUserId=${ID(3)}&status=DRAFT&ready=true&method=CORE&q=${encodeURIComponent('грунт')}&archived=true`);
  assert.equal(registryQueryString({}), '');
});

test('opening a row reaches the right package: registry rows carry the package id and the deep link keeps it', () => {
  assert.equal(documentationRegistryPath(ID(100)), `/object/${ID(100)}/documentation`);
  assert.equal(packagePath(ID(1)), `/pto/package/${ID(1)}`);
  assert.equal(packagePath(ID(1), { focus: 'method' }), `/pto/package/${ID(1)}?focus=method`);
  assert.equal(packagePath(ID(1), { focus: 'aosr', aosrId: ID(12) }), `/pto/package/${ID(1)}?focus=aosr&aosr=${ID(12)}`);
  const rows = buildRegistryViewModel(payload([pkg({ packageId: ID(1) }), pkg({ packageId: ID(5), workName: 'Окраска' })]), {}, true).rows;
  assert.deepEqual(rows.map(r => [r.packageId, r.workName]), [[ID(1), 'Штукатурка стен'], [ID(5), 'Окраска']]);
});

test('no documentary rule is duplicated in the frontend: the registry layers neither import the domain nor test the facts that decide readiness', () => {
  const root = join(__dirname, '..', 'apps', 'frontend', 'src');
  const files = [
    join(root, 'view-models', 'documentationRegistry.ts'), join(root, 'data', 'documentationRegistryApi.ts'), join(root, 'app', 'useDocumentationRegistry.ts'),
    join(root, 'app', 'routes', 'DocumentationRegistryRoute.tsx'),
    ...readdirSync(join(root, 'screens', 'DocumentationRegistry')).filter(f => f.endsWith('.tsx')).map(f => join(root, 'screens', 'DocumentationRegistry', f)),
  ];
  for (const file of files) {
    const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/packages\/domain|apps\/backend/.test(source), false, `${file}: must not import the domain or the backend`);
    for (const forbidden of ['generatedAtVersion', 'revisionCount <', 'revisionCount >', 'officialNumber ===', 'officialNumber !==', 'resolvePackageReadiness', 'forwardGate', 'hasFile ||', '.some((s) => s.hasFile', 'method === null']) {
      assert.equal(source.includes(forbidden), false, `${file}: contains "${forbidden}" — readiness belongs to the server`);
    }
  }
});

test('package counts read as Russian: 1 пакет / 2 пакета / 5 пакетов / 11 пакетов / 21 пакет', () => {
  assert.deepEqual([0, 1, 2, 4, 5, 11, 12, 21, 22, 25, 111].map(packagesCountText), ['0 пакетов', '1 пакет', '2 пакета', '4 пакета', '5 пакетов', '11 пакетов', '12 пакетов', '21 пакет', '22 пакета', '25 пакетов', '111 пакетов']);
});
