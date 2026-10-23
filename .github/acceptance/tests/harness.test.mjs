// Construction Core — GPR-2 CI Foundation: harness self-tests (no dependencies; Node >= 22).
//   node --test .github/acceptance/tests/harness.test.mjs
// Identity tests need a full-history clone of the repository (GPR2_TEST_REPO, default: this checkout).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateProfile, loadProfile } from '../lib/profile.mjs';
import { authorize } from '../lib/authorize.mjs';
import { verifyIdentity } from '../lib/identity.mjs';
import { classifyRun, classifyNodeFile, classifyCleanup, evaluateCleanup, applyRuntimeResult, parseTapSummary, S, GATE } from '../lib/classify.mjs';
import { writeManifest } from '../lib/seal.mjs';
import { judgeCluster, expectedDataDirectory } from '../lib/run-profile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ACC = path.resolve(HERE, '..');
const LIB = path.join(ACC, 'lib');
const PROFILES = path.join(ACC, 'profiles');
const REPO = process.env.GPR2_TEST_REPO || execFileSync('git', ['-C', ACC, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const R04 = 'b882fd0a35fe93d5f85d6be1ccd7dfdc6982f67d';
const MAIN = '9bd684806f0d87d802387abb141d9a88d950ceba';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gpr2-harness-'));
const r04 = () => JSON.parse(fs.readFileSync(path.join(PROFILES, 'r04-cp02.json'), 'utf8'));
// A complete, internally consistent cleanup.json as pg-cluster.sh stop() writes it (verified stop of a running owned postmaster).
const DATA_DIR = '/var/tmp/gpr2-accept-1-1/data';
const ID = { pid: 551, start_ticks: '34305', boot_id: 'a1b2c3d4-0000-4000-8000-000000000001', exe: '/usr/lib/postgresql/16/bin/postgres',
             argv: ['/usr/lib/postgresql/16/bin/postgres', '-D', DATA_DIR, '-c', 'port=54329'], data_directory: DATA_DIR };
const pm = (over = {}) => ({ pid: 551, role: 'postmaster', cwd: DATA_DIR, start_ticks: ID.start_ticks, boot_id: ID.boot_id, exe: ID.exe, argv: ID.argv, ...over });
const port = (responder, detail = '') => ({ pg_isready_exit: responder === 'none' ? 2 : 0, responder, detail });
const cleanupRecord = (over = {}) => ({
  status: 'STOPPED_VERIFIED', stop_mode: 'fast', stop_method: 'signal', root: '/var/tmp/gpr2-accept-1-1', root_exists_after: false,
  startup_status: 'RUNNING_VERIFIED', recorded_postmaster_pid: 551, root_existed_before: true, pg_version_present_before: true, postmaster_pid_file_before: true,
  startup_identity: { state: 'COMPLETE', missing: [], recorded: ID },
  owned_process_scan: 'ok', owned_processes_before: [pm()], owned_processes_after: [],
  ambiguous_processes_before: [], ambiguous_processes_after: [],
  signals: [{ pid: 551, signal: 'INT', exited: true }], stale_pidfile: null, prior_cleanup_status: null,
  port_before: port('owned', 'listener pid 551 is tied to the root'), port_after: port('none', 'nothing answers'),
  termination_evidence: 'stopped_by_cleanup', shutdown_proof: ['verified postmaster pid 551 exited after SIGINT', 'process table: no process is tied to the root after the stop'],
  foreign_instances_untouched: true, problems: [], notes: [], ...over,
});
const notStartedRecord = (over = {}) => cleanupRecord({
  status: 'NOT_STARTED', stop_mode: 'none', stop_method: 'none', startup_status: 'NONE', recorded_postmaster_pid: null, root_existed_before: false, pg_version_present_before: false,
  postmaster_pid_file_before: false, startup_identity: { state: 'ABSENT', missing: [], recorded: null }, owned_processes_before: [], signals: [], port_before: port('none'),
  termination_evidence: 'not_applicable', shutdown_proof: [], ...over,
});
const uninitialisedRecord = (over = {}) => notStartedRecord({ status: 'REMOVED_UNINITIALISED', root_existed_before: true, shutdown_proof: ['PG_VERSION absent, no postmaster.pid, no startup evidence, no process tied to the root'], ...over });
  // Seals an all-PASS synthetic r04-cp02 evidence package through the real seal.mjs CLI and verifies it through the real verify-evidence.mjs CLI.
const sealR04 = rr => {
  const { profile: realProfile, sha256 } = loadProfile(path.join(PROFILES, 'r04-cp02.json'));
    const d = tmp(); const rawDir = path.join(d, 'raw'); fs.mkdirSync(path.join(rawDir, 'postgres'), { recursive: true });
    for (const c of realProfile.checks.filter(x => x.kind === 'node-test')) { fs.mkdirSync(path.join(rawDir, 'checks', c.id), { recursive: true });
      fs.writeFileSync(path.join(rawDir, 'checks', c.id, 'result.json'), JSON.stringify({ state: 'EXECUTED', files: c.files.map(f => ({ path: f.path, state: 'EXECUTED', exit_code: 0, counts: { tests: f.expect_tests, pass: f.expect_tests, fail: 0, cancelled: 0, skipped: 0, todo: 0 } })) })); }
    const pw = realProfile.checks.find(c => c.kind === 'playwright'); fs.mkdirSync(path.join(rawDir, 'checks', pw.id), { recursive: true });
    fs.writeFileSync(path.join(rawDir, 'checks', pw.id, 'report.json'), JSON.stringify({ stats: { expected: pw.expect_passed, unexpected: 0, flaky: 0, skipped: 0 }, errors: [], suites: [{ title: 's', specs: Array.from({ length: pw.expect_passed }, (_, i) => ({ title: 't' + i, tests: [{ status: 'expected', results: [{ status: 'passed' }] }] })) }] }));
    fs.writeFileSync(path.join(rawDir, 'checks', pw.id, 'result.json'), JSON.stringify({ state: 'EXECUTED', exit_code: 0, report: `checks/${pw.id}/report.json` }));
    fs.writeFileSync(path.join(rawDir, 'postgres', 'cleanup.json'), JSON.stringify(cleanupRecord()));
    const cand = { sha: R04, tree: realProfile.candidates[0].tree };
    fs.writeFileSync(path.join(rawDir, 'identity-runtime.json'), JSON.stringify({ ok: true, candidate: cand }));
    fs.writeFileSync(path.join(d, 'authorization.json'), JSON.stringify({ ok: true, request: { actor: 'Shamil9586', triggering_actor: 'Shamil9586' }, candidate: cand, profile: { sha256 } }));
    fs.writeFileSync(path.join(d, 'identity-seal.json'), JSON.stringify({ ok: true, candidate: cand }));
    const out = path.join(d, 'sealed');
    const args = [path.join(LIB, 'seal.mjs'), '--profile', path.join(PROFILES, 'r04-cp02.json'), '--raw', rawDir, '--authorization', path.join(d, 'authorization.json'), '--identity', path.join(d, 'identity-seal.json'), ...(rr === undefined ? [] : ['--runtime-result', rr]), '--out', out];
    const run = spawnSync('node', args, { encoding: 'utf8' });
    const rec = JSON.parse(fs.readFileSync(path.join(out, 'acceptance-result.json'), 'utf8'));
    const verify = spawnSync('node', [path.join(LIB, 'verify-evidence.mjs'), out, '--profile', path.join(PROFILES, 'r04-cp02.json')], { encoding: 'utf8' });
    return { run, rec, verify, out };
  };
const hasCommit = sha => spawnSync('git', ['-C', REPO, 'cat-file', '-e', `${sha}^{commit}`]).status === 0;

describe('profile registry', () => {
  test('every committed profile validates strictly', () => {
    for (const f of fs.readdirSync(PROFILES).filter(x => x.endsWith('.json'))) assert.doesNotThrow(() => loadProfile(path.join(PROFILES, f)), f);
  });
  test('the R04 profile reproduces the accepted 27 native + 16 PGlite + 22 Chromium = 65 gates', () => {
    const p = r04();
    const native = p.checks.find(c => c.class === 'NATIVE_POSTGRESQL');
    const pglite = p.checks.find(c => c.class === 'PURE_PGLITE');
    const browser = p.checks.find(c => c.class === 'BROWSER_CHROMIUM');
    assert.equal(native.files.reduce((a, f) => a + f.expect_tests, 0), 27);
    assert.equal(native.files.length, 7);
    assert.equal(pglite.files.reduce((a, f) => a + f.expect_tests, 0), 16);
    assert.equal(browser.expect_passed, 22);
    assert.equal(browser.config, 'playwright.gpr-1.config.ts');
    assert.ok(p.checks.every(c => c.mandatory && !c.allow_skip));
  });
  const mutate = (fn) => { const p = r04(); fn(p); return validateProfile(p); };
  for (const [name, fn, needle] of [
    ['unknown top-level key', p => { p.run = 'curl evil'; }, 'unknown key "run"'],
    ['short candidate SHA', p => { p.candidates[0].sha = 'b882fd0'; }, 'full 40-hex'],
    ['path traversal in a test file', p => { p.checks[0].files[0].path = 'tests/../scripts/x.test.ts'; }, 'without ".."'],
    ['absolute test path', p => { p.checks[0].files[0].path = '/etc/passwd'; }, 'tests/**'],
    ['free-form playwright config path', p => { p.checks[2].config = '../x.config.ts'; }, 'playwright.<name>'],
    ['mandatory check allowing skips', p => { p.checks[0].allow_skip = true; }, 'may not allow skipped'],
    ['PGlite check requiring native postgres', p => { p.checks[1].requires = ['postgres']; }, 'PURE_PGLITE'],
    ['native check without postgres', p => { p.checks[0].requires = []; }, 'must require postgres'],
    ['non-exact expected count', p => { p.checks[0].files[0].expect_tests = 0; }, 'exact positive'],
    ['duplicate test file', p => { p.checks[1].files.push({ ...p.checks[0].files[0] }); }, 'listed twice'],
    ['ACTIVE without candidates', p => { p.candidates = []; }, 'at least one approved candidate'],
    ['npm script with shell syntax', p => { p.checks.push({ id: 'evil', title: 'x', class: 'TYPECHECK_BUILD', kind: 'npm-script', mandatory: true, requires: [], script: 'build && curl x', timeout_seconds: 60 }); }, 'package.json script'],
    ['unknown runner', p => { p.runtime.runner = 'self-hosted'; }, 'runtime.runner'],
    ['lineage rev with command syntax', p => { p.candidates[0].lineage[0].rev = 'HEAD; rm -rf /'; }, 'HEAD-relative'],
  ]) test(`rejects: ${name}`, () => { const e = mutate(fn); assert.ok(e.some(x => x.includes(needle)), JSON.stringify(e)); });
  test('a TEMPLATE profile may not carry candidates', () => {
    const t = JSON.parse(fs.readFileSync(path.join(PROFILES, 'stage-template.json'), 'utf8'));
    t.candidates = r04().candidates;
    assert.ok(validateProfile(t).some(x => x.includes('TEMPLATE')));
  });
});

describe('dispatch authorisation', () => {
  const okEnv = (o = {}) => ({ GITHUB_REPOSITORY: 'Shamil9586/construction-core-mvp', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_ACTOR: 'Shamil9586',
    GITHUB_TRIGGERING_ACTOR: 'Shamil9586', GITHUB_SHA: MAIN, GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1', INPUT_PROFILE: 'r04-cp02', INPUT_CANDIDATE_SHA: R04,
    INPUT_CONFIRMATION: `APPROVE-TEST-ONLY r04-cp02 ${R04}`, ...o });
  test('authorises the registered R04 candidate with the exact confirmation', () => {
    const r = authorize({ env: okEnv(), harnessDir: ACC });
    assert.equal(r.ok, true, r.refusals.join('\n'));
    assert.equal(r.candidate.tree, '2f5d3648b330c30642a08b62e7737834dbe25ec2');
  });
  for (const [name, env, needle] of [
    ['an incorrect (unregistered) SHA', { INPUT_CANDIDATE_SHA: '0'.repeat(40), INPUT_CONFIRMATION: `APPROVE-TEST-ONLY r04-cp02 ${'0'.repeat(40)}` }, 'not registered'],
    ['a short SHA', { INPUT_CANDIDATE_SHA: 'b882fd0', INPUT_CONFIRMATION: 'APPROVE-TEST-ONLY r04-cp02 b882fd0' }, 'full lowercase 40-hex'],
    ['a branch name instead of a SHA', { INPUT_CANDIDATE_SHA: 'main' }, 'full lowercase 40-hex'],
    ['an uppercase SHA', { INPUT_CANDIDATE_SHA: R04.toUpperCase() }, 'full lowercase 40-hex'],
    ['main SHA under the R04 profile (unauthorised stage/profile combination)', { INPUT_CANDIDATE_SHA: MAIN, INPUT_CONFIRMATION: `APPROVE-TEST-ONLY r04-cp02 ${MAIN}` }, 'not registered in profile r04-cp02'],
    ['R04 SHA under the main-integration profile', { INPUT_PROFILE: 'r04-main-integration', INPUT_CONFIRMATION: `APPROVE-TEST-ONLY r04-main-integration ${R04}` }, 'not registered in profile r04-main-integration'],
    ['the template profile', { INPUT_PROFILE: 'stage-template', INPUT_CONFIRMATION: `APPROVE-TEST-ONLY stage-template ${R04}` }, 'TEMPLATE, not ACTIVE'],
    ['an unknown profile', { INPUT_PROFILE: 'r05-early', INPUT_CONFIRMATION: `APPROVE-TEST-ONLY r05-early ${R04}` }, 'not registered on the workflow commit'],
    ['a traversal profile id', { INPUT_PROFILE: '../../workflows/claude' }, 'malformed'],
    ['the default DO_NOT_RUN confirmation', { INPUT_CONFIRMATION: 'DO_NOT_RUN' }, 'confirmation must be exactly'],
    ['a confirmation for another SHA', { INPUT_CONFIRMATION: `APPROVE-TEST-ONLY r04-cp02 ${MAIN}` }, 'confirmation must be exactly'],
    ['a non-approved actor', { GITHUB_ACTOR: 'someone-else' }, 'actor someone-else'],
    ['a re-run by a non-approved user', { GITHUB_TRIGGERING_ACTOR: 'someone-else' }, 'triggering actor someone-else'],
    ['a dispatch from a non-main ref', { GITHUB_REF: 'refs/heads/feature/x' }, 'not refs/heads/main'],
    ['a pull_request event', { GITHUB_EVENT_NAME: 'pull_request' }, 'not workflow_dispatch'],
    ['a fork repository', { GITHUB_REPOSITORY: 'attacker/construction-core-mvp' }, 'is not Shamil9586'],
  ]) test(`refuses ${name}`, () => {
    const r = authorize({ env: okEnv(env), harnessDir: ACC });
    assert.equal(r.ok, false);
    assert.ok(r.refusals.some(x => x.includes(needle)), r.refusals.join('\n'));
  });
  test('CLI exits 2 and writes the refusal record', () => {
    const out = tmp();
    const r = spawnSync('node', [path.join(LIB, 'authorize.mjs'), ACC, out], { env: { ...process.env, ...okEnv({ INPUT_CONFIRMATION: 'yes' }), GITHUB_OUTPUT: '' }, encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'authorization.json'), 'utf8')).ok, false);
  });
});

