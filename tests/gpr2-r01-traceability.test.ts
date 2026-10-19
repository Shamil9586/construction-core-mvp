import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DECISIONS, CANCELLED_EXPECTATIONS, PINNED_SUITES, TD_SHA256, ROADMAP_SHA256, BASE_SHA, type TestRef } from './helpers/gpr2-decision-index';
import { renderMatrix, parseTap } from './helpers/gpr2-matrix';

/**
 * GPR-2 R01 — the decision-to-test index is checked, not just written (Roadmap R01 task 3; TD §15; decision C18).
 * A matrix that nobody verifies drifts; every claim below is something this test can fail on.
 */
const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => prefix + String(i + 1).padStart(2, '0'));
const ALL_IDS = [...ids('D', 24), ...ids('K', 4), ...ids('C', 18)];
const read = (file: string) => fs.readFileSync(file, 'utf8');
const sha = (text: string) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
const mentions = (file: string, fragment: string) => fs.existsSync(file) && read(file).includes(fragment);
const refProblems = (refs: TestRef[]) => refs.filter(r => !mentions(r.file, r.fragment)).map(r => `${r.file} ⟶ «${r.fragment}»`);

test('every decision D01–D24, K01–K04 and C01–C18 appears exactly once, in order, with its TD acceptance scenarios and a stage', () => {
  assert.deepEqual(DECISIONS.map(d => d.id), ALL_IDS, '24 D + 4 K + 18 C = 46 rows, none missing, none repeated');
  const stages = new Set(ids('R', 23).map(n => 'R' + String(Number(n.slice(1)) - 1).padStart(2, '0')));
  for (const d of DECISIONS) {
    assert.ok(d.title.length > 10, d.id + ' has a title');
    assert.ok(d.acceptance.length > 0 && d.acceptance.every(a => /^A(0[1-9]|[12]\d|30)$/.test(a)), d.id + ' acceptance scenarios are real A01–A30');
    assert.ok(d.stages.length > 0 && d.stages.every(s => stages.has(s)), d.id + ' stages are real R00–R22');
    assert.ok(['CONTRACT_PINNED', 'CONTRACT_PARTIAL', 'LATER_STAGE'].includes(d.r01), d.id);
    assert.ok(d.pins.length > 8, d.id + ' says what R01 pins (or why nothing)');
    assert.ok(d.tdSections.length > 3, d.id + ' cites the TD');
  }
  assert.match(TD_SHA256, /^[0-9a-f]{64}$/); assert.match(ROADMAP_SHA256, /^[0-9a-f]{64}$/); assert.equal(BASE_SHA, '48f3ce7e9c50b8bbaac67c6c3e4a7e0b94af7409');
});

test('every decision is honest about R01: PINNED / PARTIAL rows cite real new tests, LATER_STAGE rows cite none, and nothing claims a stage that has not run', () => {
  for (const d of DECISIONS) {
    if (d.r01 === 'LATER_STAGE') assert.deepEqual(d.r01Tests, [], d.id + ' is a later stage: R01 claims no test for it');
    else {
      assert.ok(d.r01Tests.length >= 1, d.id + ' cites at least one R01 test');
      if (d.r01 === 'CONTRACT_PINNED') assert.ok(d.r01Tests.length >= 1 && d.stages.length >= 1, d.id);
    }
    for (const r of d.r01Tests) assert.match(r.file, /^tests\/gpr2-r01-[a-z-]+\.test\.ts$/, d.id + ': an R01 test lives in a gpr2-r01-* file');
    for (const r of d.protectedTests) assert.doesNotMatch(r.file, /gpr2-r01/, d.id + ': a protected test is an EXISTING suite');
  }
  const count = (s: string) => DECISIONS.filter(d => d.r01 === s).length;
  assert.deepEqual([count('CONTRACT_PINNED'), count('CONTRACT_PARTIAL'), count('LATER_STAGE')], [9, 30, 7], 'the coverage split is a conscious number: changing it is changing a claim');
  assert.deepEqual(DECISIONS.filter(d => d.r01 === 'CONTRACT_PINNED').map(d => d.id), ['D11', 'D14', 'D15', 'D16', 'D18', 'D22', 'K03', 'C10', 'C18']);
  assert.deepEqual(DECISIONS.filter(d => d.r01 === 'LATER_STAGE').map(d => d.id), ['D03', 'D20', 'D24', 'C02', 'C06', 'C07', 'C15']);
});

