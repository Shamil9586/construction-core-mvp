#!/usr/bin/env node
// Construction Core — GPR-2 CI Foundation: execute a profile's checks against the checked-out candidate.
// Harness-owned: the candidate's own runner scripts (e.g. scripts/gpr2-p1-run-tests.sh) are NOT used, so the candidate cannot redefine
// which files run or how results are counted. Each node-test file runs alone (--test-concurrency=1) under `timeout`, on a freshly
// recreated `construction_test` database when the check requires native PostgreSQL, with a scrubbed environment.
//
// CLI: node run-profile.mjs --profile <profile.json> --core <candidate dir> --out <raw evidence dir>
// Env: GPR2_ENV_DEPS / GPR2_ENV_POSTGRES / GPR2_ENV_CHROMIUM = outcome of the provisioning steps (success|failure|skipped|cancelled)
// Exit: 0 when the preliminary classification passes, 1 otherwise (the authoritative verdict is produced by the seal job).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProfile } from './profile.mjs';
import { parseTapSummary, classifyRun } from './classify.mjs';
import { testInventory } from './identity.mjs';

const PG_BASE = 'postgresql://postgres:x@127.0.0.1:54329';
const CLUSTER_NAME = 'gpr2-p1-isolated';
const SCRUB = /^(DATABASE_URL|PG[A-Z_]*|E2E_.*|POSTGRES_.*|GPR2_ISOLATED_PG_URL|GPR2_EVIDENCE_DIR|ACTIONS_.*|GITHUB_TOKEN|GH_TOKEN|GPR2_EXTERNAL_INPUTS_DIR|GPR2_TD_PATH|GPR2_ROADMAP_PATH|NODE_OPTIONS|NPM_TOKEN|.*(TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY).*)$/i;

