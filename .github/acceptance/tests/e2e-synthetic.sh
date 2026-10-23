#!/usr/bin/env bash
# shellcheck disable=SC2015 # ok()/bad() always succeed, so "cond && ok || bad" is a safe if/else here
# Construction Core — GPR-2 CI Foundation: end-to-end harness test on a SYNTHETIC candidate repository.
# Exercises the real chain authorize -> identity -> disposable PostgreSQL -> run-profile (node:test + Playwright Chromium + npm script)
# -> verified cleanup -> identity re-verification -> seal -> verify-evidence, then negative scenarios. It does not use product code.
#
# Requires: unprivileged user with passwordless sudo, PostgreSQL binaries, jq, Node 22, and a node_modules directory providing
# tsx + playwright (+ an installed Chromium) given as GPR2_SYNTH_NODE_MODULES (default /opt/npm-tools/node_modules).
#   bash .github/acceptance/tests/e2e-synthetic.sh [work-dir]
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ACC="$(cd "$HERE/.." && pwd)"
WORK="${1:-$(mktemp -d /tmp/gpr2-e2e.XXXXXX)}"; rm -rf "$WORK"; mkdir -p "$WORK"
NM="${GPR2_SYNTH_NODE_MODULES:-/opt/npm-tools/node_modules}"
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "PASS $1"; }
bad() { fail=$((fail+1)); echo "FAIL $1: $2"; }

# ---------- synthetic candidate repository ----------
C="$WORK/candidate-src"; mkdir -p "$C/tests/syn-browser"
git -C "$C" init -q -b main && git -C "$C" config user.email ci@example.invalid && git -C "$C" config user.name 'synthetic'
printf 'node_modules\ntest-results\n' > "$C/.gitignore"
echo '{"name":"synthetic","private":true,"scripts":{"build":"node -e \"console.log(42)\""}}' > "$C/package.json"
git -C "$C" add -A && git -C "$C" commit -qm 'synthetic baseline'
BASE="$(git -C "$C" rev-parse HEAD)"; BASE_TREE="$(git -C "$C" rev-parse 'HEAD^{tree}')"
cat > "$C/tests/syn-native-pg.test.ts" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const q = (sql: string) => execFileSync('psql', [process.env.E2E_DATABASE_URL!, '-XAtc', sql], { encoding: 'utf8' }).trim();
test('runs on the fresh construction_test database of the isolated cluster', () => {
  assert.equal(q('select current_database()'), 'construction_test');
  assert.equal(q("select current_setting('cluster_name')"), 'gpr2-p1-isolated');
});
test('database is empty (recreated per file)', () => { assert.equal(q("select count(*) from pg_tables where schemaname='public'"), '0'); q('create table t(x int)'); });
test('concurrency primitive works natively', () => { assert.equal(q('select pg_try_advisory_lock(42)'), 't'); });
EOF
cat > "$C/tests/syn-pure.test.ts" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
test('no database URL leaks into a pure check', () => { assert.ok(!process.env.DATABASE_URL); assert.ok(!process.env.E2E_DATABASE_URL); assert.ok(!process.env.GPR2_ISOLATED_PG_URL); });
test('scrubbed secrets', () => { assert.ok(!Object.keys(process.env).some(k => /TOKEN|SECRET|PASSWORD/i.test(k))); });
EOF
cat > "$C/playwright.syn.config.ts" <<'EOF'
import { defineConfig } from 'playwright/test';
export default defineConfig({ testDir: './tests/syn-browser', workers: 1, retries: 0, reporter: [['list']], use: { screenshot: 'only-on-failure' } });
EOF
cat > "$C/tests/syn-browser/w01.spec.ts" <<'EOF'
import { test, expect } from 'playwright/test';
for (const width of [1440, 390]) test(`renders the label at ${width}px in a real Chromium`, async ({ page, browserName }) => {
  expect(browserName).toBe('chromium');
  await page.setViewportSize({ width, height: 900 });
  await page.setContent('<main><h1>Ранняя работа</h1><p>Не включена в график</p></main>');
  await expect(page.getByText('Не включена в график', { exact: true })).toBeVisible();
});
EOF
git -C "$C" add -A && git -C "$C" commit -qm 'synthetic candidate: native + pure + browser'
CAND="$(git -C "$C" rev-parse HEAD)"; CAND_TREE="$(git -C "$C" rev-parse 'HEAD^{tree}')"
# negative candidate: one native test fails, the pure file is deleted
sed -i "s/'t'); });/'f'); });/" "$C/tests/syn-native-pg.test.ts"; git -C "$C" rm -q tests/syn-pure.test.ts
git -C "$C" commit -qam 'synthetic broken candidate'
BAD="$(git -C "$C" rev-parse HEAD)"; BAD_TREE="$(git -C "$C" rev-parse 'HEAD^{tree}')"
# skip candidate: every native test skipped
git -C "$C" -c advice.detachedHead=false checkout -q "$CAND" && sed -i 's/^test(/test.skip(/' "$C/tests/syn-native-pg.test.ts" && git -C "$C" commit -qam 'synthetic skipped candidate'
SKIPC="$(git -C "$C" rev-parse HEAD)"; SKIP_TREE="$(git -C "$C" rev-parse 'HEAD^{tree}')"

