import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DECISIONS, TD_SHA256, ROADMAP_SHA256 } from './helpers/gpr2-decision-index';
import { renderMatrix, parseTap } from './helpers/gpr2-matrix';
import { extract } from '../scripts/gpr2-extract-normative';

/**
 * GPR-2 R01 — the decision-to-test index is compared with the NORMATIVE documents, not with itself (finding R01-B06).
 *
 * The rejected candidate listed `A04–A06` as [A04, A06], `A01–A30` as [A01, A30] and so on, and its own test only compared the index with the generator's
 * output — so the truncation could not be seen. Three things here cannot be fooled by that:
 *   1. tests/fixtures/gpr2-normative-expectations.json — read from the two documents by scripts/gpr2-extract-normative.ts (own range expansion, no shared
 *      code with the index or the generator), with the sha256 of the files it was read from; checked against the pinned hashes of the index;
 *   2. this file's own expansion of the RAW text of every row (`tdRaw`, copied from the document into the fixture) — a third implementation;
 *   3. the ten discrepancies the independent reviewer found, written out BY HAND below, row by row, from the Technical Design text.
 */
type Fixture = { tdSha256: string; roadmapSha256: string; stageAcceptance: Record<string, string[]>;
  decisions: Record<string, { tdRaw: string; acceptance: string[]; stages: string[]; stagesFrom: string }> };
const fixture: Fixture = JSON.parse(fs.readFileSync('tests/fixtures/gpr2-normative-expectations.json', 'utf8'));
const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => prefix + String(i + 1).padStart(2, '0'));
const ALL_IDS = [...ids('D', 24), ...ids('K', 4), ...ids('C', 18)];
const A = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => 'A' + String(from + i).padStart(2, '0'));

/** The comparison under test: every way the index can disagree with the normative expectation. */
export function disagreements(index: { id: string; acceptance: string[]; stages: string[] }[], expected: Fixture['decisions']): string[] {
  const out: string[] = [];
  for (const d of index) {
    const e = expected[d.id];
    if (!e) { out.push(`${d.id}: not in the normative documents`); continue; }
    const missingA = e.acceptance.filter(a => !d.acceptance.includes(a)), extraA = d.acceptance.filter(a => !e.acceptance.includes(a));
    const missingS = e.stages.filter(s => !d.stages.includes(s)), extraS = d.stages.filter(s => !e.stages.includes(s));
    if (missingA.length) out.push(`${d.id}: acceptance missing ${missingA.join(',')}`);
    if (extraA.length) out.push(`${d.id}: acceptance has extra ${extraA.join(',')}`);
    if (missingS.length) out.push(`${d.id}: stages missing ${missingS.join(',')}`);
    if (extraS.length) out.push(`${d.id}: stages has extra ${extraS.join(',')}`);
  }
  for (const id of Object.keys(expected)) if (!index.some(d => d.id === id)) out.push(`${id}: missing from the index`);
  return out;
}

test('the fixture is read from exactly the documents the index pins (sha256), and has every row of TD §2 and §3 and every stage of the Roadmap', () => {
  assert.equal(fixture.tdSha256, TD_SHA256, 'Technical Design');
  assert.equal(fixture.roadmapSha256, ROADMAP_SHA256, 'Implementation Roadmap');
  assert.deepEqual(Object.keys(fixture.decisions), ALL_IDS, '24 D + 4 K + 18 C, in order');
  assert.deepEqual(Object.keys(fixture.stageAcceptance), ids('R', 22).map((_, i) => 'R' + String(i + 1).padStart(2, '0')), 'R01–R22 have an Acceptance line (R00 has none)');
  assert.deepEqual(fixture.stageAcceptance.R01, ['A19']);
  assert.deepEqual(fixture.stageAcceptance.R21, A(1, 30), 'R21: «весь A01–A30» is all thirty scenarios, not A01 and A30');
  assert.deepEqual(fixture.stageAcceptance.R17, ['A20', 'A21', 'A26', 'A27', 'A28'], 'R17: A26–A28 is three scenarios');
});

test('the index equals the normative documents: every acceptance scenario of every row, every range expanded, and every derived stage', () => {
  const found = disagreements(DECISIONS, fixture.decisions);
  assert.deepEqual(found, [], 'regenerate the index columns from tests/fixtures/gpr2-normative-expectations.json');
  for (const d of DECISIONS) {
    assert.deepEqual(d.acceptance, [...d.acceptance].sort(), d.id + ' acceptance is sorted');
    assert.equal(new Set(d.acceptance).size, d.acceptance.length, d.id + ' has no duplicate scenario');
  }
});

