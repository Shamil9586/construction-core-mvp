// Construction Core — GPR-2 CI Foundation: self-tests for the R05 additions (no dependencies; Node >= 22, git >= 2.38).
//   node --test .github/acceptance/tests/r05-harness.test.mjs
// Covers: archived-bundle restoration (source-bundle.mjs) incl. its negative paths, the archive-transport gate in authorize.mjs, the R05
// TEMPLATE profile, the full_regression inventory oracle (classify.mjs), seal/verify-evidence source binding, credential scrubbing and the
// read-only merge-tree rehearsal. Synthetic Git repositories are built in a temp dir, so nothing here needs the private archive; the real R05
// bundle is exercised only when GPR2_R05_BUNDLE points at it (and GPR2_TEST_REPO holds its prerequisite).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateProfile, loadProfile } from '../lib/profile.mjs';
import { authorize, stepOutputs } from '../lib/authorize.mjs';
import { verifyIdentity, testInventory } from '../lib/identity.mjs';
import { classifyRun, classifyFullRegression, classifyNodeFile, S, GATE } from '../lib/classify.mjs';
import { restoreFromBundle, parseBundleHeader, gitBlobId, gitEnv, CANDIDATE_REF, REQUIRED_STEPS, RECORD_SCHEMA, sourcePin } from '../lib/source-bundle.mjs';
import { sourceBindingProblems, writeManifest } from '../lib/seal.mjs';
import { computeInputs } from '../lib/stage-inputs.mjs';
import { prepareClosure, runIsolated, sandboxCommand, SANDBOX_UID } from '../lib/run-normative.mjs';
import { isolatedProvenanceProblems, expectedCore, digestOf, mergeIsolatedResults, STAGE_SCHEMA, NORMATIVE_SCHEMA } from '../lib/provenance.mjs';
import { rehearse, parseMergeTree } from '../lib/merge-tree.mjs';
import { baseEnv } from '../lib/run-profile.mjs';
import { resolveExternalInputs } from '../lib/external-inputs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ACC = path.resolve(HERE, '..');
const LIB = path.join(ACC, 'lib');
const PROFILES = path.join(ACC, 'profiles');
const R05_FILE = path.join(PROFILES, 'r05-final-verification.json');
const R05 = 'c18d42689dd442feda48546096fd42d6b16607a2';
const R05_TREE = '046ea45eb3882e0f1cd9a7325ec5af94bf008315';
const R05_BASE = '0417083ae69842caf40349ccd042ff0401911283';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gpr2-r05-'));
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const r05 = () => JSON.parse(fs.readFileSync(R05_FILE, 'utf8'));
/** The R05 profile as it would look after a separately approved activation (only ever built in memory / temp dirs by these tests). */
const activated = (p = r05()) => { p.status = 'ACTIVE'; p.candidates = p.proposed_candidates; delete p.proposed_candidates; return p; };
const G = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...G, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const okEnv = (o = {}) => ({ GITHUB_REPOSITORY: 'Shamil9586/construction-core-mvp', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_ACTOR: 'Shamil9586',
  GITHUB_TRIGGERING_ACTOR: 'Shamil9586', GITHUB_SHA: '1'.repeat(40), GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '1', INPUT_PROFILE: 'r05-final-verification', INPUT_CANDIDATE_SHA: R05,
  INPUT_CONFIRMATION: `APPROVE-TEST-ONLY r05-final-verification ${R05}`, ...o });

/**
 * A synthetic stage: origin repo with base -> c1 -> c2 (candidate, adds tests), a receiving clone that holds only the base (like a checkout of the
 * public baseline), an incremental bundle base..candidate, and a profile entry pinning it exactly as r05-final-verification.json does.
 */
function synth() {
  const d = tmp(); const origin = path.join(d, 'origin'); const recv = path.join(d, 'recv');
  fs.mkdirSync(path.join(origin, 'tests'), { recursive: true });
  git(origin, 'init', '-q');
  fs.writeFileSync(path.join(origin, 'README.md'), 'base\n'); fs.writeFileSync(path.join(origin, 'tests', 'a.test.ts'), 'a\n');
  git(origin, 'add', '-A'); git(origin, 'commit', '-q', '-m', 'base');
  const base = git(origin, 'rev-parse', 'HEAD');
  execFileSync('git', ['clone', '-q', '--no-local', origin, recv]);
  git(origin, 'checkout', '-q', '-b', 'feature/stage');
  fs.writeFileSync(path.join(origin, 'tests', 'b.test.ts'), 'b\n'); git(origin, 'add', '-A'); git(origin, 'commit', '-q', '-m', 'c1');
  fs.writeFileSync(path.join(origin, 'tests', 'c.test.ts'), 'c\n'); fs.mkdirSync(path.join(origin, 'tests', 'helpers')); fs.writeFileSync(path.join(origin, 'tests', 'helpers', 'h.test.ts'), 'nested, not top level\n');
  git(origin, 'add', '-A'); git(origin, 'commit', '-q', '-m', 'c2');
  const cand = git(origin, 'rev-parse', 'HEAD'), tree = git(origin, 'rev-parse', 'HEAD^{tree}'), p1 = git(origin, 'rev-parse', 'HEAD^'), p1t = git(origin, 'rev-parse', 'HEAD^^{tree}');
  const bundle = path.join(d, 'candidate.bundle');
  git(origin, 'bundle', 'create', '-q', bundle, `${base}..feature/stage`);
  const buf = fs.readFileSync(bundle);
  const profile = {
    schema: 'construction-core/gpr2-acceptance-profile@1', profile_id: 'synthetic-stage', stage: 'R05', title: 'synthetic', status: 'ACTIVE',
    baseline: { sha: base, tree: git(origin, 'rev-parse', `${base}^{tree}`) },
    candidates: [{ sha: cand, tree, lineage: [{ rev: 'HEAD^', sha: p1, tree: p1t }], diff_check_from: base, approval: 'synthetic test candidate',
      source: { kind: 'git-bundle', repository: 'Shamil9586/construction-core-acceptance-evidence', commit: 'a'.repeat(40), path: 'x/candidate.bundle',
                blob: gitBlobId(buf), bytes: buf.length, sha256: sha256(buf), ref: 'refs/heads/feature/stage', prerequisites: [base] } }],
    runtime: { runner: 'ubuntu-24.04', node: '22.22.0', postgres_major: 16, job_timeout_minutes: 30, requires: [] },
    checks: [{ id: 'unit', title: 'u', class: 'UNIT', kind: 'node-test', mandatory: true, requires: [], allow_skip: false, fresh_database_per_file: false, file_timeout_seconds: 60,
               files: [{ path: 'tests/a.test.ts', expect_tests: 2 }, { path: 'tests/b.test.ts', expect_tests: 3 }, { path: 'tests/c.test.ts', expect_tests: 1 }] }],
    full_regression: { inventory: 'tests/*.test.ts', checks: ['unit'], expect_files: 3, expect_tests: 6 },
  };
  assert.deepEqual(validateProfile(profile), []);
  return { d, origin, recv, base, cand, tree, bundle, buf, profile };
}
/** Same pin, different bytes (pinned to the corrupted copy so the corruption itself — not the hash — must be detected). */
function repin(s, buf, name) {
  const f = path.join(s.d, name); fs.writeFileSync(f, buf);
  const p = structuredClone(s.profile); Object.assign(p.candidates[0].source, { bytes: buf.length, sha256: sha256(buf), blob: gitBlobId(buf) });
  return { file: f, profile: p };
}
const refusedAt = (r, step) => { assert.equal(r.ok, false); assert.equal(r.steps.at(-1).step, step, JSON.stringify(r.steps.at(-1))); assert.equal(r.steps.at(-1).ok, false); };

