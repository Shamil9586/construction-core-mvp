import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aosrDocxState, forwardGateMessage, resolveAosrDocumentaryReadiness, resolvePackageReadiness,
  METHOD_REQUIRED_MESSAGE, SCHEME_FILE_REQUIRED_MESSAGE, NO_CORE_AOSR_MESSAGE,
  type AosrDocumentFacts, type PackageReadinessFacts,
} from '../packages/domain/documentation-readiness';
import {
  awaitsEngineerAction, filterRegistryRows, pickLastUpdate, sortRegistryRows, summarizeRegistry,
  type RegistryPackageRow,
} from '../packages/domain/documentation-registry';
import { SCOPE_NOT_SELECTED_MESSAGE } from '../packages/domain/package-scope';

/**
 * ID-AUTO-2 — the pure rules behind the registry. The same functions decide the forward gate and the registry verdict, so these tests pin
 * the ID-AUTO-1 CORE / EXTERNAL rules themselves (no database, no HTTP).
 */
const aosr = (over: Partial<AosrDocumentFacts> = {}): AosrDocumentFacts => ({ id: 'a1', title: 'Грунтовка основания', officialNumber: 1, revisionCount: 1, generatedAtVersion: 3, version: 3, linkedSchemes: [{ id: 's1', hasFile: true }], ...over });
const pkg = (over: Partial<PackageReadinessFacts> = {}): PackageReadinessFacts => ({ hasScope: true, method: 'CORE', aosrs: [aosr()], schemes: [{ hasFile: true }], ...over });
const codes = (f: PackageReadinessFacts) => resolvePackageReadiness(f).reasons.map(r => r.code);

test('AOSR DOCX state: draft, current, and outdated after an edit — the official number does not matter once a revision exists', () => {
  assert.equal(aosrDocxState(aosr({ officialNumber: null, revisionCount: 0, generatedAtVersion: null, version: 1 })), 'NOT_GENERATED');
  assert.equal(aosrDocxState(aosr()), 'CURRENT');
  assert.equal(aosrDocxState(aosr({ version: 4 })), 'OUTDATED', 'edited (or relinked) after generation');
  assert.equal(aosrDocxState(aosr({ revisionCount: 0 })), 'NOT_GENERATED', 'a number without a successful generation is not a current act');
});

test('CORE: ready only when every Core AOSR has a current DOCX and a file-backed scheme covers it', () => {
  assert.deepEqual(resolvePackageReadiness(pkg()), { ready: true, reasons: [] });
  const draft = { id: 'a2', title: 'Штукатурка', officialNumber: null, revisionCount: 0, generatedAtVersion: null, version: 1 };
  assert.deepEqual(codes(pkg({ aosrs: [aosr(), aosr(draft)] })), ['AOSR_NOT_GENERATED'], 'a draft that is linked to a file-backed scheme is blocked only by its missing DOCX');
  assert.deepEqual(codes(pkg({ aosrs: [aosr(), aosr({ ...draft, linkedSchemes: [] })] })), ['AOSR_NOT_GENERATED', 'AOSR_SCHEME_MISSING'], 'an uncovered draft is blocked twice, each reason naming the act');
  assert.deepEqual(codes(pkg({ aosrs: [aosr({ version: 9 })] })), ['AOSR_DOCX_OUTDATED']);
  assert.deepEqual(codes(pkg({ aosrs: [] })), ['NO_CORE_AOSR']);
});

test('CORE: a metadata-only scheme (no file) never satisfies readiness — neither the package scheme nor an AOSR\'s coverage', () => {
  assert.deepEqual(codes(pkg({ schemes: [{ hasFile: false }] })), ['SCHEME_FILE_REQUIRED']);
  assert.deepEqual(codes(pkg({ schemes: [{ hasFile: false }, { hasFile: true }] })), [], 'one file-backed scheme is enough at package level');
  assert.deepEqual(codes(pkg({ aosrs: [aosr({ linkedSchemes: [{ id: 's9', hasFile: false }] })] })), ['AOSR_SCHEME_MISSING']);
  assert.deepEqual(codes(pkg({ aosrs: [aosr({ linkedSchemes: [] })] })), ['AOSR_SCHEME_MISSING']);
  assert.deepEqual(resolveAosrDocumentaryReadiness(aosr({ linkedSchemes: [{ id: 's9', hasFile: false }, { id: 's1', hasFile: true }] })), { ready: true, reasons: [] });
});

