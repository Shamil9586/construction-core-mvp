// Construction Core — GPR-2 CI Foundation: result classification.
// Turns raw runtime evidence into per-file, per-check and gate outcomes, using ONLY the profile from the workflow commit as the oracle.
//
// Vocabulary (backend-testing §8):  PASS | FAIL | SKIP | NOT RUN | ENVIRONMENT BLOCKED
//   PASS                 executed and every criterion of the profile met (exact counts, no failures/cancellations/todo/unexpected skips)
//   FAIL                 executed and a criterion violated — including a missing required test file, a count mismatch or a timeout
//   SKIP                 executed, but the runner reported every test as skipped (nothing was asserted)
//   NOT RUN              no execution record exists (job cancelled, earlier harness step failed, evidence not uploaded)
//   ENVIRONMENT BLOCKED  the harness could not provide a prerequisite (dependencies, PostgreSQL, Chromium, test database reset)
// SKIP and NOT RUN are never merged, and neither is ever counted as PASS.
//
// Gate verdicts (technical only — never an acceptance):
//   TECHNICAL_GATES_PASSED            every mandatory check PASS, identity re-verified, cleanup verified
//   TECHNICAL_GATES_FAILED            a mandatory check FAIL or SKIP, or identity/cleanup refused
//   INCONCLUSIVE_ENVIRONMENT_BLOCKED  no mandatory failure, but a mandatory check is ENVIRONMENT BLOCKED or NOT RUN
import fs from 'node:fs';
import path from 'node:path';

export const S = { PASS: 'PASS', FAIL: 'FAIL', SKIP: 'SKIP', NOT_RUN: 'NOT RUN', BLOCKED: 'ENVIRONMENT BLOCKED' };
export const GATE = { PASSED: 'TECHNICAL_GATES_PASSED', FAILED: 'TECHNICAL_GATES_FAILED', INCONCLUSIVE: 'INCONCLUSIVE_ENVIRONMENT_BLOCKED' };

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const n = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/** node:test TAP summary: the last "# <key> <value>" lines of a log. */
export function parseTapSummary(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) (\S+)\s*$/.exec(line);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

export function classifyNodeFile(spec, rec, check) {
  const reasons = [];
  if (!rec) return { path: spec.path, status: S.NOT_RUN, expected_tests: spec.expect_tests, reasons: ['no execution record'] };
  const base = { path: spec.path, expected_tests: spec.expect_tests, exit_code: rec.exit_code ?? null, seconds: rec.seconds ?? null, counts: rec.counts ?? {}, log: rec.log ?? null, junit: rec.junit ?? null };
  if (rec.state === 'MISSING') return { ...base, status: S.FAIL, reasons: ['required test file is missing or empty in the candidate'] };
  if (rec.state === 'DB_RESET_FAILED') return { ...base, status: S.BLOCKED, reasons: ['the disposable test database could not be recreated'] };
  if (rec.state === 'BLOCKED') return { ...base, status: S.BLOCKED, reasons: [rec.reason || 'prerequisite unavailable'] };
  if (rec.state !== 'EXECUTED') return { ...base, status: S.NOT_RUN, reasons: ['file was not executed'] };
  const c = rec.counts || {};
  const tests = n(c.tests), pass = n(c.pass), fail = n(c.fail), cancelled = n(c.cancelled), skipped = n(c.skipped), todo = n(c.todo);
  if (rec.timed_out) reasons.push(`timed out after ${check.file_timeout_seconds}s`);
  if ([tests, pass, fail, cancelled, skipped, todo].some(v => v === null)) reasons.push('runner summary (tests/pass/fail/cancelled/skipped/todo) is incomplete');
  else {
    if (tests > 0 && skipped === tests && fail === 0 && cancelled === 0) return { ...base, status: S.SKIP, reasons: [`all ${tests} tests skipped`] };
    if (tests !== spec.expect_tests) reasons.push(`expected exactly ${spec.expect_tests} tests, runner reported ${tests}`);
    if (fail) reasons.push(`${fail} failed`);
    if (cancelled) reasons.push(`${cancelled} cancelled`);
    if (todo) reasons.push(`${todo} todo`);
    if (skipped && !check.allow_skip) reasons.push(`${skipped} unexpectedly skipped`);
    const required = check.allow_skip ? spec.expect_tests - skipped : spec.expect_tests;
    if (pass !== required) reasons.push(`expected ${required} passing, runner reported ${pass}`);
  }
  if (rec.exit_code !== 0) reasons.push(`exit code ${rec.exit_code}`);
  return { ...base, status: reasons.length ? S.FAIL : S.PASS, reasons };
}

