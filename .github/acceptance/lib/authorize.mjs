#!/usr/bin/env node
// Construction Core — GPR-2 CI Foundation: dispatch authorisation gate.
// Runs in the `authorize` job BEFORE any candidate code exists on the runner. A workflow input is never sufficient on its own:
//   * the event must be a manual workflow_dispatch of this exact repository, from refs/heads/main;
//   * github.actor AND github.triggering_actor (re-runs) must both be listed in approvers.txt at the workflow commit;
//   * the profile must exist at the workflow commit, validate strictly and be ACTIVE;
//   * the candidate SHA must be a full SHA registered in that profile (registration = a reviewed PR to main);
//   * the confirmation must restate the exact profile and SHA: "APPROVE-TEST-ONLY <profile_id> <candidate_sha>";
//   * a candidate restored from an archived Git bundle (candidate.source) is refused while ARCHIVE_TRANSPORT_APPROVED is false: obtaining the
//     bundle on a hosted runner crosses the public/private repository boundary and has no security-approved credential/transport yet.
// Writes <out>/authorization.json and, under GitHub Actions, step outputs for the later jobs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfile, findCandidate } from './profile.mjs';

export const EXPECTED_REPOSITORY = 'Shamil9586/construction-core-mvp';
const PROFILE_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SHA = /^[0-9a-f]{40}$/;
// Flipping this is an activation step: it needs an independently reviewed transport for the private archive (no credential in any job that
// runs candidate code, no private bytes in public artifacts or logs) and a separate owner/coordinator decision. Until then: fail closed.
export const ARCHIVE_TRANSPORT_APPROVED = false;

export function authorize({ env, harnessDir }) {
  const refusals = [];
  const need = k => (env[k] ?? '').trim();
  const repository = need('GITHUB_REPOSITORY'), eventName = need('GITHUB_EVENT_NAME'), ref = need('GITHUB_REF');
  const actor = need('GITHUB_ACTOR'), triggeringActor = need('GITHUB_TRIGGERING_ACTOR') || actor;
  const profileId = need('INPUT_PROFILE'), candidateSha = need('INPUT_CANDIDATE_SHA'), confirmation = need('INPUT_CONFIRMATION');

  if (repository !== EXPECTED_REPOSITORY) refusals.push(`repository ${repository || '(none)'} is not ${EXPECTED_REPOSITORY}`);
  if (eventName !== 'workflow_dispatch') refusals.push(`event ${eventName || '(none)'} is not workflow_dispatch`);
  if (ref !== 'refs/heads/main') refusals.push(`workflow ref ${ref || '(none)'} is not refs/heads/main`);

  const approvers = fs.readFileSync(path.join(harnessDir, 'approvers.txt'), 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (!approvers.includes(actor)) refusals.push(`actor ${actor || '(none)'} is not an approved dispatcher`);
  if (!approvers.includes(triggeringActor)) refusals.push(`triggering actor ${triggeringActor || '(none)'} is not an approved dispatcher`);

  let profile = null, profileSha256 = null, candidate = null;
  if (!PROFILE_ID.test(profileId)) refusals.push(`profile id ${JSON.stringify(profileId)} is malformed`);
  else {
    const file = path.join(harnessDir, 'profiles', `${profileId}.json`);
    if (!fs.existsSync(file)) refusals.push(`profile ${profileId} is not registered on the workflow commit`);
    else {
      try { ({ profile, sha256: profileSha256 } = loadProfile(file)); }
      catch (err) { refusals.push(err.message); }
      if (profile && profile.status !== 'ACTIVE') refusals.push(`profile ${profileId} is ${profile.status}, not ACTIVE`);
    }
  }
  if (!SHA.test(candidateSha)) refusals.push('candidate_sha must be a full lowercase 40-hex commit SHA (no branch names, tags or short SHAs)');
  else if (profile) {
    candidate = findCandidate(profile, candidateSha);
    if (!candidate) refusals.push(`candidate ${candidateSha} is not registered in profile ${profileId}`);
    else if (candidate.source && !ARCHIVE_TRANSPORT_APPROVED) refusals.push(`candidate ${candidateSha} is restored from an archived ${candidate.source.kind} (${candidate.source.repository}); hosted transport of the private archive is not approved`);
  }
  const expectedConfirmation = `APPROVE-TEST-ONLY ${profileId} ${candidateSha}`;
  if (confirmation !== expectedConfirmation) refusals.push(`confirmation must be exactly "APPROVE-TEST-ONLY <profile> <candidate_sha>" for this dispatch`);

  return {
    ok: refusals.length === 0, refusals,
    request: { repository, event_name: eventName, ref, actor, triggering_actor: triggeringActor, profile_id: profileId, candidate_sha: candidateSha },
    workflow: { sha: need('GITHUB_SHA'), run_id: need('GITHUB_RUN_ID'), run_attempt: need('GITHUB_RUN_ATTEMPT'), workflow_ref: need('GITHUB_WORKFLOW_REF') },
    profile: profile && { id: profile.profile_id, stage: profile.stage, status: profile.status, sha256: profileSha256, title: profile.title },
    candidate: candidate && { sha: candidate.sha, tree: candidate.tree, approval: candidate.approval, source: candidate.source || null },
    runtime: profile && profile.runtime, baseline_sha: profile && profile.baseline.sha,
    decided_at: new Date().toISOString(),
  };
}

/** Step outputs for the later jobs. checkout_ref is what actions/checkout fetches: the candidate itself, or — for an archived candidate — the
 *  public stage baseline (full history), into which source-bundle.mjs then restores the exact candidate before identity.mjs re-verifies it. */
export function stepOutputs(r) {
  const sha12 = r.candidate.sha.slice(0, 12);
  const src = r.candidate.source;
  return {
    stage: r.profile.stage, profile_id: r.profile.id, profile_sha256: r.profile.sha256, candidate_sha: r.candidate.sha, candidate_tree: r.candidate.tree,
    source_kind: src ? src.kind : 'none', checkout_ref: src ? r.baseline_sha : r.candidate.sha,
    node_version: r.runtime.node, postgres_major: String(r.runtime.postgres_major), job_timeout_minutes: String(r.runtime.job_timeout_minutes),
    needs_postgres: String(r.runtime.requires.includes('postgres')), needs_chromium: String(r.runtime.requires.includes('chromium')),
    evidence_name: `gpr2-acceptance-${r.profile.stage.toLowerCase()}-${r.profile.id}-${sha12}-run${r.workflow.run_id}-a${r.workflow.run_attempt}`,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [harnessDir, outDir] = process.argv.slice(2);
  if (!harnessDir || !outDir) { console.error('usage: authorize.mjs <harness-acceptance-dir> <out-dir>'); process.exit(64); }
  const r = authorize({ env: process.env, harnessDir });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'authorization.json'), JSON.stringify(r, null, 2) + '\n');
  if (!r.ok) { console.error('REFUSED dispatch:\n  - ' + r.refusals.join('\n  - ')); process.exit(2); }
  if (process.env.GITHUB_OUTPUT) {
    const out = stepOutputs(r);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(out).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  }
  console.log(`AUTHORIZED isolated test-only run: profile=${r.profile.id} stage=${r.profile.stage} candidate=${r.candidate.sha} by ${r.request.actor}`);
}
