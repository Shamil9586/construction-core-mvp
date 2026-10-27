#!/usr/bin/env node
// Construction Core — GPR-2 CI Foundation: acceptance profile loader and strict validator.
//
// A profile (.github/acceptance/profiles/<id>.json) is the ONLY place where a stage's candidate allowlist and required checks live.
// Profiles are reviewed through a pull request and read from the exact workflow commit (github.sha) — never from the candidate.
// Validation is deliberately strict: unknown keys, unexpected types, path traversal and free-form commands are rejected.
//
// CLI:
//   node profile.mjs validate <profile.json>            -> exit 0 / 2, prints the problems
//   node profile.mjs validate-all <profiles-dir>        -> validates every *.json (templates included)
//   node profile.mjs get <profile.json> <dotted.path>   -> prints a scalar (or compact JSON)
// Library: loadProfile(file), validateProfile(obj, {fileName}), findCandidate(profile, sha)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const SCHEMA_ID = 'construction-core/gpr2-acceptance-profile@1';
export const PROFILE_STATUSES = ['ACTIVE', 'TEMPLATE', 'RETIRED'];
export const CHECK_KINDS = ['node-test', 'playwright', 'npm-script'];
export const CHECK_CLASSES = ['NATIVE_POSTGRESQL', 'PURE_PGLITE', 'UNIT', 'BROWSER_CHROMIUM', 'TYPECHECK_BUILD', 'MIGRATION'];
export const REQUIREMENTS = ['postgres', 'chromium'];
export const RUNNERS = ['ubuntu-24.04'];
// A candidate that is not reachable in this repository may be restored from an archived Git bundle. Only these archive repositories may be named;
// the bundle is pinned by archive commit, path, Git blob, byte size and SHA-256, and its single ref and prerequisites are pinned too (source-bundle.mjs).
export const SOURCE_KINDS = ['git-bundle'];
export const SOURCE_REPOSITORIES = ['Shamil9586/construction-core-acceptance-evidence'];
// full_regression.inventory: the candidate test set the listed checks must cover exactly (the files `npm test` globs: tests/*.test.ts, top level only).
export const INVENTORIES = ['tests/*.test.ts'];

const SHA = /^[0-9a-f]{40}$/;
const ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const STAGE = /^(R[0-9]{2}[a-z]?|GPR2-[A-Z0-9-]{1,30})$/;
const REV = /^HEAD((\^[12]?)|(~[0-9]{1,2}))*$/;
const TEST_FILE = /^tests\/(?!.*\.\.)[A-Za-z0-9._\/-]+\.test\.ts$/;
const PW_CONFIG = /^playwright\.[A-Za-z0-9._-]+\.config\.ts$/;
const NPM_SCRIPT = /^[a-z0-9][a-z0-9:._-]{0,40}$/;
const NODE_VERSION = /^[0-9]{2}\.[0-9]{1,2}\.[0-9]{1,2}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const EXTERNAL_ENV = /^GPR2_[A-Z0-9_]{2,40}$/;
const EXTERNAL_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;
const BUNDLE_PATH = /^(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._\/-]{1,300}\.bundle$/;
const BUNDLE_REF = /^refs\/heads\/(?!.*\.\.)(?!.*\/\/)(?!.*\/$)[A-Za-z0-9._\/-]{1,200}$/;
const TOP_LEVEL_TEST = /^tests\/[A-Za-z0-9._-]+\.test\.ts$/;

