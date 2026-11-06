#!/usr/bin/env node
// Construction Core — GPR-2 CI Foundation: read-only offline compatibility rehearsal with real `git merge-tree --write-tree`.
// Simulates the pairwise merges of pinned commits (e.g. product main, an exact stage candidate and a parallel feature head) WITHOUT changing the
// repository: every object merge-tree writes goes to a throw-away object directory (GIT_OBJECT_DIRECTORY, the repository's objects only as an
// alternate), no ref, index, worktree or commit is created, and the refs and the repository's own object store are fingerprinted before and after.
// The result is a technical observation (CLEAN / CONFLICT per pair, conflicted paths, merged blob ids of watched paths), never an integration decision.
//
// CLI: node merge-tree.mjs --repo <git dir> --commit <name>=<sha> (x2..5) [--watch <path>]... --out <dir>
//   -> <out>/merge-tree.json and the raw stdout/stderr of every merge-tree run. Exit 0 when every simulation ran (clean or conflicting), 2 on error.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RESULT_SCHEMA = 'construction-core/gpr2-merge-tree@1';
const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
const WATCH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._\/-]{1,300}$/;

function runner(repo, extraEnv = {}) {
  const env = { PATH: process.env.PATH || '/usr/bin:/bin', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...extraEnv };
  return args => {
    const r = spawnSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
    return { status: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
}
const digest = s => crypto.createHash('sha256').update(s).digest('hex');

/** Fingerprint of everything a read-only rehearsal must leave untouched: all refs (incl. HEAD) and the repository's own object store. */
export function repoFingerprint(repo) {
  const git = runner(repo);
  const refs = git(['for-each-ref', '--format=%(objectname) %(refname)']).stdout + git(['rev-parse', 'HEAD']).stdout;
  const objects = git(['count-objects', '-v']).stdout;
  const status = git(['status', '--porcelain', '--untracked-files=all']).stdout;
  return { refs_sha256: digest(refs), count_objects: objects.trim().split('\n'), status_sha256: digest(status) };
}

/** Parse `git merge-tree --write-tree --name-only --messages` stdout: tree id, conflicted paths, informational messages. */
export function parseMergeTree(stdout) {
  const [first, ...rest] = stdout.split('\n');
  const blank = rest.indexOf('');
  const names = (blank < 0 ? rest : rest.slice(0, blank)).filter(Boolean);
  const messages = blank < 0 ? [] : rest.slice(blank + 1).filter(Boolean);
  return { tree: SHA.test(first) ? first : null, conflicted_paths: [...new Set(names)].sort(), messages };
}

export function rehearse({ repo, commits, watch = [], outDir }) {
  const problems = [];
  for (const [name, sha] of Object.entries(commits)) {
    if (!NAME.test(name)) problems.push(`commit name ${JSON.stringify(name)} is malformed`);
    if (!SHA.test(sha)) problems.push(`commit ${name} must be a full 40-hex SHA`);
  }
  for (const w of watch) if (!WATCH.test(w)) problems.push(`watch path ${JSON.stringify(w)} is malformed`);
  if (Object.keys(commits).length < 2 || Object.keys(commits).length > 5) problems.push('between 2 and 5 commits are required');
  if (problems.length) return { ok: false, problems };

  const gitDir = runner(repo)(['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim();
  const before = repoFingerprint(repo);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gpr2-merge-tree-'));
  const objDir = path.join(scratch, 'objects');
  fs.mkdirSync(path.join(objDir, 'info'), { recursive: true });
  fs.mkdirSync(path.join(objDir, 'pack'), { recursive: true });
  const git = runner(repo, { GIT_OBJECT_DIRECTORY: objDir, GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(gitDir, 'objects') });
  fs.mkdirSync(outDir, { recursive: true });

  const resolved = {};
  for (const [name, sha] of Object.entries(commits)) {
    const r = git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
    if (r.stdout.trim() !== sha) problems.push(`commit ${name} ${sha} is not present in the repository`);
    resolved[name] = { sha, tree: git(['rev-parse', `${sha}^{tree}`]).stdout.trim() || null };
  }
  if (problems.length) { fs.rmSync(scratch, { recursive: true, force: true }); return { ok: false, problems }; }

  const names = Object.keys(commits);
  const ancestry = [];
  for (const a of names) for (const b of names) if (a !== b)
    ancestry.push({ ancestor: a, descendant: b, is_ancestor: git(['merge-base', '--is-ancestor', commits[a], commits[b]]).status === 0 });
  const blobAt = (treeish, p) => { const r = git(['rev-parse', '--verify', '--quiet', `${treeish}:${p}`]); return r.status === 0 ? r.stdout.trim() : null; };

  const pairs = [];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const [a, b] = [names[i], names[j]];
    const id = `${a}+${b}`;
    const bases = git(['merge-base', '--all', commits[a], commits[b]]).stdout.trim().split('\n').filter(Boolean);
    const r = git(['merge-tree', '--write-tree', '--name-only', '--messages', commits[a], commits[b]]);
    fs.writeFileSync(path.join(outDir, `${id}.stdout`), r.stdout);
    fs.writeFileSync(path.join(outDir, `${id}.stderr`), r.stderr);
    const parsed = parseMergeTree(r.stdout);
    const outcome = r.status === 0 && parsed.tree ? 'CLEAN' : r.status === 1 && parsed.tree ? 'CONFLICT' : 'ERROR';
    if (outcome === 'ERROR') problems.push(`${id}: git merge-tree exit ${r.status}: ${r.stderr.slice(0, 500)}`);
    const changed = side => bases.length === 1 ? git(['diff', '--name-only', bases[0], commits[side]]).stdout.split('\n').filter(Boolean) : null;
    const ca = changed(a), cb = changed(b);
    // keep the merged text (with conflict markers) of every watched conflicted path as raw evidence; the temporary objects are deleted below
    for (const p of watch) if (parsed.tree && parsed.conflicted_paths.includes(p))
      fs.writeFileSync(path.join(outDir, `${id}.${p.replace(/\//g, '_')}.merged`), git(['cat-file', 'blob', `${parsed.tree}:${p}`]).stdout);
    pairs.push({ id, ours: a, theirs: b, merge_bases: bases, exit_code: r.status, outcome, result_tree: parsed.tree, conflicted_paths: parsed.conflicted_paths, messages: parsed.messages,
      both_changed: ca && cb ? ca.filter(x => cb.includes(x)).sort() : null,
      watched: watch.map(p => ({ path: p, base: bases.length === 1 ? blobAt(bases[0], p) : null, [a]: blobAt(commits[a], p), [b]: blobAt(commits[b], p),
        result: parsed.tree ? blobAt(parsed.tree, p) : null, conflicted: parsed.conflicted_paths.includes(p) })) });
  }
  const gitVersion = git(['version']).stdout.trim();
  fs.rmSync(scratch, { recursive: true, force: true });
  const after = repoFingerprint(repo);
  const untouched = JSON.stringify(before) === JSON.stringify(after);
  if (!untouched) problems.push('repository refs, object store or worktree changed during the rehearsal');
  return { ok: problems.length === 0, problems, read_only: { untouched, before, after, object_directory: 'temporary (deleted)' }, commits: resolved, ancestry, pairs, git_version: gitVersion };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const argv = process.argv.slice(2); const commits = {}; const watch = []; const a = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [k, v] = [argv[i].replace(/^--/, ''), argv[i + 1]];
    if (k === 'commit') { const m = /^([^=]+)=(.*)$/.exec(v || ''); if (!m) { console.error('--commit expects <name>=<sha>'); process.exit(64); } commits[m[1]] = m[2]; }
    else if (k === 'watch') watch.push(v); else a[k] = v;
  }
  if (!a.repo || !a.out) { console.error('usage: merge-tree.mjs --repo <dir> --commit <name>=<sha>... [--watch <path>]... --out <dir>'); process.exit(64); }
  const r = { schema: RESULT_SCHEMA, ...rehearse({ repo: a.repo, commits, watch, outDir: path.resolve(a.out) }), recorded_at: new Date().toISOString(),
              statement: 'Read-only simulation. No commit, ref, index or worktree change; not an integration decision.' };
  fs.mkdirSync(a.out, { recursive: true });
  fs.writeFileSync(path.join(a.out, 'merge-tree.json'), JSON.stringify(r, null, 2) + '\n');
  for (const p of r.pairs || []) console.log(`${p.outcome.padEnd(8)} ${p.id} (exit ${p.exit_code}) tree ${p.result_tree ?? '-'}${p.conflicted_paths.length ? ' conflicts: ' + p.conflicted_paths.join(', ') : ''}`);
  if (!r.ok) { console.error('REHEARSAL INCOMPLETE:\n  - ' + r.problems.join('\n  - ')); process.exit(2); }
}