function combine(statuses) {
  if (statuses.includes(S.FAIL)) return S.FAIL;
  if (statuses.includes(S.BLOCKED)) return S.BLOCKED;
  if (statuses.includes(S.NOT_RUN)) return S.NOT_RUN;
  if (statuses.length && statuses.every(s => s === S.SKIP)) return S.SKIP;
  if (statuses.includes(S.SKIP)) return S.FAIL; // a partly skipped check is incomplete evidence
  return S.PASS;
}

export function classifyPlaywright(check, rec, rawDir) {
  const base = { exit_code: rec?.exit_code ?? null, expected_passed: check.expect_passed };
  if (!rec) return { ...base, status: S.NOT_RUN, reasons: ['no execution record'] };
  if (rec.state === 'BLOCKED') return { ...base, status: S.BLOCKED, reasons: [rec.reason || 'prerequisite unavailable'] };
  if (rec.state === 'MISSING') return { ...base, status: S.FAIL, reasons: ['playwright config is missing in the candidate'] };
  if (rec.state !== 'EXECUTED') return { ...base, status: S.NOT_RUN, reasons: ['not executed'] };
  const report = rec.report ? readJson(path.join(rawDir, rec.report)) : null;
  const reasons = [];
  if (rec.timed_out) reasons.push(`timed out after ${check.timeout_seconds}s`);
  if (!report || !report.stats) return { ...base, status: S.FAIL, reasons: [...reasons, 'no Playwright JSON report (run did not complete)'] };
  const st = report.stats;
  const tests = [];
  const walk = (suite, trail) => {
    for (const s of suite.suites || []) walk(s, [...trail, s.title].filter(Boolean));
    for (const sp of suite.specs || []) for (const t of sp.tests || []) tests.push({ title: [...trail, sp.title].join(' › '), project: t.projectName || '', status: t.status, outcome: (t.results || []).map(r => r.status) });
  };
  for (const s of report.suites || []) walk(s, [s.title]);
  const counts = { expected: st.expected ?? null, unexpected: st.unexpected ?? null, flaky: st.flaky ?? null, skipped: st.skipped ?? null, total: tests.length };
  if ((report.errors || []).length) reasons.push(`${report.errors.length} global error(s) reported`);
  if (counts.total > 0 && counts.skipped === counts.total) return { ...base, counts, tests, status: S.SKIP, reasons: ['all browser tests skipped'] };
  if (counts.expected !== check.expect_passed) reasons.push(`expected exactly ${check.expect_passed} passing browser tests, report has ${counts.expected}`);
  if (counts.unexpected) reasons.push(`${counts.unexpected} failed`);
  if (counts.flaky) reasons.push(`${counts.flaky} flaky (retries are disabled for acceptance)`);
  if (counts.skipped && !check.allow_skip) reasons.push(`${counts.skipped} unexpectedly skipped`);
  if (counts.total !== check.expect_passed + (check.allow_skip ? counts.skipped : 0)) reasons.push(`report lists ${counts.total} tests, profile expects ${check.expect_passed}`);
  if (rec.exit_code !== 0) reasons.push(`exit code ${rec.exit_code}`);
  return { ...base, counts, tests, status: reasons.length ? S.FAIL : S.PASS, reasons };
}

export function classifyScript(check, rec) {
  if (!rec) return { status: S.NOT_RUN, reasons: ['no execution record'] };
  if (rec.state === 'BLOCKED') return { status: S.BLOCKED, reasons: [rec.reason || 'prerequisite unavailable'], exit_code: null };
  if (rec.state === 'MISSING') return { status: S.FAIL, reasons: [`package.json has no "${check.script}" script`], exit_code: null };
  if (rec.state !== 'EXECUTED') return { status: S.NOT_RUN, reasons: ['not executed'] };
  const reasons = [];
  if (rec.timed_out) reasons.push(`timed out after ${check.timeout_seconds}s`);
  if (rec.exit_code !== 0) reasons.push(`exit code ${rec.exit_code}`);
  return { status: reasons.length ? S.FAIL : S.PASS, reasons, exit_code: rec.exit_code, seconds: rec.seconds ?? null, log: rec.log ?? null };
}

