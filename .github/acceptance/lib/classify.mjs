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

const CLEANUP_SUCCESS = ['STOPPED_VERIFIED', 'STOPPED_VERIFIED_AFTER_ESCALATION', 'NOT_STARTED', 'REMOVED_UNINITIALISED'];
const STARTUP_STATUSES = ['NONE', 'START_ATTEMPTED_UNVERIFIED', 'RUNNING_VERIFIED', 'IDENTITY_UNREADABLE'];
const RESPONDERS = ['none', 'owned', 'foreign', 'unknown'];
// Startup evidence that a server of this cluster really ran (or may have): only a stop performed by the cleanup, a stale postmaster.pid of a dead pid,
// or an earlier verified stop closes it. A missing PG_VERSION, a missing postmaster.pid or a deleted root never does (F-CI-02).
const TERMINATION_EVIDENCE = ['stopped_by_cleanup', 'stale_pidfile_dead_pid', 'prior_verified_stop'];

/**
 * Judge a cleanup.json. A success status is only believed when the rest of the record agrees with it (same table as pg-cluster.sh stop()):
 *   STOPPED_VERIFIED[_AFTER_ESCALATION]  shutdown proof present; any owned postmaster seen before was stopped by the cleanup; running-startup evidence closed
 *   NOT_STARTED           root absent before, no startup evidence, no owned process (a foreign listener on the port is irrelevant)
 *   REMOVED_UNINITIALISED root present without PG_VERSION/postmaster.pid, no startup evidence, no owned process, port not answered by us
 * Anything contradictory, incomplete or unverifiable is a failure; there is no clamping of a doubt into a pass.
 * Cross-field rules shared by every success: no ambiguous process (one that names -D <root>/data without provably serving it — possibly a
 * foreign cluster) and no unverified postmaster before or after; a port observation is internally consistent (responder "none" iff pg_isready
 * exit 2) and a listener called "owned" is backed by an owned process; the cluster that was to be removed never answers on the port afterwards.
 */
