// Construction Core — GPR-2 CI Foundation: provenance of the inputs of a profile's isolated files (profile files[].isolated / external_inputs).
// The expected values come ONLY from the profile of the workflow commit (pins); what the jobs report is compared against them and against an
// independent recomputation made by the trusted seal job from the private source itself (stage-inputs.mjs), never from an artifact.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const STAGE_SCHEMA = 'construction-core/gpr2-stage-inputs@1';
export const NORMATIVE_SCHEMA = 'construction-core/gpr2-normative-result@1';

/** The isolated files of a profile: [{ check, file }]. */
export function isolatedFiles(profile) {
  return (profile.checks || []).filter(c => c.kind === 'node-test').flatMap(c => (c.files || []).filter(f => f.isolated).map(file => ({ check: c, file })));
}
const sortBy = (a, k) => [...a].sort((x, y) => (x[k] < y[k] ? -1 : x[k] > y[k] ? 1 : 0));

/** What a correct staging record must say, derived from the profile alone. */
export function expectedCore(profile, cand, profileSha256) {
  return {
    profile_id: profile.profile_id, profile_sha256: profileSha256, candidate_sha: cand.sha, candidate_tree: cand.tree,
    bundle: { bytes: cand.source.bytes, sha256: cand.source.sha256, blob: cand.source.blob },
    isolated: sortBy(isolatedFiles(profile).map(({ file }) => ({
      path: file.path,
      docs: sortBy(file.external_inputs.map(x => ({ env: x.env, filename: x.filename, sha256: x.sha256 })), 'env'),
      closure: sortBy(file.isolated.closure.map(x => ({ path: x.path, blob: x.blob })), 'path'),
    })), 'path'),
  };
}
/** The same shape, read from a staging record (stage-inputs.mjs output). */
export function recordCore(rec) {
  const cl = x => ({ path: x.path, blob: x.blob });
  return {
    profile_id: rec?.profile_id, profile_sha256: rec?.profile_sha256, candidate_sha: rec?.candidate_sha, candidate_tree: rec?.candidate_tree,
    bundle: { bytes: rec?.bundle?.bytes, sha256: rec?.bundle?.sha256, blob: rec?.bundle?.blob },
    isolated: sortBy((rec?.isolated || []).map(f => ({
      path: f.path,
      docs: sortBy((f.docs || []).map(x => ({ env: x.env, filename: x.filename, sha256: x.sha256 })), 'env'),
      closure: sortBy((f.closure || []).map(x => cl(x)), 'path'),
    })), 'path'),
  };
}
export const digestOf = core => crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Problems with the provenance of the isolated files' inputs. Empty when the profile has no isolated file.
 *   stageOutputs  the `stage` job's outputs (written by the workflow from needs.stage.outputs — a runtime job cannot alter them)
 *   stageRecord   the stage job's staging record (artifact; consistency only)
 *   sealRecord    the seal job's OWN recomputation from the private source (stage-inputs.mjs run in the seal job)
 *   normative     the normative job's result (run-normative.mjs)
 */
export function isolatedProvenanceProblems({ profile, cand, profileSha256, stageOutputs, stageRecord, sealRecord, normative }) {
  const iso = isolatedFiles(profile);
  if (!iso.length) return [];
  const p = [];
  if (!cand || !cand.source) return ['isolated files require an archived (bundle) candidate'];
  const want = expectedCore(profile, cand, profileSha256), wantDigest = digestOf(want);
  const rec = (name, r) => {
    if (!r || r.ok !== true || r.schema !== STAGE_SCHEMA) { p.push(`${name} staging record missing or not OK`); return; }
    if (!same(recordCore(r), want)) p.push(`${name} staging record does not equal the inputs pinned by the profile`);
  };
  rec('seal-job (independent)', sealRecord);
  rec('stage-job', stageRecord);
  if (!stageOutputs || stageOutputs.inputs_digest !== wantDigest) p.push('stage job output inputs_digest differs from the digest of the pinned inputs');
  if (stageOutputs && stageOutputs.candidate_sha !== cand.sha) p.push('stage job output names another candidate');
  if (!normative || normative.schema !== NORMATIVE_SCHEMA || normative.job !== 'normative') p.push('normative job result missing');
  else {
    if (normative.profile_id !== profile.profile_id || normative.profile_sha256 !== profileSha256 || normative.candidate_sha !== cand.sha) p.push('normative job result is for another profile, digest or candidate');
    for (const { file } of iso) {
      const r = (normative.files || []).find(x => x && x.path === file.path);
      const w = want.isolated.find(x => x.path === file.path);
      if (!r) { p.push(`normative job result lacks ${file.path}`); continue; }
      if (r.state !== 'EXECUTED') p.push(`${file.path}: normative job state ${r.state}`);
      if (!same(sortBy((r.external_inputs || []).map(x => ({ env: x.env, filename: x.filename, sha256: x.sha256 })), 'env'), w.docs)) p.push(`${file.path}: documents used by the normative job differ from the pinned documents`);
      if (!same(sortBy((r.closure_verified || []).map(x => ({ path: x.path, blob: x.blob })), 'path'), w.closure)) p.push(`${file.path}: files executed by the normative job differ from the pinned closure`);
      const sb = r.sandbox || {};
      if (!(sb.network === 'none' && Number.isInteger(sb.uid) && sb.uid > 0 && sb.env === 'minimal' && sb.probe_ok === true)) p.push(`${file.path}: the normative job did not record a verified network-isolated, unprivileged, minimal-environment sandbox`);
    }
  }
  return p;
}

/** Replace each isolated file's DEFERRED runtime entry (sealed copy of the raw evidence) by the normative job's record. Returns the files merged. */
export function mergeIsolatedResults(rawDir, profile, normative) {
  const merged = [];
  for (const { check, file } of isolatedFiles(profile)) {
    const f = path.join(rawDir, 'checks', check.id, 'result.json');
    let res; try { res = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const r = normative && Array.isArray(normative.files) ? normative.files.find(x => x && x.path === file.path) : null;
    if (!r || !Array.isArray(res.files)) continue;
    const i = res.files.findIndex(x => x && x.path === file.path);
    if (i < 0) continue;
    res.files[i] = { ...res.files[i], ...r, executed_in: 'normative', log: r.log ? `normative/${r.log}` : null };
    fs.writeFileSync(f, JSON.stringify(res, null, 2) + '\n');
    merged.push(file.path);
  }
  return merged;
}