describe('candidate identity (git only)', { skip: !hasCommit(R04) && 'R04 candidate not present in this clone' }, () => {
  const worktree = sha => { const d = path.join(tmp(), 'core'); execFileSync('git', ['-C', REPO, 'worktree', 'add', '--detach', '-q', d, sha]); return d; };
  const drop = d => spawnSync('git', ['-C', REPO, 'worktree', 'remove', '--force', d]);
  test('verifies the registered R04 candidate, its tree, lineage and baseline', () => {
    const d = worktree(R04);
    try { const r = verifyIdentity({ profile: r04(), candidateSha: R04, repo: d }); assert.equal(r.ok, true, r.refusals.join('\n')); assert.equal(r.diff_check, 'CLEAN'); assert.equal(r.lineage.length, 3); }
    finally { drop(d); }
  });
  test('verifies the integrated main merge commit under its own profile', { skip: !hasCommit(MAIN) }, () => {
    const d = worktree(MAIN);
    try { const p = JSON.parse(fs.readFileSync(path.join(PROFILES, 'r04-main-integration.json'), 'utf8')); const r = verifyIdentity({ profile: p, candidateSha: MAIN, repo: d }); assert.equal(r.ok, true, r.refusals.join('\n')); }
    finally { drop(d); }
  });
  test('refuses a checkout whose HEAD is not the registered SHA', () => {
    const d = worktree(MAIN);
    try { const r = verifyIdentity({ profile: r04(), candidateSha: R04, repo: d }); assert.equal(r.ok, false); assert.ok(r.refusals.some(x => x.startsWith('HEAD '))); }
    finally { drop(d); }
  });
  test('refuses a wrong registered tree and a wrong pinned ancestor', () => {
    const d = worktree(R04);
    try {
      const p = r04(); p.candidates[0].tree = 'f'.repeat(40); p.candidates[0].lineage[1].sha = 'e'.repeat(40);
      const r = verifyIdentity({ profile: p, candidateSha: R04, repo: d });
      assert.ok(r.refusals.some(x => x.includes('HEAD tree'))); assert.ok(r.refusals.some(x => x.startsWith('HEAD~2 ')));
    } finally { drop(d); }
  });
  test('refuses a dirty candidate checkout (modified or untracked files)', () => {
    const d = worktree(R04);
    try { fs.writeFileSync(path.join(d, 'injected.txt'), 'x'); const r = verifyIdentity({ profile: r04(), candidateSha: R04, repo: d }); assert.ok(r.refusals.some(x => x.includes('not clean'))); }
    finally { drop(d); }
  });
  test('refuses a shallow checkout', () => {
    const d = path.join(tmp(), 'shallow');
    execFileSync('git', ['clone', '-q', '--depth', '1', '--no-local', `file://${REPO}`, d]);
    execFileSync('git', ['-C', d, 'fetch', '-q', '--depth', '1', 'origin', R04]);
    execFileSync('git', ['-C', d, 'checkout', '-q', '--detach', R04]);
    const r = verifyIdentity({ profile: r04(), candidateSha: R04, repo: d });
    assert.equal(r.ok, false); assert.ok(r.refusals.some(x => x.includes('shallow')));
  });
});