function args() {
  const a = {}; const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i += 2) a[v[i].replace(/^--/, '')] = v[i + 1];
  for (const k of ['profile', 'core', 'out']) if (!a[k]) { console.error(`missing --${k}`); process.exit(64); }
  return a;
}
/** Environment for every candidate process: credential-, database- and runner-control variables are removed (SCRUB), then pinned. */
export function baseEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!SCRUB.test(k)) env[k] = v;
  return { ...env, TZ: 'UTC', CI: 'true', AUTH_MODE: 'mock', DATABASE_URL: '', ...extra };
}
function run(cmd, argv, { cwd, env, log, timeoutSec }) {
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, 'w');
  const t0 = Date.now();
  const full = timeoutSec ? ['timeout', ['--kill-after=15', String(timeoutSec), cmd, ...argv]] : [cmd, argv];
  const r = spawnSync(full[0], full[1], { cwd, env, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  const exit = r.status ?? (r.signal ? 128 : -1);
  return { exit_code: exit, timed_out: timeoutSec ? exit === 124 || exit === 137 : false, seconds: Math.round((Date.now() - t0) / 1000), error: r.error ? String(r.error) : undefined };
}
const capture = (cmd, argv, opts = {}) => { const r = spawnSync(cmd, argv, { encoding: 'utf8', ...opts }); return r.status === 0 ? r.stdout.trim() : null; };
const psql = (url, sql) => spawnSync('psql', [url, '-XAtq', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', env: baseEnv() });

/** Exact data directory of THIS run's disposable cluster (the layout pg-cluster.sh creates), or null when the run identity is missing or not numeric. */
export function expectedDataDirectory(env = process.env) {
  const id = env.GITHUB_RUN_ID, attempt = env.GITHUB_RUN_ATTEMPT;
  if (typeof id !== 'string' || typeof attempt !== 'string' || !/^[0-9]+$/.test(id) || !/^[0-9]+$/.test(attempt)) return null;
  return `/var/tmp/gpr2-accept-${id}-${attempt}/data`;
}
/**
 * Judge what a server reports about itself against this run's disposable cluster. Returns null only for the expected one, otherwise the refusal
 * reason. Pure (no I/O): the destructive database reset is never reached unless this returns null. Defense in depth: pg-cluster.sh start already
 * refuses a stale root and an occupied port, so only this run's cluster can normally answer here; this makes that an enforced precondition.
 */
export function judgeCluster({ name, dir, addr }, env = process.env) {
  const expected = expectedDataDirectory(env);
  if (!expected) return 'GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT are missing or not numeric: this run\'s disposable cluster cannot be identified';
  if (name !== CLUSTER_NAME) return `cluster_name is '${name}', not ${CLUSTER_NAME}`;
  if (dir !== expected) return `data directory ${dir} is not this run's disposable cluster (${expected})`;
  if (!/^127\.0\.0\.1(\/32)?$/.test(addr)) return `server address ${addr} is not loopback`;
  return null;
}
function verifyCluster() {
  if (!expectedDataDirectory()) return judgeCluster({});   // no run identity: refuse before connecting to anything
  const r = psql(`${PG_BASE}/postgres`, "select current_setting('cluster_name') || '|' || current_setting('data_directory') || '|' || inet_server_addr()::text");
  if (r.status !== 0) return 'isolated cluster does not answer on 127.0.0.1:54329';
  const [name, dir, addr] = r.stdout.trim().split('|');
  return judgeCluster({ name, dir, addr });
}

function nodeTestCheck(check, ctx) {
  const dir = path.join(ctx.out, 'checks', check.id);
  const needsPg = check.requires.includes('postgres');
  const files = [];
  for (const f of check.files) {
    const abs = path.join(ctx.core, f.path);
    const slug = f.path.replace(/[\/]/g, '_');
    const rec = { path: f.path, expected_tests: f.expect_tests, log: `checks/${check.id}/logs/${slug}.log`, junit: `checks/${check.id}/junit/${slug}.xml` };
    if (!fs.existsSync(abs) || fs.statSync(abs).size === 0) { files.push({ ...rec, state: 'MISSING' }); continue; }
    // A file the profile runs in an isolated job (profile files[].isolated) is NEVER executed here: this job runs candidate code and dependencies and must
    // never hold the private documents. Its result is produced by run-normative.mjs in the `normative` job and merged by the seal job.
    if (f.isolated) { files.push({ ...rec, state: 'DEFERRED', executed_in: f.isolated.job, reason: `executed in the isolated ${f.isolated.job} job, not in this job` }); continue; }
    let extra = {};
    if (needsPg) {
      const bad = verifyCluster();
      if (bad) { files.push({ ...rec, state: 'BLOCKED', reason: bad }); continue; }
      if (check.fresh_database_per_file) {
        const d = psql(`${PG_BASE}/postgres`, 'DROP DATABASE IF EXISTS construction_test WITH (FORCE)');
        const c = d.status === 0 ? psql(`${PG_BASE}/postgres`, 'CREATE DATABASE construction_test') : d;
        if (c.status !== 0) { files.push({ ...rec, state: 'DB_RESET_FAILED', reason: (c.stderr || '').slice(0, 500) }); continue; }
      }
      extra = { ...extra, GPR2_ISOLATED_PG_URL: `${PG_BASE}/postgres`, E2E_DATABASE_URL: `${PG_BASE}/construction_test`, E2E_ADMIN_DATABASE_URL: `${PG_BASE}/postgres`, E2E_POSTGRES_HOST_URL: `${PG_BASE}/`, GPR2_EVIDENCE_DIR: path.join(dir, 'evidence') };
      fs.mkdirSync(extra.GPR2_EVIDENCE_DIR, { recursive: true });
    }
    fs.mkdirSync(path.join(dir, 'junit'), { recursive: true });
    const r = run('node', ['--import', ctx.importLoader, '--test', '--test-concurrency=1', '--test-reporter=tap', '--test-reporter-destination=stdout',
                           '--test-reporter=junit', `--test-reporter-destination=${path.join(ctx.out, rec.junit)}`, f.path],
                  { cwd: ctx.core, env: baseEnv(extra), log: path.join(ctx.out, rec.log), timeoutSec: check.file_timeout_seconds });
    const counts = parseTapSummary(fs.readFileSync(path.join(ctx.out, rec.log), 'utf8'));
    if (r.timed_out) fs.appendFileSync(path.join(ctx.out, rec.log), `\n# HARNESS: TIMEOUT after ${check.file_timeout_seconds}s\n`);
    files.push({ ...rec, state: 'EXECUTED', ...r, counts });
    console.log(`  ${f.path}: exit=${r.exit_code} tests=${counts.tests ?? '?'} pass=${counts.pass ?? '?'} fail=${counts.fail ?? '?'} skipped=${counts.skipped ?? '?'} (${r.seconds}s)`);
  }
  return { id: check.id, kind: check.kind, class: check.class, state: 'EXECUTED', files };
}

function playwrightCheck(check, ctx) {
  const rel = `checks/${check.id}`;
  const dir = path.join(ctx.out, rel);
  if (!fs.existsSync(path.join(ctx.core, check.config))) return { id: check.id, state: 'MISSING' };
  fs.mkdirSync(dir, { recursive: true });
  const report = path.join(dir, 'report.json');
  const r = run('npx', ['--no-install', 'playwright', 'test', '--config', check.config, '--reporter=list,json', '--retries=0', '--trace=retain-on-failure', '--output', path.join(dir, 'test-results')],
                { cwd: ctx.core, env: baseEnv({ PLAYWRIGHT_JSON_OUTPUT_FILE: report, PLAYWRIGHT_JSON_OUTPUT_NAME: report, PLAYWRIGHT_FORCE_TTY: '0', FORCE_COLOR: '0' }),
                  log: path.join(dir, 'playwright.log'), timeoutSec: check.timeout_seconds });
  console.log(`  ${check.config}: exit=${r.exit_code} (${r.seconds}s)`);
  return { id: check.id, kind: check.kind, class: check.class, state: 'EXECUTED', ...r, report: fs.existsSync(report) ? `${rel}/report.json` : null, log: `${rel}/playwright.log` };
}

function scriptCheck(check, ctx) {
  const rel = `checks/${check.id}`;
  let pkg = {}; try { pkg = JSON.parse(fs.readFileSync(path.join(ctx.core, 'package.json'), 'utf8')); } catch { /* reported below */ }
  if (!pkg.scripts || typeof pkg.scripts[check.script] !== 'string') return { id: check.id, state: 'MISSING' };
  const r = run('npm', ['run', check.script], { cwd: ctx.core, env: baseEnv(), log: path.join(ctx.out, rel, 'npm-script.log'), timeoutSec: check.timeout_seconds });
  console.log(`  npm run ${check.script}: exit=${r.exit_code} (${r.seconds}s)`);
  return { id: check.id, kind: check.kind, class: check.class, state: 'EXECUTED', script_body: pkg.scripts[check.script], ...r, log: `${rel}/npm-script.log` };
}

function environment(ctx, profile) {
  const v = (c, a) => capture(c, a, { cwd: ctx.core, env: baseEnv() });
  const osr = (() => { try { return Object.fromEntries(fs.readFileSync('/etc/os-release', 'utf8').split('\n').filter(Boolean).map(l => l.split('=')).map(([k, ...r]) => [k, r.join('=').replace(/^"|"$/g, '')])); } catch { return {}; } })();
  const chromiumPath = profile.runtime.requires.includes('chromium') ? v('node', ['-e', "process.stdout.write(require('playwright-core').chromium.executablePath())"]) : null;
  const lock = path.join(ctx.core, 'package-lock.json');
  return {
    os: { pretty_name: osr.PRETTY_NAME || null, version_id: osr.VERSION_ID || null, kernel: v('uname', ['-srm']), image_os: process.env.ImageOS || null, image_version: process.env.ImageVersion || null, runner_name: process.env.RUNNER_NAME || null, runner_environment: process.env.RUNNER_ENVIRONMENT || null },
    node: v('node', ['--version']), npm: v('npm', ['--version']), git: v('git', ['--version']), psql_client: v('psql', ['--version']),
    postgres_server: (() => { try { return JSON.parse(fs.readFileSync(path.join(ctx.out, 'postgres', 'identity.json'), 'utf8')); } catch { return null; } })(),
    playwright: profile.runtime.requires.includes('chromium') ? v('npx', ['--no-install', 'playwright', '--version']) : null,
    chromium: chromiumPath ? { executable: chromiumPath, version: v(chromiumPath, ['--version']) } : null,
    package_lock_sha256: fs.existsSync(lock) ? capture('sha256sum', [lock])?.split(/\s+/)[0] ?? null : null,
    timezone: 'UTC', test_import_loader: ctx.importLoader,
    provisioning: ctx.provisioning,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = args();
  const { profile, sha256 } = loadProfile(a.profile);
  const out = path.resolve(a.out), core = path.resolve(a.core);
  fs.mkdirSync(path.join(out, 'checks'), { recursive: true });
  const provisioning = { dependencies: process.env.GPR2_ENV_DEPS || 'unknown', postgres: profile.runtime.requires.includes('postgres') ? process.env.GPR2_ENV_POSTGRES || 'unknown' : 'not_required', chromium: profile.runtime.requires.includes('chromium') ? process.env.GPR2_ENV_CHROMIUM || 'unknown' : 'not_required' };
  const ctx = { out, core, provisioning, importLoader: process.env.GPR2_TEST_IMPORT || 'tsx' };
  const started = new Date().toISOString();
  for (const check of profile.checks) {
    const dir = path.join(out, 'checks', check.id);
    fs.mkdirSync(dir, { recursive: true });
    const blocked = [];
    if (provisioning.dependencies !== 'success') blocked.push(`dependency installation outcome: ${provisioning.dependencies}`);
    if (check.requires.includes('postgres') && provisioning.postgres !== 'success') blocked.push(`PostgreSQL provisioning outcome: ${provisioning.postgres}`);
    if (check.requires.includes('chromium') && provisioning.chromium !== 'success') blocked.push(`Chromium provisioning outcome: ${provisioning.chromium}`);
    console.log(`[${check.id}] ${check.title}`);
    let rec;
    if (blocked.length) { rec = { id: check.id, kind: check.kind, class: check.class, state: 'BLOCKED', reason: blocked.join('; ') }; console.log('  ENVIRONMENT BLOCKED: ' + rec.reason); }
    else if (check.kind === 'node-test') rec = nodeTestCheck(check, ctx);
    else if (check.kind === 'playwright') rec = playwrightCheck(check, ctx);
    else rec = scriptCheck(check, ctx);
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(rec, null, 2) + '\n');
  }
  fs.writeFileSync(path.join(out, 'environment.json'), JSON.stringify(environment(ctx, profile), null, 2) + '\n');
  const pre = classifyRun({ profile, rawDir: out, identity: { ok: true, test_inventory: testInventory(core) } });
  fs.writeFileSync(path.join(out, 'runtime-summary.json'), JSON.stringify({ profile_id: profile.profile_id, profile_sha256: sha256, started_at: started, finished_at: new Date().toISOString(),
    preliminary_gate_excluding_cleanup_and_seal: pre.gate, checks: pre.checks.map(c => ({ id: c.id, status: c.status })) }, null, 2) + '\n');
  for (const c of pre.checks.filter(x => x.id !== 'postgres-cleanup')) console.log(`${c.status.padEnd(19)} ${c.id}${c.reasons && c.reasons.length ? ' — ' + c.reasons.join(' | ') : ''}`);
  // postgres-cleanup is NOT RUN at this point by design; it is evaluated by the seal job after the cleanup step.
  // Files deferred to an isolated job (and the regression inventory that depends on them) are judged by the seal job once their result is merged.
  const hasDeferred = pre.checks.some(c => (c.files || []).some(f => f.deferred));
  const failing = pre.checks.filter(c => c.mandatory && c.id !== 'postgres-cleanup' && c.status !== 'PASS'
    && !(c.files && c.files.length && c.files.every(f => f.status === 'PASS' || f.deferred))
    && !(hasDeferred && c.id === 'full-regression-inventory'));
  process.exit(failing.length ? 1 : 0);
}