# ---------- harness copy with a synthetic profile (never written into the real registry) ----------
H="$WORK/harness/.github/acceptance"; mkdir -p "$H"; cp -r "$SRC_ACC/lib" "$SRC_ACC/approvers.txt" "$H/"; mkdir -p "$H/profiles"
cand_json() { jq -n --arg s "$1" --arg t "$2" --arg b "$BASE" --arg bt "$BASE_TREE" --arg p "$3" --arg pt "$4" \
  '{sha:$s, tree:$t, lineage:[{rev:"HEAD^", sha:$p, tree:$pt}], diff_check_from:$b, approval:"synthetic harness self-test candidate"}'; }
jq -n --arg b "$BASE" --arg bt "$BASE_TREE" \
  --argjson c1 "$(cand_json "$CAND" "$CAND_TREE" "$BASE" "$BASE_TREE")" \
  --argjson c2 "$(cand_json "$BAD" "$BAD_TREE" "$CAND" "$CAND_TREE")" \
  --argjson c3 "$(cand_json "$SKIPC" "$SKIP_TREE" "$CAND" "$CAND_TREE")" '{
  schema:"construction-core/gpr2-acceptance-profile@1", profile_id:"synthetic-e2e", stage:"GPR2-SELFTEST", title:"Synthetic harness self-test", status:"ACTIVE",
  baseline:{sha:$b, tree:$bt}, candidates:[$c1,$c2,$c3],
  runtime:{runner:"ubuntu-24.04", node:"22.22.0", postgres_major:16, job_timeout_minutes:20, requires:["postgres","chromium"]},
  checks:[
    {id:"native-pg", title:"synthetic native", class:"NATIVE_POSTGRESQL", kind:"node-test", mandatory:true, requires:["postgres"], allow_skip:false, fresh_database_per_file:true, file_timeout_seconds:60,
     files:[{path:"tests/syn-native-pg.test.ts", expect_tests:3}]},
    {id:"pure", title:"synthetic pure", class:"PURE_PGLITE", kind:"node-test", mandatory:true, requires:[], allow_skip:false, fresh_database_per_file:false, file_timeout_seconds:60,
     files:[{path:"tests/syn-pure.test.ts", expect_tests:2}]},
    {id:"browser", title:"synthetic chromium", class:"BROWSER_CHROMIUM", kind:"playwright", mandatory:true, requires:["chromium"], allow_skip:false, config:"playwright.syn.config.ts", expect_passed:2, timeout_seconds:300},
    {id:"build", title:"synthetic build", class:"TYPECHECK_BUILD", kind:"npm-script", mandatory:true, requires:[], script:"build", timeout_seconds:120}]}' > "$H/profiles/synthetic-e2e.json"
node "$H/lib/profile.mjs" validate "$H/profiles/synthetic-e2e.json" >/dev/null && ok 'synthetic profile validates' || bad profile "$(node "$H/lib/profile.mjs" validate "$H/profiles/synthetic-e2e.json" 2>&1)"