export function evaluateCleanup(c) {
  if (!CLEANUP_SUCCESS.includes(c.status)) return { ok: false, reasons: [`cleanup status ${c.status}`, ...(c.problems || [])] };
  const why = [];
  const empty = a => Array.isArray(a) && a.length === 0;
  if (c.root_exists_after !== false) why.push('cluster root still exists after cleanup');
  if (c.foreign_instances_untouched !== true) why.push('foreign PostgreSQL instances were not shown to be untouched');
  if (!empty(c.problems)) why.push(`success status recorded together with problems: ${Array.isArray(c.problems) ? c.problems.join('; ') : 'problems missing'}`);
  if (c.owned_process_scan !== 'ok') why.push(`owned-process scan is ${c.owned_process_scan ?? 'missing'}: shutdown cannot be established`);
  if (!Array.isArray(c.owned_processes_before)) why.push('owned_processes_before missing (incomplete cleanup evidence)');
  if (!empty(c.owned_processes_after)) why.push(Array.isArray(c.owned_processes_after) ? `owned process(es) still present after cleanup: ${c.owned_processes_after.map(p => p.pid).join(', ')}` : 'owned_processes_after missing (incomplete cleanup evidence)');
  if (!STARTUP_STATUSES.includes(c.startup_status)) why.push(`startup_status ${c.startup_status ?? 'missing'} is not a recognised value (incomplete cleanup evidence)`);
  if (!Array.isArray(c.ambiguous_processes_before) || !Array.isArray(c.ambiguous_processes_after)) why.push('ambiguous_processes_before/after missing (incomplete cleanup evidence)');
  else if (c.ambiguous_processes_before.length || c.ambiguous_processes_after.length) why.push(`process(es) with unestablished ownership name the cluster directory: ${[...c.ambiguous_processes_before, ...c.ambiguous_processes_after].map(p => p.pid).join(', ')}`);
  if (Array.isArray(c.owned_processes_before) && c.owned_processes_before.some(p => p.role === 'postmaster_unverified')) why.push('a postmaster that does not match the recorded start-up identity was present before cleanup');
  const respBefore = c.port_before?.responder, respAfter = c.port_after?.responder;
  const portInconsistent = o => !RESPONDERS.includes(o?.responder) || !Number.isInteger(o?.pg_isready_exit) || (o.responder === 'none') !== (o.pg_isready_exit === 2);
  if (portInconsistent(c.port_before) || portInconsistent(c.port_after)) why.push('port observations missing, unrecognised or internally inconsistent (incomplete cleanup evidence)');
  if (respAfter === 'owned') why.push('127.0.0.1:54329 is answered by the cluster that was to be removed');
  if (respBefore === 'owned' && Array.isArray(c.owned_processes_before) && !c.owned_processes_before.length) why.push('port_before.responder is "owned" but no owned process was recorded');
  if (why.length) return { ok: false, reasons: [`cleanup status ${c.status} contradicts its own evidence`, ...why] };

  const ownedBefore = c.owned_processes_before;
  const sawPostmaster = ownedBefore.some(p => p.role === 'postmaster');
  const running = c.startup_status === 'RUNNING_VERIFIED' || c.startup_status === 'IDENTITY_UNREADABLE';
  if (c.status === 'NOT_STARTED') {
    if (c.root_existed_before !== false) why.push('NOT_STARTED but the cluster root existed');
    if (c.startup_status !== 'NONE') why.push(`NOT_STARTED but startup evidence is ${c.startup_status}`);
    if (ownedBefore.length) why.push('NOT_STARTED but processes tied to the cluster were present');
    if (respBefore === 'owned') why.push('NOT_STARTED but the pre-cleanup port observation identifies the cluster as running on the port');
    if (respAfter === 'owned') why.push('NOT_STARTED but the port is answered by this cluster after cleanup');
  } else if (c.status === 'REMOVED_UNINITIALISED') {
    if (c.root_existed_before !== true) why.push('REMOVED_UNINITIALISED but the cluster root did not exist');
    if (c.pg_version_present_before !== false) why.push('REMOVED_UNINITIALISED but PG_VERSION was present (or not recorded)');
    if (c.postmaster_pid_file_before !== false) why.push('REMOVED_UNINITIALISED but a postmaster.pid existed (or was not recorded)');
    if (c.startup_status !== 'NONE') why.push(`REMOVED_UNINITIALISED but startup evidence is ${c.startup_status}: a server may have run, so "never initialised" is not established`);
    if (ownedBefore.length) why.push('REMOVED_UNINITIALISED but processes tied to the cluster were present');
    if (respBefore !== 'none' && respBefore !== 'foreign') why.push(`REMOVED_UNINITIALISED but the port was answered by an ${respBefore} listener before removal`);
    if (respAfter !== 'none' && respAfter !== 'foreign') why.push(`REMOVED_UNINITIALISED but the port is answered by an ${respAfter} listener after removal`);
  } else {
    if (!Array.isArray(c.shutdown_proof) || !c.shutdown_proof.length) why.push('no shutdown proof recorded');
    if (c.status === 'STOPPED_VERIFIED_AFTER_ESCALATION' && c.stop_mode !== 'immediate') why.push(`escalation status with stop_mode ${c.stop_mode}`);
    if (running && !TERMINATION_EVIDENCE.includes(c.termination_evidence)) why.push(`startup evidence is ${c.startup_status} but termination evidence is ${c.termination_evidence ?? 'missing'}: a verified-running server's shutdown is not proven`);
    if (sawPostmaster && c.termination_evidence !== 'stopped_by_cleanup') why.push('an owned postmaster was running before cleanup but no stop performed by the cleanup is recorded');
    if (respAfter !== 'none' && respAfter !== 'foreign') why.push(`port is answered by an ${respAfter} listener after cleanup`);
  }
  return why.length ? { ok: false, reasons: [`cleanup status ${c.status} contradicts its own evidence`, ...why] } : { ok: true, reasons: c.notes || [] };
}

export function classifyCleanup(profile, rawDir) {
  if (!profile.runtime.requires.includes('postgres')) return null;
  const c = readJson(path.join(rawDir, 'postgres', 'cleanup.json'));
  const head = { id: 'postgres-cleanup', title: 'Disposable PostgreSQL cluster stopped and removed (verified)', class: 'INFRASTRUCTURE', mandatory: true };
  if (!c) return { ...head, status: S.NOT_RUN, reasons: ['no cleanup.json'] };
  const r = evaluateCleanup(c);
  return { ...head, status: r.ok ? S.PASS : S.FAIL, cleanup_status: c.status, stop_mode: c.stop_mode, reasons: r.reasons };
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