describe('R05 profile (TEMPLATE, not runnable)', () => {
  test('validates strictly, is TEMPLATE with no runnable candidates, and pins the exact proposed identity and bundle', () => {
    const { profile } = loadProfile(R05_FILE);
    assert.equal(profile.status, 'TEMPLATE');
    assert.deepEqual(profile.candidates, []);
    const c = profile.proposed_candidates[0];
    assert.equal(c.sha, R05); assert.equal(c.tree, R05_TREE);
    assert.deepEqual(c.lineage.map(l => [l.rev, l.sha]), [['HEAD^', '5ceb54d80b35719216a2791ee683ade3754ba6d9'], ['HEAD~2', '7c8b401d883efa4f0f72c8c6440f75b34ab2533f'], ['HEAD~3', '7a838ca032f7d6cdce4d5ee4d92f8301587124f6']]);
    assert.equal(profile.baseline.sha, R05_BASE); assert.equal(profile.baseline.tree, 'f841eb030d792cadd392c6c47a9cec0cd2595b73');
    assert.deepEqual({ ...c.source }, { kind: 'git-bundle', repository: 'Shamil9586/construction-core-acceptance-evidence', commit: '0665f9a3f16eaf32f78138d686809cf06d8a44a3',
      path: 'exchange/gpr2/r05/preview-corrective/source/candidate.bundle', blob: '059f9889c7ff9ccf6b815787a0a46a5e29fea089', bytes: 166910,
      sha256: '46f0471ace6d6294399132a9e04342e70e7dc75e7ebf542e314e07326e373677', ref: 'refs/heads/feature/gpr2-r05-worktype-finish-templates', prerequisites: [R05_BASE] });
  });
  test('the full regression is exactly 145 files / 1258 tests, every check mandatory, no skips allowed, isolated PostgreSQL 16', () => {
    const p = r05();
    const listed = p.full_regression.checks.map(id => p.checks.find(c => c.id === id));
    const files = listed.flatMap(c => c.files);
    assert.equal(files.length, 145); assert.equal(new Set(files.map(f => f.path)).size, 145);
    assert.equal(files.reduce((a, f) => a + f.expect_tests, 0), 1258);
    assert.deepEqual([p.full_regression.expect_files, p.full_regression.expect_tests], [145, 1258]);
    assert.ok(p.checks.every(c => c.mandatory === true && c.allow_skip !== true));
    assert.ok(listed.every(c => c.requires.includes('postgres') && c.fresh_database_per_file === true));
    assert.equal(p.runtime.postgres_major, 16);
    assert.ok(p.checks.some(c => c.kind === 'playwright' && c.expect_passed === 22));
  });
  test('cannot be dispatched: TEMPLATE refusal, and the proposed SHA is not registered', () => {
    const r = authorize({ env: okEnv(), harnessDir: ACC });
    assert.equal(r.ok, false);
    assert.ok(r.refusals.some(x => x.includes('TEMPLATE, not ACTIVE')), r.refusals.join('\n'));
    assert.ok(r.refusals.some(x => x.includes('not registered in profile r05-final-verification')), r.refusals.join('\n'));
  });
  const ARCHIVE_REPO = 'Shamil9586/construction-core-acceptance-evidence';
  const HSHA = 'a'.repeat(40);
  const activatedHarness = () => { const h = tmp(); fs.mkdirSync(path.join(h, 'profiles')); fs.copyFileSync(path.join(ACC, 'approvers.txt'), path.join(h, 'approvers.txt'));
    fs.writeFileSync(path.join(h, 'profiles', 'r05-final-verification.json'), JSON.stringify(activated(), null, 2)); return h; };
  test('even after a hypothetical activation, a bundle-sourced candidate is refused in the PUBLIC product repository (it may run only inside the private archive)', () => {
    const h = activatedHarness();
    const r = authorize({ env: okEnv({ GPR2_HARNESS_SHA: HSHA }), harnessDir: h });
    assert.equal(r.ok, false);
    assert.deepEqual(r.refusals.length, 1, r.refusals.join('\n'));
    assert.match(r.refusals[0], /may run only inside that private repository/);
    for (const [name, env, needle] of [['unauthorised actor', { GITHUB_ACTOR: 'someone-else' }, 'actor someone-else'], ['re-run by another user', { GITHUB_TRIGGERING_ACTOR: 'x' }, 'triggering actor x'],
      ['wrong candidate', { INPUT_CANDIDATE_SHA: '5ceb54d80b35719216a2791ee683ade3754ba6d9', INPUT_CONFIRMATION: 'APPROVE-TEST-ONLY r05-final-verification 5ceb54d80b35719216a2791ee683ade3754ba6d9' }, 'not registered'],
      ['missing profile', { INPUT_PROFILE: 'r05-missing', INPUT_CONFIRMATION: `APPROVE-TEST-ONLY r05-missing ${R05}` }, 'not registered on the workflow commit'],
      ['pull_request event', { GITHUB_EVENT_NAME: 'pull_request' }, 'not workflow_dispatch']]) {
      const x = authorize({ env: okEnv(env), harnessDir: h });
      assert.ok(x.refusals.some(m => m.includes(needle)), `${name}: ${x.refusals.join('\n')}`);
    }
  });
  test('inside the private archive repository the bundle-sourced candidate is authorised (with the pinned harness SHA); every other guard still applies; the product repo still refuses it', () => {
    const h = activatedHarness();
    const ok = authorize({ env: okEnv({ GITHUB_REPOSITORY: ARCHIVE_REPO, GPR2_HARNESS_SHA: HSHA }), harnessDir: h });
    assert.equal(ok.ok, true, ok.refusals.join('\n')); assert.equal(ok.harness_sha, HSHA);
    const out = stepOutputs(ok); assert.equal(out.source_commit, '0665f9a3f16eaf32f78138d686809cf06d8a44a3'); assert.equal(out.source_path, 'exchange/gpr2/r05/preview-corrective/source/candidate.bundle'); assert.equal(out.harness_sha, HSHA);
    for (const [name, env, needle] of [['no harness sha', { GPR2_HARNESS_SHA: '' }, 'GPR2_HARNESS_SHA'], ['short harness sha', { GPR2_HARNESS_SHA: 'abc' }, 'GPR2_HARNESS_SHA'],
      ['other repository', { GITHUB_REPOSITORY: 'Shamil9586/some-other-repo' }, 'not Shamil9586/construction-core-mvp or an approved private archive repository'],
      ['not main', { GITHUB_REF: 'refs/heads/x' }, 'not refs/heads/main'], ['another actor', { GITHUB_ACTOR: 'someone-else' }, 'actor someone-else'], ['wrong confirmation', { INPUT_CONFIRMATION: 'yes' }, 'confirmation must be exactly']]) {
      const x = authorize({ env: okEnv({ GITHUB_REPOSITORY: ARCHIVE_REPO, GPR2_HARNESS_SHA: HSHA, ...env }), harnessDir: h });
      assert.equal(x.ok, false, name); assert.ok(x.refusals.some(m => m.includes(needle)), `${name}: ${x.refusals.join('\n')}`);
    }
    // an ordinary (no-source) candidate may not run in the archive repository
    const R04 = 'b882fd0a35fe93d5f85d6be1ccd7dfdc6982f67d';
    const plain = authorize({ env: okEnv({ GITHUB_REPOSITORY: ARCHIVE_REPO, INPUT_PROFILE: 'r04-cp02', INPUT_CANDIDATE_SHA: R04, INPUT_CONFIRMATION: `APPROVE-TEST-ONLY r04-cp02 ${R04}` }), harnessDir: ACC });
    assert.equal(plain.ok, false); assert.ok(plain.refusals.some(x => x.includes('has no archived source and may run only in')), plain.refusals.join('\n'));
  });
  test('step outputs: an ordinary candidate is checked out by its own SHA; an archived one from the public baseline', () => {
    const base = { profile: { stage: 'R05', id: 'p', sha256: 'x' }, runtime: { node: '22.22.0', postgres_major: 16, job_timeout_minutes: 30, requires: ['postgres'] }, workflow: { run_id: '1', run_attempt: '1' }, baseline_sha: R05_BASE };
    const plain = stepOutputs({ ...base, candidate: { sha: 'b882fd0a35fe93d5f85d6be1ccd7dfdc6982f67d', tree: 't', source: null } });
    assert.equal(plain.checkout_ref, 'b882fd0a35fe93d5f85d6be1ccd7dfdc6982f67d'); assert.equal(plain.source_kind, 'none');
    const arch = stepOutputs({ ...base, candidate: { sha: R05, tree: R05_TREE, source: { kind: 'git-bundle' } } });
    assert.equal(arch.checkout_ref, R05_BASE); assert.equal(arch.source_kind, 'git-bundle'); assert.equal(arch.candidate_sha, R05);
  });
  test('accepted R04 profiles still authorise unchanged and keep checkout_ref = candidate SHA', () => {
    const R04 = 'b882fd0a35fe93d5f85d6be1ccd7dfdc6982f67d';
    const r = authorize({ env: okEnv({ INPUT_PROFILE: 'r04-cp02', INPUT_CANDIDATE_SHA: R04, INPUT_CONFIRMATION: `APPROVE-TEST-ONLY r04-cp02 ${R04}` }), harnessDir: ACC });
    assert.equal(r.ok, true, r.refusals.join('\n'));
    assert.equal(stepOutputs(r).checkout_ref, R04); assert.equal(stepOutputs(r).source_kind, 'none');
  });
});

describe('profile schema additions are strict', () => {
  const mutate = fn => { const p = activated(); fn(p); return validateProfile(p); };
  for (const [name, fn, needle] of [
    ['an archive repository outside the allowlist', p => { p.candidates[0].source.repository = 'attacker/evidence'; }, '.repository must be one of'],
    ['a bundle path with traversal', p => { p.candidates[0].source.path = 'exchange/../../etc/x.bundle'; }, 'without ".."'],
    ['a non-bundle path', p => { p.candidates[0].source.path = 'exchange/run.sh'; }, '*.bundle'],
    ['a short archive commit', p => { p.candidates[0].source.commit = '0665f9a'; }, 'archive commit SHA'],
    ['an uppercase / short SHA-256', p => { p.candidates[0].source.sha256 = 'ABC'; }, '64-hex SHA-256'],
    ['a zero byte size', p => { p.candidates[0].source.bytes = 0; }, 'exact bundle size'],
    ['a non-branch bundle ref', p => { p.candidates[0].source.ref = 'HEAD'; }, 'refs/heads/<name>'],
    ['no prerequisites', p => { p.candidates[0].source.prerequisites = []; }, 'every bundle prerequisite'],
    ['an unknown source kind', p => { p.candidates[0].source.kind = 'tarball'; }, '.kind must be one of'],
    ['an unknown source key', p => { p.candidates[0].source.url = 'https://x'; }, 'unknown key "url"'],
    ['proposed candidates in an ACTIVE profile', p => { p.proposed_candidates = structuredClone(p.candidates); }, 'only in a TEMPLATE'],
    ['a full regression whose test total is wrong', p => { p.full_regression.expect_tests = 1257; }, 'expect_tests is 1257'],
    ['a full regression whose file total is wrong', p => { p.full_regression.expect_files = 144; }, 'expect_files is 144'],
    ['a full regression naming an unknown check', p => { p.full_regression.checks.push('nope'); }, 'not a check of this profile'],
    ['a full regression naming a non node-test check', p => { p.full_regression.checks.push('typecheck-build'); }, 'must be a node-test check'],
    ['a full regression over a non-mandatory check', p => { p.checks[0].mandatory = false; }, 'must be mandatory'],
    ['a full regression with an unsupported inventory', p => { p.full_regression.inventory = 'tests/**'; }, 'inventory must be one of'],
    ['a nested file in a top-level inventory', p => { p.checks[0].files[0].path = 'tests/helpers/x.test.ts'; }, 'not a top-level'],
  ]) test(`rejects ${name}`, () => { const e = mutate(fn); assert.ok(e.some(x => x.includes(needle)), JSON.stringify(e)); });
  test('a TEMPLATE profile still may not list (runnable) candidates', () => {
    const p = r05(); p.candidates = structuredClone(p.proposed_candidates);
    assert.ok(validateProfile(p).some(x => x.includes('TEMPLATE profile must not list candidates')));
  });
});