# ---------- one emulated workflow run ----------
# run <name> <sha> <pg: start|fail> <run_id>  -> leaves $WORK/<name>/sealed and prints the gate
run() {
  local sha="$2" pg="$3" rid="$4" R="$WORK/$1"; mkdir -p "$R"
  export GITHUB_REPOSITORY=Shamil9586/construction-core-mvp GITHUB_EVENT_NAME=workflow_dispatch GITHUB_REF=refs/heads/main GITHUB_ACTOR=Shamil9586 GITHUB_TRIGGERING_ACTOR=Shamil9586 \
         GITHUB_SHA=0000000000000000000000000000000000000000 GITHUB_RUN_ID="$rid" GITHUB_RUN_ATTEMPT=1 INPUT_PROFILE=synthetic-e2e INPUT_CANDIDATE_SHA="$sha" \
         INPUT_CONFIRMATION="APPROVE-TEST-ONLY synthetic-e2e $sha"
  node "$H/lib/authorize.mjs" "$H" "$R/authz" > "$R/authorize.log" 2>&1 || { echo "authorize refused"; return 1; }
  git clone -q --no-local "$C" "$R/core" && git -C "$R/core" -c advice.detachedHead=false checkout -q --detach "$sha"
  ln -s "$NM" "$R/core/node_modules"
  node "$H/lib/identity.mjs" --phase authorize --profile "$H/profiles/synthetic-e2e.json" --candidate "$sha" --repo "$R/core" --out "$R/authz/identity-authorize.json" > "$R/identity.log" 2>&1 || { echo 'identity refused'; return 1; }
  mkdir -p "$R/raw"
  node "$H/lib/identity.mjs" --phase runtime --profile "$H/profiles/synthetic-e2e.json" --candidate "$sha" --repo "$R/core" --out "$R/raw/identity-runtime.json" >> "$R/identity.log" 2>&1
  local pg_outcome=skipped
  if [[ "$pg" == start ]]; then GPR2_EVIDENCE_OUT="$R/raw" bash "$H/lib/pg-cluster.sh" start > "$R/pg-start.log" 2>&1 && pg_outcome=success || pg_outcome=failure; else pg_outcome=failure; fi
  GPR2_ENV_DEPS=success GPR2_ENV_POSTGRES="$pg_outcome" GPR2_ENV_CHROMIUM=success node "$H/lib/run-profile.mjs" --profile "$H/profiles/synthetic-e2e.json" --core "$R/core" --out "$R/raw" > "$R/run-profile.log" 2>&1
  GPR2_EVIDENCE_OUT="$R/raw" bash "$H/lib/pg-cluster.sh" stop > "$R/pg-stop.log" 2>&1
  node "$H/lib/identity.mjs" --phase seal --profile "$H/profiles/synthetic-e2e.json" --candidate "$sha" --repo "$R/core" --out "$R/identity-seal.json" >> "$R/identity.log" 2>&1
  node "$H/lib/seal.mjs" --profile "$H/profiles/synthetic-e2e.json" --raw "$R/raw" --authorization "$R/authz/authorization.json" --identity "$R/identity-seal.json" --runtime-result success --out "$R/sealed" > "$R/seal.log" 2>&1
  jq -r .result.gate "$R/sealed/acceptance-result.json"
}
status_of() { jq -r --arg id "$2" '.result.checks[]|select(.id==$id)|.status' "$WORK/$1/sealed/acceptance-result.json"; }

g="$(run good "$CAND" start 880001)"
if [[ "$g" == TECHNICAL_GATES_PASSED ]]; then ok 'good candidate: TECHNICAL_GATES_PASSED (native PG 3 + pure 2 + Chromium 2 + build)'; else bad good "$g; $(tail -15 "$WORK/good/run-profile.log")"; fi
[[ "$(jq -r '.result.by_class.NATIVE_POSTGRESQL.tests_pass' "$WORK/good/sealed/acceptance-result.json")" == 3 && "$(jq -r '.result.by_class.PURE_PGLITE.tests_pass' "$WORK/good/sealed/acceptance-result.json")" == 2 && "$(jq -r '.result.by_class.BROWSER_CHROMIUM.tests_pass' "$WORK/good/sealed/acceptance-result.json")" == 2 ]] \
  && ok 'native PostgreSQL, pure and browser counts reported separately' || bad classes "$(jq -c .result.by_class "$WORK/good/sealed/acceptance-result.json")"
