#!/usr/bin/env bash
# usage: run-checks.sh <core_dir> <harness_dir> <evidence_dir>
# FIN1-25 numbered-sequence route. Env: DATABASE_URL (loopback fin_sdo_test only), FIN_SDO_ISOLATED_CONFIRM=YES.
# Every check keeps raw stdout/stderr + exit code. A check that DEPENDS on a failed one is recorded NOT_RUN, never silently skipped.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/candidate.env"
CORE="$(cd "${1:?core dir}" && pwd)"; HARNESS="$(cd "${2:?harness dir}" && pwd)"; EV="$(mkdir -p "${3:?evidence dir}" && cd "$3" && pwd)"
: "${DATABASE_URL:?}" "${FIN_SDO_ISOLATED_CONFIRM:?}"
case "$DATABASE_URL" in postgres://*@127.0.0.1:*/fin_sdo_test|postgres://*@localhost:*/fin_sdo_test) ;; *) echo 'REFUSED: DATABASE_URL must be a loopback fin_sdo_test database' >&2; exit 2;; esac
export FIN_SEQ_PRE_COUNT="$PRE_COUNT" FIN_SEQ_EVIDENCE_DIR="$EV/fin-seq"
: > "$EV/checks.tsv"
declare -A RC
run_check() { # label, dependency-label-or-'-', command...
  local label="$1" dep="$2"; shift 2
  if [[ "$dep" != "-" && "${RC[$dep]:-NA}" != "0" ]]; then
    echo NOT_RUN > "$EV/$label.exit"; : > "$EV/$label.stdout.log"; echo "depends on $dep (exit ${RC[$dep]:-NA})" > "$EV/$label.stderr.log"
    RC[$label]=NOT_RUN; printf '%s\tNOT_RUN\t-\n' "$label" >> "$EV/checks.tsv"; echo "NOT_RUN $label"; return 0
  fi
  local start end rc; start=$(date +%s)
  ( cd "$CORE" && "$@" ) > "$EV/$label.stdout.log" 2> "$EV/$label.stderr.log"; rc=$?
  end=$(date +%s); echo "$rc" > "$EV/$label.exit"; RC[$label]=$rc
  printf '%s\t%s\t%ss\n' "$label" "$([[ $rc -eq 0 ]] && echo PASS || echo FAIL)" "$((end-start))" >> "$EV/checks.tsv"
  echo "$([[ $rc -eq 0 ]] && echo PASS || echo FAIL) $label (exit $rc)"
}
SEQ=(node --import tsx scripts/fin-sdo-1-isolated-sequence-verify.ts)

run_check typecheck             -                 npx tsc --noEmit
run_check build                 -                 npm run build
run_check unit-fin-and-contracts - node --import tsx --test tests/fin-sdo-1-*.test.ts tests/gpr2-r01-permissions.test.ts tests/gpr2-r03a-tx-context.test.ts tests/gpr2-r03b-writer-registry.test.ts tests/gpr2-r03d-migration-runner.test.ts
run_check postgres-identity     -                 node -e "
const {Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
const r=(await c.query(\"SELECT version() v, current_setting('server_version') sv, current_database() db, inet_server_addr()::text addr, current_user u\")).rows[0];
console.log(JSON.stringify(r));if(!/^16\./.test(r.sv)||r.db!=='fin_sdo_test')process.exit(3);await c.end();})().catch(e=>{console.error(e.message);process.exit(1)})"
run_check migrate-plan-all      postgres-identity node --import tsx scripts/migrate.ts --plan
run_check migrate-through-gpr   postgres-identity node --import tsx scripts/migrate.ts "--through=$PRE_COUNT"
run_check seq-pre               migrate-through-gpr "${SEQ[@]}" pre
run_check migrate-fin           seq-pre           npm run db:migrate
run_check seq-post              migrate-fin       "${SEQ[@]}" post
run_check seq-rerun             seq-post          "${SEQ[@]}" rerun
# From here the FIN schema comes from the LEDGER (numbered migration), not from design/…UNNUMBERED.sql.
export FIN_SDO_SCHEMA_APPLIED=1
run_check native-pg             seq-post          node --import tsx scripts/fin-sdo-1-isolated-pg-verify.ts
run_check native-service        native-pg         node --import tsx scripts/fin-sdo-1-isolated-service-verify.ts
run_check native-http           native-pg         node --import tsx scripts/fin-sdo-1-isolated-http-verify.ts
run_check native-protected      native-pg         node --import tsx scripts/fin-sdo-1-isolated-protected-verify.ts
run_check native-sec01-f01      native-protected  node --import tsx scripts/fin-sdo-1-isolated-sec01-f01-verify.ts
run_check native-evidence-gaps  native-protected  node --import tsx scripts/fin-sdo-1-isolated-evidence-gaps-verify.ts
run_check reviewer-negative-f02 native-protected  env "GITHUB_WORKSPACE=$(dirname "$CORE")" node --import tsx "$HARNESS/.github/acceptance/reviews/fin-sdo-1-sec01-f02-negative.mjs"
# Mutates (and restores) the ledger checksum of the FIN row: last, so no other check can observe the temporary state.
run_check seq-tamper            reviewer-negative-f02 "${SEQ[@]}" tamper

failed=$(awk -F'\t' '$2=="FAIL"{n++} END{print n+0}' "$EV/checks.tsv"); notrun=$(awk -F'\t' '$2=="NOT_RUN"{n++} END{print n+0}' "$EV/checks.tsv")
echo "CHECKS_FAILED=$failed CHECKS_NOT_RUN=$notrun"
[[ "$failed" -eq 0 && "$notrun" -eq 0 ]]
