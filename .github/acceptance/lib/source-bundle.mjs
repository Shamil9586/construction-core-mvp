#!/usr/bin/env node
// Construction Core — GPR-2 CI Foundation: restore a registered candidate from its archived Git bundle (git only, fail closed).
// For a candidate that is not reachable in this repository, the profile entry pins `source` (profile.mjs): archive repository, commit, path,
// Git blob, byte size, SHA-256, the single bundle ref and its prerequisites. This helper does NOT obtain the bundle (that transport crosses the
// public/private repository boundary and is a separate, security-reviewed step); it verifies a local file against the pin and only then lets Git
// read it, into a repository that already holds the prerequisites (a normal, credential-free checkout of the public baseline).
// Order (each step only after the previous one passed): descriptor -> regular file + exact size -> SHA-256 -> Git blob id -> bundle header
// (v2, exactly the pinned ref -> candidate and exactly the pinned prerequisites) -> prerequisites present -> `git bundle verify` -> fetch into
// refs/gpr2-acceptance/candidate with fsck on transfer -> fetched SHA -> `git fsck --full --strict` -> ancestry -> tree -> detached checkout.
// The unchanged identity.mjs must re-verify the checkout afterwards (SHA, tree, lineage, baseline, clean worktree, diff-check).
// Git runs with a minimal environment (no credentials, no global/system config, no hooks, no prompts); candidate code is never executed.
//
// CLI: node source-bundle.mjs --profile <profile.json> --candidate <sha> --bundle <file> --repo <git dir> --out <record.json> [--phase <name>]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProfile, findCandidate } from './profile.mjs';

export const RECORD_SCHEMA = 'construction-core/gpr2-source-bundle@1';
export const CANDIDATE_REF = 'refs/gpr2-acceptance/candidate';
const HEADER_MAX = 64 * 1024;

/** The only environment Git receives here: nothing inherited except PATH, so no token, credential helper, askpass or config can leak in. */
export function gitEnv(env = process.env) {
  return { PATH: env.PATH || '/usr/bin:/bin', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ASKPASS: '/bin/false', SSH_ASKPASS: '/bin/false' };
}
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
              '-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true', '-c', 'credential.helper='];
function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...SAFE, ...args], { encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? -1, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim().slice(0, 2000), error: r.error ? String(r.error) : undefined };
}

/** Parse a bundle header (v2 only). Returns { version, prerequisites:[sha], refs:[{sha, ref}] } or { error }. Pure. */
export function parseBundleHeader(buf) {
  const head = buf.subarray(0, Math.min(buf.length, HEADER_MAX)).toString('latin1');
  const end = head.indexOf('\n\n');
  if (end < 0) return { error: 'bundle header is not terminated within the first 64 KiB' };
  const lines = head.slice(0, end).split('\n');
  if (lines[0] !== '# v2 git bundle') return { error: `unsupported bundle signature ${JSON.stringify(lines[0].slice(0, 40))} (only "# v2 git bundle" is accepted)` };
  const prerequisites = [], refs = [];
  for (const l of lines.slice(1)) {
    let m;
    if ((m = /^-([0-9a-f]{40})(?: .*)?$/.exec(l))) prerequisites.push(m[1]);
    else if ((m = /^([0-9a-f]{40}) (refs\/[^\s]+)$/.exec(l))) refs.push({ sha: m[1], ref: m[2] });
    else return { error: `malformed bundle header line ${JSON.stringify(l.slice(0, 120))}` };
  }
  return { version: 2, prerequisites, refs };
}