describe('result classification', () => {
  const check = { id: 'native-pg', title: 'n', class: 'NATIVE_POSTGRESQL', kind: 'node-test', mandatory: true, requires: ['postgres'], allow_skip: false, fresh_database_per_file: true, file_timeout_seconds: 60,
                  files: [{ path: 'tests/a.test.ts', expect_tests: 3 }, { path: 'tests/b.test.ts', expect_tests: 2 }] };
  const exec = (p, c, exit = 0, extra = {}) => ({ path: p, state: 'EXECUTED', exit_code: exit, counts: { tests: c[0], pass: c[1], fail: c[2], cancelled: 0, skipped: c[3], todo: 0 }, ...extra });
  test('parses the node:test TAP summary', () => {
    assert.deepEqual(parseTapSummary('ok 1 - x\n# tests 3\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n# duration_ms 12.5\n'),
      { tests: 3, suites: 0, pass: 2, fail: 0, cancelled: 0, skipped: 1, todo: 0, duration_ms: 12.5 });
  });
  const f = (rec) => classifyNodeFile(check.files[0], rec, check);
  test('PASS only on the exact count with zero fail/cancel/skip/todo and exit 0', () => assert.equal(f(exec('tests/a.test.ts', [3, 3, 0, 0])).status, S.PASS));
  test('FAIL on a count mismatch (a silently deleted test)', () => assert.equal(f(exec('tests/a.test.ts', [2, 2, 0, 0])).status, S.FAIL));
  test('FAIL on an unexpected partial skip', () => assert.equal(f(exec('tests/a.test.ts', [3, 2, 0, 1])).status, S.FAIL));
  test('SKIP (not PASS, not NOT RUN) when every test was skipped', () => assert.equal(f(exec('tests/a.test.ts', [3, 0, 0, 3])).status, S.SKIP));
  test('FAIL on a missing required test file', () => assert.equal(f({ path: 'tests/a.test.ts', state: 'MISSING' }).status, S.FAIL));
  test('NOT RUN without an execution record', () => assert.equal(f(null).status, S.NOT_RUN));
  test('ENVIRONMENT BLOCKED when the disposable database could not be reset', () => assert.equal(f({ path: 'tests/a.test.ts', state: 'DB_RESET_FAILED' }).status, S.BLOCKED));
  test('FAIL on timeout even with a plausible summary', () => assert.equal(f(exec('tests/a.test.ts', [3, 3, 0, 0], 124, { timed_out: true })).status, S.FAIL));
  test('FAIL on non-zero exit even with a clean summary', () => assert.equal(f(exec('tests/a.test.ts', [3, 3, 0, 0], 1)).status, S.FAIL));
  test('FAIL when the summary is incomplete (runner crashed)', () => assert.equal(f({ path: 'tests/a.test.ts', state: 'EXECUTED', exit_code: 1, counts: { tests: 3 } }).status, S.FAIL));

  const writeRaw = (results, cleanup) => {
    const d = tmp();
    for (const [id, r] of Object.entries(results)) { fs.mkdirSync(path.join(d, 'checks', id), { recursive: true }); fs.writeFileSync(path.join(d, 'checks', id, 'result.json'), JSON.stringify(r)); }
    if (cleanup) { fs.mkdirSync(path.join(d, 'postgres'), { recursive: true }); fs.writeFileSync(path.join(d, 'postgres', 'cleanup.json'), JSON.stringify(cleanup)); }
    return d;
  };
  const profile = { profile_id: 't', stage: 'R04', runtime: { requires: ['postgres'] }, checks: [check, { id: 'build', title: 'b', class: 'TYPECHECK_BUILD', kind: 'npm-script', mandatory: false, requires: [], script: 'build', timeout_seconds: 60 }] };
  const goodCleanup = cleanupRecord();
  const goodNative = { state: 'EXECUTED', files: [exec('tests/a.test.ts', [3, 3, 0, 0]), exec('tests/b.test.ts', [2, 2, 0, 0])] };
  test('gate PASSED with all mandatory checks PASS, verified cleanup and identity; optional failure reported but not gating', () => {
    const r = classifyRun({ profile, rawDir: writeRaw({ 'native-pg': goodNative, build: { state: 'EXECUTED', exit_code: 2 } }, goodCleanup), identity: { ok: true } });
    assert.equal(r.gate, GATE.PASSED);
    assert.equal(r.checks.find(c => c.id === 'build').status, S.FAIL);
    assert.equal(r.by_class.NATIVE_POSTGRESQL.tests_pass, 5);
  });
  test('gate FAILED when PostgreSQL cleanup could not be verified (F-CI-01)', () => {
    const r = classifyRun({ profile, rawDir: writeRaw({ 'native-pg': goodNative }, cleanupRecord({ status: 'FAILED', root_exists_after: true, problems: ['postmaster.pid still present'] })), identity: { ok: true } });
    assert.equal(r.gate, GATE.FAILED);
  });
  test('gate INCONCLUSIVE (not PASSED, not FAILED) when PostgreSQL was ENVIRONMENT BLOCKED', () => {
    const r = classifyRun({ profile, rawDir: writeRaw({ 'native-pg': { state: 'BLOCKED', reason: 'PostgreSQL provisioning outcome: failure' } }, notStartedRecord()), identity: { ok: true } });
    assert.equal(r.gate, GATE.INCONCLUSIVE);
    assert.equal(r.checks[0].status, S.BLOCKED);
  });
  test('gate INCONCLUSIVE with NOT RUN when no raw evidence exists at all', () => {
    const r = classifyRun({ profile, rawDir: tmp(), identity: { ok: true } });
    assert.equal(r.gate, GATE.INCONCLUSIVE);
    assert.equal(r.checks[0].status, S.NOT_RUN);
    assert.equal(r.check_status_counts['NOT RUN'], 3);
  });
  test('gate FAILED when a mandatory check is entirely SKIPPED', () => {
    const raw = writeRaw({ 'native-pg': { state: 'EXECUTED', files: [exec('tests/a.test.ts', [3, 0, 0, 3]), exec('tests/b.test.ts', [2, 0, 0, 2])] } }, goodCleanup);
    const r = classifyRun({ profile, rawDir: raw, identity: { ok: true } });
    assert.equal(r.checks[0].status, S.SKIP); assert.equal(r.gate, GATE.FAILED);
  });
  test('gate FAILED when identity re-verification failed, even if all tests passed', () => {
    const r = classifyRun({ profile, rawDir: writeRaw({ 'native-pg': goodNative }, goodCleanup), identity: { ok: false, refusals: ['tree mismatch'] } });
    assert.equal(r.gate, GATE.FAILED);
  });
  test('an execution record with extra, unrequested files fails the check', () => {
    const r = classifyRun({ profile, rawDir: writeRaw({ 'native-pg': { state: 'EXECUTED', files: [...goodNative.files, exec('tests/c.test.ts', [1, 1, 0, 0])] } }, goodCleanup), identity: { ok: true } });
    assert.equal(r.checks[0].status, S.FAIL);
  });
  test('Playwright: PASS on exact 22 expected; FAIL on 21 + 1 skipped; FAIL on flaky', async () => {
    const { classifyPlaywright } = await import('../lib/classify.mjs');
    const pw = { id: 'b', class: 'BROWSER_CHROMIUM', kind: 'playwright', mandatory: true, requires: ['chromium'], allow_skip: false, config: 'playwright.x.config.ts', expect_passed: 22, timeout_seconds: 600 };
    const mk = (stats, statuses) => { const d = tmp(); fs.writeFileSync(path.join(d, 'r.json'), JSON.stringify({ stats, errors: [], suites: [{ title: 'f.spec.ts', specs: statuses.map((s, i) => ({ title: 't' + i, tests: [{ projectName: '', status: s, results: [{ status: 'passed' }] }] })) }] })); return d; };
    assert.equal(classifyPlaywright(pw, { state: 'EXECUTED', exit_code: 0, report: 'r.json' }, mk({ expected: 22, unexpected: 0, flaky: 0, skipped: 0 }, Array(22).fill('expected'))).status, S.PASS);
    assert.equal(classifyPlaywright(pw, { state: 'EXECUTED', exit_code: 0, report: 'r.json' }, mk({ expected: 21, unexpected: 0, flaky: 0, skipped: 1 }, [...Array(21).fill('expected'), 'skipped'])).status, S.FAIL);
    assert.equal(classifyPlaywright(pw, { state: 'EXECUTED', exit_code: 0, report: 'r.json' }, mk({ expected: 21, unexpected: 0, flaky: 1, skipped: 0 }, [...Array(21).fill('expected'), 'flaky'])).status, S.FAIL);
    assert.equal(classifyPlaywright(pw, { state: 'EXECUTED', exit_code: 1, report: null }, tmp()).status, S.FAIL);
  });
});

