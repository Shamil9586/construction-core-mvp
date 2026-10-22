#!/usr/bin/env bash
set -euo pipefail
ROOT="${GITHUB_WORKSPACE:?Missing workspace}"
OUT="$ROOT/gpr2-ci-evidence"
CAND="b882fd0a35fe93d5f85d6be1ccd7dfdc6982f67d"
[[ "$(git -C "$ROOT/core" rev-parse HEAD)" == "$CAND" ]] || { echo 'Candidate drift' >&2; exit 2; }
[[ -s "$OUT/postgresql-identity.txt" ]] || { echo 'No PostgreSQL identity' >&2; exit 2; }
cd "$ROOT/core"
mkdir -p "$OUT/native" "$OUT/browser"
node --version > "$OUT/node-version.txt"
npm --version > "$OUT/npm-version.txt"
npx --no-install playwright --version > "$OUT/playwright-version.txt"
native=(
  tests/gpr2-r02-fact-resolver-pg.test.ts
  tests/gpr2-r03a-snapshot-pg.test.ts
  tests/gpr2-r03b-coordination-pg.test.ts
  tests/gpr2-r03c-ledger-pg.test.ts
  tests/gpr2-r03d-migration-pg.test.ts
  tests/gpr2-r03d-migration-runner.test.ts
  tests/gpr2-r04-native-pg.test.ts
  tests/gpr2-r04-cp02-native-pg.test.ts
)
for file in "${native[@]}"; do
  [[ -s "$file" ]] || { echo "Required native test not found: $file" >&2; exit 2; }
done
export FILE_TIMEOUT=480
set +e
bash scripts/gpr2-p1-run-tests.sh "$OUT/native" "${native[@]}" > "$OUT/native-runner.log" 2>&1
native_script_exit=$?
set -e
native_rc=0
if [[ "$native_script_exit" != 0 || ! -s "$OUT/native/summary.tsv" ]]; then
  native_rc=1
else
  awk -F '\t' 'NR>1 && ($2 != 0 || $3 == "" || $3 == 0 || $5 != 0 || $6 != 0 || $7 != 0) { print "BAD_NATIVE: " $0; fail=1 } END { if(NR<2) fail=1; exit fail }' "$OUT/native/summary.tsv" || native_rc=1
  executed="$(awk -F '\t' 'NR>1 {n++} END {print n+0}' "$OUT/native/summary.tsv")"
  [[ "$executed" == "${#native[@]}" ]] || native_rc=1
fi
printf '%s\n' "$native_rc" > "$OUT/native.exit"
set +e
npx --no-install playwright test --config playwright.gpr-1.config.ts --reporter=list --trace=retain-on-failure > "$OUT/browser/playwright.log" 2>&1
browser_rc=$?
set -e
# Verify the exact browser case count from the accepted corrective candidate.
if ! grep -Eq '(^|[[:space:]])22 passed' "$OUT/browser/playwright.log"; then
  browser_rc=1
fi
printf '%s\n' "$browser_rc" > "$OUT/browser.exit"
if [[ -d test-results ]]; then
  cp -a test-results "$OUT/browser/test-results"
fi
{
  echo "candidate=$CAND"
  echo "tree=$(git rev-parse 'HEAD^{tree}')"
  echo "native_files=${#native[@]}"
  echo "native_exit=$native_rc"
  echo "browser_exit=$browser_rc"
  echo "finished_utc=$(date -u +%FT%TZ)"
} | tee "$OUT/runtime-summary.txt"
[[ "$native_rc" == 0 && "$browser_rc" == 0 ]] || { echo 'R04 RUNTIME GATES FAILED; no ACCEPTED verdict' >&2; exit 1; }
echo 'R04 technical runtime gates passed; independent reviewer acceptance still required.'