test('EXTERNAL: zero Core AOSRs / DOCX / numbers are valid — only the genuine scheme-file evidence remains', () => {
  assert.deepEqual(resolvePackageReadiness(pkg({ method: 'EXTERNAL', aosrs: [] })), { ready: true, reasons: [] });
  assert.deepEqual(codes(pkg({ method: 'EXTERNAL', aosrs: [], schemes: [] })), ['SCHEME_FILE_REQUIRED']);
  assert.deepEqual(codes(pkg({ method: 'EXTERNAL', aosrs: [], schemes: [{ hasFile: false }] })), ['SCHEME_FILE_REQUIRED']);
});

test('METHOD_UNSET and a missing scope are explicit blockers; nothing is inferred from the absence of AOSRs', () => {
  assert.deepEqual(codes(pkg({ method: null, aosrs: [] })), ['METHOD_UNSET'], 'no Core-AOSR complaint while the method is undeclared');
  assert.deepEqual(codes(pkg({ method: null, aosrs: [], schemes: [] })), ['METHOD_UNSET', 'SCHEME_FILE_REQUIRED']);
  assert.deepEqual(codes(pkg({ hasScope: false, method: null })), ['SCOPE_NOT_SELECTED', 'METHOD_UNSET']);
  const r = resolvePackageReadiness(pkg({ hasScope: false, method: null }));
  assert.deepEqual(r.reasons.map(x => x.target.kind), ['SCOPE', 'METHOD'], 'every blocker names where it is fixed');
});

test('every AOSR-related blocker points at the exact act; package-level blockers point at their section', () => {
  const r = resolvePackageReadiness(pkg({ aosrs: [aosr({ id: 'x', version: 5 }), aosr({ id: 'y', title: 'Б', linkedSchemes: [] })], schemes: [] }));
  assert.deepEqual(r.reasons.map(x => [x.code, x.target.kind, x.aosrId ?? null]), [
    ['AOSR_DOCX_OUTDATED', 'AOSR', 'x'], ['SCHEME_FILE_REQUIRED', 'SCHEMES', null], ['AOSR_SCHEME_MISSING', 'AOSR', 'y'],
  ]);
  assert.equal(resolvePackageReadiness(pkg({ aosrs: [] })).reasons[0].target.kind, 'AOSR_SECTION');
});

test('the forward gate message is the first failing stage with the wording the engineer already knows', () => {
  assert.equal(forwardGateMessage(resolvePackageReadiness(pkg())), null);
  assert.equal(forwardGateMessage(resolvePackageReadiness(pkg({ hasScope: false }))), SCOPE_NOT_SELECTED_MESSAGE);
  assert.equal(forwardGateMessage(resolvePackageReadiness(pkg({ method: null }))), METHOD_REQUIRED_MESSAGE);
  assert.equal(forwardGateMessage(resolvePackageReadiness(pkg({ aosrs: [] }))), NO_CORE_AOSR_MESSAGE);
  assert.equal(forwardGateMessage(resolvePackageReadiness(pkg({ schemes: [] }))), SCHEME_FILE_REQUIRED_MESSAGE);
  const two = pkg({ aosrs: [aosr({ title: 'А', version: 8 }), aosr({ id: 'a2', title: 'Б', officialNumber: null, revisionCount: 0, generatedAtVersion: null, version: 1, linkedSchemes: [] })] });
  assert.equal(forwardGateMessage(resolvePackageReadiness(two)), 'Не сформирован актуальный DOCX у АОСР: «А», «Б». Сформируйте его (или удалите черновик, если АОСР в Core не нужен)');
  assert.match(forwardGateMessage(resolvePackageReadiness(pkg({ aosrs: [aosr({ linkedSchemes: [] })] })))!, /Нет исполнительной схемы с файлом у АОСР: «Грунтовка основания»/);
});

/* ------------------------------ registry rows ------------------------------ */

const row = (over: Partial<RegistryPackageRow> & { id?: string } = {}): RegistryPackageRow => ({
  packageId: over.id ?? 'p1', workId: 'w1', workName: 'Штукатурка стен',
  scope: { hasScope: true, zoneSummary: '1 этаж', zones: ['1 этаж'], currentQuantity: { quantity: '498.0000', unit: 'м²', source: 'INTERNAL_SC' } },
  responsible: { id: 'u1', name: 'Иванов' }, status: 'DRAFT', aosrMethod: 'CORE', aosrCount: 0, aosrGeneratedCount: 0, schemeCount: 0, schemeFileBackedCount: 0,
  readiness: { ready: false, reasons: [] }, awaitingEngineerAction: true, lastUpdate: { at: '2026-01-01T00:00:00.000Z', kind: 'PACKAGE_CREATED' }, aosrs: [], ...over,
});

