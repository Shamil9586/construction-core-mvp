import { DECISIONS, CANCELLED_EXPECTATIONS, BASE_SHA, TD_SHA256, ROADMAP_SHA256, type TestRef, type DecisionEntry } from './gpr2-decision-index';

/**
 * Renders the decision-to-test matrix (docs/gpr-2-r01-decision-test-matrix.md). With no argument the output is static and is what is committed — a test
 * keeps the file equal to this function's output. With the text of a TAP report (`node --test` output) every test reference also carries the result of
 * that run: ✔ passed, ✘ failed, ⊘ skipped or todo (NOT a pass), ? not found in the report.
 */
export type TapStatus = 'pass' | 'fail' | 'skip' | 'todo';
export interface TapResult { title: string; status: TapStatus }
export function parseTap(text: string): TapResult[] {
  const out: TapResult[] = [];
  for (const line of text.split('\n')) {
    const m = /^(not )?ok \d+ - (.+?)(?: # (SKIP|TODO)\b.*)?$/i.exec(line);
    if (!m) continue;
    const directive = m[3]?.toUpperCase();
    out.push({ title: m[2], status: directive === 'SKIP' ? 'skip' : directive === 'TODO' ? 'todo' : m[1] ? 'fail' : 'pass' });
  }
  return out;
}
const short = (file: string) => file.replace(/^tests\//, '').replace(/\.test\.ts$/, '');
const mark = (ref: TestRef, tap?: TapResult[]) => {
  if (!tap) return '';
  const hits = tap.filter(t => t.title.includes(ref.fragment));
  if (hits.length === 0) return '? ';
  if (hits.some(h => h.status === 'fail')) return '✘ ';
  return hits.every(h => h.status === 'pass') ? '✔ ' : '⊘ ';
};
const refs = (list: TestRef[], tap?: TapResult[]) => list.length ? list.map(r => `${mark(r, tap)}\`${short(r.file)}\` › ${r.fragment.replace(/\|/g, '\\|')}`).join('<br>') : '—';

export function renderMatrix(tapText?: string): string {
  const tap = tapText === undefined ? undefined : parseTap(tapText);
  const count = (s: DecisionEntry['r01']) => DECISIONS.filter(d => d.r01 === s).length;
  const lines: string[] = [];
  lines.push('# GPR-2 R01 — decision-to-test matrix', '');
  lines.push('Generated from `tests/helpers/gpr2-decision-index.ts` by `scripts/gpr2-r01-matrix.ts`; `tests/gpr2-r01-traceability.test.ts` fails if this file differs from the generator\'s output.', '');
  lines.push(`Base commit \`${BASE_SHA}\`. Normative sources (NOT in this repository; sha256): Technical Design \`${TD_SHA256}\`, Implementation Roadmap \`${ROADMAP_SHA256}\`.`, '');
  lines.push('**Status words describe R01 contract coverage only — never how much behaviour exists.** `CONTRACT_PINNED` — everything the Roadmap assigns to R01 for the decision (types, enums, transitions, errors, schemas, grants) is fixed and tested. `CONTRACT_PARTIAL` — R01 fixes only the part named under "R01 pins"; the rest belongs to the listed stages. `LATER_STAGE` — nothing for R01 to pin. **No row claims the decision is implemented** (TD §0: LOCKED → DESIGNED); "Accepted by" are the independent acceptance scenarios of TD §15 that will accept it, not results.', '');
  lines.push(`Coverage of the 46 decisions: ${count('CONTRACT_PINNED')} pinned · ${count('CONTRACT_PARTIAL')} partial · ${count('LATER_STAGE')} later stage.`, '');
  if (tap) lines.push('Test marks: ✔ passed in the supplied run · ✘ failed · ⊘ skipped or todo (not a pass) · ? not found in the report.', '');
  lines.push('## Matrix', '', '| ID | Decision | R01 contract coverage | R01 tests | Protected tests | Accepted by (every scenario, ranges expanded) | Stages |', '|---|---|---|---:|---:|---|---|');
  for (const d of DECISIONS) lines.push(`| ${d.id} | ${d.title} | ${d.r01} | ${d.r01Tests.length} | ${d.protectedTests.length} | ${d.acceptance.join(', ')} | ${d.stages.join(', ')} |`);
  lines.push('', '## Per decision', '');
  for (const d of DECISIONS) {
    lines.push(`### ${d.id} — ${d.title}`, '', `- **R01 contract coverage:** ${d.r01} · **TD:** ${d.tdSections}`, `- **Accepted by (A-scenarios, expanded):** ${d.acceptance.join(', ')} · **Stages:** ${d.stages.join(', ')}`, `- **R01 pins:** ${d.pins}`, `- **R01 tests:** ${refs(d.r01Tests, tap)}`, `- **Protected (existing) tests:** ${refs(d.protectedTests, tap)}`, '');
  }
  lines.push('## Register of cancelled expectations (Roadmap §5.2)', '', 'R01 changes **none** of these tests. Each is changed by the stage named, citing the decision; `PINNED_SUITES` holds the sha256 of every one of them at the base commit.', '');
  for (const e of CANCELLED_EXPECTATIONS) {
    lines.push(`### ${e.n}. ${e.oldExpectation}`, '', `- **Replaced by:** ${e.newExpectation}`, `- **Decisions:** ${e.decisions.join(', ')} · **Changed in:** ${e.changedInStage}`,
      `- **Tests that assert the old expectation:** ${refs(e.tests, tap)}`, `- **Production anchors:** ${e.productionAnchors.map(a => `\`${a.file}\` («${a.fragment}»)`).join('; ')}`, ...(e.note ? [`- **Note:** ${e.note}`] : []), '');
  }
  return lines.join('\n').replace(/\n+$/, '') + '\n';
}