function keys(obj, allowed, where, errors) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) { errors.push(`${where}: must be an object`); return false; }
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${where}: unknown key "${k}"`);
  return true;
}
const isStr = (v, re) => typeof v === 'string' && (!re || re.test(v));
const isInt = (v, min = 0, max = 100000) => Number.isInteger(v) && v >= min && v <= max;

function validateSource(s, w, e) {
  if (!keys(s, ['kind', 'repository', 'commit', 'path', 'blob', 'bytes', 'sha256', 'ref', 'prerequisites'], w, e)) return;
  if (!SOURCE_KINDS.includes(s.kind)) e.push(`${w}.kind must be one of ${SOURCE_KINDS.join('|')}`);
  if (!SOURCE_REPOSITORIES.includes(s.repository)) e.push(`${w}.repository must be one of ${SOURCE_REPOSITORIES.join('|')}`);
  if (!isStr(s.commit, SHA)) e.push(`${w}.commit must be the full 40-hex archive commit SHA`);
  if (!isStr(s.path, BUNDLE_PATH)) e.push(`${w}.path must be a relative *.bundle path without ".." or "//"`);
  if (!isStr(s.blob, SHA)) e.push(`${w}.blob must be the full 40-hex Git blob SHA of the bundle`);
  if (!isInt(s.bytes, 1, 50 * 1024 * 1024)) e.push(`${w}.bytes must be the exact bundle size (1..50 MiB)`);
  if (!isStr(s.sha256, SHA256)) e.push(`${w}.sha256 must be a lowercase 64-hex SHA-256`);
  if (!isStr(s.ref, BUNDLE_REF)) e.push(`${w}.ref must be a refs/heads/<name> ref without ".."`);
  if (!Array.isArray(s.prerequisites) || s.prerequisites.length < 1 || !s.prerequisites.every(x => isStr(x, SHA))) e.push(`${w}.prerequisites must list the full SHA of every bundle prerequisite`);
  else if (new Set(s.prerequisites).size !== s.prerequisites.length) e.push(`${w}.prerequisites are duplicated`);
}

function validateCandidates(list, label, e) {
  const seen = new Set();
  list.forEach((c, i) => {
    const w = `${label}[${i}]`;
    if (!keys(c, ['sha', 'tree', 'lineage', 'diff_check_from', 'approval', 'source'], w, e)) return;
    if (!isStr(c.sha, SHA)) e.push(`${w}.sha must be a full 40-hex SHA`);
    if (!isStr(c.tree, SHA)) e.push(`${w}.tree must be a full 40-hex SHA`);
    if (seen.has(c.sha)) e.push(`${w}.sha is duplicated`); seen.add(c.sha);
    if (!isStr(c.approval) || c.approval.length < 10) e.push(`${w}.approval must reference the owner decision that registered it`);
    if (c.diff_check_from !== undefined && !isStr(c.diff_check_from, SHA)) e.push(`${w}.diff_check_from must be a full SHA`);
    if (c.source !== undefined) validateSource(c.source, `${w}.source`, e);
    if (!Array.isArray(c.lineage) || c.lineage.length < 1) e.push(`${w}.lineage must pin at least the first parent`);
    else c.lineage.forEach((l, j) => {
      const lw = `${w}.lineage[${j}]`;
      if (!keys(l, ['rev', 'sha', 'tree'], lw, e)) return;
      if (!isStr(l.rev, REV) || l.rev === 'HEAD') e.push(`${lw}.rev must be a HEAD-relative ancestor expression (e.g. HEAD^, HEAD~2, HEAD^2)`);
      if (!isStr(l.sha, SHA)) e.push(`${lw}.sha must be a full SHA`);
      if (!isStr(l.tree, SHA)) e.push(`${lw}.tree must be a full SHA`);
    });
  });
}

export function validateProfile(p, { fileName } = {}) {
  const e = [];
  if (!keys(p, ['$comment', 'schema', 'profile_id', 'stage', 'title', 'status', 'baseline', 'candidates', 'proposed_candidates', 'runtime', 'checks', 'full_regression', 'notes'], 'profile', e)) return e;
  if (p.schema !== SCHEMA_ID) e.push(`schema must be "${SCHEMA_ID}"`);
  if (!isStr(p.profile_id, ID)) e.push('profile_id must match ' + ID);
  if (fileName && path.basename(fileName) !== `${p.profile_id}.json`) e.push(`file name must be ${p.profile_id}.json`);
  if (!isStr(p.stage, STAGE)) e.push('stage must match ' + STAGE);
  if (!isStr(p.title) || p.title.length > 200) e.push('title must be a string (<=200 chars)');
  if (!PROFILE_STATUSES.includes(p.status)) e.push('status must be one of ' + PROFILE_STATUSES.join('|'));
  if (p.notes !== undefined && !(Array.isArray(p.notes) && p.notes.every(n => isStr(n)))) e.push('notes must be an array of strings');

  if (keys(p.baseline, ['sha', 'tree', 'description'], 'baseline', e)) {
    if (!isStr(p.baseline.sha, SHA)) e.push('baseline.sha must be a full 40-hex SHA');
    if (!isStr(p.baseline.tree, SHA)) e.push('baseline.tree must be a full 40-hex SHA');
  }

  if (!Array.isArray(p.candidates)) e.push('candidates must be an array');
  else {
    if (p.status === 'ACTIVE' && p.candidates.length === 0) e.push('an ACTIVE profile needs at least one approved candidate');
    if (p.status === 'TEMPLATE' && p.candidates.length !== 0) e.push('a TEMPLATE profile must not list candidates');
    validateCandidates(p.candidates, 'candidates', e);
  }
  // proposed_candidates: the exact identity a TEMPLATE profile is being reviewed for. Never read by authorize/identity (findCandidate looks at
  // `candidates` only), so a proposal cannot run; activation moves it to `candidates` and sets ACTIVE in a separately approved, reviewed PR.
  if (p.proposed_candidates !== undefined) {
    if (p.status !== 'TEMPLATE') e.push('proposed_candidates are allowed only in a TEMPLATE profile');
    if (!Array.isArray(p.proposed_candidates) || p.proposed_candidates.length === 0) e.push('proposed_candidates must be a non-empty array when present');
    else validateCandidates(p.proposed_candidates, 'proposed_candidates', e);
  }

  if (keys(p.runtime, ['runner', 'node', 'postgres_major', 'job_timeout_minutes', 'requires'], 'runtime', e)) {
    const r = p.runtime;
    if (!RUNNERS.includes(r.runner)) e.push('runtime.runner must be one of ' + RUNNERS.join('|'));
    if (!isStr(r.node, NODE_VERSION)) e.push('runtime.node must be an exact x.y.z version');
    if (!isInt(r.postgres_major, 14, 18)) e.push('runtime.postgres_major must be an integer 14..18');
    if (!isInt(r.job_timeout_minutes, 10, 180)) e.push('runtime.job_timeout_minutes must be 10..180');
    if (!Array.isArray(r.requires) || !r.requires.every(x => REQUIREMENTS.includes(x))) e.push('runtime.requires must list only ' + REQUIREMENTS.join('|'));
  }

  if (!Array.isArray(p.checks) || p.checks.length === 0) e.push('checks must be a non-empty array');
  else {
    const ids = new Set();
    const allFiles = new Set();
    p.checks.forEach((c, i) => {
      const w = `checks[${i}]`;
      if (!keys(c, ['id', 'title', 'class', 'kind', 'mandatory', 'requires', 'allow_skip', 'files', 'file_timeout_seconds', 'fresh_database_per_file', 'config', 'expect_passed', 'script', 'timeout_seconds'], w, e)) return;
      if (!isStr(c.id, ID)) e.push(`${w}.id must match ${ID}`);
      if (ids.has(c.id)) e.push(`${w}.id is duplicated`); ids.add(c.id);
      if (!isStr(c.title)) e.push(`${w}.title must be a string`);
      if (!CHECK_CLASSES.includes(c.class)) e.push(`${w}.class must be one of ${CHECK_CLASSES.join('|')}`);
      if (!CHECK_KINDS.includes(c.kind)) e.push(`${w}.kind must be one of ${CHECK_KINDS.join('|')}`);
      if (typeof c.mandatory !== 'boolean') e.push(`${w}.mandatory must be boolean`);
      if (c.allow_skip !== undefined && typeof c.allow_skip !== 'boolean') e.push(`${w}.allow_skip must be boolean`);
      if (c.mandatory === true && c.allow_skip === true) e.push(`${w}: a mandatory check may not allow skipped tests`);
      if (!Array.isArray(c.requires) || !c.requires.every(x => REQUIREMENTS.includes(x))) e.push(`${w}.requires must list only ${REQUIREMENTS.join('|')}`);
      else if (p.runtime && Array.isArray(p.runtime.requires)) for (const x of c.requires) if (!p.runtime.requires.includes(x)) e.push(`${w}.requires "${x}" is not provisioned by runtime.requires`);
      if (c.kind === 'node-test') {
        if (!Array.isArray(c.files) || c.files.length === 0) e.push(`${w}.files must be a non-empty array`);
        else c.files.forEach((f, j) => {
          const fw = `${w}.files[${j}]`;
          if (!keys(f, ['path', 'expect_tests', 'external_inputs'], fw, e)) return;
          if (!isStr(f.path, TEST_FILE)) e.push(`${fw}.path must be a tests/**/*.test.ts path without ".."`);
          if (allFiles.has(f.path)) e.push(`${fw}.path is listed twice in this profile`); allFiles.add(f.path);
          if (!isInt(f.expect_tests, 1, 5000)) e.push(`${fw}.expect_tests must be an exact positive test count`);
          // Approved external documents this test file reads (never in the repository). Pinned by SHA-256; supplied only by the harness (run-profile.mjs).
          if (f.external_inputs !== undefined) {
            if (!Array.isArray(f.external_inputs) || f.external_inputs.length === 0) e.push(`${fw}.external_inputs must be a non-empty array`);
            else f.external_inputs.forEach((x, k) => {
              const xw = `${fw}.external_inputs[${k}]`;
              if (!keys(x, ['env', 'filename', 'sha256'], xw, e)) return;
              if (!isStr(x.env, EXTERNAL_ENV)) e.push(`${xw}.env must match ${EXTERNAL_ENV}`);
              if (!isStr(x.filename, EXTERNAL_FILENAME)) e.push(`${xw}.filename must be a plain file name`);
              if (!isStr(x.sha256, SHA256)) e.push(`${xw}.sha256 must be 64 lowercase hex digits`);
              if (f.external_inputs.findIndex(y => y && y.env === x.env) !== k) e.push(`${xw}.env is listed twice`);
            });
          }
        });
        if (!isInt(c.file_timeout_seconds, 30, 3600)) e.push(`${w}.file_timeout_seconds must be 30..3600`);
        if (typeof c.fresh_database_per_file !== 'boolean') e.push(`${w}.fresh_database_per_file must be boolean`);
        const needsPg = Array.isArray(c.requires) && c.requires.includes('postgres');
        if (c.fresh_database_per_file && !needsPg) e.push(`${w}: fresh_database_per_file needs requires: ["postgres"]`);
        if (c.class === 'NATIVE_POSTGRESQL' && !needsPg) e.push(`${w}: a NATIVE_POSTGRESQL check must require postgres`);
        if (c.class === 'PURE_PGLITE' && needsPg) e.push(`${w}: a PURE_PGLITE check must not require native postgres (keeps the two classes separate)`);
        for (const k of ['config', 'expect_passed', 'script']) if (c[k] !== undefined) e.push(`${w}.${k} is not valid for kind node-test`);
      } else if (c.kind === 'playwright') {
        if (!isStr(c.config, PW_CONFIG)) e.push(`${w}.config must be a root playwright.<name>.config.ts file`);
        if (!isInt(c.expect_passed, 1, 5000)) e.push(`${w}.expect_passed must be the exact number of passing browser tests`);
        if (c.class !== 'BROWSER_CHROMIUM') e.push(`${w}: playwright checks are class BROWSER_CHROMIUM`);
        if (!Array.isArray(c.requires) || !c.requires.includes('chromium')) e.push(`${w}: playwright checks must require chromium`);
        if (!isInt(c.timeout_seconds, 60, 7200)) e.push(`${w}.timeout_seconds must be 60..7200`);
        for (const k of ['files', 'file_timeout_seconds', 'fresh_database_per_file', 'script']) if (c[k] !== undefined) e.push(`${w}.${k} is not valid for kind playwright`);
      } else if (c.kind === 'npm-script') {
        if (!isStr(c.script, NPM_SCRIPT)) e.push(`${w}.script must name a package.json script (${NPM_SCRIPT})`);
        if (!isInt(c.timeout_seconds, 30, 7200)) e.push(`${w}.timeout_seconds must be 30..7200`);
        for (const k of ['files', 'file_timeout_seconds', 'fresh_database_per_file', 'config', 'expect_passed']) if (c[k] !== undefined) e.push(`${w}.${k} is not valid for kind npm-script`);
      }
    });
    if (p.runtime && Array.isArray(p.runtime.requires)) for (const x of p.runtime.requires)
      if (!p.checks.some(c => Array.isArray(c.requires) && c.requires.includes(x))) e.push(`runtime.requires "${x}" is provisioned but no check uses it`);
  }

  // full_regression: the listed node-test checks together ARE the complete regression — statically exact here (file and test totals), and at
  // run time the candidate's own inventory must equal their file union (classify.mjs, check "full-regression-inventory").
  if (p.full_regression !== undefined && keys(p.full_regression, ['inventory', 'checks', 'expect_files', 'expect_tests'], 'full_regression', e)) {
    const fr = p.full_regression;
    if (!INVENTORIES.includes(fr.inventory)) e.push(`full_regression.inventory must be one of ${INVENTORIES.join('|')}`);
    if (!isInt(fr.expect_files, 1, 5000)) e.push('full_regression.expect_files must be the exact number of test files');
    if (!isInt(fr.expect_tests, 1, 100000)) e.push('full_regression.expect_tests must be the exact number of tests');
    if (!Array.isArray(fr.checks) || fr.checks.length === 0 || !fr.checks.every(x => isStr(x, ID))) e.push('full_regression.checks must list check ids');
    else if (new Set(fr.checks).size !== fr.checks.length) e.push('full_regression.checks are duplicated');
    else if (Array.isArray(p.checks)) {
      const listed = fr.checks.map(id => p.checks.find(c => c && c.id === id));
      fr.checks.forEach((id, i) => {
        const c = listed[i];
        if (!c) e.push(`full_regression.checks: "${id}" is not a check of this profile`);
        else if (c.kind !== 'node-test') e.push(`full_regression.checks: "${id}" must be a node-test check`);
        else if (c.mandatory !== true || c.allow_skip === true) e.push(`full_regression.checks: "${id}" must be mandatory and may not allow skips`);
      });
      const files = listed.filter(c => c && c.kind === 'node-test' && Array.isArray(c.files)).flatMap(c => c.files);
      if (fr.inventory === 'tests/*.test.ts') for (const f of files) if (!isStr(f.path, TOP_LEVEL_TEST)) e.push(`full_regression: ${f.path} is not a top-level tests/*.test.ts file`);
      if (isInt(fr.expect_files, 1, 5000) && files.length !== fr.expect_files) e.push(`full_regression.expect_files is ${fr.expect_files} but the listed checks have ${files.length} files`);
      const total = files.reduce((a, f) => a + (Number.isInteger(f.expect_tests) ? f.expect_tests : 0), 0);
      if (isInt(fr.expect_tests, 1, 100000) && total !== fr.expect_tests) e.push(`full_regression.expect_tests is ${fr.expect_tests} but the listed files expect ${total}`);
    }
  }
  return e;
}

export function loadProfile(file) {
  const raw = fs.readFileSync(file);
  let obj;
  try { obj = JSON.parse(raw.toString('utf8')); } catch (err) { throw new Error(`${file}: invalid JSON: ${err.message}`); }
  const errors = validateProfile(obj, { fileName: file });
  if (errors.length) { const err = new Error(`${file}: invalid profile:\n  - ` + errors.join('\n  - ')); err.problems = errors; throw err; }
  return { profile: obj, sha256: crypto.createHash('sha256').update(raw).digest('hex') };
}

export const findCandidate = (profile, sha) => profile.candidates.find(c => c.sha === sha) || null;

function get(obj, dotted) { return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === 'validate') { const { profile, sha256 } = loadProfile(a); console.log(`OK ${profile.profile_id} (${profile.status}) sha256=${sha256}`); }
    else if (cmd === 'validate-all') {
      let bad = 0;
      for (const f of fs.readdirSync(a).filter(x => x.endsWith('.json')).sort()) {
        try { const { profile } = loadProfile(path.join(a, f)); console.log(`OK   ${f} ${profile.status}`); } catch (err) { bad++; console.error(`FAIL ${err.message}`); }
      }
      process.exit(bad ? 2 : 0);
    } else if (cmd === 'get') { const v = get(loadProfile(a).profile, b); if (v === undefined) process.exit(3); console.log(typeof v === 'object' ? JSON.stringify(v) : String(v)); }
    else { console.error('usage: profile.mjs validate|validate-all|get ...'); process.exit(64); }
  } catch (err) { console.error(err.message); process.exit(2); }
}