test('summary counts are derived from the very rows they summarise', () => {
  const rows = [row({ id: 'a', readiness: { ready: true, reasons: [] }, awaitingEngineerAction: false }), row({ id: 'b' }), row({ id: 'c', awaitingEngineerAction: false })];
  assert.deepEqual(summarizeRegistry(rows), { activePackages: 3, ready: 1, notReady: 2, awaitingEngineerAction: 1 });
  assert.deepEqual(summarizeRegistry([]), { activePackages: 0, ready: 0, notReady: 0, awaitingEngineerAction: 0 });
});

test('"awaiting engineer action" is the existing PTO attention classifier, not a new rule', () => {
  for (const [status, expected] of [['DRAFT', true], ['PREPARING', true], ['CORRECTING', true], ['RETURNED', true], ['READY_FOR_PRESENTATION', false], ['PRESENTED', false], ['ACCEPTED_BY_CUSTOMER', false]] as [string, boolean][])
    assert.equal(awaitsEngineerAction(status), expected, status);
});

test('filters: responsible, status, readiness, method (incl. UNSET), and a Work / zone / AOSR search; all combinable', () => {
  const rows = [
    row({ id: 'a', readiness: { ready: true, reasons: [] }, aosrMethod: 'EXTERNAL' }),
    row({ id: 'b', workName: 'Окраска', aosrMethod: null, responsible: { id: 'u2', name: 'Петров' }, status: 'PREPARING', scope: { hasScope: true, zoneSummary: '2 этаж', zones: ['2 этаж'], currentQuantity: null } }),
    row({ id: 'c', aosrs: [{ id: 'x', number: 7, title: 'Грунтовка основания' } as any] }),
  ];
  const ids = (f: any) => filterRegistryRows(rows, f).map(r => r.packageId);
  assert.deepEqual(ids({}), ['a', 'b', 'c']);
  assert.deepEqual(ids({ ready: true }), ['a']);
  assert.deepEqual(ids({ ready: false }), ['b', 'c']);
  assert.deepEqual(ids({ method: 'UNSET' }), ['b']);
  assert.deepEqual(ids({ method: 'CORE' }), ['c']);
  assert.deepEqual(ids({ method: 'EXTERNAL' }), ['a']);
  assert.deepEqual(ids({ responsibleUserId: 'u2' }), ['b']);
  assert.deepEqual(ids({ status: 'PREPARING' }), ['b']);
  assert.deepEqual(ids({ q: 'окраск' }), ['b'], 'work name, case-insensitive');
  assert.deepEqual(ids({ q: '2 этаж' }), ['b'], 'zone');
  assert.deepEqual(ids({ q: 'ГРУНТОВКА' }), ['c'], 'AOSR title');
  assert.deepEqual(ids({ q: '7' }), ['c'], 'AOSR number');
  assert.deepEqual(ids({ q: '   ' }), ['a', 'b', 'c'], 'a blank search is no search');
  assert.deepEqual(ids({ ready: false, status: 'DRAFT' }), ['c']);
});

test('the working list puts what needs attention first, then orders by work and zone, independent of input order', () => {
  const rows = [
    row({ id: 'z', workName: 'Б', readiness: { ready: true, reasons: [] } }),
    row({ id: 'y', workName: 'Б' }),
    row({ id: 'x', workName: 'А', scope: { hasScope: true, zoneSummary: '10 этаж', zones: [], currentQuantity: null } }),
    row({ id: 'w', workName: 'А', scope: { hasScope: true, zoneSummary: '2 этаж', zones: [], currentQuantity: null } }),
  ];
  assert.deepEqual(sortRegistryRows(rows).map(r => r.packageId), ['w', 'x', 'y', 'z']);
  assert.deepEqual(sortRegistryRows([...rows].reverse()).map(r => r.packageId), ['w', 'x', 'y', 'z']);
});

test('last meaningful update: the newest event wins; an exact tie goes to the more descriptive (earlier-listed) one', () => {
  const t = (s: string) => new Date(s);
  assert.deepEqual(pickLastUpdate([{ at: t('2026-02-01T10:00:00Z'), kind: 'STATUS_CHANGED' }, { at: t('2026-03-01T10:00:00Z'), kind: 'AOSR_GENERATED' }]), { at: '2026-03-01T10:00:00.000Z', kind: 'AOSR_GENERATED' });
  assert.equal(pickLastUpdate([{ at: '2026-02-01T10:00:00Z', kind: 'STATUS_CHANGED' }, { at: '2026-02-01T10:00:00Z', kind: 'PACKAGE_CHANGED' }])!.kind, 'STATUS_CHANGED');
  assert.deepEqual(pickLastUpdate([{ at: null, kind: 'STATUS_CHANGED' }, { at: undefined, kind: 'METHOD_CHOSEN' }, { at: 'junk', kind: 'AOSR_CHANGED' }]), null);
});