describe('archived bundle restoration (source-bundle.mjs)', () => {
  test('restores the exact candidate, which the unchanged identity.mjs then verifies', () => {
    const s = synth();
    const r = restoreFromBundle({ profile: s.profile, candidateSha: s.cand, bundle: s.bundle, repo: s.recv });
    assert.equal(r.ok, true, r.refusals.join('\n'));
    assert.deepEqual(r.steps.map(x => x.step), ['descriptor', 'descriptor', 'file', 'size', 'sha256', 'git-blob', 'header', 'header-ref', 'header-prerequisites', 'prerequisites-present', 'shallow',
      'bundle-verify', 'bundle-list-heads', 'fetch', 'fetched-sha', 'fsck', 'ancestry', 'baseline-ancestry', 'tree', 'checkout']);
    assert.equal(git(s.recv, 'rev-parse', CANDIDATE_REF), s.cand);
    const id = verifyIdentity({ profile: s.profile, candidateSha: s.cand, repo: s.recv });
    assert.equal(id.ok, true, id.refusals.join('\n'));
    assert.deepEqual(id.test_inventory, ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts']);
    assert.deepEqual(testInventory(s.recv), id.test_inventory);
  });
  test('refuses a wrong bundle SHA-256 before Git reads the file', () => {
    const s = synth(); s.profile.candidates[0].source.sha256 = '0'.repeat(64);
    refusedAt(restoreFromBundle({ profile: s.profile, candidateSha: s.cand, bundle: s.bundle, repo: s.recv }), 'sha256');
    assert.notEqual(spawnSync('git', ['-C', s.recv, 'rev-parse', '--verify', '--quiet', CANDIDATE_REF]).status, 0, 'nothing may be fetched');
  });
  test('refuses a same-size substitute (size passes, SHA-256 does not)', () => {
    const s = synth(); const b = Buffer.from(s.buf); b[b.length - 30] ^= 0xff; fs.writeFileSync(s.bundle, b);
    refusedAt(restoreFromBundle({ profile: s.profile, candidateSha: s.cand, bundle: s.bundle, repo: s.recv }), 'sha256');
  });
  test('refuses a wrong byte size and a wrong Git blob pin', () => {
    const s = synth(); s.profile.candidates[0].source.bytes += 1;
    refusedAt(restoreFromBundle({ profile: s.profile, candidateSha: s.cand, bundle: s.bundle, repo: s.recv }), 'size');
    const t = synth(); t.profile.candidates[0].source.blob = 'f'.repeat(40);
    refusedAt(restoreFromBundle({ profile: t.profile, candidateSha: t.cand, bundle: t.bundle, repo: t.recv }), 'git-blob');
  });
  test('refuses a corrupted bundle even when the pin matches the corrupted bytes', () => {
    const s = synth(); const b = Buffer.from(s.buf); b[b.length - 40] ^= 0x55;   // inside the pack, header intact
    const { file, profile } = repin(s, b, 'corrupt.bundle');
    const r = restoreFromBundle({ profile, candidateSha: s.cand, bundle: file, repo: s.recv });
    assert.equal(r.ok, false);
    assert.ok(['bundle-verify', 'bundle-list-heads', 'fetch', 'fsck'].includes(r.steps.at(-1).step), JSON.stringify(r.steps.at(-1)));
    assert.notEqual(git(s.recv, 'rev-parse', 'HEAD'), s.cand);
  });
  test('refuses a bundle whose header names another ref or another candidate', () => {
    const s = synth();
    const b = Buffer.from(s.buf.toString('latin1').replace('refs/heads/feature/stage', 'refs/heads/feature/other'), 'latin1');
    const { file, profile } = repin(s, b, 'otherref.bundle');
    refusedAt(restoreFromBundle({ profile, candidateSha: s.cand, bundle: file, repo: s.recv }), 'header-ref');
    const t = synth(); const p = structuredClone(t.profile); p.candidates[0].sha = git(t.origin, 'rev-parse', 'HEAD^');
    refusedAt(restoreFromBundle({ profile: p, candidateSha: p.candidates[0].sha, bundle: t.bundle, repo: t.recv }), 'header-ref');
  });
  test('refuses an unregistered candidate SHA and a candidate without a bundle source', () => {
    const s = synth();
    refusedAt(restoreFromBundle({ profile: s.profile, candidateSha: 'e'.repeat(40), bundle: s.bundle, repo: s.recv }), 'descriptor');
    delete s.profile.candidates[0].source;
    refusedAt(restoreFromBundle({ profile: s.profile, candidateSha: s.cand, bundle: s.bundle, repo: s.recv }), 'descriptor');
  });
  test('refuses a wrong expected tree (after a verified fetch, before checkout)', () => {
    const s = synth(); s.profile.candidates[0].tree = 'd'.repeat(40);
    refusedAt(restoreFromBundle({ profile: s.profile, candidateSha: s.cand, bundle: s.bundle, repo: s.recv }), 'tree');
    assert.notEqual(git(s.recv, 'rev-parse', 'HEAD'), s.cand, 'no checkout of an unverified tree');
  });
  test('refuses pinned prerequisites that differ from the bundle header', () => {
    const s = synth(); s.profile.candidates[0].source.prerequisites = ['c'.repeat(40)];
    refusedAt(restoreFromBundle({ profile: s.profile, candidateSha: s.cand, bundle: s.bundle, repo: s.recv }), 'header-prerequisites');
  });
  test('refuses when the prerequisite baseline is missing from the receiving repository', () => {
    const s = synth(); const empty = path.join(s.d, 'empty'); fs.mkdirSync(empty); git(empty, 'init', '-q');
    refusedAt(restoreFromBundle({ profile: s.profile, candidateSha: s.cand, bundle: s.bundle, repo: empty }), 'prerequisites-present');
  });
  test('refuses a shallow receiving repository', () => {
    const s = synth(); const sh = path.join(s.d, 'shallow');
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${s.recv}`, sh]);
    refusedAt(restoreFromBundle({ profile: s.profile, candidateSha: s.cand, bundle: s.bundle, repo: sh }), 'shallow');
  });
  test('refuses an unavailable archive (missing file), a directory and a symbolic link', () => {
    const s = synth();
    refusedAt(restoreFromBundle({ profile: s.profile, candidateSha: s.cand, bundle: path.join(s.d, 'absent.bundle'), repo: s.recv }), 'file');
    refusedAt(restoreFromBundle({ profile: s.profile, candidateSha: s.cand, bundle: s.d, repo: s.recv }), 'file');
    const link = path.join(s.d, 'link.bundle'); fs.symlinkSync(s.bundle, link);
    refusedAt(restoreFromBundle({ profile: s.profile, candidateSha: s.cand, bundle: link, repo: s.recv }), 'file');
  });
  test('header parser accepts only v2 and rejects malformed lines', () => {
    assert.match(parseBundleHeader(Buffer.from('# v3 git bundle\n@object-format=sha1\n\nPACK')).error, /only "# v2 git bundle"/);
    assert.match(parseBundleHeader(Buffer.from('# v2 git bundle\n$(curl x) refs/heads/a\n\nPACK')).error, /malformed/);
    assert.match(parseBundleHeader(Buffer.from('# v2 git bundle\n' + 'a'.repeat(70000))).error, /not terminated/);
    assert.deepEqual(parseBundleHeader(Buffer.from(`# v2 git bundle\n-${'1'.repeat(40)} base\n${'2'.repeat(40)} refs/heads/x\n\nPACK`)), { version: 2, prerequisites: ['1'.repeat(40)], refs: [{ sha: '2'.repeat(40), ref: 'refs/heads/x' }] });
  });
  test('CLI writes the record and exits 2 on refusal', () => {
    const s = synth(); s.profile.candidates[0].source.sha256 = '0'.repeat(64);
    const pf = path.join(s.d, 'synthetic-stage.json'); fs.writeFileSync(pf, JSON.stringify(s.profile));
    const out = path.join(s.d, 'rec.json');
    const r = spawnSync('node', [path.join(LIB, 'source-bundle.mjs'), '--profile', pf, '--candidate', s.cand, '--bundle', s.bundle, '--repo', s.recv, '--out', out, '--phase', 'runtime'], { encoding: 'utf8' });
    assert.equal(r.status, 2, r.stderr);
    const rec = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(rec.ok, false); assert.equal(rec.phase, 'runtime'); assert.ok(rec.refusals[0].startsWith('sha256'));
  });
  test('the real R05 bundle restores c18d426 / 046ea45 (only when GPR2_R05_BUNDLE is provided)', { skip: !process.env.GPR2_R05_BUNDLE && 'private bundle not supplied (set GPR2_R05_BUNDLE and GPR2_TEST_REPO)' }, () => {
    const repo = process.env.GPR2_TEST_REPO; assert.ok(repo, 'GPR2_TEST_REPO must be a full clone of the product repository');
    const d = path.join(tmp(), 'core'); execFileSync('git', ['clone', '-q', '--no-local', repo, d]); git(d, 'checkout', '-q', '--detach', R05_BASE);
    const p = activated();
    const r = restoreFromBundle({ profile: p, candidateSha: R05, bundle: process.env.GPR2_R05_BUNDLE, repo: d });
    assert.equal(r.ok, true, r.refusals.join('\n'));
    const id = verifyIdentity({ profile: p, candidateSha: R05, repo: d });
    assert.equal(id.ok, true, id.refusals.join('\n'));
    assert.equal(id.diff_check, 'CLEAN');
    const files = p.full_regression.checks.flatMap(cid => p.checks.find(c => c.id === cid).files.map(f => f.path)).sort();
    assert.deepEqual(id.test_inventory, files, 'profile regression files = exact candidate inventory');
  });
});

describe('no credential reaches a child process', () => {
  const SECRETS = { GPR2_ARCHIVE_TOKEN: 's3cr3t-archive', GH_TOKEN: 's3cr3t-gh', GITHUB_TOKEN: 's3cr3t-gt', ACTIONS_RUNTIME_TOKEN: 's3cr3t-rt', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 's3cr3t-oidc',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.invalid', NPM_TOKEN: 's3cr3t-npm', AWS_SECRET_ACCESS_KEY: 's3cr3t-aws', PGPASSWORD: 's3cr3t-pg', DATABASE_URL: 'postgres://live.invalid/prod',
    GIT_ASKPASS: '/tmp/steal', GIT_CONFIG_PARAMETERS: "'credential.helper'='!steal'" };
  const withEnv = (vars, fn) => { const old = {}; for (const k of Object.keys(vars)) { old[k] = process.env[k]; process.env[k] = vars[k]; }
    try { return fn(); } finally { for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  test('every git process of the bundle restoration gets only the minimal environment', () => {
    const s = synth();
    const shim = path.join(s.d, 'shim'); fs.mkdirSync(shim); const dump = path.join(s.d, 'env-dumps');
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(shim, 'git'), `#!/bin/sh\nenv >> '${dump}'\necho ---- >> '${dump}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
    const r = withEnv({ ...SECRETS, PATH: `${shim}:${process.env.PATH}` }, () => restoreFromBundle({ profile: s.profile, candidateSha: s.cand, bundle: s.bundle, repo: s.recv }));
    assert.equal(r.ok, true, r.refusals.join('\n'));
    const text = fs.readFileSync(dump, 'utf8');
    assert.ok(text.split('----').length > 10, 'the shim saw the git invocations');
    for (const [k, v] of Object.entries(SECRETS)) { assert.ok(!text.includes(v), `${k} value leaked`); }
    for (const line of text.split('\n').filter(l => l && l !== '----')) assert.ok(/^(PATH|LC_ALL|GIT_TERMINAL_PROMPT|GIT_CONFIG_NOSYSTEM|GIT_CONFIG_GLOBAL|GIT_ASKPASS|SSH_ASKPASS|PWD|SHLVL|_|OLDPWD)=/.test(line), `unexpected variable: ${line}`);
    assert.equal(gitEnv({ PATH: '/x', GH_TOKEN: 't' }).GH_TOKEN, undefined);
  });
  test('candidate processes (run-profile baseEnv) lose every credential, database and runner-control variable', () => {
    const env = withEnv(SECRETS, () => baseEnv({ E2E_DATABASE_URL: 'postgresql://postgres:x@127.0.0.1:54329/construction_test' }));
    for (const k of ['GPR2_ARCHIVE_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'PGPASSWORD'])
      assert.equal(env[k], undefined, `${k} must be scrubbed`);
    assert.equal(env.DATABASE_URL, ''); assert.equal(env.AUTH_MODE, 'mock'); assert.equal(env.E2E_DATABASE_URL, 'postgresql://postgres:x@127.0.0.1:54329/construction_test');
  });
});

describe('full regression oracle (classify.mjs)', () => {
  const profile = () => synth().profile;
  const rawWith = (p, files, extraState = {}) => {
    const d = tmp(); fs.mkdirSync(path.join(d, 'checks', 'unit'), { recursive: true });
    fs.writeFileSync(path.join(d, 'checks', 'unit', 'result.json'), JSON.stringify({ state: 'EXECUTED', ...extraState, files }));
    return d;
  };
  const execd = (pth, t, over = {}) => ({ path: pth, state: 'EXECUTED', exit_code: 0, counts: { tests: t, pass: t, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...over } });
  const INV = ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts'];
  const all = () => [execd('tests/a.test.ts', 2), execd('tests/b.test.ts', 3), execd('tests/c.test.ts', 1)];
  const run = (p, files, inv = INV, state) => classifyRun({ profile: p, rawDir: rawWith(p, files, state), identity: { ok: true, test_inventory: inv } });
  const fr = r => r.checks.find(c => c.id === 'full-regression-inventory');
  test('PASS only when the inventory matches exactly and every one of the expected tests passed', () => {
    const r = run(profile(), all());
    assert.equal(fr(r).status, S.PASS, fr(r).reasons.join('; ')); assert.equal(r.gate, GATE.PASSED);
    assert.deepEqual(fr(r).totals, { files: 3, files_with_summary: 3, expected_files: 3, expected_tests: 6, tests: 6, pass: 6, inventory_files: 3 });
  });
  test('FAIL when the candidate has a test file the profile does not cover', () => {
    const r = run(profile(), all(), [...INV, 'tests/d.test.ts']);
    assert.equal(fr(r).status, S.FAIL); assert.ok(fr(r).reasons.some(x => x.includes('not covered') && x.includes('tests/d.test.ts'))); assert.equal(r.gate, GATE.FAILED);
  });
  test('FAIL when a required test file is missing from the candidate (inventory and execution record)', () => {
    const files = all(); files[2] = { path: 'tests/c.test.ts', state: 'MISSING' };
    const r = run(profile(), files, INV.slice(0, 2));
    assert.equal(fr(r).status, S.FAIL); assert.ok(fr(r).reasons.some(x => x.includes('absent from the candidate inventory')));
    assert.equal(r.checks.find(c => c.id === 'unit').status, S.FAIL); assert.equal(r.gate, GATE.FAILED);
  });
  test('FAIL on an incomplete test count (one test fewer than expected, otherwise green)', () => {
    const files = all(); files[1] = execd('tests/b.test.ts', 2);
    const r = run(profile(), files);
    assert.equal(fr(r).status, S.FAIL); assert.ok(fr(r).reasons.some(x => x.includes('5 tests in total')));
  });
  test('FAIL on a single skip (no clamping into a pass), on a cancellation and on a crashed runner summary', () => {
    for (const files of [[execd('tests/a.test.ts', 2, { pass: 1, skipped: 1 }), ...all().slice(1)], [execd('tests/a.test.ts', 2, { pass: 1, cancelled: 1 }), ...all().slice(1)],
      [{ path: 'tests/a.test.ts', state: 'EXECUTED', exit_code: 1, counts: {} }, ...all().slice(1)]]) {
      const r = run(profile(), files); assert.equal(fr(r).status, S.FAIL); assert.equal(r.gate, GATE.FAILED);
    }
  });
  test('FAIL when the identity record carries no inventory although identity passed; NOT RUN / BLOCKED when nothing ran', () => {
    const p = profile();
    const r = classifyRun({ profile: p, rawDir: rawWith(p, all()), identity: { ok: true } });
    assert.equal(fr(r).status, S.FAIL); assert.ok(fr(r).reasons.some(x => x.includes('missing from the identity record')));
    const none = classifyRun({ profile: p, rawDir: tmp(), identity: { ok: true, test_inventory: INV } });
    assert.equal(fr(none).status, S.NOT_RUN); assert.equal(none.gate, GATE.INCONCLUSIVE);
    const blocked = run(p, [], INV, { state: 'BLOCKED', reason: 'PostgreSQL provisioning outcome: failure' });
    assert.equal(fr(blocked).status, S.BLOCKED); assert.equal(blocked.gate, GATE.INCONCLUSIVE);
  });
  test('profiles without full_regression (R04) get no extra check', () => {
    const p = JSON.parse(fs.readFileSync(path.join(PROFILES, 'r04-cp02.json'), 'utf8'));
    assert.equal(classifyFullRegression(p, [], { ok: true }), null);
    assert.ok(!classifyRun({ profile: p, rawDir: tmp(), identity: { ok: true } }).checks.some(c => c.id === 'full-regression-inventory'));
  });
});

describe('sealing an archived candidate: all three source records must bind, PostgreSQL teardown and the manifest are enforced', () => {
  const ID = { pid: 551, start_ticks: '34305', boot_id: 'a1b2c3d4-0000-4000-8000-000000000001', exe: '/usr/lib/postgresql/16/bin/postgres', argv: ['/usr/lib/postgresql/16/bin/postgres', '-D', '/var/tmp/gpr2-accept-1-1/data', '-c', 'port=54329'], data_directory: '/var/tmp/gpr2-accept-1-1/data' };
  const cleanup = () => ({ status: 'STOPPED_VERIFIED', stop_mode: 'fast', stop_method: 'signal', root: '/var/tmp/gpr2-accept-1-1', root_exists_after: false, startup_status: 'RUNNING_VERIFIED', recorded_postmaster_pid: 551,
    root_existed_before: true, pg_version_present_before: true, postmaster_pid_file_before: true, startup_identity: { state: 'COMPLETE', missing: [], recorded: ID }, owned_process_scan: 'ok',
    owned_processes_before: [{ pid: 551, role: 'postmaster', cwd: ID.data_directory, start_ticks: ID.start_ticks, boot_id: ID.boot_id, exe: ID.exe, argv: ID.argv }], owned_processes_after: [],
    ambiguous_processes_before: [], ambiguous_processes_after: [], signals: [{ pid: 551, signal: 'INT', exited: true }], stale_pidfile: null, prior_cleanup_status: null,
    port_before: { pg_isready_exit: 0, responder: 'owned', detail: '' }, port_after: { pg_isready_exit: 2, responder: 'none', detail: '' }, termination_evidence: 'stopped_by_cleanup',
    shutdown_proof: ['verified postmaster pid 551 exited after SIGINT'], foreign_instances_untouched: true, problems: [], notes: [] });
  /** Builds an all-PASS synthetic evidence set for the (activated) R05 profile and runs the real seal.mjs and verify-evidence.mjs CLIs. */
  function sealR05({ dropSource = null, cleanupRecord = cleanup(), tamper = null, records = (_phase, rec) => rec, afterSeal = null, iso = (_kind, o) => o, omit = [] } = {}) {
    const p = activated(); const d = tmp();
    const pf = path.join(d, 'profiles', 'r05-final-verification.json'); fs.mkdirSync(path.dirname(pf), { recursive: true }); fs.writeFileSync(pf, JSON.stringify(p, null, 2));
    const { sha256: profileSha } = loadProfile(pf);
    const cand = p.candidates[0]; const candId = { sha: cand.sha, tree: cand.tree };
    const raw = path.join(d, 'raw'); fs.mkdirSync(path.join(raw, 'postgres'), { recursive: true });
    for (const c of p.checks) {
      const cd = path.join(raw, 'checks', c.id); fs.mkdirSync(cd, { recursive: true });
      if (c.kind === 'node-test') fs.writeFileSync(path.join(cd, 'result.json'), JSON.stringify({ state: 'EXECUTED', files: c.files.map(f => f.isolated ? { path: f.path, state: 'DEFERRED', executed_in: f.isolated.job, reason: 'executed in the isolated job' }
        : { path: f.path, state: 'EXECUTED', exit_code: 0, counts: { tests: f.expect_tests, pass: f.expect_tests, fail: 0, cancelled: 0, skipped: 0, todo: 0 } }) }));
      else if (c.kind === 'playwright') { fs.writeFileSync(path.join(cd, 'report.json'), JSON.stringify({ stats: { expected: c.expect_passed, unexpected: 0, flaky: 0, skipped: 0 }, errors: [], suites: [{ title: 's', specs: Array.from({ length: c.expect_passed }, (_, i) => ({ title: 't' + i, tests: [{ status: 'expected', results: [{ status: 'passed' }] }] })) }] }));
        fs.writeFileSync(path.join(cd, 'result.json'), JSON.stringify({ state: 'EXECUTED', exit_code: 0, report: `checks/${c.id}/report.json` })); }
      else fs.writeFileSync(path.join(cd, 'result.json'), JSON.stringify({ state: 'EXECUTED', exit_code: 0 }));
    }
    if (cleanupRecord) fs.writeFileSync(path.join(raw, 'postgres', 'cleanup.json'), JSON.stringify(cleanupRecord));
    const inventory = p.full_regression.checks.flatMap(id => p.checks.find(c => c.id === id).files.map(f => f.path)).sort();
    fs.writeFileSync(path.join(raw, 'identity-runtime.json'), JSON.stringify({ ok: true, candidate: candId, test_inventory: inventory }));
    // A realistic restoration record, exactly as source-bundle.mjs writes it (phase, profile identity, pin, every step passed).
    const src = phase => ({ schema: RECORD_SCHEMA, phase, profile_id: p.profile_id, profile_sha256: profileSha, candidate_sha: cand.sha, ok: true, refusals: [],
      steps: REQUIRED_STEPS.map(step => ({ step, ok: true, detail: 'x' })), pin: sourcePin(cand.source), observed: { bytes: cand.source.bytes, sha256: cand.source.sha256, blob: cand.source.blob },
      candidate: { sha: cand.sha, tree: cand.tree, ref: 'refs/gpr2-acceptance/candidate', checked_out: cand.sha }, verified_at: 'x' });
    // The isolated job's artefacts: stage record, stage outputs (job outputs), the seal job's own recomputation, and the normative job's result.
    const isoFiles = p.checks.flatMap(c => c.files || []).filter(f => f.isolated);
    const want = expectedCore(p, cand, profileSha);
    const stageRec = () => ({ schema: STAGE_SCHEMA, ok: true, refusals: [], ...want, harness_sha: 'a'.repeat(40), inputs_digest: digestOf(want),
      isolated: want.isolated.map(f => ({ ...f, job: 'normative', closure: f.closure.map(x => ({ ...x, candidate_blob: x.blob, baseline_blob: x.blob })) })) });
    const normative = () => ({ schema: NORMATIVE_SCHEMA, job: 'normative', profile_id: p.profile_id, profile_sha256: profileSha, candidate_sha: cand.sha, files: isoFiles.map(f => ({
      path: f.path, state: 'EXECUTED', exit_code: 0, counts: { tests: f.expect_tests, pass: f.expect_tests, fail: 0, cancelled: 0, skipped: 0, todo: 0 }, log: null,
      closure_verified: f.isolated.closure.map(x => ({ path: x.path, blob: x.blob })), sandbox: { network: 'none', uid: 65534, env: 'minimal', probe_ok: true },
      ...(tamper === 'drop-input-record' ? {} : { external_inputs: f.external_inputs.map(x => ({ env: x.env, filename: x.filename, sha256: tamper === 'wrong-input-sha' ? '0'.repeat(64) : x.sha256, bytes: 1 })) }) })) });
    const isoDir = path.join(d, 'iso'); fs.mkdirSync(path.join(isoDir, 'normative'), { recursive: true });
    const wr = (name, obj) => { if (!omit.includes(name)) fs.writeFileSync(path.join(isoDir, name), JSON.stringify(iso(name, obj))); };
    wr('stage-outputs.json', { inputs_digest: digestOf(want), candidate_sha: cand.sha, bundle_sha256: cand.source.sha256 });
    wr('stage-record.json', stageRec()); wr('inputs-seal.json', stageRec());
    if (!omit.includes('normative')) fs.writeFileSync(path.join(isoDir, 'normative', 'result.json'), JSON.stringify(iso('normative', normative())));
    const authzDir = path.join(d, 'authz'); fs.mkdirSync(authzDir);
    fs.writeFileSync(path.join(authzDir, 'authorization.json'), JSON.stringify({ ok: true, request: { actor: 'Shamil9586', triggering_actor: 'Shamil9586' }, candidate: { ...candId, source: cand.source }, profile: { sha256: profileSha } }));
    const recs = { authorize: path.join(authzDir, 'source-bundle-authorize.json'), runtime: path.join(raw, 'source-bundle-runtime.json'), seal: path.join(d, 'source-bundle-seal.json') };
    for (const [ph, f] of Object.entries(recs)) if (ph !== dropSource) fs.writeFileSync(f, JSON.stringify(records(ph, src(ph))));
    if (tamper === 'runtime-sha') fs.writeFileSync(recs.runtime, JSON.stringify({ ...src('runtime'), observed: { ...src('runtime').observed, sha256: '0'.repeat(64) } }));
    fs.writeFileSync(path.join(d, 'identity-seal.json'), JSON.stringify({ ok: true, candidate: candId, test_inventory: inventory }));
    const out = path.join(d, 'sealed');
    const run = spawnSync('node', [path.join(LIB, 'seal.mjs'), '--profile', pf, '--raw', raw, '--authorization', path.join(authzDir, 'authorization.json'), '--identity', path.join(d, 'identity-seal.json'),
      '--runtime-result', 'success', '--source', recs.seal, '--normative', path.join(isoDir, 'normative'), '--stage-outputs', path.join(isoDir, 'stage-outputs.json'),
      '--stage-record', path.join(isoDir, 'stage-record.json'), '--inputs-seal', path.join(isoDir, 'inputs-seal.json'), '--out', out], { encoding: 'utf8' });
    const rec = JSON.parse(fs.readFileSync(path.join(out, 'acceptance-result.json'), 'utf8'));
    if (tamper === 'drop-file') fs.rmSync(path.join(out, 'raw', 'checks', 'browser-gpr1', 'report.json'));
    if (tamper === 'extra-file') fs.writeFileSync(path.join(out, 'raw', 'injected.log'), 'x');
    if (afterSeal) afterSeal(out);
    if (tamper === 'manifest-edit') { const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')); m.files.pop(); fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(m)); }
    const verify = spawnSync('node', [path.join(LIB, 'verify-evidence.mjs'), out, '--profile', pf, '--expect-candidate', R05], { encoding: 'utf8' });
    return { run, rec, verify, out };
  }
  test('all-PASS evidence with three bound source records seals TECHNICAL_GATES_PASSED and verifies', () => {
    const { run, rec, verify, out } = sealR05();
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(rec.result.gate, GATE.PASSED, rec.result.gate_reasons.join('\n'));
    assert.equal(rec.result.checks.find(c => c.id === 'full-regression-inventory').status, S.PASS);
    for (const f of ['source-bundle-authorize.json', 'source-bundle-seal.json', 'raw/source-bundle-runtime.json']) assert.ok(fs.existsSync(path.join(out, f)), f);
    assert.equal(verify.status, 0, verify.stdout); assert.match(verify.stdout, /archived source bound in all three phases/);
  });
  for (const phase of ['authorize', 'runtime', 'seal']) test(`a missing ${phase}-phase source record fails the gate and the verification`, () => {
    const { run, rec, verify } = sealR05({ dropSource: phase });
    assert.equal(run.status, 1); assert.equal(rec.result.gate, GATE.FAILED);
    assert.ok(rec.result.gate_reasons.some(x => x.includes(`${phase}-phase archived-source record missing`)), rec.result.gate_reasons.join('\n'));
    assert.equal(verify.status, 2);
  });
  test('a runtime source record bound to another bundle digest fails', () => {
    const { rec } = sealR05({ tamper: 'runtime-sha' });
    assert.equal(rec.result.gate, GATE.FAILED); assert.ok(rec.result.gate_reasons.some(x => x.includes('runtime-phase archived-source record is not bound')));
  });
  // F-CI-R05-01: a record that merely says ok:true with the right candidate/digest must still be of ITS phase, for THIS profile, with the registered pin and every step passed.
  const bindingCases = [
    ['one authorize-phase record reused in all three slots', (ph, rec) => ({ ...rec, phase: 'authorize' }), /(runtime|seal)-phase archived-source record is a "authorize"-phase record/],
    ['a record of the wrong phase (runtime record in the seal slot)', (ph, rec) => (ph === 'seal' ? { ...rec, phase: 'runtime' } : rec), /seal-phase archived-source record is a "runtime"-phase record/],
    ['a record without any phase', (ph, rec) => { const r = { ...rec }; if (ph === 'runtime') delete r.phase; return r; }, /runtime-phase archived-source record is a undefined-phase record|runtime-phase archived-source record is a .*phase record/],
    ['a record made for another profile id', (ph, rec) => (ph === 'runtime' ? { ...rec, profile_id: 'r04-cp02' } : rec), /runtime-phase archived-source record is for profile "r04-cp02"/],
    ['a record made under another profile digest (edited profile)', (ph, rec) => (ph === 'seal' ? { ...rec, profile_sha256: 'f'.repeat(64) } : rec), /seal-phase archived-source record was made under profile digest/],
    ['a record naming another candidate_sha', (ph, rec) => (ph === 'authorize' ? { ...rec, candidate_sha: '9'.repeat(40) } : rec), /authorize-phase archived-source record is not bound to candidate/],
    ['a record without a pin', (ph, rec) => { const r = { ...rec }; if (ph === 'runtime') delete r.pin; return r; }, /runtime-phase archived-source record does not carry the registered source pin/],
    ['a record with another pin (other archive commit)', (ph, rec) => (ph === 'runtime' ? { ...rec, pin: { ...rec.pin, commit: 'b'.repeat(40) } } : rec), /runtime-phase archived-source record does not carry the registered source pin/],
    ['a record with other prerequisites in the pin', (ph, rec) => (ph === 'seal' ? { ...rec, pin: { ...rec.pin, prerequisites: ['c'.repeat(40)] } } : rec), /seal-phase archived-source record does not carry the registered source pin/],
    ['a record without steps', (ph, rec) => { const r = { ...rec }; if (ph === 'authorize') delete r.steps; return r; }, /authorize-phase archived-source record lacks passed restoration step\(s\): descriptor, file/],
    ['a record missing the fsck step', (ph, rec) => (ph === 'runtime' ? { ...rec, steps: rec.steps.filter(x => x.step !== 'fsck') } : rec), /runtime-phase archived-source record lacks passed restoration step\(s\): fsck/],
    ['a record with a failed step', (ph, rec) => (ph === 'seal' ? { ...rec, steps: rec.steps.map(x => (x.step === 'tree' ? { ...x, ok: false } : x)) } : rec), /seal-phase archived-source record (lacks passed restoration step\(s\): tree|contains failed)/],
    ['a record of another schema', (ph, rec) => (ph === 'authorize' ? { ...rec, schema: 'x' } : rec), /authorize-phase archived-source record has schema/],
  ];
  for (const [name, records, expected] of bindingCases) {
    test(`F-CI-R05-01 sealing refuses ${name}`, () => {
      const { run, rec } = sealR05({ records });
      assert.equal(run.status, 1, run.stdout); assert.equal(rec.result.gate, GATE.FAILED);
      assert.ok(rec.result.gate_reasons.some(x => expected.test(x)), rec.result.gate_reasons.join('\n'));
    });
    test(`F-CI-R05-01 verify-evidence refuses ${name} even when the manifest is rebuilt (checksums consistent)`, () => {
      // Seal honest evidence, then swap the saved source records for the tampered ones and REBUILD manifest + SHA256SUMS, so only the binding can reject it.
      const { verify: honest, out } = sealR05({ afterSeal: out => {
        const honestRec = ph => JSON.parse(fs.readFileSync(path.join(out, ph === 'runtime' ? 'raw/source-bundle-runtime.json' : `source-bundle-${ph}.json`), 'utf8'));
        for (const ph of ['authorize', 'runtime', 'seal']) fs.writeFileSync(path.join(out, ph === 'runtime' ? 'raw/source-bundle-runtime.json' : `source-bundle-${ph}.json`), JSON.stringify(records(ph, honestRec(ph))));
        const { files, file_count, ...meta } = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')); writeManifest(out, (({ schema, ...m }) => m)(meta));
      } });
      assert.equal(honest.status, 2, honest.stdout);
      assert.doesNotMatch(honest.stdout, /checksum mismatch|not covered by SHA256SUMS|manifest entry differs/);
      assert.ok(honest.stdout.split('\n').some(l => l.includes('FAIL') && expected.test(l)), honest.stdout);
    });
  }
  test('F-CI-R05-01 control: the same rebuilt-manifest procedure with untampered records still verifies', () => {
    const { verify } = sealR05({ afterSeal: out => { const { files, file_count, schema, ...meta } = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')); writeManifest(out, meta); } });
    assert.equal(verify.status, 0, verify.stdout); assert.match(verify.stdout, /archived source bound in all three phases/);
  });
  test('D1-A/NORM sealing: all documents verified -> PASS; a missing or wrong document record in the evidence fails the gate and verify-evidence', () => {
    assert.equal(sealR05().rec.result.gate, GATE.PASSED);
    for (const tamper of ['drop-input-record', 'wrong-input-sha']) {
      const { rec } = sealR05({ tamper });
      assert.equal(rec.result.gate, GATE.FAILED, tamper); assert.ok(JSON.stringify(rec.result.checks).includes('is not recorded as verified'), tamper);
    }
  });
  // D1-B: provenance of the isolated inputs. Each tamper is tried against seal.mjs, and against verify-evidence.mjs with a REBUILT manifest (so only the provenance can reject it).
  const SEALED = { 'stage-outputs.json': 'stage-outputs.json', 'stage-record.json': 'stage-record.json', 'inputs-seal.json': 'inputs-seal.json', normative: 'normative/result.json' };
  const isoCases = [
    ['a stage output digest that is not the digest of the pinned inputs', 'stage-outputs.json', o => ({ ...o, inputs_digest: '0'.repeat(64) }), /stage job output inputs_digest differs/],
    ['a stage output naming another candidate', 'stage-outputs.json', o => ({ ...o, candidate_sha: '9'.repeat(40) }), /stage job output names another candidate/],
    ['a seal-job recomputation that differs in a document digest', 'inputs-seal.json', o => ({ ...o, isolated: o.isolated.map(f => ({ ...f, docs: f.docs.map(d => ({ ...d, sha256: '1'.repeat(64) })) })) }), /seal-job \(independent\) staging record does not equal/],
    ['a seal-job recomputation that differs in a closure blob', 'inputs-seal.json', o => ({ ...o, isolated: o.isolated.map(f => ({ ...f, closure: f.closure.map((x, i) => (i ? x : { ...x, blob: '2'.repeat(40) })) })) }), /seal-job \(independent\) staging record does not equal/],
    ['a seal-job recomputation that is not OK', 'inputs-seal.json', o => ({ ...o, ok: false }), /seal-job \(independent\) staging record missing or not OK/],
    ['a seal-job recomputation for another bundle', 'inputs-seal.json', o => ({ ...o, bundle: { ...o.bundle, sha256: '3'.repeat(64) } }), /seal-job \(independent\) staging record does not equal/],
    ['a stage-job record that differs from the pins', 'stage-record.json', o => ({ ...o, candidate_tree: '4'.repeat(40) }), /stage-job staging record does not equal/],
    ['a normative result for another candidate', 'normative', o => ({ ...o, candidate_sha: '5'.repeat(40) }), /normative job result is for another profile, digest or candidate/],
    ['a normative result made under another profile digest', 'normative', o => ({ ...o, profile_sha256: '6'.repeat(64) }), /normative job result is for another profile, digest or candidate/],
    ['a normative result that used another document', 'normative', o => ({ ...o, files: o.files.map(f => ({ ...f, external_inputs: f.external_inputs.map((x, i) => (i ? x : { ...x, sha256: '7'.repeat(64) })) })) }), /documents used by the normative job differ/],
    ['a normative result that executed other files than the pinned closure', 'normative', o => ({ ...o, files: o.files.map(f => ({ ...f, closure_verified: f.closure_verified.slice(1) })) }), /files executed by the normative job differ/],
    ['a normative result without a network-isolated sandbox', 'normative', o => ({ ...o, files: o.files.map(f => ({ ...f, sandbox: { ...f.sandbox, network: 'host' } })) }), /did not record a verified network-isolated/],
    ['a normative result run as root', 'normative', o => ({ ...o, files: o.files.map(f => ({ ...f, sandbox: { ...f.sandbox, uid: 0 } })) }), /did not record a verified network-isolated/],
    ['a normative result whose sandbox probe failed', 'normative', o => ({ ...o, files: o.files.map(f => ({ ...f, sandbox: { ...f.sandbox, probe_ok: false } })) }), /did not record a verified network-isolated/],
    ['a normative result that did not execute the file', 'normative', o => ({ ...o, files: o.files.map(f => ({ ...f, state: 'BLOCKED' })) }), /normative job state BLOCKED/],
    ['a normative result without the file', 'normative', o => ({ ...o, files: [] }), /normative job result lacks/],
  ];
  for (const [name, which, mut, expected] of isoCases) {
    test(`D1-B sealing refuses ${name}`, () => {
      const { run, rec } = sealR05({ iso: (kind, o) => (kind === which ? mut(o) : o) });
      assert.equal(rec.result.gate, GATE.FAILED, rec.result.gate_reasons.join('\n')); assert.equal(run.status, 1);
      assert.ok(rec.result.gate_reasons.some(x => expected.test(x)), rec.result.gate_reasons.join('\n'));
    });
    test(`D1-B verify-evidence refuses ${name} even when the manifest is rebuilt`, () => {
      const { verify } = sealR05({ afterSeal: out => {
        const f = path.join(out, SEALED[which]); fs.writeFileSync(f, JSON.stringify(mut(JSON.parse(fs.readFileSync(f, 'utf8')))));
        const { files, file_count, schema, ...meta } = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')); writeManifest(out, meta);
      } });
      assert.equal(verify.status, 2, verify.stdout); assert.doesNotMatch(verify.stdout, /checksum mismatch|not covered by SHA256SUMS|manifest entry differs/);
      assert.ok(verify.stdout.split('\n').some(l => l.includes('FAIL') && expected.test(l)), verify.stdout);
    });
  }
  for (const name of ['stage-outputs.json', 'stage-record.json', 'inputs-seal.json', 'normative']) test(`D1-B a missing ${name} fails the gate (the seal job needs every isolated artefact)`, () => {
    const { rec } = sealR05({ omit: [name] }); assert.equal(rec.result.gate, GATE.FAILED, rec.result.gate_reasons.join('\n'));
  });
  test('D1-B the sealed classification takes the isolated file from the normative job, not from the runtime job; the merged record is attributed to it', () => {
    const { rec, out } = sealR05(); assert.equal(rec.result.gate, GATE.PASSED, rec.result.gate_reasons.join('\n'));
    const merged = JSON.parse(fs.readFileSync(path.join(out, 'raw', 'checks', 'full-regression-other', 'result.json'), 'utf8')).files.find(f => f.path === 'tests/gpr2-r01-normative-expectations.test.ts');
    assert.equal(merged.state, 'EXECUTED'); assert.equal(merged.executed_in, 'normative'); assert.deepEqual([merged.counts.tests, merged.counts.pass, merged.counts.skipped], [8, 8, 0]);
    for (const f of ['normative/result.json', 'stage-outputs.json', 'stage-record.json', 'inputs-seal.json']) assert.ok(fs.existsSync(path.join(out, f)), f);
    assert.equal(rec.result.checks.find(c => c.id === 'full-regression-inventory').status, S.PASS);
  });
  test('D1-B mergeIsolatedResults replaces only the DEFERRED entry of the isolated file', () => {
    const p = activated(); const d = tmp(); const cd = path.join(d, 'checks', 'full-regression-other'); fs.mkdirSync(cd, { recursive: true });
    const NORM = 'tests/gpr2-r01-normative-expectations.test.ts'; const other = p.checks.find(c => c.id === 'full-regression-other').files.find(f => f.path !== NORM).path;
    fs.writeFileSync(path.join(cd, 'result.json'), JSON.stringify({ state: 'EXECUTED', files: [{ path: NORM, state: 'DEFERRED' }, { path: other, state: 'EXECUTED', counts: { tests: 1 } }] }));
    assert.deepEqual(mergeIsolatedResults(d, p, { files: [{ path: NORM, state: 'EXECUTED', counts: { tests: 8 }, log: 'logs/x.log' }, { path: other, state: 'HIJACK' }] }), [NORM]);
    const res = JSON.parse(fs.readFileSync(path.join(cd, 'result.json'), 'utf8')); assert.equal(res.files[0].state, 'EXECUTED'); assert.equal(res.files[0].executed_in, 'normative'); assert.equal(res.files[1].state, 'EXECUTED'); assert.equal(res.files[1].counts.tests, 1);
  });
  test('a PostgreSQL teardown failure (or missing teardown evidence) is never a PASS', () => {
    const bad = sealR05({ cleanupRecord: { ...cleanup(), owned_processes_after: [{ pid: 551, role: 'postmaster' }] } });
    assert.equal(bad.rec.result.gate, GATE.FAILED); assert.equal(bad.rec.result.checks.find(c => c.id === 'postgres-cleanup').status, S.FAIL);
    const none = sealR05({ cleanupRecord: null });
    assert.equal(none.rec.result.checks.find(c => c.id === 'postgres-cleanup').status, S.NOT_RUN); assert.equal(none.rec.result.gate, GATE.INCONCLUSIVE);
  });
  for (const [name, tamper] of [['a removed evidence file', 'drop-file'], ['an unlisted extra file', 'extra-file'], ['an edited (incomplete) manifest', 'manifest-edit']])
    test(`verify-evidence rejects ${name}`, () => { const { verify } = sealR05({ tamper }); assert.equal(verify.status, 2, verify.stdout); assert.match(verify.stdout, /EVIDENCE INTEGRITY: FAILED/); });
  test('binding helper: no source -> no requirement; any mismatch is reported per phase', () => {
    assert.deepEqual(sourceBindingProblems({ sha: 'a', tree: 'b' }, {}), []);
    const source = { kind: 'git-bundle', repository: 'Shamil9586/construction-core-acceptance-evidence', commit: 'e'.repeat(40), path: 'x/c.bundle', blob: 'd'.repeat(40), bytes: 9, sha256: 'c'.repeat(64), ref: 'refs/heads/f', prerequisites: ['1'.repeat(40)] };
    const cand = { sha: 'a'.repeat(40), tree: 'b'.repeat(40), source }; const ctx = { profileId: 'p', profileSha256: '7'.repeat(64) };
    const mk = phase => ({ schema: RECORD_SCHEMA, phase, profile_id: 'p', profile_sha256: ctx.profileSha256, candidate_sha: cand.sha, ok: true, steps: REQUIRED_STEPS.map(step => ({ step, ok: true })), pin: sourcePin(source),
      observed: { bytes: 9, sha256: source.sha256, blob: source.blob }, candidate: { sha: cand.sha, tree: cand.tree } });
    const good = { authorize: mk('authorize'), runtime: mk('runtime'), seal: mk('seal') };
    assert.deepEqual(sourceBindingProblems(cand, good, ctx), []);
    assert.equal(sourceBindingProblems(cand, { ...good, runtime: { ...good.runtime, candidate: { sha: 'x', tree: cand.tree } }, seal: { ...good.seal, ok: false } }, ctx).length, 2);
    // the three weaknesses reproduced by the independent reviewer (F-CI-R05-01):
    const sameThrice = { authorize: good.authorize, runtime: good.authorize, seal: good.authorize };
    assert.equal(sourceBindingProblems(cand, sameThrice, ctx).length, 2, 'one authorize record in all three slots');
    assert.ok(sourceBindingProblems(cand, { ...good, runtime: { ...good.runtime, profile_sha256: '0'.repeat(64) } }, ctx).length >= 1, 'edited profile digest');
    assert.ok(sourceBindingProblems(cand, { ...good, runtime: { schema: RECORD_SCHEMA, ok: true, candidate: { sha: cand.sha, tree: cand.tree }, observed: good.runtime.observed } }, ctx).length >= 1, 'no phase / pin / steps / profile');
    // a missing profile context cannot bind anything (fail closed)
    assert.ok(sourceBindingProblems(cand, good).length >= 1); assert.ok(sourceBindingProblems(cand, good, {}).length >= 1);
  });
});

describe('D1-A/NORM: the normative documents are pinned external inputs — no skip, no waiver', () => {
  const crypto2 = crypto;
  const doc = (name, text) => { const d = tmp(); fs.writeFileSync(path.join(d, name), text); return { d, sha: sha256(Buffer.from(text)) }; };
  const NORM = 'tests/gpr2-r01-normative-expectations.test.ts';
  const normSpec = () => r05().checks.flatMap(c => c.files || []).find(f => f.path === NORM);
  test('the R05 TEMPLATE keeps the original criterion (145 files / 1258 tests, no skip anywhere) and pins exactly the two approved documents for the normative file only', () => {
    const p = r05(); const files = p.checks.flatMap(c => c.files || []);
    assert.deepEqual([p.full_regression.expect_files, p.full_regression.expect_tests, p.full_regression.expect_skipped], [145, 1258, undefined]);
    assert.ok(files.every(f => f.expect_skipped === undefined && f.skip_reason === undefined), 'no skip exception exists');
    assert.ok(p.checks.every(c => c.allow_skip !== true));
    assert.deepEqual(files.filter(f => f.external_inputs).map(f => f.path), [NORM]);
    assert.equal(normSpec().expect_tests, 8);
    assert.deepEqual(normSpec().external_inputs.map(x => [x.env, x.filename, x.sha256]), [
      ['GPR2_TD_PATH', 'Construction_Core_GPR-2_Final_Technical_Design_2026-10-15.md', 'b80ba7315509b9a011b87a45957f7e9a3eaf802624c1ca241f7072fab8879368'],
      ['GPR2_ROADMAP_PATH', 'Construction_Core_GPR-2_Implementation_Roadmap_2026-10-15.md', 'a4c27d19a731b0d32a70c75a14af4f04c289ff93007d4ed78fe308a6ab434f76']]);
    assert.equal(p.status, 'TEMPLATE'); assert.deepEqual(p.candidates, []);
  });
  test('the pins equal the hashes the repository itself pins (tests/helpers/gpr2-decision-index.ts)', () => {
    const src = fs.readFileSync(path.resolve(ACC, '..', '..', 'tests', 'helpers', 'gpr2-decision-index.ts'), 'utf8');
    const pinned = k => new RegExp(`export const ${k} = '([0-9a-f]{64})'`).exec(src)?.[1];
    const [td, rm] = normSpec().external_inputs;
    assert.equal(td.sha256, pinned('TD_SHA256')); assert.equal(rm.sha256, pinned('ROADMAP_SHA256'));
  });
  test('profile schema: external_inputs is strict (env name, plain file name, 64-hex digest, no duplicates, non-empty)', () => {
    const base = () => { const p = r05(); return { p, f: p.checks.flatMap(c => c.files || []).find(x => x.path === NORM) }; };
    for (const [mut, msg] of [[f => { f.external_inputs[0].env = 'PATH'; }, 'env must match'], [f => { f.external_inputs[0].filename = '../x.md'; }, 'filename must be a plain file name'],
      [f => { f.external_inputs[0].filename = '/etc/passwd'; }, 'filename must be a plain file name'], [f => { f.external_inputs[0].sha256 = 'ABC'; }, 'sha256 must be 64 lowercase hex'],
      [f => { f.external_inputs[1].env = 'GPR2_TD_PATH'; }, 'is listed twice'], [f => { f.external_inputs = []; }, 'must be a non-empty array'], [f => { f.external_inputs[0].url = 'https://x'; }, 'url']]) {
      const { p, f } = base(); mut(f); assert.ok(validateProfile(p).some(x => x.includes(msg)), msg);
    }
    const { p, f } = base(); f.expect_skipped = 1; assert.ok(validateProfile(p).length > 0, 'expect_skipped is no longer a valid key');
  });
  test('resolveExternalInputs: verified byte for byte; missing dir, missing file, same-size substitute, wrong content and symbolic links are refused', () => {
    const { d, sha } = doc('a.md', 'approved text');
    const spec = [{ env: 'GPR2_TD_PATH', filename: 'a.md', sha256: sha }];
    const ok = resolveExternalInputs(spec, d);
    assert.equal(ok.reason, undefined); assert.equal(ok.env.GPR2_TD_PATH, path.join(d, 'a.md')); assert.deepEqual(ok.records, [{ env: 'GPR2_TD_PATH', filename: 'a.md', sha256: sha, bytes: 13 }]);
    assert.deepEqual(resolveExternalInputs(undefined, d), { env: {}, records: [] });
    assert.match(resolveExternalInputs(spec, undefined).reason, /not supplied/); assert.match(resolveExternalInputs(spec, 'relative/dir').reason, /not supplied/);
    assert.match(resolveExternalInputs([{ ...spec[0], filename: 'b.md' }], d).reason, /missing or is not a regular file/);
    const swapped = doc('a.md', 'forged  text!');                      // same length (13 bytes), different content
    assert.match(resolveExternalInputs(spec, swapped.d).reason, /has sha256 .* pinned /);
    const lnk = tmp(); fs.writeFileSync(path.join(lnk, 'real.md'), 'approved text'); fs.symlinkSync(path.join(lnk, 'real.md'), path.join(lnk, 'a.md'));
    assert.match(resolveExternalInputs(spec, lnk).reason, /not a regular file/);
    const dirAsFile = tmp(); fs.mkdirSync(path.join(dirAsFile, 'a.md')); assert.match(resolveExternalInputs(spec, dirAsFile).reason, /not a regular file/);
  });
  test('the directory variable never reaches a candidate process (baseEnv scrubs GPR2_EXTERNAL_INPUTS_DIR)', () => {
    const before = process.env.GPR2_EXTERNAL_INPUTS_DIR; process.env.GPR2_EXTERNAL_INPUTS_DIR = '/x';
    try { assert.equal(baseEnv().GPR2_EXTERNAL_INPUTS_DIR, undefined); } finally { if (before === undefined) delete process.env.GPR2_EXTERNAL_INPUTS_DIR; else process.env.GPR2_EXTERNAL_INPUTS_DIR = before; }
  });
  test('classification: PASS only with 8/8 and the pinned documents on record; unsupplied documents are ENVIRONMENT BLOCKED, never a skip and never PASS', () => {
    const spec = normSpec(); const check = { file_timeout_seconds: 60 };
    const recOk = { path: NORM, state: 'EXECUTED', executed_in: 'normative', exit_code: 0, counts: { tests: 8, pass: 8, fail: 0, cancelled: 0, skipped: 0, todo: 0 }, external_inputs: spec.external_inputs.map(x => ({ env: x.env, filename: x.filename, sha256: x.sha256, bytes: 1 })) };
    assert.equal(classifyNodeFile(spec, recOk, check).status, S.PASS);
    const noRec = classifyNodeFile(spec, { ...recOk, external_inputs: undefined }, check); assert.equal(noRec.status, S.FAIL); assert.ok(noRec.reasons.some(x => x.includes('GPR2_TD_PATH')));
    const wrong = classifyNodeFile(spec, { ...recOk, external_inputs: recOk.external_inputs.map(x => ({ ...x, sha256: '1'.repeat(64) })) }, check); assert.equal(wrong.status, S.FAIL);
    const skipped = classifyNodeFile(spec, { ...recOk, counts: { tests: 8, pass: 7, fail: 0, cancelled: 0, skipped: 1, todo: 0 } }, check);
    assert.equal(skipped.status, S.FAIL); assert.ok(skipped.reasons.some(x => x.includes('unexpectedly skipped')), 'the old 7 pass + 1 skip outcome is a FAIL again');
    const blocked = classifyNodeFile(spec, { path: NORM, state: 'INPUT_UNVERIFIED', reason: 'not supplied' }, check); assert.equal(blocked.status, S.BLOCKED);
    const viaRuntime = classifyNodeFile(spec, { ...recOk, executed_in: undefined }, check); assert.equal(viaRuntime.status, S.FAIL); assert.ok(viaRuntime.reasons.some(x => x.includes('not produced by the isolated normative job')));
    const deferred = classifyNodeFile(spec, { path: NORM, state: 'DEFERRED', executed_in: 'normative' }, check); assert.equal(deferred.status, S.NOT_RUN); assert.equal(deferred.deferred, true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// D1-B PRIVATE-RUN: the isolated `normative` job, stage/seal provenance
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const TSX_OK = fs.existsSync(path.resolve(ACC, '..', '..', 'node_modules', 'tsx'));
const NODE_MODULES = TSX_OK ? fs.realpathSync(path.resolve(ACC, '..', '..', 'node_modules')) : null;
const open755 = dir => { for (let d = dir; d.startsWith(os.tmpdir()) && d !== os.tmpdir(); d = path.dirname(d)) fs.chmodSync(d, 0o755); };
const N_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
test('private document visible; unprivileged; no network; minimal environment', async () => {
  assert.equal(process.getuid(), 65534);
  assert.match(fs.readFileSync(process.env.GPR2_TD_PATH!, 'utf8'), /PRIVATE-TD/);
  assert.equal(process.env.GPR2_EXTERNAL_INPUTS_DIR, undefined); assert.equal(process.env.GITHUB_TOKEN, undefined); assert.equal(process.env.ACTIONS_RUNTIME_TOKEN, undefined);
  const code = await new Promise(r => { const s = net.connect({ host: '1.1.1.1', port: 443 }); s.on('error', (e: any) => r(e.code)); s.on('connect', () => r('CONNECTED')); });
  assert.notEqual(code, 'CONNECTED');
});
`;
/** A synthetic repo: base (public baseline) holds the closure; the candidate adds one more test. Profile pins the closure and a private document. */
function synthIso({ candidateChangesClosure = false } = {}) {
  const d = tmp(); const origin = path.join(d, 'origin'); const recv = path.join(d, 'recv');
  fs.mkdirSync(path.join(origin, 'tests'), { recursive: true }); git(origin, 'init', '-q');
  const files = { 'package.json': '{"name":"x","private":true}\n', 'package-lock.json': '{}\n', 'tests/n.test.ts': N_TEST, 'tests/o.test.ts': 'o\n' };
  for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(origin, f), t);
  git(origin, 'add', '-A'); git(origin, 'commit', '-q', '-m', 'base');
  const base = git(origin, 'rev-parse', 'HEAD'); execFileSync('git', ['clone', '-q', '--no-local', origin, recv]);
  git(origin, 'checkout', '-q', '-b', 'feature/stage');
  fs.writeFileSync(path.join(origin, 'tests', 'p.test.ts'), 'p\n'); if (candidateChangesClosure) fs.writeFileSync(path.join(origin, 'tests', 'n.test.ts'), N_TEST + '// changed by the candidate\n');
  git(origin, 'add', '-A'); git(origin, 'commit', '-q', '-m', 'cand');
  const cand = git(origin, 'rev-parse', 'HEAD'), tree = git(origin, 'rev-parse', 'HEAD^{tree}');
  const bundle = path.join(d, 'candidate.bundle'); git(origin, 'bundle', 'create', '-q', bundle, `${base}..feature/stage`); const buf = fs.readFileSync(bundle);
  const docs = path.join(d, 'docs'); fs.mkdirSync(docs); fs.writeFileSync(path.join(docs, 'td.md'), 'PRIVATE-TD text'); const docSha = sha256(Buffer.from('PRIVATE-TD text'));
  const profile = {
    schema: 'construction-core/gpr2-acceptance-profile@1', profile_id: 'synthetic-iso', stage: 'R05', title: 'synthetic', status: 'ACTIVE', baseline: { sha: base, tree: git(origin, 'rev-parse', `${base}^{tree}`) },
    candidates: [{ sha: cand, tree, lineage: [{ rev: 'HEAD^', sha: base, tree: git(origin, 'rev-parse', `${base}^{tree}`) }], diff_check_from: base, approval: 'synthetic test candidate', source: { kind: 'git-bundle', repository: 'Shamil9586/construction-core-acceptance-evidence', commit: 'a'.repeat(40), path: 'x/candidate.bundle',
      blob: gitBlobId(buf), bytes: buf.length, sha256: sha256(buf), ref: 'refs/heads/feature/stage', prerequisites: [base] } }],
    runtime: { runner: 'ubuntu-24.04', node: '22.22.0', postgres_major: 16, job_timeout_minutes: 30, requires: [] },
    checks: [{ id: 'unit', title: 'u', class: 'UNIT', kind: 'node-test', mandatory: true, requires: [], allow_skip: false, fresh_database_per_file: false, file_timeout_seconds: 60, files: [
      { path: 'tests/n.test.ts', expect_tests: 1, external_inputs: [{ env: 'GPR2_TD_PATH', filename: 'td.md', sha256: docSha }],
        isolated: { job: 'normative', closure: ['package.json', 'package-lock.json', 'tests/n.test.ts'].map(f => ({ path: f, blob: gitBlobId(Buffer.from(files[f])) })) } },
      { path: 'tests/o.test.ts', expect_tests: 1 }, { path: 'tests/p.test.ts', expect_tests: 1 }] }],
    full_regression: { inventory: 'tests/*.test.ts', checks: ['unit'], expect_files: 3, expect_tests: 3 },
  };
  assert.deepEqual(validateProfile(profile), []);
  return { d, origin, recv, base, cand, tree, bundle, docs, profile, docSha, files };
}
const profSha = p => sha256(Buffer.from(JSON.stringify(p)));

describe('D1-B isolated files: profile schema', () => {
  const mutate = f => { const p = r05(); const file = p.checks.flatMap(c => c.files || []).find(x => x.path === 'tests/gpr2-r01-normative-expectations.test.ts'); f(file, p); return validateProfile(p); };
  test('the R05 TEMPLATE isolates exactly the normative file in the normative job, with the 8-file closure pinned by Git blob', () => {
    const p = r05(); const iso = p.checks.flatMap(c => c.files || []).filter(f => f.isolated);
    assert.deepEqual(iso.map(f => [f.path, f.isolated.job, f.isolated.closure.length]), [['tests/gpr2-r01-normative-expectations.test.ts', 'normative', 8]]);
    assert.deepEqual(validateProfile(p), []);
  });
  for (const [name, f, needle] of [
    ['external_inputs without isolated', file => { delete file.isolated; }, 'must be declared together'],
    ['isolated without external_inputs', file => { delete file.external_inputs; }, 'must be declared together'],
    ['an unknown job', file => { file.isolated.job = 'runtime'; }, 'job must be one of'],
    ['an empty closure', file => { file.isolated.closure = []; }, 'closure must list'],
    ['a closure without the test itself', file => { file.isolated.closure = file.isolated.closure.filter(x => x.path !== file.path); }, `closure must include ${'tests/gpr2-r01-normative-expectations.test.ts'}`],
    ['a closure without package-lock.json', file => { file.isolated.closure = file.isolated.closure.filter(x => x.path !== 'package-lock.json'); }, 'closure must include package-lock.json'],
    ['a traversing closure path', file => { file.isolated.closure[1].path = '../x'; }, 'plain repository path'],
    ['a malformed blob', file => { file.isolated.closure[1].blob = 'zz'; }, 'blob must be a 40-hex'],
    ['a duplicated closure path', file => { file.isolated.closure.push({ ...file.isolated.closure[0] }); }, 'listed twice'],
    ['an unknown key', file => { file.isolated.network = true; }, 'network'],
  ]) test(`rejects ${name}`, () => assert.ok(mutate(f).some(x => x.includes(needle)), needle));
});

describe('D1-B stage-inputs.mjs: private inputs verified from the private source (stage and seal jobs)', () => {
  const inputs = (s, over = {}) => computeInputs({ profile: s.profile, profileSha256: profSha(s.profile), candidateSha: s.cand, bundle: s.bundle, docsDir: s.docs, repo: s.recv, harnessSha: 'a'.repeat(40), ...over });
  test('verifies bundle, documents and the closure in both candidate and baseline; the digest equals the digest derived from the profile pins alone', () => {
    const s = synthIso(); const r = inputs(s);
    assert.equal(r.ok, true, r.refusals.join('\n'));
    assert.equal(r.inputs_digest, digestOf(expectedCore(s.profile, s.profile.candidates[0], profSha(s.profile))));
    assert.deepEqual(r.isolated[0].closure.map(x => [x.path, x.blob === x.candidate_blob && x.blob === x.baseline_blob]), [['package.json', true], ['package-lock.json', true], ['tests/n.test.ts', true]]);
    assert.deepEqual(isolatedProvenanceProblems({ profile: s.profile, cand: s.profile.candidates[0], profileSha256: profSha(s.profile), stageOutputs: { inputs_digest: r.inputs_digest, candidate_sha: s.cand }, stageRecord: r, sealRecord: r,
      normative: null }).filter(x => !x.includes('normative job result missing')), []);
  });
  test('refuses a wrong document (same size), a missing document, a missing bundle and a corrupted bundle', () => {
    const s = synthIso(); fs.writeFileSync(path.join(s.docs, 'td.md'), 'PRIVATE-XX text');
    assert.ok(inputs(s).refusals.some(x => x.includes('has sha256')));
    fs.rmSync(path.join(s.docs, 'td.md')); assert.ok(inputs(s).refusals.some(x => x.includes('missing or is not a regular file')));
    const t = synthIso(); assert.ok(inputs(t, { bundle: path.join(t.d, 'nope.bundle') }).refusals.some(x => x.startsWith('bundle:')));
    const u = synthIso(); const bad = Buffer.from(u.profile.candidates[0] && fs.readFileSync(u.bundle)); bad[bad.length - 5] ^= 0xff; fs.writeFileSync(u.bundle, bad);
    assert.equal(inputs(u).ok, false);
  });
  test('refuses a candidate whose closure differs from the pinned blobs (code that could read the documents), and a baseline that differs', () => {
    const s = synthIso({ candidateChangesClosure: true }); const r = inputs(s);
    assert.equal(r.ok, false); assert.ok(r.refusals.some(x => x.includes('tests/n.test.ts has blob') && x.includes('in the candidate')), r.refusals.join('\n'));
    assert.ok(!r.refusals.some(x => x.includes('in the public baseline')), 'the baseline still equals the pin');
    const t = synthIso(); t.profile.checks[0].files[0].isolated.closure[2].blob = '1'.repeat(40);
    const q = inputs(t); assert.ok(q.refusals.some(x => x.includes('in the public baseline')) && q.refusals.some(x => x.includes('in the candidate')));
  });
});

describe('D1-B run-normative.mjs: prepare (no documents) and run (sandbox)', () => {
  const sandboxOk = TSX_OK && (() => { const r = spawnSync('bash', ['-c', process.getuid() === 0 ? 'unshare -n true && command -v setpriv' : 'sudo -n unshare -n true && command -v setpriv'], { encoding: 'utf8' }); return r.status === 0; })();
  const opts = { skip: !sandboxOk && 'needs tsx in node_modules, unshare, setpriv and root or passwordless sudo' };
  const work = s => { const w = path.join(s.d, 'work'); fs.mkdirSync(w); return w; };
  const prepared = s => { const w = work(s); const base = path.join(s.d, 'base'); fs.mkdirSync(path.join(base, 'tests'), { recursive: true });
    for (const [f, t] of Object.entries(s.files)) { fs.mkdirSync(path.dirname(path.join(base, f)), { recursive: true }); fs.writeFileSync(path.join(base, f), t); }
    const r = prepareClosure({ profile: s.profile, base, work: w }); assert.equal(r.ok, true, r.refusals.join('\n'));
    if (TSX_OK) fs.symlinkSync(NODE_MODULES, path.join(w, 'node_modules')); open755(s.d); spawnSync('chmod', ['-R', 'a+rX', s.d]); return { w, base }; };
  test('prepareClosure copies only pinned files and refuses a changed, missing or linked file (the baseline checkout is not trusted)', () => {
    const s = synthIso(); const { w, base } = (() => { const w2 = work(s); return { w: w2, base: path.join(s.d, 'base') }; })();
    fs.mkdirSync(path.join(base, 'tests'), { recursive: true }); for (const [f, t] of Object.entries(s.files)) fs.writeFileSync(path.join(base, f), t);
    assert.equal(prepareClosure({ profile: s.profile, base, work: w }).ok, true);
    assert.deepEqual(fs.readdirSync(w).sort(), ['package-lock.json', 'package.json', 'tests'], 'only the closure, not o.test.ts or anything else');
    assert.deepEqual(fs.readdirSync(path.join(w, 'tests')), ['n.test.ts']);
    fs.writeFileSync(path.join(base, 'tests', 'n.test.ts'), N_TEST + '//x'); assert.ok(prepareClosure({ profile: s.profile, base, work: w }).refusals.some(x => x.includes('pinned')));
    fs.rmSync(path.join(base, 'tests', 'n.test.ts')); assert.ok(prepareClosure({ profile: s.profile, base, work: w }).refusals.some(x => x.includes('missing or not a regular file')));
    fs.symlinkSync(path.join(base, 'package.json'), path.join(base, 'tests', 'n.test.ts')); assert.ok(prepareClosure({ profile: s.profile, base, work: w }).refusals.some(x => x.includes('not a regular file')));
  });
  test('sandboxCommand: empty network namespace, dropped uid/gid, no new privileges, exactly the given environment; sudo only when not root', () => {
    const c = sandboxCommand({ argv: ['node', 'x'], env: { A: '1' }, root: true });
    assert.deepEqual(c, ['unshare', '-n', 'setpriv', `--reuid=${SANDBOX_UID}`, `--regid=${SANDBOX_UID}`, '--clear-groups', '--no-new-privs', 'env', '-i', 'A=1', 'node', 'x']);
    assert.deepEqual(sandboxCommand({ argv: ['node'], env: {}, root: false }).slice(0, 3), ['sudo', '-n', 'unshare']);
  });
  test('the unchanged-style test runs 1/1 in the sandbox: private document readable, uid 65534, no network, no tokens or directory variable in its environment', opts, () => {
    const s = synthIso(); const { w } = prepared(s);
    const out = path.join(s.d, 'out'); const save = { ...process.env };
    Object.assign(process.env, { GITHUB_TOKEN: 'secret', ACTIONS_RUNTIME_TOKEN: 'secret', GPR2_EXTERNAL_INPUTS_DIR: s.docs });
    try {
      const r = runIsolated({ profile: s.profile, profileSha256: profSha(s.profile), candidateSha: s.cand, work: w, docsDir: s.docs, out, timeoutSec: 120 });
      const f = r.files[0];
      assert.equal(f.state, 'EXECUTED', JSON.stringify(f).slice(0, 400)); assert.equal(f.exit_code, 0, fs.readFileSync(path.join(out, f.log), 'utf8'));
      assert.deepEqual([f.counts.tests, f.counts.pass, f.counts.skipped], [1, 1, 0]);
      assert.deepEqual(f.sandbox, { network: 'none', uid: SANDBOX_UID, env: 'minimal', probe_ok: true, probe: f.sandbox.probe }); assert.equal(f.sandbox.probe.connect.startsWith('E'), true);
      assert.deepEqual(f.external_inputs.map(x => [x.env, x.sha256]), [['GPR2_TD_PATH', s.docSha]]);
      assert.deepEqual(f.closure_verified.map(x => x.path), ['package.json', 'package-lock.json', 'tests/n.test.ts']);
      assert.ok(!fs.readFileSync(path.join(out, f.log), 'utf8').includes('PRIVATE-TD'), 'document text is not printed into the log');
    } finally { for (const k of ['GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'GPR2_EXTERNAL_INPUTS_DIR']) if (save[k] === undefined) delete process.env[k]; else process.env[k] = save[k]; }
  });
  test('refusals are BLOCKED / INPUT_UNVERIFIED, never a skip: wrong document, missing document, closure file changed after prepare, sandbox unavailable', opts, () => {
    const s = synthIso(); const { w } = prepared(s); const go = (o = {}) => runIsolated({ profile: s.profile, profileSha256: profSha(s.profile), candidateSha: s.cand, work: w, docsDir: s.docs, out: path.join(s.d, 'o' + Math.random()), timeoutSec: 60, ...o }).files[0];
    fs.writeFileSync(path.join(s.docs, 'td.md'), 'PRIVATE-XX text'); assert.equal(go().state, 'INPUT_UNVERIFIED'); fs.writeFileSync(path.join(s.docs, 'td.md'), 'PRIVATE-TD text');
    assert.equal(go({ docsDir: path.join(s.d, 'nodocs') }).state, 'INPUT_UNVERIFIED');
    fs.writeFileSync(path.join(w, 'tests', 'n.test.ts'), N_TEST + '//tampered'); const t = go(); assert.equal(t.state, 'BLOCKED'); assert.match(t.reason, /differ from the pinned blobs/); fs.writeFileSync(path.join(w, 'tests', 'n.test.ts'), N_TEST);
    const savePath = process.env.PATH; process.env.PATH = '/nonexistent'; try { const b = go(); assert.equal(b.state, 'BLOCKED'); assert.equal(b.sandbox.probe_ok, false); } finally { process.env.PATH = savePath; }
  });
  test('a failing test in the sandbox is reported as such (non-zero exit, counts), never hidden', opts, () => {
    const s = synthIso(); s.files['tests/n.test.ts'] = N_TEST.replace('/PRIVATE-TD/', '/NOT-IN-THE-DOCUMENT/'); const blob = gitBlobId(Buffer.from(s.files['tests/n.test.ts']));
    s.profile.checks[0].files[0].isolated.closure.find(x => x.path === 'tests/n.test.ts').blob = blob; const { w } = prepared(s);
    const f = runIsolated({ profile: s.profile, profileSha256: profSha(s.profile), candidateSha: s.cand, work: w, docsDir: s.docs, out: path.join(s.d, 'out'), timeoutSec: 60 }).files[0];
    assert.equal(f.state, 'EXECUTED'); assert.notEqual(f.exit_code, 0); assert.equal(f.counts.fail, 1);
  });
});

describe('D1-B runtime job: the isolated file is never executed there', () => {
  test('run-profile.mjs records DEFERRED for the isolated file, executes the others, and does not fail its preliminary gate for the deferral', { skip: !TSX_OK && 'needs tsx' }, () => {
    const s = synthIso(); const core = path.join(s.d, 'core'); fs.mkdirSync(path.join(core, 'tests'), { recursive: true });
    for (const f of ['n', 'o', 'p']) fs.writeFileSync(path.join(core, 'tests', `${f}.test.ts`), f === 'n' ? "throw new Error('the isolated file must never run in the runtime job');\n" : "import { test } from 'node:test'; test('t', () => {});\n");
    fs.symlinkSync(NODE_MODULES, path.join(core, 'node_modules'));
    git(core, 'init', '-q'); fs.writeFileSync(path.join(core, '.gitignore'), 'node_modules\n'); git(core, 'add', '-A'); git(core, 'commit', '-q', '-m', 'core');
    const pf = path.join(s.d, 'synthetic-iso.json'); fs.writeFileSync(pf, JSON.stringify(s.profile)); const out = path.join(s.d, 'raw');
    const r = spawnSync('node', [path.join(LIB, 'run-profile.mjs'), '--profile', pf, '--core', core, '--out', out], { encoding: 'utf8',
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NODE_TEST'))), GPR2_ENV_DEPS: 'success', GPR2_ENV_POSTGRES: 'skipped', GPR2_ENV_CHROMIUM: 'skipped', GPR2_EXTERNAL_INPUTS_DIR: s.docs } });
    const res = JSON.parse(fs.readFileSync(path.join(out, 'checks', 'unit', 'result.json'), 'utf8'));
    assert.deepEqual(res.files.map(f => [f.path, f.state]), [['tests/n.test.ts', 'DEFERRED'], ['tests/o.test.ts', 'EXECUTED'], ['tests/p.test.ts', 'EXECUTED']]);
    assert.equal(res.files[0].executed_in, 'normative'); assert.equal(res.files[0].counts, undefined);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

describe('read-only merge-tree rehearsal (merge-tree.mjs)', () => {
  function threeWay() {
    const d = tmp(); const r = path.join(d, 'repo'); fs.mkdirSync(r); git(r, 'init', '-q');
    const w = (f, t) => { fs.mkdirSync(path.dirname(path.join(r, f)), { recursive: true }); fs.writeFileSync(path.join(r, f), t); };
    w('src/registry.ts', 'a\nb\nc\nd\ne\nf\ng\n'); w('tests/scan.ts', 'header\nline\n'); git(r, 'add', '-A'); git(r, 'commit', '-q', '-m', 'base');
    const base = git(r, 'rev-parse', 'HEAD');
    w('docs/x.md', 'main\n'); git(r, 'add', '-A'); git(r, 'commit', '-q', '-m', 'main'); const main = git(r, 'rev-parse', 'HEAD');
    git(r, 'checkout', '-q', '-b', 'cand', base); w('src/registry.ts', 'a\nCAND\nc\nd\ne\nf\ng\n'); w('tests/scan.ts', 'header cand\nline\n'); git(r, 'add', '-A'); git(r, 'commit', '-q', '-m', 'cand');
    const cand = git(r, 'rev-parse', 'HEAD');
    git(r, 'checkout', '-q', '-b', 'fin', main); w('src/registry.ts', 'a\nb\nc\nd\ne\nFIN\ng\n'); w('tests/scan.ts', 'header fin\nline\n'); git(r, 'add', '-A'); git(r, 'commit', '-q', '-m', 'fin');
    const fin = git(r, 'rev-parse', 'HEAD');
    git(r, 'checkout', '-q', 'main');
    return { d, r, main, cand, fin };
  }
  test('reports clean and conflicting pairs, merged blobs of watched paths, and leaves refs, objects and worktree untouched', () => {
    const t = threeWay(); const out = path.join(t.d, 'out');
    const res = rehearse({ repo: t.r, commits: { main: t.main, r05: t.cand, fin: t.fin }, watch: ['src/registry.ts', 'tests/scan.ts'], outDir: out });
    assert.equal(res.ok, true, res.problems.join('\n'));
    assert.equal(res.read_only.untouched, true);
    const byId = Object.fromEntries(res.pairs.map(p => [p.id, p]));
    assert.equal(byId['main+r05'].outcome, 'CLEAN'); assert.equal(byId['main+fin'].outcome, 'CLEAN');
    assert.equal(byId['r05+fin'].outcome, 'CONFLICT'); assert.deepEqual(byId['r05+fin'].conflicted_paths, ['tests/scan.ts']);
    assert.deepEqual(byId['r05+fin'].both_changed, ['src/registry.ts', 'tests/scan.ts']);
    const reg = byId['r05+fin'].watched.find(w => w.path === 'src/registry.ts'); assert.equal(reg.conflicted, false); assert.ok(reg.result && reg.result !== reg.r05 && reg.result !== reg.fin);
    assert.ok(res.ancestry.some(a => a.ancestor === 'main' && a.descendant === 'fin' && a.is_ancestor));
    assert.match(fs.readFileSync(path.join(out, 'r05+fin.tests_scan.ts.merged'), 'utf8'), /^<<<<<<< /m);
    assert.equal(spawnSync('git', ['-C', t.r, 'cat-file', '-e', `${byId['main+r05'].result_tree}^{tree}`]).status === 0, false, 'the simulated tree must not be written into the repository');
    assert.equal(git(t.r, 'branch', '--list').split('\n').length, 3, 'no branch was created');
  });
  test('refuses malformed and unknown commits without touching the repository', () => {
    const t = threeWay();
    assert.equal(rehearse({ repo: t.r, commits: { main: 'main', r05: t.cand }, outDir: path.join(t.d, 'o1') }).ok, false);
    assert.equal(rehearse({ repo: t.r, commits: { main: t.main }, outDir: path.join(t.d, 'o2') }).ok, false);
    assert.equal(rehearse({ repo: t.r, commits: { main: t.main, r05: t.cand }, watch: ['../etc/passwd'], outDir: path.join(t.d, 'o3') }).ok, false);
    const r = rehearse({ repo: t.r, commits: { main: t.main, r05: 'f'.repeat(40) }, outDir: path.join(t.d, 'o4') });
    assert.equal(r.ok, false); assert.ok(r.problems.some(x => x.includes('not present')));
  });
  test('parses merge-tree output', () => {
    assert.deepEqual(parseMergeTree(`${'a'.repeat(40)}\nx.ts\nx.ts\n\nAuto-merging x.ts\nCONFLICT (content): Merge conflict in x.ts\n`),
      { tree: 'a'.repeat(40), conflicted_paths: ['x.ts'], messages: ['Auto-merging x.ts', 'CONFLICT (content): Merge conflict in x.ts'] });
    assert.deepEqual(parseMergeTree(`${'b'.repeat(40)}\n`), { tree: 'b'.repeat(40), conflicted_paths: [], messages: [] });
  });
});