test('the raw text of every row is expanded independently here — a range includes every scenario between its ends (third implementation)', () => {
  let ranges = 0;
  for (const [id, row] of Object.entries(fixture.decisions)) {
    const afterStages = id.startsWith('C') ? row.tdRaw.slice(row.tdRaw.indexOf(';') + 1) : row.tdRaw.slice(row.tdRaw.indexOf(';') + 1);
    const expected = new Set<string>();
    for (const token of afterStages.split(',').map(t => t.trim()).filter(Boolean)) {
      const m = /^A(\d{2})(?:\s*[–-]\s*A?(\d{2}))?$/.exec(token);
      assert.ok(m, `${id}: token «${token}» is an A-scenario or a range`);
      const from = Number(m![1]), to = m![2] ? Number(m![2]) : from;
      if (m![2]) ranges++;
      for (let n = from; n <= to; n++) expected.add('A' + String(n).padStart(2, '0'));
    }
    assert.deepEqual([...expected].sort(), row.acceptance, `${id} «${row.tdRaw}»`);
    const indexed = DECISIONS.find(d => d.id === id)!;
    assert.deepEqual(indexed.acceptance, [...expected].sort(), `${id}: the index lists every scenario of «${row.tdRaw}»`);
  }
  assert.ok(ranges >= 10, 'the documents contain at least ten ranges: ' + ranges);
});

test('the ten discrepancies the independent reviewer found are closed — each row lists EVERY scenario of its range (expected values written by hand from the Technical Design)', () => {
  const HAND: Record<string, string[]> = {
    D04: ['A04', 'A05', 'A06'],                                   // «§5–6; A04–A06»
    D07: ['A08', 'A09', 'A10'],                                   // «§8; A08–A10»
    D19: ['A04', 'A05', 'A06', 'A23'],                            // «§6; A04–A06, A23»
    K01: ['A20', 'A26', 'A27', 'A28'],                            // «§7; A20, A26–A28»
    K03: ['A21', 'A22', 'A23'],                                   // «§9, §11; A21–A23»
    K04: ['A08', 'A09', 'A10'],                                   // «§8; A08–A10»
    C05: ['A04', 'A05', 'A06'],                                   // «R06–R07; A04–A06»
    C12: ['A21', 'A22', 'A23'],                                   // «R09; A21–A23»
    C14: ['A08', 'A09', 'A10', 'A14'],                            // «R10, R14, R18; A08–A10, A14»
    C18: A(1, 30)                                                 // «Каждый этап; A01–A30» — thirty scenarios, not [A01, A30]
  };
  assert.equal(Object.keys(HAND).length, 10);
  for (const [id, expected] of Object.entries(HAND)) {
    assert.deepEqual(DECISIONS.find(d => d.id === id)!.acceptance, expected, id + ' (index)');
    assert.deepEqual(fixture.decisions[id].acceptance, expected, id + ' (fixture)');
  }
  assert.equal(DECISIONS.find(d => d.id === 'C18')!.acceptance.length, 30);
  // the rows the reviewer did NOT list were already right and stay right: a single scenario or a plain list is unchanged
  assert.deepEqual(DECISIONS.find(d => d.id === 'D01')!.acceptance, ['A01', 'A25']);
  assert.deepEqual(DECISIONS.find(d => d.id === 'D21')!.acceptance, ['A21', 'A22'], 'D21 «A21–A22»: both ends');
});

test('derived stages are recomputed from the full ranges: R21 («весь A01–A30») accepts every D / K decision; R17 accepts A27; C-row stages come from the row; C18 is every stage', () => {
  for (const d of DECISIONS.filter(x => /^[DK]/.test(x.id))) {
    assert.ok(d.stages.includes('R21'), `${d.id}: R21 accepts all of A01–A30`);
    const recomputed = Object.keys(fixture.stageAcceptance).filter(r => fixture.stageAcceptance[r].some(a => d.acceptance.includes(a))).sort();
    assert.deepEqual(d.stages, recomputed, `${d.id}: stages = the Roadmap stages whose Acceptance names one of its scenarios`);
  }
  assert.ok(DECISIONS.find(d => d.id === 'K01')!.stages.includes('R17'));
  assert.deepEqual(DECISIONS.find(d => d.id === 'D04')!.stages, ['R02', 'R03', 'R04', 'R06', 'R07', 'R19', 'R21'], 'A05 (R02, R04, R19) is part of D04\'s A04–A06');
  assert.deepEqual(DECISIONS.find(d => d.id === 'C05')!.stages, ['R06', 'R07'], 'a C row keeps the stages the TD row names («R06–R07»)');
  assert.deepEqual(DECISIONS.find(d => d.id === 'C17')!.stages, ['R00', 'R03', 'R19', 'R20', 'R21', 'R22'], '«R19–R22» is four stages');
  assert.deepEqual(DECISIONS.find(d => d.id === 'C18')!.stages, ids('R', 23).map((_, i) => 'R' + String(i).padStart(2, '0')), '«Каждый этап»: R00–R22');
});

