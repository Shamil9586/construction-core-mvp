#!/usr/bin/env bash
# GPR-2 P1 — run test files one by one against the ISOLATED PostgreSQL cluster, each on a freshly created `construction_test`
# database, and write a per-file exit-code table. A file that hangs is killed by its timeout and reported as such; nothing is skipped silently.
#
# Usage:  scripts/gpr2-p1-run-tests.sh <out-dir> <test-file>...
# Needs:  GPR2_ISOLATED_PG_URL   admin URL of the isolated cluster, e.g. postgresql://postgres:x@127.0.0.1:54329/postgres
#         PSQL                   path to psql (default: psql)
#         FILE_TIMEOUT           seconds per file (default 900)
#
# Isolation: the script reads the cluster's own `cluster_name` and refuses to touch any server that does not report `gpr2-p1-isolated`, or that
# is not on a loopback address. It never reads DATABASE_URL / E2E_* from the caller's environment — it sets them itself.
set -u
OUT="${1:?out dir}"; shift
: "${GPR2_ISOLATED_PG_URL:?GPR2_ISOLATED_PG_URL is not set}"
PSQL="${PSQL:-psql}"
FILE_TIMEOUT="${FILE_TIMEOUT:-900}"

BASE="${GPR2_ISOLATED_PG_URL%/*}"                       # postgresql://user:pw@host:port
case "$BASE" in *@127.0.0.1:*|*@localhost:*|*@\[::1\]:*) ;; *) echo "refusing: not a loopback server: $BASE" >&2; exit 2;; esac
CLUSTER="$($PSQL "$GPR2_ISOLATED_PG_URL" -Atc "select current_setting('cluster_name')" 2>/dev/null || true)"
[ "$CLUSTER" = "gpr2-p1-isolated" ] || { echo "refusing: cluster_name is '$CLUSTER', not gpr2-p1-isolated" >&2; exit 2; }

for v in DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE; do unset "$v"; done
export TZ=UTC
export E2E_DATABASE_URL="$BASE/construction_test"
export E2E_ADMIN_DATABASE_URL="$BASE/postgres"
export E2E_POSTGRES_HOST_URL="$BASE/"                    # trailing slash: some suites append a database name to it
export GPR2_ISOLATED_PG_URL
export GPR2_EVIDENCE_DIR="$OUT/evidence"

mkdir -p "$OUT/logs" "$OUT/evidence"
SUMMARY="$OUT/summary.tsv"
printf 'file\texit\ttests\tpass\tfail\tcancelled\tskipped\tseconds\n' > "$SUMMARY"

for f in "$@"; do
  name="$(echo "$f" | tr '/' '_')"
  $PSQL "$E2E_ADMIN_DATABASE_URL" -qc "DROP DATABASE IF EXISTS construction_test WITH (FORCE)" -c "CREATE DATABASE construction_test" >/dev/null 2>&1
  start=$(date +%s)
  timeout --kill-after=10 "$FILE_TIMEOUT" node --import tsx --test --test-concurrency=1 "$f" > "$OUT/logs/$name.log" 2>&1
  code=$?
  secs=$(( $(date +%s) - start ))
  n() { grep -E "^# $1 " "$OUT/logs/$name.log" | tail -1 | awk '{print $3}'; }
  [ "$code" = "124" ] && echo "# TIMEOUT after ${FILE_TIMEOUT}s" >> "$OUT/logs/$name.log"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$f" "$code" "$(n tests)" "$(n pass)" "$(n fail)" "$(n cancelled)" "$(n skipped)" "$secs" >> "$SUMMARY"
  echo "$f exit=$code"
done
awk -F'\t' 'NR>1{t+=$3;p+=$4;f+=$5;c+=$6;s+=$7; if($2!=0)bad++} END{printf "TOTAL files=%d nonzero_exit=%d tests=%d pass=%d fail=%d cancelled=%d skipped=%d\n",NR-1,bad,t,p,f,c,s}' "$SUMMARY" | tee "$OUT/total.txt"