describe('F-CI-02: PostgreSQL cleanup must fail closed', () => {
  const ev = rec => evaluateCleanup(rec);
  const profile = { runtime: { requires: ['postgres'] } };
  const viaFile = rec => { const d = tmp(); fs.mkdirSync(path.join(d, 'postgres')); fs.writeFileSync(path.join(d, 'postgres', 'cleanup.json'), JSON.stringify(rec)); return classifyCleanup(profile, d); };

  // Negative
  test('N1 the original false positive: REMOVED_UNINITIALISED recorded after RUNNING_VERIFIED start-up is FAIL', () => {
    assert.equal(ev(uninitialisedRecord({ startup_status: 'RUNNING_VERIFIED' })).ok, false);
    assert.match(ev(uninitialisedRecord({ startup_status: 'RUNNING_VERIFIED' })).reasons.join('\n'), /may have run/);
  });
  test('N1 the pre-correction record shape (status + root removed + foreign untouched, nothing else) is incomplete evidence, FAIL', () => {
    const legacy = { status: 'REMOVED_UNINITIALISED', root_exists_after: false, foreign_instances_untouched: true, problems: [] };
    assert.equal(ev(legacy).ok, false);
    assert.equal(viaFile(legacy).status, S.FAIL);
    assert.equal(viaFile({ ...legacy, status: 'STOPPED_VERIFIED' }).status, S.FAIL);
  });
  test('N1 REMOVED_UNINITIALISED while a postmaster of the cluster was running is FAIL', () => {
    assert.equal(ev(uninitialisedRecord({ owned_processes_before: [{ pid: 551, role: 'postmaster', cwd: '/x' }] })).ok, false);
  });
  test('N1 a verified-running server cannot be closed by absence of files: STOPPED_VERIFIED without termination evidence is FAIL', () => {
    for (const termination_evidence of ['not_applicable', undefined, 'none']) assert.equal(ev(cleanupRecord({ termination_evidence, owned_processes_before: [], signals: [], stop_method: 'none', pg_version_present_before: false })).ok, false, String(termination_evidence));
  });
  test('N1 NOT_STARTED while start-up evidence says RUNNING_VERIFIED is FAIL', () => {
    assert.equal(ev(notStartedRecord({ startup_status: 'RUNNING_VERIFIED' })).ok, false);
    assert.equal(ev(notStartedRecord({ startup_status: 'START_ATTEMPTED_UNVERIFIED' })).ok, false);
  });
  test('N2 contradictory: root reported removed but an owned postmaster is still present after cleanup is FAIL', () => {
    const r = ev(cleanupRecord({ owned_processes_after: [{ pid: 551, role: 'postmaster', cwd: '/var/tmp/gpr2-accept-1-1/data (deleted)' }] }));
    assert.equal(r.ok, false); assert.match(r.reasons.join('\n'), /still present after cleanup: 551/);
    assert.equal(ev(cleanupRecord({ owned_processes_after: [{ pid: 553, role: 'member', cwd: '/x' }] })).ok, false);
  });
  test('N2 contradictory: owned postmaster seen before but no stop by the cleanup recorded is FAIL', () => {
    assert.equal(ev(cleanupRecord({ termination_evidence: 'stale_pidfile_dead_pid' })).ok, false);
  });
  test('N2 incomplete: scan unreliable, scan field missing, empty shutdown proof, success next to problems are all FAIL', () => {
    assert.equal(ev(cleanupRecord({ owned_process_scan: 'failed' })).ok, false);
    const { owned_process_scan, ...noScan } = cleanupRecord(); void owned_process_scan; assert.equal(ev(noScan).ok, false);
    assert.equal(ev(cleanupRecord({ shutdown_proof: [] })).ok, false);
    assert.equal(ev(cleanupRecord({ problems: ['postmaster.pid still present'] })).ok, false);
    assert.equal(ev(cleanupRecord({ root_exists_after: true })).ok, false);
    assert.equal(ev(cleanupRecord({ foreign_instances_untouched: false })).ok, false);
    assert.equal(ev(cleanupRecord({ status: 'STOPPED_VERIFIED_AFTER_ESCALATION', stop_mode: 'fast' })).ok, false);
  });
  test('N3 uncertain ownership of the port: an unidentified or owned listener never supports a removal/stop success', () => {
    assert.equal(ev(uninitialisedRecord({ port_before: port('unknown') })).ok, false);
    assert.equal(ev(uninitialisedRecord({ port_after: port('unknown') })).ok, false);
    assert.equal(ev(cleanupRecord({ port_after: port('unknown') })).ok, false);
    assert.equal(ev(cleanupRecord({ port_after: port('owned') })).ok, false);
    assert.equal(ev(notStartedRecord({ port_before: port('owned'), port_after: port('owned') })).ok, false);
  });
  // R1 / R2 (final narrow corrective)
  test('R2 exact: NOT_STARTED with port_before.responder=owned and port_after.responder=none is FAIL', () => {
    const r = ev(notStartedRecord({ port_before: port('owned'), port_after: port('none') }));
    assert.equal(r.ok, false); assert.match(r.reasons.join('\n'), /port_before\.responder is "owned"/);
  });
  test('R2 contradictory port evidence is FAIL: owned listener without an owned process; "none" with a responding pg_isready exit; a responder with exit 2; missing exit code', () => {
    assert.equal(ev(cleanupRecord({ owned_processes_before: [], termination_evidence: 'stale_pidfile_dead_pid' })).ok, false);   // port_before owned, nothing owned
    assert.equal(ev(notStartedRecord({ port_before: { pg_isready_exit: 0, responder: 'none', detail: '' } })).ok, false);
    assert.equal(ev(notStartedRecord({ port_before: { pg_isready_exit: 2, responder: 'foreign', detail: '' } })).ok, false);
    assert.equal(ev(notStartedRecord({ port_before: { responder: 'none' } })).ok, false);
  });
  test('R2 NOT_STARTED stays valid for an unstarted cluster, with a foreign or an unidentified listener on the port', () => {
    assert.equal(ev(notStartedRecord()).ok, true);
    assert.equal(ev(notStartedRecord({ port_before: port('foreign'), port_after: port('foreign') })).ok, true);
    assert.equal(ev(notStartedRecord({ port_before: port('unknown'), port_after: port('unknown') })).ok, true);
  });
  test('R1 ambiguous ownership recorded (a process naming -D <root>/data without cwd there, possibly foreign) can never be a success, before or after', () => {
    const amb = [{ pid: 257, role: 'config_only', cwd: '/var/tmp/gpr2-foreign/data' }];
    for (const rec of [cleanupRecord({ ambiguous_processes_before: amb }), cleanupRecord({ ambiguous_processes_after: amb }), uninitialisedRecord({ ambiguous_processes_before: amb }), notStartedRecord({ ambiguous_processes_before: amb })]) assert.equal(ev(rec).ok, false);
    const { ambiguous_processes_before, ...legacy } = cleanupRecord(); void ambiguous_processes_before; assert.equal(ev(legacy).ok, false);
  });
  test('R1 a postmaster that contradicts the recorded start-up identity is never part of a success', () => {
    assert.equal(ev(cleanupRecord({ owned_processes_before: [{ pid: 700, role: 'postmaster_unverified', cwd: '/x' }] })).ok, false);
  });

  // C1 / C2: no signal and no success without a complete, matching start-up identity; shutdown must be structurally evidenced
  test('S2-S4/S13 an incomplete recorded identity (any field missing or invalid) can never support a success', () => {
    for (const field of ['pid', 'start_ticks', 'boot_id', 'exe', 'argv', 'data_directory']) {
      const rec = { ...ID }; delete rec[field];
      assert.equal(ev(cleanupRecord({ startup_identity: { state: 'COMPLETE', missing: [], recorded: rec } })).ok, false, `COMPLETE claimed without ${field}`);
      assert.equal(ev(cleanupRecord({ startup_identity: { state: 'INCOMPLETE', missing: [field], recorded: null } })).ok, false, `INCOMPLETE (${field})`);
    }
    for (const bad of [{ pid: 0 }, { pid: '551' }, { start_ticks: '' }, { start_ticks: 'abc' }, { boot_id: '' }, { exe: '/bin/true' }, { argv: [] }, { argv: ['/x/postgres', '-D', '/other'] }])
      assert.equal(ev(cleanupRecord({ startup_identity: { state: 'COMPLETE', missing: [], recorded: { ...ID, ...bad } } })).ok, false, JSON.stringify(bad));
    assert.equal(ev(cleanupRecord({ startup_identity: { state: 'ABSENT', missing: [], recorded: null } })).ok, false);
    assert.equal(ev(cleanupRecord({ startup_identity: { state: 'CORRUPT', missing: ['unparsable'], recorded: null } })).ok, false);
    assert.equal(ev(cleanupRecord({ startup_identity: { state: 'INCOMPLETE', missing: ['boot_id'], recorded: ID } })).ok, false);   // attached identity contradicts the state
  });
  test('S5/S13 a "verified" postmaster that differs from the recorded identity in ANY field is FAIL', () => {
    for (const diff of [{ pid: 552 }, { start_ticks: '1' }, { boot_id: 'other' }, { exe: '/usr/lib/postgresql/15/bin/postgres' }, { argv: [...ID.argv, '-c', 'x=1'] }, { cwd: '/var/tmp/elsewhere' }])
      assert.equal(ev(cleanupRecord({ owned_processes_before: [pm(diff)], signals: [{ pid: diff.pid ?? 551, signal: 'INT', exited: true }] })).ok, false, JSON.stringify(diff));
  });
  test('C2 shutdown must be evidenced structurally, not by text: fabricated textual proof, signals without a verified target, undelivered or illegal signals are FAIL', () => {
    assert.equal(ev(cleanupRecord({ signals: [], stop_method: 'none', owned_processes_before: [], shutdown_proof: ['pg_ctl stop completed', 'verified postmaster exited'] })).ok, false);   // text only
    assert.equal(ev(cleanupRecord({ signals: [{ pid: 999, signal: 'INT', exited: true }] })).ok, false);                     // target never verified
    assert.equal(ev(cleanupRecord({ signals: [{ pid: 551, signal: 'INT', exited: false }] })).ok, false);                   // did not exit
    assert.equal(ev(cleanupRecord({ signals: [{ pid: 551, signal: 'KILL', exited: true }] })).ok, false);                    // not an allowed signal
    assert.equal(ev(cleanupRecord({ signals: [], stop_method: 'signal' })).ok, false);                                       // method claims a signal
    assert.equal(ev(cleanupRecord({ stop_method: 'none' })).ok, false);                                                      // signal sent, method denies it
    assert.equal(ev(cleanupRecord({ termination_evidence: 'not_applicable' })).ok, false);                                   // postmaster stopped but evidence says otherwise
    assert.equal(ev(cleanupRecord({ stop_mode: 'immediate' })).ok, false);                                                   // immediate without a SIGQUIT
    assert.equal(ev(cleanupRecord({ owned_processes_before: [pm(), pm({ pid: 560 })] })).ok, false);                         // second verified postmaster never signalled
    assert.equal(ev(cleanupRecord({ stop_method: 'none', signals: [], owned_processes_before: [], termination_evidence: 'stopped_by_cleanup' })).ok, false);
  });
  test('C2 stale-pid and repeat-cleanup evidence must name the RECORDED pid / an earlier verified stop', () => {
    const stale = over => cleanupRecord({ stop_mode: 'already_stopped', stop_method: 'none', signals: [], owned_processes_before: [], port_before: port('none'), termination_evidence: 'stale_pidfile_dead_pid', stale_pidfile: { pid: 551, alive: false }, ...over });
    assert.equal(ev(stale()).ok, true);
    assert.equal(ev(stale({ stale_pidfile: { pid: 700, alive: false } })).ok, false);   // not the recorded postmaster
    assert.equal(ev(stale({ stale_pidfile: null })).ok, false);
    assert.equal(ev(stale({ stale_pidfile: { pid: 551, alive: true } })).ok, false);
    assert.equal(ev(stale({ startup_identity: { state: 'ABSENT', missing: [], recorded: null } })).ok, false);
    const prior = over => cleanupRecord({ stop_mode: 'already_stopped', stop_method: 'none', signals: [], root_existed_before: false, owned_processes_before: [], port_before: port('none'), termination_evidence: 'prior_verified_stop', prior_cleanup_status: 'STOPPED_VERIFIED', ...over });
    assert.equal(ev(prior()).ok, true);
    assert.equal(ev(prior({ prior_cleanup_status: 'FAILED' })).ok, false); assert.equal(ev(prior({ prior_cleanup_status: null })).ok, false);
    assert.equal(ev(prior({ root_existed_before: true })).ok, false);
  });
  test('C2 NOT_STARTED / REMOVED_UNINITIALISED require NO start-up identity and no signal; an unverified-start STOPPED_VERIFIED with a live postmaster is FAIL', () => {
    assert.equal(ev(notStartedRecord({ startup_identity: { state: 'COMPLETE', missing: [], recorded: ID } })).ok, false);
    assert.equal(ev(uninitialisedRecord({ startup_identity: { state: 'INCOMPLETE', missing: ['boot_id'], recorded: null } })).ok, false);
    assert.equal(ev(uninitialisedRecord({ signals: [{ pid: 551, signal: 'INT', exited: true }], stop_method: 'signal' })).ok, false);
    assert.equal(ev(cleanupRecord({ startup_status: 'START_ATTEMPTED_UNVERIFIED', startup_identity: { state: 'ABSENT', missing: [], recorded: null } })).ok, false);   // live postmaster, nothing to match it to
  });

  test('gate FAILED (not PASSED, not INCONCLUSIVE) on the original false-positive record', () => {
    const d = tmp(); fs.mkdirSync(path.join(d, 'postgres')); fs.writeFileSync(path.join(d, 'postgres', 'cleanup.json'), JSON.stringify(uninitialisedRecord({ startup_status: 'RUNNING_VERIFIED' })));
    const prof = { profile_id: 't', stage: 'R04', runtime: { requires: ['postgres'] }, checks: [] };
    const r = classifyRun({ profile: prof, rawDir: d, identity: { ok: true } });
    assert.equal(r.gate, GATE.FAILED);
    assert.equal(r.checks.find(c => c.id === 'postgres-cleanup').status, S.FAIL);
  });

  // Positive: legitimate behaviour is preserved
  test('P1 never-started cluster: NOT_STARTED is PASS, also next to an independently identified foreign listener on the port', () => {
    assert.equal(ev(notStartedRecord()).ok, true);
    assert.equal(viaFile(notStartedRecord()).status, S.PASS);
    const foreign = notStartedRecord({ port_before: port('foreign'), port_after: port('foreign'), notes: ['foreign'] });
    assert.equal(ev(foreign).ok, true);
  });
  test('P2 partially initialised root, no postmaster, port not ours: REMOVED_UNINITIALISED is PASS', () => {
    assert.equal(ev(uninitialisedRecord()).ok, true);
    assert.equal(ev(uninitialisedRecord({ port_before: port('foreign'), port_after: port('foreign') })).ok, true);
  });
  test('P3 verified shutdown is PASS: pg_ctl stop, escalation, direct signal of a verified postmaster, stale pid of a dead server, repeat cleanup', () => {
    assert.equal(ev(cleanupRecord()).ok, true);
    assert.equal(ev(cleanupRecord({ status: 'STOPPED_VERIFIED_AFTER_ESCALATION', stop_mode: 'immediate', signals: [{ pid: 551, signal: 'QUIT', exited: true }] })).ok, true);
    assert.equal(ev(cleanupRecord({ pg_version_present_before: false })).ok, true);
    assert.equal(ev(cleanupRecord({ stop_mode: 'already_stopped', stop_method: 'none', signals: [], owned_processes_before: [], port_before: port('none'), termination_evidence: 'stale_pidfile_dead_pid', stale_pidfile: { pid: 551, alive: false }, shutdown_proof: ['postmaster.pid named pid 551, which is not alive'] })).ok, true);
    assert.equal(ev(cleanupRecord({ stop_mode: 'already_stopped', stop_method: 'none', signals: [], root_existed_before: false, owned_processes_before: [], port_before: port('none'), termination_evidence: 'prior_verified_stop', prior_cleanup_status: 'STOPPED_VERIFIED', shutdown_proof: ['earlier cleanup'] })).ok, true);
    // a start that was attempted but never produced a server (nothing recorded, nothing running) is a legitimate verified no-op
    assert.equal(ev(cleanupRecord({ startup_status: 'START_ATTEMPTED_UNVERIFIED', startup_identity: { state: 'ABSENT', missing: [], recorded: null }, termination_evidence: 'not_applicable', owned_processes_before: [], signals: [], port_before: port('none'), stop_mode: 'already_stopped', stop_method: 'none' })).ok, true);
  });
  test('P4 a foreign instance interfering with the cleanup record is FAIL; FAILED stays FAIL with its problems listed', () => {
    const r = ev({ status: 'FAILED', problems: ['a'] }); assert.equal(r.ok, false); assert.deepEqual(r.reasons, ['cleanup status FAILED', 'a']);
  });
});

