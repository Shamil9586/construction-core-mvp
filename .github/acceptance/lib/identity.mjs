#!/usr/bin/env node
// Construction Core — GPR-2 CI Foundation: candidate Git identity verification.
// Verifies a checked-out candidate against its profile entry: exact HEAD SHA, tree, pinned ancestry (lineage), a clean worktree and
// whitespace integrity of the diff from the stage baseline. Executes only `git`; never runs candidate code.
//
// CLI: node identity.mjs --profile <profile.json> --candidate <sha> --repo <dir> --out <identity.json> [--phase authorize|runtime|seal]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProfile, findCandidate } from './profile.mjs';

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
const tryGit = (repo, ...args) => { try { return git(repo, ...args); } catch { return null; } };

export function verifyIdentity({ profile, candidateSha, repo }) {
  const refusals = [];
  const cand = findCandidate(profile, candidateSha);
  if (!cand) return { ok: false, refusals: [`candidate ${candidateSha} is not registered in profile ${profile.profile_id}`] };
  const head = tryGit(repo, 'rev-parse', '--verify', 'HEAD^{commit}');
  const tree = tryGit(repo, 'rev-parse', '--verify', 'HEAD^{tree}');
  if (head !== cand.sha) refusals.push(`HEAD ${head} != registered candidate ${cand.sha}`);
  if (tree !== cand.tree) refusals.push(`HEAD tree ${tree} != registered tree ${cand.tree}`);
  if (tryGit(repo, 'rev-parse', '--is-shallow-repository') !== 'false') refusals.push('candidate checkout is shallow: full history is required for lineage and migration-history checks');
  const lineage = cand.lineage.map(l => {
    const sha = tryGit(repo, 'rev-parse', '--verify', `${l.rev}^{commit}`);
    const t = tryGit(repo, 'rev-parse', '--verify', `${l.rev}^{tree}`);
    if (sha !== l.sha) refusals.push(`${l.rev} ${sha} != ${l.sha}`);
    if (t !== l.tree) refusals.push(`${l.rev} tree ${t} != ${l.tree}`);
    return { rev: l.rev, sha, tree: t };
  });
  const status = tryGit(repo, 'status', '--porcelain', '--untracked-files=all');
  if (status === null || status !== '') refusals.push('candidate checkout is not clean: ' + (status ?? 'git status failed').slice(0, 500));
  const baseOk = tryGit(repo, 'merge-base', '--is-ancestor', profile.baseline.sha, 'HEAD') !== null;
  if (!baseOk) refusals.push(`stage baseline ${profile.baseline.sha} is not an ancestor of the candidate`);
  const baseTree = tryGit(repo, 'rev-parse', '--verify', `${profile.baseline.sha}^{tree}`);
  if (baseTree !== profile.baseline.tree) refusals.push(`baseline tree ${baseTree} != ${profile.baseline.tree}`);
  let diffCheck = 'NOT_REQUESTED';
  if (cand.diff_check_from) {
    try { git(repo, 'diff', '--check', `${cand.diff_check_from}..HEAD`); diffCheck = 'CLEAN'; }
    catch (err) { diffCheck = 'FAILED'; refusals.push('git diff --check reported problems: ' + String(err.stdout || err.message).slice(0, 500)); }
  }
  const changed = baseOk ? (tryGit(repo, 'diff', '--name-status', `${profile.baseline.sha}..HEAD`) || '').split('\n').filter(Boolean) : [];
  return {
    ok: refusals.length === 0, refusals,
    candidate: { sha: head, tree, registered_sha: cand.sha, registered_tree: cand.tree, approval: cand.approval,
                 subject: tryGit(repo, 'log', '-1', '--format=%s', 'HEAD'), committed_at: tryGit(repo, 'log', '-1', '--format=%cI', 'HEAD') },
    lineage, baseline: { sha: profile.baseline.sha, tree: baseTree, is_ancestor: baseOk },
    diff_check: diffCheck, changed_files_from_baseline: changed.length, changed_files: changed.slice(0, 2000),
    git_version: tryGit(repo, 'version'),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => (v.startsWith('--') ? [...acc, [v.slice(2), arr[i + 1]]] : acc), []));
  for (const k of ['profile', 'candidate', 'repo', 'out']) if (!a[k]) { console.error(`missing --${k}`); process.exit(64); }
  let result;
  try {
    const { profile, sha256 } = loadProfile(a.profile);
    result = { phase: a.phase || 'unspecified', profile_id: profile.profile_id, profile_sha256: sha256, stage: profile.stage,
               ...verifyIdentity({ profile, candidateSha: a.candidate, repo: a.repo }), verified_at: new Date().toISOString() };
  } catch (err) { result = { phase: a.phase, ok: false, refusals: [err.message] }; }
  fs.mkdirSync(path.dirname(a.out), { recursive: true });
  fs.writeFileSync(a.out, JSON.stringify(result, null, 2) + '\n');
  if (!result.ok) { console.error('REFUSED candidate identity:\n  - ' + result.refusals.join('\n  - ')); process.exit(2); }
  console.log(`Candidate identity verified (${result.phase}): ${result.candidate.sha} tree ${result.candidate.tree}; ${result.lineage.length} pinned ancestors; diff-check ${result.diff_check}`);
}
