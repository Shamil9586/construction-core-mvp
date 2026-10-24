import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/gpr2-isolation';
import { WRITERS, WriterEntry } from '../apps/backend/src/writer-registry';
import { firstStatementCoordinates, scanBackend, scanSource } from './helpers/gpr2-writer-scan';

/**
 * GPR-2 R03b — the writer register is COMPLETE and EVERY coordinated writer really coordinates first (Roadmap R03b: "полный реестр relevant
 * writers … проверяющий ищет все bypass paths, включая legacy endpoint и importer"; TD §12.3 item 2).
 *
 * Source analysis with the TypeScript compiler. It is a static proof about the code, complementary to the native PostgreSQL tests that prove
 * the lock behaves; neither replaces the other.
 */
const registry = WRITERS as Record<string, WriterEntry>;
const sites = scanBackend();

test('R03b the scanner finds writers: it is not vacuous', () => {
    assert.ok(sites.length >= 80, 'expected the ~90 writer sites of the backend, found ' + sites.length);
    const found = scanSource('x/y.ts', `class A { async w(a){ return transaction(async (c) => { await c.query('x'); }); } async p(){ await pool.query("INSERT INTO t VALUES (1)"); await pool.query("SELECT 1"); } async q(){ await insert(pool,'t',{}); } async r(){ return getFileStore().transaction(async (c) => {}); } }`);
    assert.deepEqual(found.map(s => [s.key, s.kind]), [['x/y.ts#w', 'TX'], ['x/y.ts#p', 'POOLWRITE'], ['x/y.ts#q', 'POOLWRITE'], ['x/y.ts#r', 'TX']]);
});

test('R03b the first-statement check is real: a late, misnamed or missing coordinate() is caught', () => {
  const site = (body: string) => scanSource('x/y.ts', `class A { async w(a){ return transaction(async (c) => { ${body} }); } }`)[0];
  assert.equal(firstStatementCoordinates(site(`await coordinate(c, 'x/y.ts#w', a.tenantId, { work: 1 }); await c.query('x');`).callback!, 'x/y.ts#w'), true);
  assert.equal(firstStatementCoordinates(site(`await c.query('x'); await coordinate(c, 'x/y.ts#w', a.tenantId, { work: 1 });`).callback!, 'x/y.ts#w'), false, 'a row lock may already be held');
  assert.equal(firstStatementCoordinates(site(`await coordinate(c, 'x/y.ts#other', a.tenantId, { work: 1 });`).callback!, 'x/y.ts#w'), false, 'it must name its own registry id');
  assert.equal(firstStatementCoordinates(site(`coordinate(c, 'x/y.ts#w', a.tenantId, { work: 1 });`).callback!, 'x/y.ts#w'), false, 'it must be awaited');
  assert.equal(firstStatementCoordinates(site(`await c.query('x');`).callback!, 'x/y.ts#w'), false);
});

test('R03b every writer site is registered — a new writer cannot appear unclassified (bypass paths: legacy endpoints, importer, controllers)', () => {
    const missing = [...new Set(sites.map(s => s.key))].filter(k => !(k in registry));
    assert.deepEqual(missing, [], 'unregistered writers: ' + missing.join(', ') + ' — add each to apps/backend/src/writer-registry.ts with a mode and a reason');
});

test('R03b the register names no writer that no longer exists', () => {
    const present = new Set(sites.map(s => s.key));
    assert.deepEqual(Object.keys(registry).filter(k => !present.has(k)), []);
});

test('R03b a writer key is unambiguous (two sites with one key would hide one of them)', () => {
    const seen = new Map<string, number>();
    for (const s of sites)
        seen.set(s.key, (seen.get(s.key) ?? 0) + 1);
    assert.deepEqual([...seen].filter(([, n]) => n > 1).map(([k]) => k), []);
});

test('R03b every SHARED / EXCLUSIVE writer takes the coordination lock as the FIRST statement of its transaction callback', () => {
    const bad: string[] = [];
    for (const s of sites) {
        const entry = registry[s.key];
        if (!entry || entry.mode === 'NONE')
            continue;
        if (s.kind !== 'TX' || !s.callback || !firstStatementCoordinates(s.callback, s.key))
            bad.push(s.key + ' (line ' + s.line + ')');
    }
    assert.deepEqual(bad, [], 'writers that do not call `await coordinate(c, <own id>, …)` first');
});

test('R03b no NONE writer calls coordinate(), and no non-transaction write is registered as coordinated', () => {
    for (const s of sites) {
        const entry = registry[s.key];
        if (!entry)
            continue;
        if (s.kind === 'POOLWRITE')
            assert.equal(entry.mode, 'NONE', s.key + ' writes straight on the pool, outside any transaction, so it cannot hold a transaction lock');
        if (entry.mode === 'NONE' && s.callback)
            assert.ok(!s.callback.getText().includes('coordinate('), s.key + ' is registered NONE but calls coordinate()');
    }
});

test('R03b every NONE row carries a real reason', () => {
    for (const [k, e] of Object.entries(registry))
        assert.ok(e.mode !== 'NONE' || e.reason.trim().length >= 12, k + ' is NONE without a reason');
});

test('R03b the EXCLUSIVE set is exactly the scope-changing writers (a change of this list is a design decision, not an edit)', () => {
    const exclusive = Object.entries(registry).filter(([, e]) => e.mode === 'EXCLUSIVE').map(([k]) => k).sort();
    // GPR-2 R05d: Work generation from a finish system (finish-system.confirm) is scope-changing Work generation (TD §12.3 item 1).
    assert.deepEqual(exclusive, ['gpr2-r05-generation.ts#confirmGeneration', 'schedule-service.ts#approveDraft', 'service.ts#completeWorkPlanning', 'service.ts#createWork', 'service.ts#dependency']);
});

test('R03b the fact / SC / PTO / SDO writers named by the Technical Design are all SHARED', () => {
    for (const k of ['service.ts#progress', 'service.ts#recordPortionFact', 'service.ts#inspectionAction', 'service.ts#requestPortionInspection', 'service.ts#createDocumentationPackage',
        'service.ts#registerDocumentationCustomerAcceptance', 'service.ts#handoffDocumentationPackageToSdo', 'service.ts#changeSdoClosingStatus', 'service.ts#setSdoClosingPortionAllocation',
        'pto-work-assignment-service.ts#assign', 'aosr-service.ts#recordCustomerAcceptedQuantity'])
        assert.equal(registry[k]?.mode, 'SHARED', k);
});