describe('C3: the runtime job conclusion bounds the sealed gate (S14-S16)', () => {
  // All-PASS evidence + verified cleanup: only the runtime conclusion varies.
  const profile = { profile_id: 't', stage: 'R04', runtime: { requires: ['postgres'] }, checks: [{ id: 'pure', title: 'p', class: 'PURE_PGLITE', kind: 'node-test', mandatory: true, requires: [], allow_skip: false, file_timeout_seconds: 60, files: [{ path: 'tests/a.test.ts', expect_tests: 2 }] }] };
  const raw = (pass = true) => {
    const d = tmp(); fs.mkdirSync(path.join(d, 'checks', 'pure'), { recursive: true }); fs.mkdirSync(path.join(d, 'postgres'));
    fs.writeFileSync(path.join(d, 'checks', 'pure', 'result.json'), JSON.stringify({ state: 'EXECUTED', files: [{ path: 'tests/a.test.ts', state: 'EXECUTED', exit_code: pass ? 0 : 1, counts: { tests: 2, pass: pass ? 2 : 1, fail: pass ? 0 : 1, cancelled: 0, skipped: 0, todo: 0 } }] }));
    fs.writeFileSync(path.join(d, 'postgres', 'cleanup.json'), JSON.stringify(notStartedRecord()));
    return d;
  };
  const gate = (rr, dir = raw()) => classifyRun({ profile, rawDir: dir, identity: { ok: true }, runtimeResult: rr });
  test('S16 success + complete evidence: normal classification, PASSED', () => { const r = gate('success'); assert.equal(r.gate, GATE.PASSED); assert.deepEqual(r.gate_reasons, []); });
  test('S14 every check PASS but the runtime job failed: gate is not PASSED (FAILED), check statuses are preserved as PASS', () => {
    const r = gate('failure'); assert.equal(r.gate, GATE.FAILED);
    assert.ok(r.checks.every(c => c.status === S.PASS)); assert.match(r.gate_reasons.join(' '), /runtime job concluded failure/);
  });
  test('S15 cancelled and skipped runtime jobs: not PASSED (INCONCLUSIVE), checks preserved', () => {
    for (const rr of ['cancelled', 'skipped']) { const r = gate(rr); assert.equal(r.gate, GATE.INCONCLUSIVE, rr); assert.ok(r.checks.every(c => c.status === S.PASS)); assert.match(r.gate_reasons.join(' '), new RegExp(rr)); }
  });
  test('S15 missing / unrecognised runtime result fails closed (FAILED)', () => {
    for (const rr of [null, 'unknown', '', 'Success', 'success ', 'passed', 7]) assert.equal(gate(rr).gate, GATE.FAILED, String(rr));
  });
  test('the runtime result never upgrades: a FAILED or INCONCLUSIVE gate stays; a failed job with blocked evidence stays INCONCLUSIVE (explained), not FAILED', () => {
    assert.equal(gate('success', raw(false)).gate, GATE.FAILED);
    assert.equal(gate('failure', raw(false)).gate, GATE.FAILED);
    assert.equal(gate('cancelled', raw(false)).gate, GATE.FAILED);
    const blocked = tmp(); fs.mkdirSync(path.join(blocked, 'checks', 'pure'), { recursive: true }); fs.mkdirSync(path.join(blocked, 'postgres'));
    fs.writeFileSync(path.join(blocked, 'checks', 'pure', 'result.json'), JSON.stringify({ state: 'BLOCKED', reason: 'dependency installation outcome: failure' }));
    fs.writeFileSync(path.join(blocked, 'postgres', 'cleanup.json'), JSON.stringify(notStartedRecord()));
    assert.equal(gate('success', blocked).gate, GATE.INCONCLUSIVE); assert.equal(gate('failure', blocked).gate, GATE.INCONCLUSIVE); assert.equal(gate('unknown', blocked).gate, GATE.FAILED);
  });
  test('undefined means "not applicable" (the runtime job\'s own preliminary classification) and changes nothing', () => {
    assert.equal(classifyRun({ profile, rawDir: raw(), identity: { ok: true } }).gate, GATE.PASSED);
    const r = { gate: GATE.PASSED, gate_reasons: [] }; assert.equal(applyRuntimeResult(r, 'failure').gate, GATE.FAILED);
  });
  test('seal.mjs CLI enforces it end-to-end, records the conclusion, and verify-evidence rejects a PASS sealed next to a failed runtime job', () => {
    const ok = sealR04('success');
    assert.equal(ok.rec.result.gate, GATE.PASSED); assert.equal(ok.run.status, 0, ok.run.stdout + ok.run.stderr); assert.equal(ok.rec.github.runtime_job_result, 'success'); assert.equal(ok.verify.status, 0, ok.verify.stdout);
    for (const [rr, expected] of [['failure', GATE.FAILED], ['cancelled', GATE.INCONCLUSIVE], ['skipped', GATE.INCONCLUSIVE], [undefined, GATE.FAILED], ['bogus', GATE.FAILED]]) {
      const x = sealR04(rr);
      assert.equal(x.rec.result.gate, expected, String(rr)); assert.notEqual(x.run.status, 0, String(rr));
      assert.ok(x.rec.result.checks.filter(c => c.id !== 'postgres-cleanup').every(c => c.status === S.PASS), 'individual outcomes are preserved: ' + rr);
      assert.equal(x.verify.status, 0, `${rr}: the sealed package verifies consistently\n${x.verify.stdout}`);
    }
    // forging the sealed gate to PASSED next to a failed runtime job is caught by independent re-classification
    const f = sealR04('failure'); const recFile = path.join(f.out, 'acceptance-result.json');
    fs.writeFileSync(recFile, fs.readFileSync(recFile, 'utf8').replace(/"gate": "TECHNICAL_GATES_FAILED"/, '"gate": "TECHNICAL_GATES_PASSED"'));
    writeManifest(f.out, { gate: 'TECHNICAL_GATES_PASSED' });
    const v = spawnSync('node', [path.join(LIB, 'verify-evidence.mjs'), f.out, '--profile', path.join(PROFILES, 'r04-cp02.json')], { encoding: 'utf8' });
    assert.equal(v.status, 2, v.stdout); assert.match(v.stdout, /re-classification gives TECHNICAL_GATES_FAILED, sealed result claims TECHNICAL_GATES_PASSED/);
  });
});