[[ "$(jq -r .status "$WORK/good/sealed/raw/postgres/cleanup.json")" == STOPPED_VERIFIED ]] && ok 'cleanup STOPPED_VERIFIED recorded in sealed evidence' || bad cleanup "$(cat "$WORK/good/sealed/raw/postgres/cleanup.json")"
jq -e '.environment.chromium.version and .environment.playwright and .environment.postgres_server.server_version and .environment.node' "$WORK/good/sealed/acceptance-result.json" >/dev/null \
  && ok "environment identity captured ($(jq -r '.environment.chromium.version' "$WORK/good/sealed/acceptance-result.json"); PG $(jq -r '.environment.postgres_server.server_version' "$WORK/good/sealed/acceptance-result.json"))" || bad env "$(jq -c .environment "$WORK/good/sealed/acceptance-result.json")"
ls "$WORK/good/sealed/raw/checks/native-pg/junit/"*.xml >/dev/null 2>&1 && ok 'per-file JUnit XML produced' || bad junit 'missing'
v="$(node "$H/lib/verify-evidence.mjs" "$WORK/good/sealed" --profile "$H/profiles/synthetic-e2e.json" --expect-candidate "$CAND" 2>&1)" && ok 'verify-evidence: integrity VERIFIED' || bad verify "$v"
echo "$v" > "$WORK/good/verify.log"

g="$(run broken "$BAD" start 880002)"
[[ "$g" == TECHNICAL_GATES_FAILED && "$(status_of broken native-pg)" == FAIL && "$(status_of broken pure)" == FAIL ]] \
  && ok "broken candidate: TECHNICAL_GATES_FAILED (native FAIL; deleted file -> FAIL, not PASS)" || bad broken "$g $(status_of broken native-pg) $(status_of broken pure)"
jq -e '.result.checks[]|select(.id=="pure")|.files[0].reasons|map(test("missing"))|any' "$WORK/broken/sealed/acceptance-result.json" >/dev/null && ok 'missing test file named as the reason' || bad reason 'no missing-file reason'

g="$(run skipped "$SKIPC" start 880003)"
[[ "$g" == TECHNICAL_GATES_FAILED && "$(status_of skipped native-pg)" == SKIP ]] && ok 'all-skipped mandatory check: SKIP (distinct from NOT RUN) and gate FAILED' || bad skipped "$g $(status_of skipped native-pg)"

g="$(run blocked "$CAND" fail 880004)"
[[ "$g" == INCONCLUSIVE_ENVIRONMENT_BLOCKED && "$(status_of blocked native-pg)" == 'ENVIRONMENT BLOCKED' && "$(status_of blocked pure)" == PASS && "$(status_of blocked postgres-cleanup)" == PASS ]] \
  && ok 'PostgreSQL unavailable: native ENVIRONMENT BLOCKED, pure still PASS, gate INCONCLUSIVE' || bad blocked "$g $(status_of blocked native-pg) $(status_of blocked pure)"

# tampering after sealing is detected
cp -r "$WORK/good/sealed" "$WORK/tampered"; sed -i 's/"pass": 3/"pass": 4/' "$WORK/tampered/raw/checks/native-pg/result.json" 2>/dev/null
jq '.files[0].counts.pass=99' "$WORK/good/sealed/raw/checks/native-pg/result.json" > "$WORK/tampered/raw/checks/native-pg/result.json"
node "$H/lib/verify-evidence.mjs" "$WORK/tampered" --profile "$H/profiles/synthetic-e2e.json" > "$WORK/tampered.log" 2>&1 && bad tamper 'not detected' || ok 'tampered sealed evidence is rejected by verify-evidence'

# authorisation refusals on the real CLI
export INPUT_CONFIRMATION="APPROVE-TEST-ONLY synthetic-e2e $BASE" INPUT_CANDIDATE_SHA="$BASE"
node "$H/lib/authorize.mjs" "$H" "$WORK/refused" > "$WORK/refused.log" 2>&1 && bad refuse 'baseline (unregistered) SHA authorised' || ok 'unregistered SHA refused by authorize.mjs'
ls -d /var/tmp/gpr2-accept-88* 2>/dev/null && bad leftovers 'cluster roots left' || ok 'no disposable clusters left behind'
echo "TOTAL pass=$pass fail=$fail  (work dir: $WORK)"
[[ "$fail" == 0 ]]
