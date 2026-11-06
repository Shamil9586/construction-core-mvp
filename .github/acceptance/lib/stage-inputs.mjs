#!/usr/bin/env node
// Construction Core — GPR-2 CI Foundation: verify and stage the PRIVATE inputs of an archived candidate (trusted jobs only: `stage` and `seal`).
// Runs no candidate code. It checks, from the private archive checkout, (1) the candidate bundle against the profile pin (size, SHA-256, Git blob,
// header, prerequisites, fetch with fsck — source-bundle.mjs, without checking anything out), (2) every pinned external document by SHA-256, and
// (3) that the Git blob of every file of each isolated test's closure is the pinned one in BOTH the candidate and the public baseline.
// The seal job runs this again on a fresh checkout of the private source: its record, not the stage job's artifact, is what the gate trusts.
//
// CLI: node stage-inputs.mjs --profile <p.json> --candidate <sha> --bundle <file> --docs <dir> --repo <baseline git dir> --out <dir> [--harness-sha <sha>]
//      writes <out>/stage.json (always); on success also <out>/bundle/candidate.bundle and <out>/docs/<files> (verified bytes)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProfile, findCandidate } from './profile.mjs';
import { restoreFromBundle, gitEnv, CANDIDATE_REF } from './source-bundle.mjs';
import { resolveExternalInputs } from './external-inputs.mjs';
import { isolatedFiles, STAGE_SCHEMA, expectedCore, digestOf } from './provenance.mjs';

const gitBlobAt = (repo, rev, file) => {
  const r = spawnSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', 'rev-parse', '--verify', '--quiet', `${rev}:${file}`], { encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  return r.status === 0 ? r.stdout.trim() : null;
};

export function computeInputs({ profile, profileSha256, candidateSha, bundle, docsDir, repo, harnessSha = null }) {
  const refusals = [];
  const cand = findCandidate(profile, candidateSha);
  const rec = { schema: STAGE_SCHEMA, ok: false, refusals, profile_id: profile.profile_id, profile_sha256: profileSha256, candidate_sha: candidateSha, candidate_tree: cand?.tree ?? null, harness_sha: harnessSha, bundle: null, isolated: [] };
  if (!cand || !cand.source) { refusals.push('the candidate is not registered with an archived source'); return rec; }
  const restored = restoreFromBundle({ profile, candidateSha, bundle, repo, checkout: false });
  rec.bundle = restored.observed ? { bytes: restored.observed.bytes, sha256: restored.observed.sha256, blob: restored.observed.blob } : null;
  rec.bundle_steps = restored.steps;
  if (!restored.ok) refusals.push(...restored.refusals.map(x => `bundle: ${x}`));
  for (const { file } of isolatedFiles(profile)) {
    const entry = { path: file.path, job: file.isolated.job, docs: [], closure: [] };
    const docs = resolveExternalInputs(file.external_inputs, docsDir);
    if (docs.reason) refusals.push(`${file.path}: ${docs.reason}`); else entry.docs = docs.records;
    for (const x of file.isolated.closure) {
      const candidateBlob = restored.ok ? gitBlobAt(repo, CANDIDATE_REF, x.path) : null;
      const baselineBlob = gitBlobAt(repo, profile.baseline.sha, x.path);
      entry.closure.push({ path: x.path, blob: x.blob, candidate_blob: candidateBlob, baseline_blob: baselineBlob });
      if (restored.ok && candidateBlob !== x.blob) refusals.push(`${file.path}: closure file ${x.path} has blob ${candidateBlob} in the candidate, pinned ${x.blob}`);
      if (baselineBlob !== x.blob) refusals.push(`${file.path}: closure file ${x.path} has blob ${baselineBlob} in the public baseline, pinned ${x.blob}`);
    }
    rec.isolated.push(entry);
  }
  rec.ok = refusals.length === 0;
  if (rec.ok) rec.inputs_digest = digestOf(expectedCore(profile, cand, profileSha256));
  return rec;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = {}; const v = process.argv.slice(2); for (let i = 0; i < v.length; i += 2) a[v[i].replace(/^--/, '')] = v[i + 1];
  for (const k of ['profile', 'candidate', 'bundle', 'docs', 'repo', 'out']) if (!a[k]) { console.error(`missing --${k}`); process.exit(64); }
  const { profile, sha256 } = loadProfile(a.profile);
  const out = path.resolve(a.out); fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  const rec = computeInputs({ profile, profileSha256: sha256, candidateSha: a.candidate, bundle: a.bundle, docsDir: path.resolve(a.docs), repo: a.repo, harnessSha: a['harness-sha'] ?? null });
  fs.writeFileSync(path.join(out, 'stage.json'), JSON.stringify(rec, null, 2) + '\n');
  if (!rec.ok) { console.error('REFUSED private inputs:\n  - ' + rec.refusals.join('\n  - ')); process.exit(2); }
  fs.mkdirSync(path.join(out, 'bundle'), { recursive: true }); fs.copyFileSync(a.bundle, path.join(out, 'bundle', 'candidate.bundle'));
  fs.mkdirSync(path.join(out, 'docs'), { recursive: true });
  for (const f of rec.isolated) for (const d of f.docs) fs.copyFileSync(path.join(path.resolve(a.docs), d.filename), path.join(out, 'docs', d.filename));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `inputs_digest=${rec.inputs_digest}\nbundle_sha256=${rec.bundle.sha256}\ncandidate_sha=${rec.candidate_sha}\n`);
  console.log(`Private inputs verified for ${rec.candidate_sha}: bundle sha256 ${rec.bundle.sha256}; ${rec.isolated.length} isolated file(s); digest ${rec.inputs_digest}`);
}