describe('C4 defense in depth: the database reset targets exactly this run\'s disposable cluster (pure, no SQL)', () => {
  const ENV = { GITHUB_RUN_ID: '123456789', GITHUB_RUN_ATTEMPT: '2' };
  const GOOD = { name: 'gpr2-p1-isolated', dir: '/var/tmp/gpr2-accept-123456789-2/data', addr: '127.0.0.1/32' };
  test('the exact run id + attempt is accepted (also with a plain 127.0.0.1 address)', () => {
    assert.equal(expectedDataDirectory(ENV), '/var/tmp/gpr2-accept-123456789-2/data');
    assert.equal(judgeCluster(GOOD, ENV), null); assert.equal(judgeCluster({ ...GOOD, addr: '127.0.0.1' }, ENV), null);
  });
  test('a different run id, a different attempt, and a stale-looking root of another run are rejected although they match the generic pattern', () => {
    assert.match(judgeCluster({ ...GOOD, dir: '/var/tmp/gpr2-accept-123456780-2/data' }, ENV), /not this run's disposable cluster/);
    assert.match(judgeCluster({ ...GOOD, dir: '/var/tmp/gpr2-accept-123456789-1/data' }, ENV), /not this run's disposable cluster/);
    assert.match(judgeCluster(GOOD, { ...ENV, GITHUB_RUN_ATTEMPT: '3' }), /not this run's disposable cluster/);
    assert.match(judgeCluster(GOOD, { ...ENV, GITHUB_RUN_ID: '1' }), /not this run's disposable cluster/);
  });
  test('missing or invalid run identity is rejected before anything else is considered', () => {
    for (const env of [{}, { GITHUB_RUN_ID: '1' }, { GITHUB_RUN_ATTEMPT: '1' }, { ...ENV, GITHUB_RUN_ID: '' }, { ...ENV, GITHUB_RUN_ATTEMPT: '' }, { ...ENV, GITHUB_RUN_ID: 'abc' }, { ...ENV, GITHUB_RUN_ATTEMPT: '1x' },
                       { ...ENV, GITHUB_RUN_ID: '../..' }, { ...ENV, GITHUB_RUN_ID: ' 12' }, { ...ENV, GITHUB_RUN_ATTEMPT: '-1' }, { ...ENV, GITHUB_RUN_ID: '1e3' }, { ...ENV, GITHUB_RUN_ID: '12\n' }]) {
      assert.equal(expectedDataDirectory(env), null, JSON.stringify(env));
      assert.match(judgeCluster(GOOD, env), /missing or not numeric/, JSON.stringify(env));
    }
  });
  test('a foreign data directory is rejected: another cluster, a subdirectory, a parent, a traversal, a trailing slash, a symlink-style variant', () => {
    for (const dir of ['/var/lib/postgresql/16/main', '/var/tmp/gpr2-foreign/data', '/var/tmp/gpr2-accept-123456789-2', '/var/tmp/gpr2-accept-123456789-2/data/', '/var/tmp/gpr2-accept-123456789-2/data/base',
                       '/var/tmp/gpr2-accept-123456789-2/../gpr2-accept-9-9/data', '/var/tmp/gpr2-accept-123456789-2/data/..', '', undefined, null])
      assert.match(judgeCluster({ ...GOOD, dir }, ENV), /not this run's disposable cluster/, String(dir));
  });
  test('cluster_name and loopback checks are preserved', () => {
    assert.match(judgeCluster({ ...GOOD, name: 'foreign' }, ENV), /cluster_name is 'foreign'/);
    assert.match(judgeCluster({ ...GOOD, name: undefined }, ENV), /cluster_name/);
    for (const addr of ['10.0.0.5', '::1', '0.0.0.0', '127.0.0.2', '', undefined]) assert.match(judgeCluster({ ...GOOD, addr }, ENV), /not loopback/, String(addr));
  });
  test('the generic pattern alone no longer admits a cluster: judgeCluster never returns null for a mismatching run, whatever the other fields', () => {
    for (let n = 0; n < 50; n++) assert.notEqual(judgeCluster({ ...GOOD, dir: `/var/tmp/gpr2-accept-${n}-${n}/data` }, ENV), null);
  });
});

describe('CI-EVID-01: verify-evidence must fail closed on an invalid or inconsistent sealed gate', () => {
  const VERIFY = (dir) => spawnSync('node', [path.join(LIB, 'verify-evidence.mjs'), dir, '--profile', path.join(PROFILES, 'r04-cp02.json')], { encoding: 'utf8' });
  // Rewrite acceptance-result.json with `mutate`, then REBUILD manifest.json and SHA256SUMS (keeping the original manifest metadata, optionally
  // patched) so the package is checksum-consistent and only semantic verification can reject it.
  const forge = (pkg, mutate, manifestPatch = {}) => {
    const recFile = path.join(pkg.out, 'acceptance-result.json');
    const rec = JSON.parse(fs.readFileSync(recFile, 'utf8')); mutate(rec); fs.writeFileSync(recFile, JSON.stringify(rec, null, 2) + '\n');
    const { schema, file_count, files, ...meta } = JSON.parse(fs.readFileSync(path.join(pkg.out, 'manifest.json'), 'utf8')); void schema; void file_count; void files;
    writeManifest(pkg.out, { ...meta, ...manifestPatch });
    return VERIFY(pkg.out);
  };
  const FAILED_MSG = /EVIDENCE INTEGRITY: FAILED/;

  test('valid sealed PASS (checksums rebuilt, nothing altered) still verifies: exit 0', () => {
    const pkg = sealR04('success'); assert.equal(pkg.rec.result.gate, GATE.PASSED);
    const v = forge(pkg, () => {}); assert.equal(v.status, 0, v.stdout); assert.match(v.stdout, /EVIDENCE INTEGRITY: VERIFIED/);
  });
  for (const [label, mutate] of [
    ['an unrecognised gate string', r => { r.result.gate = 'UNRECOGNISED_GATE'; }],
    ['a missing gate', r => { delete r.result.gate; }],
    ['a null gate', r => { r.result.gate = null; }],
    ['a numeric gate', r => { r.result.gate = 2; }],
    ['a differently-cased gate', r => { r.result.gate = 'technical_gates_passed'; }],
    ['an inherited-property name as gate', r => { r.result.gate = 'constructor'; }],
    ['a missing result object', r => { delete r.result; }],
  ]) {
    test(`${label} fails verification (exit 2) even though manifest and SHA256SUMS were rebuilt`, () => {
      const v = forge(sealR04('success'), mutate);
      assert.equal(v.status, 2, `${label}: exit ${v.status}\n${v.stdout}${v.stderr}`); assert.match(v.stdout, FAILED_MSG);
    });
  }
  test('an unknown/invalid gate fails on every kind of package, including sealed FAILED/INCONCLUSIVE ones, without disturbing their valid semantics', () => {
    for (const [rr, expected] of [['failure', GATE.FAILED], ['cancelled', GATE.INCONCLUSIVE], ['skipped', GATE.INCONCLUSIVE]]) {
      const good = sealR04(rr); assert.equal(good.rec.result.gate, expected); assert.equal(good.verify.status, 0, `${rr} stays valid`);
      assert.equal(forge(sealR04(rr), r => { r.result.gate = 'BOGUS'; }).status, 2, `${rr} + bogus gate`);
    }
  });
  test('runtime failure + sealed gate forged to PASSED fails; downgrade semantics are unchanged (a sealed gate stricter than the re-classification is accepted)', () => {
    const v = forge(sealR04('failure'), r => { r.result.gate = GATE.PASSED; }, { gate: GATE.PASSED });
    assert.equal(v.status, 2); assert.match(v.stdout, /re-classification gives TECHNICAL_GATES_FAILED, sealed result claims TECHNICAL_GATES_PASSED/);
    // all-PASS evidence honestly sealed as FAILED/INCONCLUSIVE is a conservative downgrade, not an upgrade: still allowed (and manifest agrees)
    for (const g of [GATE.FAILED, GATE.INCONCLUSIVE]) { const w = forge(sealR04('success'), r => { r.result.gate = g; }, { gate: g }); assert.equal(w.status, 0, `${g}\n${w.stdout}`); }
  });
  test('manifest.gate must equal result.gate: a PASSED result next to a FAILED manifest (or vice versa, or a missing manifest gate) fails', () => {
    assert.equal(forge(sealR04('success'), () => {}, { gate: GATE.FAILED }).status, 2);
    assert.equal(forge(sealR04('failure'), r => { r.result.gate = GATE.INCONCLUSIVE; }, { gate: GATE.FAILED }).status, 2);
    assert.equal(forge(sealR04('success'), () => {}, { gate: 'UNRECOGNISED_GATE' }).status, 2);
    assert.equal(forge(sealR04('success'), () => {}, { gate: undefined }).status, 2);
  });
  test('ordinary checksum tampering and unlisted files are still rejected', () => {
    const pkg = sealR04('success'); const rf = path.join(pkg.out, 'raw', 'checks', 'native-pg', 'result.json');
    fs.writeFileSync(rf, fs.readFileSync(rf, 'utf8').replace('"pass":', '"pass":1')); let v = VERIFY(pkg.out);
    assert.equal(v.status, 2); assert.match(v.stdout, /checksum mismatch: raw\/checks\/native-pg\/result.json/);
    const pkg2 = sealR04('success'); fs.writeFileSync(path.join(pkg2.out, 'extra.txt'), 'x'); v = VERIFY(pkg2.out);
    assert.equal(v.status, 2); assert.match(v.stdout, /not covered by SHA256SUMS/);
  });
});

describe('evidence sealing and independent verification', () => {
  test('manifest + SHA256SUMS round-trip; verify-evidence detects tampering, unlisted files and a swapped profile', () => {
    // Build a minimal sealed package by hand, then verify it with the reviewer tool.
    const d = tmp();
    const profFile = path.join(PROFILES, 'r04-cp02.json');
    const { profile, sha256 } = loadProfile(profFile);
    fs.mkdirSync(path.join(d, 'raw', 'postgres'), { recursive: true });
    const native = profile.checks[0], pgl = profile.checks[1];
    for (const c of [native, pgl]) {
      fs.mkdirSync(path.join(d, 'raw', 'checks', c.id), { recursive: true });
      fs.writeFileSync(path.join(d, 'raw', 'checks', c.id, 'result.json'), JSON.stringify({ state: 'EXECUTED', files: c.files.map(f => ({ path: f.path, state: 'EXECUTED', exit_code: 0, counts: { tests: f.expect_tests, pass: f.expect_tests, fail: 0, cancelled: 0, skipped: 0, todo: 0 } })) }));
    }
    fs.mkdirSync(path.join(d, 'raw', 'checks', 'browser-gpr1'), { recursive: true });
    fs.writeFileSync(path.join(d, 'raw', 'checks', 'browser-gpr1', 'report.json'), JSON.stringify({ stats: { expected: 22, unexpected: 0, flaky: 0, skipped: 0 }, errors: [], suites: [{ title: 's', specs: Array.from({ length: 22 }, (_, i) => ({ title: 't' + i, tests: [{ status: 'expected', results: [{ status: 'passed' }] }] })) }] }));
    fs.writeFileSync(path.join(d, 'raw', 'checks', 'browser-gpr1', 'result.json'), JSON.stringify({ state: 'EXECUTED', exit_code: 0, report: 'checks/browser-gpr1/report.json' }));
    fs.writeFileSync(path.join(d, 'raw', 'postgres', 'cleanup.json'), JSON.stringify(cleanupRecord()));
    const identity = { ok: true, candidate: { sha: R04, tree: profile.candidates[0].tree } };
    fs.writeFileSync(path.join(d, 'identity-seal.json'), JSON.stringify(identity));
    fs.writeFileSync(path.join(d, 'authorization.json'), JSON.stringify({ ok: true, request: { actor: 'Shamil9586', triggering_actor: 'Shamil9586' }, candidate: { sha: R04 } }));
    const result = classifyRun({ profile, rawDir: path.join(d, 'raw'), identity, runtimeResult: 'success' });
    assert.equal(result.gate, GATE.PASSED);
    assert.equal(result.by_class.NATIVE_POSTGRESQL.tests_pass, 27); assert.equal(result.by_class.PURE_PGLITE.tests_pass, 16); assert.equal(result.by_class.BROWSER_CHROMIUM.tests_pass, 22);
    fs.writeFileSync(path.join(d, 'acceptance-result.json'), JSON.stringify({ profile: { id: profile.profile_id, sha256 }, git: { candidate_sha: R04, candidate_tree: profile.candidates[0].tree }, github: { run_id: '1', run_attempt: '1', workflow_sha: MAIN, runtime_job_result: 'success' }, result }));
    writeManifest(d, { gate: result.gate });
    const verify = (...extra) => spawnSync('node', [path.join(LIB, 'verify-evidence.mjs'), d, '--profile', profFile, ...extra], { encoding: 'utf8' });
    let v = verify('--expect-candidate', R04);
    assert.equal(v.status, 0, v.stdout + v.stderr);
    assert.match(v.stdout, /EVIDENCE INTEGRITY: VERIFIED/);
    // 1. a forged count inside the raw evidence
    const rf = path.join(d, 'raw', 'checks', 'native-pg', 'result.json'); const orig = fs.readFileSync(rf);
    fs.writeFileSync(rf, orig.toString().replace('"tests":2', '"tests":3'));
    v = verify(); assert.equal(v.status, 2); assert.match(v.stdout, /checksum mismatch: raw\/checks\/native-pg\/result.json/);
    fs.writeFileSync(rf, orig);
    // 2. an injected, unlisted file
    fs.writeFileSync(path.join(d, 'raw', 'extra.log'), 'x'); v = verify(); assert.equal(v.status, 2); assert.match(v.stdout, /not covered by SHA256SUMS/); fs.rmSync(path.join(d, 'raw', 'extra.log'));
    // 3. a different profile than the one the run used
    v = spawnSync('node', [path.join(LIB, 'verify-evidence.mjs'), d, '--profile', path.join(PROFILES, 'r04-main-integration.json')], { encoding: 'utf8' });
    assert.equal(v.status, 2); assert.match(v.stdout, /evidence is for profile r04-cp02/);
    // 4. wrong expected candidate
    v = verify('--expect-candidate', MAIN); assert.equal(v.status, 2);
    assert.equal(verify().status, 0);
  });
});