test('the check can fail: a truncated range, a collapsed C18, a missing derived stage and a forged extra are each reported (so a green run means something)', () => {
  const clone = () => DECISIONS.map(d => ({ id: d.id, acceptance: [...d.acceptance], stages: [...d.stages] }));
  assert.deepEqual(disagreements(clone(), fixture.decisions), []);
  const truncated = clone(); truncated.find(d => d.id === 'D04')!.acceptance = ['A04', 'A06'];
  assert.deepEqual(disagreements(truncated, fixture.decisions), ['D04: acceptance missing A05']);
  const collapsed = clone(); collapsed.find(d => d.id === 'C18')!.acceptance = ['A01', 'A30'];
  assert.equal(disagreements(collapsed, fixture.decisions).length, 1);
  assert.match(disagreements(collapsed, fixture.decisions)[0], /^C18: acceptance missing A02,A03,A04.*A29$/);
  const stage = clone(); stage.find(d => d.id === 'K01')!.stages = stage.find(d => d.id === 'K01')!.stages.filter(s => s !== 'R21');
  assert.deepEqual(disagreements(stage, fixture.decisions), ['K01: stages missing R21']);
  const forged = clone(); forged.find(d => d.id === 'D02')!.acceptance.push('A30');
  assert.deepEqual(disagreements(forged, fixture.decisions), ['D02: acceptance has extra A30']);
  assert.deepEqual(disagreements(clone().slice(1), fixture.decisions), ['D01: missing from the index']);
});

test('the matrix document lists every scenario of every row (no «A01–A30» shorthand for a row that has thirty), has one trailing newline, and never counts a skipped test as a pass', () => {
  const doc = fs.readFileSync('docs/gpr-2-r01-decision-test-matrix.md', 'utf8');
  assert.ok(doc.endsWith('\n') && !doc.endsWith('\n\n'), 'exactly one trailing newline');
  const c18 = /^\| C18 \|.*$/m.exec(doc)![0];
  for (const a of A(1, 30)) assert.ok(c18.includes(a), 'C18 row lists ' + a);
  assert.ok(doc.includes('| D04 | Original ledger, current approved quantity, nested allocations | CONTRACT_PARTIAL |') && /\| A04, A05, A06 \|/.test(doc));
  assert.doesNotMatch(c18, /A01–A30/);
  // TAP directives: a SKIP or TODO is shown as ⊘, never as ✔
  assert.deepEqual(parseTap('ok 1 - passes\nnot ok 2 - fails\nok 3 - skipped # SKIP reason\nok 4 - todo # TODO later\nnot ok 5 - todo fail # TODO\n').map(r => r.status), ['pass', 'fail', 'skip', 'todo', 'todo']);
  const marked = renderMatrix('ok 1 - D14: no approved GPR — no dates, no baseline # SKIP flaky\nok 2 - K02: REBASELINE_REQUIRED\nnot ok 3 - R01-B07 positives\n');
  assert.match(marked, /⊘ `gpr2-r01-contracts` › D14: no approved GPR/);
  assert.match(marked, /✔ `gpr2-r01-contracts` › K02: REBASELINE_REQUIRED/);
  assert.match(marked, /✘ `gpr2-r01-corrective-projection` › R01-B07 positives/);
});

// Optional: re-derive the fixture from the two documents when they are supplied. Skipped (and counted as skipped, not as a pass) otherwise — the
// documents are deliberately NOT in this repository.
const TD_PATH = process.env.GPR2_TD_PATH, ROADMAP_PATH = process.env.GPR2_ROADMAP_PATH;
test('OPTIONAL — the fixture equals a fresh extraction from the documents (needs GPR2_TD_PATH and GPR2_ROADMAP_PATH)', { skip: !(TD_PATH && ROADMAP_PATH) && 'the normative documents are not in the repository; set GPR2_TD_PATH and GPR2_ROADMAP_PATH to re-derive' }, () => {
  const fresh = extract(fs.readFileSync(TD_PATH!, 'utf8'), fs.readFileSync(ROADMAP_PATH!, 'utf8'));
  assert.deepEqual(JSON.parse(JSON.stringify(fresh)), fixture);
});