export const gitBlobId = buf => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
const sameSet = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/** Verify `bundle` against the candidate's pinned source and, only if every check passed, materialise the candidate in `repo`. */
export function restoreFromBundle({ profile, candidateSha, bundle, repo, checkout = true }) {
  const steps = [];
  const result = (ok, extra = {}) => ({ ok, refusals: steps.filter(s => !s.ok).map(s => `${s.step}: ${s.detail}`), steps, ...extra });
  const step = (name, ok, detail) => { steps.push({ step: name, ok, detail }); return ok; };

  const cand = findCandidate(profile, candidateSha);
  if (!step('descriptor', !!cand, cand ? 'candidate registered' : `candidate ${candidateSha} is not registered in profile ${profile.profile_id}`)) return result(false);
  const src = cand.source;
  if (!step('descriptor', !!src && src.kind === 'git-bundle', src ? `source kind ${src.kind}` : 'the registered candidate has no git-bundle source')) return result(false);
  const pin = { repository: src.repository, commit: src.commit, path: src.path, blob: src.blob, bytes: src.bytes, sha256: src.sha256, ref: src.ref, prerequisites: src.prerequisites };

  let st = null;
  try { st = fs.lstatSync(bundle); } catch { /* reported below */ }
  if (!step('file', !!st && st.isFile() && !st.isSymbolicLink(), st ? (st.isFile() ? 'regular file' : 'not a regular file (symbolic links and devices are refused)') : 'bundle file is not available')) return result(false, { pin });
  if (!step('size', st.size === src.bytes, `${st.size} bytes, pinned ${src.bytes}`)) return result(false, { pin });
  const buf = fs.readFileSync(bundle);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  if (!step('sha256', sha256 === src.sha256, `${sha256}, pinned ${src.sha256}`)) return result(false, { pin, observed: { bytes: st.size, sha256 } });
  const blob = gitBlobId(buf);
  if (!step('git-blob', blob === src.blob, `${blob}, pinned ${src.blob}`)) return result(false, { pin, observed: { bytes: st.size, sha256, blob } });
  const observed = { bytes: st.size, sha256, blob };

  const h = parseBundleHeader(buf);
  if (!step('header', !h.error, h.error || `v${h.version}, ${h.refs.length} ref(s), ${h.prerequisites.length} prerequisite(s)`)) return result(false, { pin, observed });
  observed.header = { refs: h.refs, prerequisites: h.prerequisites };
  if (!step('header-ref', h.refs.length === 1 && h.refs[0].ref === src.ref && h.refs[0].sha === cand.sha, `bundle refs ${JSON.stringify(h.refs)}; pinned exactly ${src.ref} -> ${cand.sha}`)) return result(false, { pin, observed });
  if (!step('header-prerequisites', sameSet(h.prerequisites, src.prerequisites), `bundle requires ${h.prerequisites.join(', ') || '(none)'}; pinned ${src.prerequisites.join(', ')}`)) return result(false, { pin, observed });

  const missing = src.prerequisites.filter(p => git(repo, ['cat-file', '-e', `${p}^{commit}`]).status !== 0);
  if (!step('prerequisites-present', missing.length === 0, missing.length ? `missing in the baseline checkout: ${missing.join(', ')}` : 'all prerequisite commits present')) return result(false, { pin, observed });
  if (!step('shallow', git(repo, ['rev-parse', '--is-shallow-repository']).stdout === 'false', 'the receiving repository must hold full history')) return result(false, { pin, observed });

  const verify = git(repo, ['bundle', 'verify', '--quiet', path.resolve(bundle)]);
  if (!step('bundle-verify', verify.status === 0, verify.status === 0 ? 'git bundle verify: ok' : `git bundle verify exit ${verify.status}: ${verify.stderr}`)) return result(false, { pin, observed });
  const heads = git(repo, ['bundle', 'list-heads', path.resolve(bundle)]);
  if (!step('bundle-list-heads', heads.status === 0 && heads.stdout === `${cand.sha} ${src.ref}`, `git bundle list-heads: ${heads.stdout || heads.stderr}`)) return result(false, { pin, observed });

  if (git(repo, ['rev-parse', '--verify', '--quiet', CANDIDATE_REF]).status === 0) git(repo, ['update-ref', '-d', CANDIDATE_REF]);
  const fetch = git(repo, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', path.resolve(bundle), `+${src.ref}:${CANDIDATE_REF}`]);
  if (!step('fetch', fetch.status === 0, fetch.status === 0 ? `fetched ${src.ref} into ${CANDIDATE_REF} (fsck on transfer)` : `git fetch exit ${fetch.status}: ${fetch.stderr}`)) return result(false, { pin, observed });
  const fetched = git(repo, ['rev-parse', '--verify', `${CANDIDATE_REF}^{commit}`]).stdout;
  if (!step('fetched-sha', fetched === cand.sha, `${fetched}, registered ${cand.sha}`)) return result(false, { pin, observed });
  const fsck = git(repo, ['fsck', '--full', '--strict', '--no-dangling', '--no-progress']);
  if (!step('fsck', fsck.status === 0, fsck.status === 0 ? 'git fsck --full --strict: ok' : `git fsck exit ${fsck.status}: ${fsck.stderr || fsck.stdout}`)) return result(false, { pin, observed });
  const notAncestor = src.prerequisites.filter(p => git(repo, ['merge-base', '--is-ancestor', p, cand.sha]).status !== 0);
  if (!step('ancestry', notAncestor.length === 0, notAncestor.length ? `prerequisite(s) not ancestors of the candidate: ${notAncestor.join(', ')}` : 'every prerequisite is an ancestor of the candidate')) return result(false, { pin, observed });
  const baseOk = git(repo, ['merge-base', '--is-ancestor', profile.baseline.sha, cand.sha]).status === 0;
  if (!step('baseline-ancestry', baseOk, `stage baseline ${profile.baseline.sha} ${baseOk ? 'is' : 'is NOT'} an ancestor of the candidate`)) return result(false, { pin, observed });
  const tree = git(repo, ['rev-parse', '--verify', `${cand.sha}^{tree}`]).stdout;
  if (!step('tree', tree === cand.tree, `${tree}, registered ${cand.tree}`)) return result(false, { pin, observed });

  let head = null;
  if (checkout) {
    const co = git(repo, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', '--force', cand.sha]);
    head = git(repo, ['rev-parse', '--verify', 'HEAD^{commit}']).stdout;
    if (!step('checkout', co.status === 0 && head === cand.sha, co.status === 0 ? `HEAD ${head}` : `git checkout exit ${co.status}: ${co.stderr}`)) return result(false, { pin, observed });
  }
  return result(true, { pin, observed, candidate: { sha: cand.sha, tree, ref: CANDIDATE_REF, checked_out: checkout ? head : null }, git_version: git(repo, ['version']).stdout });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = {}; const v = process.argv.slice(2); for (let i = 0; i < v.length; i += 2) a[v[i].replace(/^--/, '')] = v[i + 1];
  for (const k of ['profile', 'candidate', 'bundle', 'repo', 'out']) if (!a[k]) { console.error(`missing --${k}`); process.exit(64); }
  let record;
  try {
    const { profile, sha256 } = loadProfile(a.profile);
    record = { schema: RECORD_SCHEMA, phase: a.phase || 'unspecified', profile_id: profile.profile_id, profile_sha256: sha256, candidate_sha: a.candidate,
               ...restoreFromBundle({ profile, candidateSha: a.candidate, bundle: a.bundle, repo: a.repo }), verified_at: new Date().toISOString() };
  } catch (err) { record = { schema: RECORD_SCHEMA, phase: a.phase, candidate_sha: a.candidate, ok: false, refusals: [err.message], steps: [] }; }
  fs.mkdirSync(path.dirname(path.resolve(a.out)), { recursive: true });
  fs.writeFileSync(a.out, JSON.stringify(record, null, 2) + '\n');
  if (!record.ok) { console.error('REFUSED archived candidate source:\n  - ' + record.refusals.join('\n  - ')); process.exit(2); }
  console.log(`Archived candidate restored (${record.phase}): ${record.candidate.sha} tree ${record.candidate.tree} from bundle sha256 ${record.observed.sha256}`);
}
