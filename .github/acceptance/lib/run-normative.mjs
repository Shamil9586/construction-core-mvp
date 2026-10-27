#!/usr/bin/env node
// Construction Core — GPR-2 CI Foundation: the isolated `normative` job (profile files[].isolated.job = "normative").
// The private GPR-2 documents reach ONLY this job. It runs no candidate code and no candidate dependency: the test and everything it executes are the
// repository files pinned by Git blob id (files[].isolated.closure — identical in the candidate and the public baseline, checked by stage-inputs.mjs),
// copied from the PUBLIC baseline checkout; the only third-party code is the lockfile's `tsx`/`esbuild`, installed with `npm ci --ignore-scripts`
// BEFORE any document is on disk. The test runs as an unprivileged uid with no sudo, in an empty network namespace, with a minimal environment.
//
//   node run-normative.mjs prepare --profile <p.json> --base <public baseline checkout> --work <dir> [--no-install]   (documents NOT yet present)
//   node run-normative.mjs run     --profile <p.json> --work <dir> --docs <dir> --out <dir> --candidate <sha>        (documents present)
//
// Fail closed: a missing tool, a failed sandbox probe, a closure or document mismatch is a refusal / ENVIRONMENT BLOCKED, never a skipped test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProfile } from './profile.mjs';
import { gitBlobId } from './source-bundle.mjs';
import { resolveExternalInputs } from './external-inputs.mjs';
import { parseTapSummary } from './classify.mjs';
import { isolatedFiles, NORMATIVE_SCHEMA } from './provenance.mjs';

export const SANDBOX_UID = 65534;
const BASE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
// The sandbox runs the SAME node binary as the harness (absolute path: a hosted runner's setup-node toolcache is not on a minimal PATH).
const NODE = process.execPath;

/** argv that runs `argv` as an unprivileged uid inside an EMPTY network namespace with exactly `env` (pure; sudo only when not already root). */
export function sandboxCommand({ argv, env, uid = SANDBOX_UID, root = process.getuid() === 0 }) {
  const envArgs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  const inner = ['unshare', '-n', 'setpriv', `--reuid=${uid}`, `--regid=${uid}`, '--clear-groups', '--no-new-privs', 'env', '-i', ...envArgs, ...argv];
  return root ? inner : ['sudo', '-n', ...inner];
}
const run = (argv, opts = {}) => spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', ...opts });

/** Run a probe inside the sandbox: it must be the sandbox uid, with no network interface but loopback, and an outbound connection must fail. */
export function sandboxProbe(work, env) {
  const code = "const os=require('os');const net=require('net');const ifs=Object.keys(os.networkInterfaces()).filter(n=>n!=='lo');" +
    "const s=net.connect({host:'1.1.1.1',port:443});let done=false;const out=(c)=>{if(done)return;done=true;console.log(JSON.stringify({uid:process.getuid(),ifaces:ifs,connect:c}));process.exit(0)};" +
    "s.on('connect',()=>out('CONNECTED'));s.on('error',e=>out(e.code||'ERROR'));setTimeout(()=>out('TIMEOUT'),3000);";
  const r = run(sandboxCommand({ argv: [NODE, '-e', code], env }), { cwd: work, timeout: 20000 });
  if (r.status !== 0) return { ok: false, reason: `sandbox could not be started (exit ${r.status}): ${(r.stderr || r.error || '').toString().slice(0, 300)}` };
  try {
    const j = JSON.parse(r.stdout.trim().split('\n').pop());
    const ok = j.uid === SANDBOX_UID && j.ifaces.length === 0 && j.connect !== 'CONNECTED' && j.connect !== 'TIMEOUT';
    return { ok, uid: j.uid, interfaces: j.ifaces, connect: j.connect, reason: ok ? null : `sandbox probe failed: ${JSON.stringify(j)}` };
  } catch { return { ok: false, reason: 'sandbox probe printed no result' }; }
}

/** Copy exactly the pinned closure files from the public baseline checkout to `work`, each verified by Git blob id first. Returns { ok, refusals }. */
export function prepareClosure({ profile, base, work }) {
  const refusals = [];
  for (const { file } of isolatedFiles(profile)) for (const x of file.isolated.closure) {
    const src = path.join(base, x.path);
    let st = null; try { st = fs.lstatSync(src); } catch { /* below */ }
    if (!st || !st.isFile() || st.isSymbolicLink()) { refusals.push(`${x.path}: missing or not a regular file in the baseline checkout`); continue; }
    const buf = fs.readFileSync(src), blob = gitBlobId(buf);
    if (blob !== x.blob) { refusals.push(`${x.path}: blob ${blob}, pinned ${x.blob}`); continue; }
    const dst = path.join(work, x.path); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, buf);
  }
  return { ok: refusals.length === 0, refusals };
}

function minimalEnv(home, extra = {}) { return { PATH: `${path.dirname(NODE)}:${BASE_PATH}`, HOME: home, TZ: 'UTC', CI: 'true', LANG: 'C.UTF-8', ...extra }; }

