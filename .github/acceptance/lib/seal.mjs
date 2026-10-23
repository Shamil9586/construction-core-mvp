#!/usr/bin/env node
// Construction Core — GPR-2 CI Foundation: evidence sealing.
// Runs in the `seal` job, on a fresh runner where no candidate code has executed. It classifies the raw runtime evidence against the
// profile read from the workflow commit (never the copy inside the evidence), binds the result to the authorised Git identity and the
// GitHub run, and writes a manifest with SHA-256 checksums of every file. The result is a TECHNICAL gate, never an acceptance verdict.
//
// CLI: node seal.mjs --profile <profile.json> --raw <raw dir|missing> --authorization <authorization.json> --identity <seal identity.json>
//                    --runtime-result <success|failure|cancelled|skipped> --out <sealed dir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadProfile } from './profile.mjs';
import { classifyRun, GATE, S } from './classify.mjs';

export const EVIDENCE_SCHEMA = 'construction-core/gpr2-acceptance-evidence@1';
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const sha256File = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

export function listFiles(root) {
  const out = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
    const p = path.join(d, e.name);
    if (e.isSymbolicLink()) continue; // never follow links planted in evidence
    if (e.isDirectory()) walk(p); else if (e.isFile()) out.push(path.relative(root, p).split(path.sep).join('/'));
  } };
  if (fs.existsSync(root)) walk(root);
  return out;
}

export function writeManifest(root, meta) {
  const files = listFiles(root).filter(f => f !== 'SHA256SUMS' && f !== 'manifest.json');
  const entries = files.map(f => ({ path: f, bytes: fs.statSync(path.join(root, f)).size, sha256: sha256File(path.join(root, f)) }));
  const manifest = { schema: EVIDENCE_SCHEMA, ...meta, file_count: entries.length, files: entries };
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const sums = [...entries, { path: 'manifest.json', sha256: sha256File(path.join(root, 'manifest.json')) }].map(e => `${e.sha256}  ${e.path}`).join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'SHA256SUMS'), sums);
  return manifest;
}

function copyTree(src, dst) {
  for (const f of listFiles(src)) { const t = path.join(dst, f); fs.mkdirSync(path.dirname(t), { recursive: true }); fs.copyFileSync(path.join(src, f), t); }
}