export function classifyCleanup(profile, rawDir) {
  if (!profile.runtime.requires.includes('postgres')) return null;
  const c = readJson(path.join(rawDir, 'postgres', 'cleanup.json'));
  if (!c) return { id: 'postgres-cleanup', title: 'Disposable PostgreSQL cluster stopped and removed (verified)', class: 'INFRASTRUCTURE', mandatory: true, status: S.NOT_RUN, reasons: ['no cleanup.json'] };
  const ok = ['STOPPED_VERIFIED', 'STOPPED_VERIFIED_AFTER_ESCALATION', 'NOT_STARTED', 'REMOVED_UNINITIALISED'].includes(c.status) && c.root_exists_after === false && c.foreign_instances_untouched === true;
  return { id: 'postgres-cleanup', title: 'Disposable PostgreSQL cluster stopped and removed (verified)', class: 'INFRASTRUCTURE', mandatory: true,
           status: ok ? S.PASS : S.FAIL, cleanup_status: c.status, stop_mode: c.stop_mode, reasons: ok ? (c.notes || []) : [`cleanup status ${c.status}`, ...(c.problems || [])] };
}

/** Classify a whole raw evidence directory against a profile. identityOk: result of the independent seal-phase re-verification. */
export function classifyRun({ profile, rawDir, identity }) {
  const checks = profile.checks.map(check => {
    const rec = readJson(path.join(rawDir, 'checks', check.id, 'result.json'));
    const head = { id: check.id, title: check.title, class: check.class, kind: check.kind, mandatory: check.mandatory };
    if (check.kind === 'node-test') {
      const byPath = new Map(((rec && rec.files) || []).map(f => [f.path, f]));
      let files;
      if (rec && rec.state === 'BLOCKED') files = check.files.map(f => ({ path: f.path, expected_tests: f.expect_tests, status: S.BLOCKED, reasons: [rec.reason] }));
      else files = check.files.map(f => classifyNodeFile(f, rec ? byPath.get(f.path) : null, check));
      const extra = [...byPath.keys()].filter(p => !check.files.some(f => f.path === p));
      const status = rec ? combine(files.map(f => f.status)) : S.NOT_RUN;
      const sum = k => files.reduce((a, f) => a + (n(f.counts?.[k]) ?? 0), 0);
      const reasons = files.filter(f => f.status !== S.PASS).map(f => `${f.path}: ${f.status} — ${(f.reasons || []).join('; ')}`);
      if (extra.length) reasons.push('unexpected files in execution record: ' + extra.join(', '));
      return { ...head, status: extra.length ? S.FAIL : status, files, totals: { files: files.length, expected_tests: check.files.reduce((a, f) => a + f.expect_tests, 0), tests: sum('tests'), pass: sum('pass'), fail: sum('fail'), skipped: sum('skipped'), cancelled: sum('cancelled'), todo: sum('todo') }, reasons };
    }
    if (check.kind === 'playwright') return { ...head, config: check.config, ...classifyPlaywright(check, rec, rawDir) };
    return { ...head, script: check.script, ...classifyScript(check, rec) };
  });
  const cleanup = classifyCleanup(profile, rawDir);
  if (cleanup) checks.push(cleanup);

  const gateReasons = [];
  if (!identity || identity.ok !== true) gateReasons.push('candidate identity was not independently re-verified: ' + ((identity && identity.refusals) || ['missing']).join('; '));
  const mandatory = checks.filter(c => c.mandatory);
  let gate;
  if (gateReasons.length || mandatory.some(c => c.status === S.FAIL || c.status === S.SKIP)) gate = GATE.FAILED;
  else if (mandatory.some(c => c.status !== S.PASS)) gate = GATE.INCONCLUSIVE;
  else gate = GATE.PASSED;
  for (const c of mandatory) if (c.status !== S.PASS) gateReasons.push(`mandatory ${c.id}: ${c.status}`);

  const byClass = {};
  for (const c of checks) {
    const t = byClass[c.class] ||= { checks: 0, pass: 0, fail: 0, skip: 0, tests_pass: 0, tests_fail: 0, tests_skip: 0 };
    t.checks++; if (c.status === S.PASS) t.pass++; else if (c.status === S.FAIL) t.fail++; else if (c.status === S.SKIP) t.skip++;
    if (c.totals) { t.tests_pass += c.totals.pass; t.tests_fail += c.totals.fail + c.totals.cancelled; t.tests_skip += c.totals.skipped; }
    if (c.counts) { t.tests_pass += c.counts.expected ?? 0; t.tests_fail += (c.counts.unexpected ?? 0) + (c.counts.flaky ?? 0); t.tests_skip += c.counts.skipped ?? 0; }
  }
  const statusCount = Object.fromEntries(Object.values(S).map(s => [s, checks.filter(c => c.status === s).length]));
  return { gate, gate_reasons: gateReasons, checks, by_class: byClass, check_status_counts: statusCount };
}