/** Run every isolated file. Returns the result record (also used by the tests). `timeoutSec` bounds each file. */
export function runIsolated({ profile, profileSha256, candidateSha, work, docsDir, out, timeoutSec = 600 }) {
  fs.mkdirSync(out, { recursive: true });
  const result = { schema: NORMATIVE_SCHEMA, job: 'normative', profile_id: profile.profile_id, profile_sha256: profileSha256, candidate_sha: candidateSha, node: process.version, files: [] };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gpr2-norm-home-')); fs.chmodSync(home, 0o777);
  const probe = sandboxProbe(work, minimalEnv(home));
  for (const { file } of isolatedFiles(profile)) {
    const rec = { path: file.path, expected_tests: file.expect_tests, sandbox: { network: 'none', uid: probe.uid ?? null, env: 'minimal', probe_ok: probe.ok === true, probe } };
    result.files.push(rec);
    if (!probe.ok) { Object.assign(rec, { state: 'BLOCKED', reason: probe.reason }); continue; }
    // closure files in the work directory must still be the pinned ones (nothing ran between prepare and now except the lockfile install)
    const bad = file.isolated.closure.filter(x => { try { return gitBlobId(fs.readFileSync(path.join(work, x.path))) !== x.blob; } catch { return true; } });
    if (bad.length) { Object.assign(rec, { state: 'BLOCKED', reason: `closure file(s) differ from the pinned blobs: ${bad.map(x => x.path).join(', ')}` }); continue; }
    rec.closure_verified = file.isolated.closure.map(x => ({ path: x.path, blob: x.blob }));
    const docs = resolveExternalInputs(file.external_inputs, docsDir);
    if (docs.reason) { Object.assign(rec, { state: 'INPUT_UNVERIFIED', reason: docs.reason }); continue; }
    // verified bytes -> a private copy for the sandbox user (the supplied directory is never handed to the test)
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'gpr2-norm-docs-')); fs.chmodSync(stage, 0o755);
    const env = minimalEnv(home);
    for (const d of docs.records) { const dst = path.join(stage, d.filename); fs.copyFileSync(path.join(docsDir, d.filename), dst); fs.chmodSync(dst, 0o444); env[file.external_inputs.find(x => x.env && x.filename === d.filename).env] = dst; }
    const logRel = `logs/${file.path.replace(/\//g, '_')}.log`; fs.mkdirSync(path.join(out, 'logs'), { recursive: true });
    const fd = fs.openSync(path.join(out, logRel), 'w'); const t0 = Date.now();
    const argv = ['timeout', '--kill-after=15', String(timeoutSec), NODE, '--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', file.path];
    const r = run(sandboxCommand({ argv, env }), { cwd: work, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    const exit = r.status ?? (r.signal ? 128 : -1);
    run(process.getuid() === 0 ? ['pkill', '-KILL', '-u', String(SANDBOX_UID)] : ['sudo', '-n', 'pkill', '-KILL', '-u', String(SANDBOX_UID)]);
    fs.rmSync(stage, { recursive: true, force: true });
    const counts = parseTapSummary(fs.readFileSync(path.join(out, logRel), 'utf8'));
    Object.assign(rec, { state: 'EXECUTED', exit_code: exit, timed_out: exit === 124 || exit === 137, seconds: Math.round((Date.now() - t0) / 1000), counts, log: logRel, external_inputs: docs.records });
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [cmd, ...rest] = process.argv.slice(2); const a = {};
  for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) { const k = rest[i].slice(2); a[k] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true; }
  for (const k of ['profile', 'work']) if (!a[k]) { console.error(`missing --${k}`); process.exit(64); }
  const { profile, sha256 } = loadProfile(a.profile); const work = path.resolve(a.work);
  if (cmd === 'prepare') {
    if (!a.base) { console.error('missing --base'); process.exit(64); }
    fs.mkdirSync(work, { recursive: true });
    const r = prepareClosure({ profile, base: path.resolve(a.base), work });
    if (!r.ok) { console.error('REFUSED closure:\n  - ' + r.refusals.join('\n  - ')); process.exit(2); }
    if (!a['no-install']) {
      const i = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: work, stdio: 'inherit', env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: 'true' } });
      if (i.status !== 0) { console.error('npm ci --ignore-scripts failed'); process.exit(3); }
    }
    spawnSync('chmod', ['-R', 'a+rX', work]);
    console.log(`Closure prepared in ${work}`);
  } else if (cmd === 'run') {
    for (const k of ['docs', 'out', 'candidate']) if (!a[k]) { console.error(`missing --${k}`); process.exit(64); }
    const res = runIsolated({ profile, profileSha256: sha256, candidateSha: a.candidate, work, docsDir: path.resolve(a.docs), out: path.resolve(a.out) });
    for (const f of res.files) console.log(`${f.path}: ${f.state}${f.counts ? ` tests=${f.counts.tests} pass=${f.counts.pass} fail=${f.counts.fail} skipped=${f.counts.skipped}` : ` — ${f.reason}`}`);
    process.exit(res.files.every(f => f.state === 'EXECUTED' && f.exit_code === 0) ? 0 : 1);
  } else { console.error('usage: run-normative.mjs prepare|run ...'); process.exit(64); }
}