test('every test the index names exists, in the file named, with that title — R01 tests and protected tests alike', () => {
  const missing = DECISIONS.flatMap(d => [...refProblems(d.r01Tests), ...refProblems(d.protectedTests)].map(p => `${d.id}: ${p}`));
  assert.deepEqual(missing, []);
  // and every R01 test file in the repository is cited by at least one decision (no orphan suites that guard nothing in the matrix)
  const cited = new Set(DECISIONS.flatMap(d => d.r01Tests.map(r => r.file)));
  const present = fs.readdirSync('tests').filter(f => /^gpr2-r01-.*\.test\.ts$/.test(f) && f !== 'gpr2-r01-traceability.test.ts').map(f => 'tests/' + f);
  assert.deepEqual(present.filter(f => !cited.has(f)).sort(), [], 'every R01 test file is mapped from at least one decision');
});

test('register of cancelled expectations: the seven rows of Roadmap §5.2, each citing real tests and production anchors and the decisions that cancel it', () => {
  assert.deepEqual(CANCELLED_EXPECTATIONS.map(e => e.n), [1, 2, 3, 4, 5, 6, 7]);
  const known = new Set(ALL_IDS);
  for (const e of CANCELLED_EXPECTATIONS) {
    assert.ok(e.oldExpectation && e.newExpectation, 'row ' + e.n);
    assert.ok(e.decisions.length > 0 && e.decisions.every(d => known.has(d)), `row ${e.n}: decisions are real`);
    assert.doesNotMatch(e.changedInStage, /^R01\b/, `row ${e.n}: R01 changes none of the old expectations`);
    assert.deepEqual(refProblems(e.tests), [], `row ${e.n} tests exist`);
    for (const a of e.productionAnchors) assert.ok(mentions(a.file, a.fragment), `row ${e.n}: ${a.file} ⟶ «${a.fragment}»`);
  }
  // row 7 has no test BY DESIGN of this register: the weighting is only in read-service.ts, so R17 must add the replacing test
  assert.deepEqual(CANCELLED_EXPECTATIONS.filter(e => e.tests.length === 0).map(e => e.n), [7]);
  // the overlap between the protected range and row 6 is recorded, not hidden
  assert.match(CANCELLED_EXPECTATIONS[5].note ?? '', /protected list/);
  // policy: the GPR-1 suites are not deleted wholesale (Roadmap §5.2) — they are all still present
  for (const f of ['tests/gpr-1-schedule-http.test.ts', 'tests/gpr-1-schedule-domain.test.ts', 'tests/gpr-1-schedule-postgres.test.ts']) assert.ok(fs.existsSync(f), f);
});

test('protected and registered suites are byte-identical to the base commit — R01 edited none of them (line endings normalised)', () => {
  const needed = new Set<string>([...CANCELLED_EXPECTATIONS.flatMap(e => e.tests.map(t => t.file)), ...DECISIONS.flatMap(d => d.protectedTests.map(t => t.file))]);
  for (const file of needed) assert.ok(file in PINNED_SUITES, file + ' is pinned');
  const changed = Object.entries(PINNED_SUITES).filter(([file, hash]) => sha(read(file)) !== hash).map(([file]) => file);
  assert.deepEqual(changed, [], 'a stage that must change one of these suites has to update this table deliberately, naming the decision that cancels the expectation');
});

test('R01 adds no migration (no number is reserved in advance) and commits no normative document', () => {
  const numbered = fs.readdirSync('infra').filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  assert.equal(numbered.length, 25);
  assert.equal(numbered.at(-1), '025_production_schedule.sql', 'the chain still ends at 025; the next number is decided by the real branch and ledger, not here');
  const offenders: string[] = [];
  const walk = (dir: string) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p); else if (/Technical_Design|Implementation_Roadmap|R01_Approved_Source|GPR-2_.*\.(md|zip)$/i.test(entry.name)) offenders.push(p);
  } };
  walk('.');
  assert.deepEqual(offenders, [], 'the approved design documents stay outside the repository until a separate decision');
});

test('the committed matrix document is exactly what the generator prints from the index (it cannot drift), and a TAP report adds one mark per referenced test', () => {
  assert.equal(read('docs/gpr-2-r01-decision-test-matrix.md'), renderMatrix(), 'regenerate with: node --import tsx scripts/gpr2-r01-matrix.ts --write');
  assert.deepEqual(parseTap('# comment\nok 3 - a title # SKIP\nnot ok 4 - another\n  ---\n  duration_ms: 1\n'), [{ title: 'a title', ok: true }, { title: 'another', ok: false }]);
  const marked = renderMatrix('ok 1 - D14: no approved GPR — no dates, no baseline\nnot ok 2 - D15: a Work outside the approved GPR is NOT_INCLUDED\n');
  assert.match(marked, /✔ `gpr2-r01-contracts` › D14: no approved GPR/);
  assert.match(marked, /✘ `gpr2-r01-contracts` › D15: a Work outside the approved GPR/);
  assert.match(marked, /\? `gpr2-r01-decimal` › NULL is not zero/, 'a test absent from the report is shown as "?", never silently as passed');
  assert.doesNotMatch(read('docs/gpr-2-r01-decision-test-matrix.md'), /[✔✘]/, 'the committed file carries no run results');
});
