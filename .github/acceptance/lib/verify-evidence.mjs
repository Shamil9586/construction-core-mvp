#!/usr/bin/env node
// Construction Core — GPR-2 CI Foundation: independent re-verification of a sealed evidence package (for reviewers).
// Needs only Node.js (no dependencies) and the profile file taken from the workflow SHA recorded in the evidence.
//
// usage: node verify-evidence.mjs <unzipped sealed artifact dir> --profile <profile.json> [--expect-candidate <sha>] [--expect-run <run_id>]
// Checks: every SHA256SUMS entry, no unlisted or missing files, manifest consistency, profile digest equality, candidate binding, and an
// independent re-classification of the raw evidence whose gate and per-check statuses must equal the sealed result.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadProfile } from './profile.mjs';
import { classifyRun } from './classify.mjs';
import { listFiles } from './seal.mjs';

const argv = process.argv.slice(2);
const dir = argv[0];
const opt = {}; for (let i = 1; i < argv.length; i += 2) opt[argv[i].replace(/^--/, '')] = argv[i + 1];
if (!dir || !opt.profile) { console.error('usage: verify-evidence.mjs <dir> --profile <profile.json> [--expect-candidate <sha>] [--expect-run <id>]'); process.exit(64); }
const problems = [];
const ok = m => console.log('  ok   ' + m);
const bad = m => { problems.push(m); console.log('  FAIL ' + m); };
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

console.log(`Verifying ${path.resolve(dir)}`);
const sumsFile = path.join(dir, 'SHA256SUMS');
if (!fs.existsSync(sumsFile)) { bad('SHA256SUMS missing'); process.exit(2); }
const listed = new Map();
for (const line of fs.readFileSync(sumsFile, 'utf8').split('\n').filter(Boolean)) {
  const m = /^([0-9a-f]{64})  (.+)$/.exec(line);
  if (!m || m[2].includes('..') || path.isAbsolute(m[2])) { bad(`malformed SHA256SUMS line: ${line.slice(0, 120)}`); continue; }
  listed.set(m[2], m[1]);
}
let mism = 0;
for (const [f, h] of listed) { const p = path.join(dir, f); if (!fs.existsSync(p)) { bad(`listed file missing: ${f}`); mism++; } else if (sha(p) !== h) { bad(`checksum mismatch: ${f}`); mism++; } }
const present = listFiles(dir).filter(f => f !== 'SHA256SUMS');
const unlisted = present.filter(f => !listed.has(f));
if (unlisted.length) bad(`files not covered by SHA256SUMS: ${unlisted.slice(0, 20).join(', ')}`); else ok(`all ${present.length} files covered by SHA256SUMS`);
if (!mism) ok(`${listed.size} checksums match`);

const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
for (const e of manifest.files) if (listed.get(e.path) !== e.sha256) bad(`manifest entry differs from SHA256SUMS: ${e.path}`);
if (manifest.file_count !== manifest.files.length) bad('manifest file_count inconsistent');

const record = JSON.parse(fs.readFileSync(path.join(dir, 'acceptance-result.json'), 'utf8'));
const { profile, sha256 } = loadProfile(opt.profile);
if (record.profile.id !== profile.profile_id) bad(`evidence is for profile ${record.profile.id}, not ${profile.profile_id}`);
if (record.profile.sha256 !== sha256) bad(`profile digest differs: evidence ${record.profile.sha256}, supplied file ${sha256} (use the file at workflow SHA ${record.github.workflow_sha})`); else ok('profile digest matches the supplied profile');
if (opt['expect-candidate'] && record.git.candidate_sha !== opt['expect-candidate']) bad(`candidate ${record.git.candidate_sha} != expected ${opt['expect-candidate']}`);
if (opt['expect-run'] && String(record.github.run_id) !== String(opt['expect-run'])) bad(`run ${record.github.run_id} != expected ${opt['expect-run']}`);
const registered = profile.candidates.find(c => c.sha === record.git.candidate_sha);
if (!registered) bad(`candidate ${record.git.candidate_sha} is not registered in the profile`);
else if (registered.tree !== record.git.candidate_tree) bad('candidate tree differs from the registered tree'); else ok(`candidate ${record.git.candidate_sha} / tree ${record.git.candidate_tree} registered`);
const authz = JSON.parse(fs.readFileSync(path.join(dir, 'authorization.json'), 'utf8'));
if (authz.candidate?.sha !== record.git.candidate_sha) bad('authorization record names a different candidate'); else ok(`authorised by ${authz.request.actor} (triggering ${authz.request.triggering_actor})`);

const identity = JSON.parse(fs.readFileSync(path.join(dir, 'identity-seal.json'), 'utf8'));
const again = classifyRun({ profile, rawDir: path.join(dir, 'raw'), identity, runtimeResult: record.github?.runtime_job_result ?? null });
const sealedGate = record.result.gate;
// The seal can only downgrade (never upgrade) the gate for cross-record problems; an upgrade on re-classification is a mismatch.
// The runtime job's recorded conclusion is part of that re-classification, so a PASS sealed next to a non-success runtime job cannot verify.
const rank = { TECHNICAL_GATES_PASSED: 2, INCONCLUSIVE_ENVIRONMENT_BLOCKED: 1, TECHNICAL_GATES_FAILED: 0 };
if (rank[again.gate] < rank[sealedGate]) bad(`re-classification gives ${again.gate}, sealed result claims ${sealedGate}`); else ok(`re-classification gate ${again.gate} (sealed ${sealedGate})`);
for (const c of again.checks) {
  const s = record.result.checks.find(x => x.id === c.id);
  if (!s) bad(`sealed result lacks check ${c.id}`); else if (s.status !== c.status) bad(`check ${c.id}: sealed ${s.status}, re-classified ${c.status}`);
}
console.log('');
for (const c of again.checks) console.log(`  ${c.status.padEnd(19)} ${c.id} [${c.class}]${c.mandatory ? '' : ' (optional)'}`);
console.log(`\nCandidate ${record.git.candidate_sha}  run ${record.github.run_id}/${record.github.run_attempt}  workflow ${record.github.workflow_sha}`);
console.log(problems.length ? `EVIDENCE INTEGRITY: FAILED (${problems.length} problem(s))` : `EVIDENCE INTEGRITY: VERIFIED — technical gate ${sealedGate}`);
process.exit(problems.length ? 2 : 0);