export function summaryMarkdown(r) {
  const L = [];
  const g = r.result.gate;
  L.push(`# GPR-2 acceptance evidence — ${r.stage} / ${r.profile.id}`, '');
  L.push(`**Technical gate: \`${g}\`** — this is not an acceptance verdict; independent review and the owner decision remain separate steps.`, '');
  L.push('| Identity | Value |', '|---|---|');
  for (const [k, v] of [['Repository', r.git.repository], ['Candidate SHA', r.git.candidate_sha], ['Candidate tree', r.git.candidate_tree], ['Stage baseline', r.git.baseline_sha],
    ['Workflow SHA', r.github.workflow_sha], ['Run', `[${r.github.run_id} attempt ${r.github.run_attempt}](${r.github.run_url})`], ['Dispatched by', r.github.actor], ['Profile sha256', r.profile.sha256], ['Sealed at (UTC)', r.sealed_at]])
    L.push(`| ${k} | ${v ?? '—'} |`);
  L.push('', '| Check | Class | Mandatory | Status | Tests (pass/fail/skip) | Notes |', '|---|---|---|---|---|---|');
  for (const c of r.result.checks) {
    const t = c.totals ? `${c.totals.pass}/${c.totals.fail + c.totals.cancelled}/${c.totals.skipped} of ${c.totals.expected_tests}` : c.counts ? `${c.counts.expected ?? 0}/${(c.counts.unexpected ?? 0) + (c.counts.flaky ?? 0)}/${c.counts.skipped ?? 0} of ${c.expected_passed}` : '—';
    L.push(`| ${c.id} | ${c.class} | ${c.mandatory ? 'yes' : 'no'} | **${c.status}** | ${t} | ${(c.reasons || []).join('; ').replace(/\|/g, '\\|').slice(0, 300) || ''} |`);
  }
  L.push('', '| Class | Tests passed | Tests failed | Tests skipped |', '|---|---|---|---|');
  for (const [k, v] of Object.entries(r.result.by_class)) L.push(`| ${k} | ${v.tests_pass} | ${v.tests_fail} | ${v.tests_skip} |`);
  if (r.result.gate_reasons.length) L.push('', '**Gate reasons**', '', ...r.result.gate_reasons.map(x => `- ${x}`));
  L.push('', `Environment: ${r.environment?.os?.pretty_name ?? '?'} (${r.environment?.os?.image_version ?? 'image ?'}), Node ${r.environment?.node ?? '?'}, ` +
    `PostgreSQL ${r.environment?.postgres_server?.server_version ?? 'n/a'}, ${r.environment?.playwright ?? 'Playwright n/a'}, ${r.environment?.chromium?.version ?? 'Chromium n/a'}.`);
  L.push('', 'Verify: `node .github/acceptance/lib/verify-evidence.mjs <unzipped dir> --profile .github/acceptance/profiles/<profile>.json` at the workflow SHA.');
  return L.join('\n') + '\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = {}; const v = process.argv.slice(2); for (let i = 0; i < v.length; i += 2) a[v[i].replace(/^--/, '')] = v[i + 1];
  for (const k of ['profile', 'raw', 'authorization', 'identity', 'out']) if (!a[k]) { console.error(`missing --${k}`); process.exit(64); }
  const { profile, sha256 } = loadProfile(a.profile);
  const authz = readJson(a.authorization);
  const identity = readJson(a.identity);
  const out = path.resolve(a.out);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const rawPresent = fs.existsSync(a.raw) && fs.statSync(a.raw).isDirectory();
  if (rawPresent) copyTree(a.raw, path.join(out, 'raw'));
  for (const [f, name] of [[a.authorization, 'authorization.json'], [a.identity, 'identity-seal.json']]) if (fs.existsSync(f)) fs.copyFileSync(f, path.join(out, name));
  const rawDir = path.join(out, 'raw');
  const problems = [];
  if (!authz || authz.ok !== true) problems.push('authorization record missing or not OK');
  if (authz && authz.profile && authz.profile.sha256 !== sha256) problems.push(`profile changed between authorisation (${authz.profile.sha256}) and sealing (${sha256})`);
  if (authz && authz.candidate && identity && identity.candidate && authz.candidate.sha !== identity.candidate.sha) problems.push('sealed identity is a different candidate than the authorised one');
  const runtimeIdentity = readJson(path.join(rawDir, 'identity-runtime.json'));
  if (!runtimeIdentity || runtimeIdentity.ok !== true || runtimeIdentity.candidate?.sha !== authz?.candidate?.sha) problems.push('runtime pre-execution identity record missing or does not match the authorised candidate');
  const runtimeResult = a['runtime-result'] || 'unknown';   // always enforced; an absent or unrecognised value fails closed (classify.mjs applyRuntimeResult)
  const result = classifyRun({ profile, rawDir, identity: problems.length ? { ok: false, refusals: [...problems, ...(identity?.refusals || [])] } : identity, runtimeResult });
  if (!rawPresent) { result.gate = result.gate === GATE.FAILED ? GATE.FAILED : GATE.INCONCLUSIVE; result.gate_reasons.push('no raw runtime evidence was uploaded'); }
  const env = readJson(path.join(rawDir, 'environment.json'));
  const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const repo = process.env.GITHUB_REPOSITORY || authz?.request?.repository || null;
  const record = {
    schema: EVIDENCE_SCHEMA, verdict_kind: 'TECHNICAL_GATE_ONLY', stage: profile.stage,
    profile: { id: profile.profile_id, sha256, title: profile.title, path: `.github/acceptance/profiles/${profile.profile_id}.json` },
    git: { repository: repo, candidate_sha: identity?.candidate?.sha ?? null, candidate_tree: identity?.candidate?.tree ?? null, lineage: identity?.lineage ?? [],
           baseline_sha: profile.baseline.sha, baseline_tree: profile.baseline.tree, diff_check: identity?.diff_check ?? null, changed_files_from_baseline: identity?.changed_files_from_baseline ?? null },
    github: { workflow_sha: process.env.GITHUB_SHA || authz?.workflow?.sha || null, workflow_ref: process.env.GITHUB_WORKFLOW_REF || null, run_id: process.env.GITHUB_RUN_ID || authz?.workflow?.run_id || null,
              run_attempt: process.env.GITHUB_RUN_ATTEMPT || authz?.workflow?.run_attempt || null, run_url: repo && process.env.GITHUB_RUN_ID ? `${server}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT || 1}` : null,
              actor: authz?.request?.actor ?? null, triggering_actor: authz?.request?.triggering_actor ?? null, runtime_job_result: runtimeResult },
    environment: env, result, sealed_at: new Date().toISOString(),
    statement: 'Technical gates only. Not an acceptance, not an integration decision; authorises no merge, deployment, migration or LIVE access.',
  };
  fs.writeFileSync(path.join(out, 'acceptance-result.json'), JSON.stringify(record, null, 2) + '\n');
  const md = summaryMarkdown(record);
  fs.writeFileSync(path.join(out, 'SUMMARY.md'), md);
  const manifest = writeManifest(out, { stage: profile.stage, profile_id: profile.profile_id, candidate_sha: record.git.candidate_sha, candidate_tree: record.git.candidate_tree,
    workflow_sha: record.github.workflow_sha, run_id: record.github.run_id, run_attempt: record.github.run_attempt, gate: result.gate, sealed_at: record.sealed_at });
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  console.log(md);
  console.log(`Sealed ${manifest.file_count} files; manifest sha256=${sha256File(path.join(out, 'manifest.json'))}`);
  process.exit(result.gate === GATE.PASSED ? 0 : 1);
}
export { S };
