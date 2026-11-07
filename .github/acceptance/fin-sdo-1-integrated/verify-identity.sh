#!/usr/bin/env bash
# Runs BEFORE any candidate code executes. usage: verify-identity.sh <core_dir> <evidence_dir>
# Proves: exact SHA/tree/parents, full (non-shallow) history, clean tree, candidate differs from the integrated base by exactly the
# allowed paths (so no workflow, no infra/ migration, no product source slipped in), 37 numbered migrations and NO numbered FIN SQL.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE="${1:?core dir}"; EV="${2:?evidence dir}"
# shellcheck disable=SC1091
source "$HERE/candidate.env"
mkdir -p "$EV"
g() { git -C "$CORE" "$@"; }
test "$(g rev-parse HEAD)" = "$CANDIDATE_SHA"
test "$(g rev-parse 'HEAD^{tree}')" = "$CANDIDATE_TREE"
test "$(g rev-parse 'HEAD^')" = "$CANDIDATE_PARENT"
test "$(g rev-parse 'HEAD~3')" = "$INTEGRATED_BASE_SHA"
test "$(g rev-parse 'HEAD~3^{tree}')" = "$INTEGRATED_BASE_TREE"
test "$(g rev-parse 'HEAD~3^1')" = "$PRODUCT_MAIN_SHA"
test "$(g rev-parse --is-shallow-repository)" = false
test -z "$(g status --porcelain --untracked-files=all)"
g diff --check "$INTEGRATED_BASE_SHA" HEAD
g diff --name-only "$INTEGRATED_BASE_SHA" HEAD | sort > "$EV/candidate-diff-names.txt"
sort "$HERE/candidate-allowed-paths.txt" | diff -u - "$EV/candidate-diff-names.txt"
# migration inventory: exactly 001..037, strictly sequential, nothing FIN-numbered
( cd "$CORE/infra" && ls -1 *.sql | LC_ALL=C sort ) > "$EV/infra-inventory.txt"
test "$(wc -l < "$EV/infra-inventory.txt")" -eq "$EXPECTED_MIGRATIONS"
n=0; while read -r f; do n=$((n+1)); printf -v want '%03d_' "$n"; [[ "$f" == "$want"* ]] || { echo "migration sequence broken at $f" >&2; exit 1; }; done < "$EV/infra-inventory.txt"
! grep -qi 'fin' "$EV/infra-inventory.txt"
( cd "$CORE/infra" && sha256sum *.sql ) > "$EV/infra-sha256.txt"
test "$(g rev-parse HEAD:design/fin-sdo-1/schema-UNNUMBERED.sql)" = "$FIN_UNNUMBERED_SQL_BLOB"
{ g rev-parse HEAD 'HEAD^{tree}' 'HEAD^' 'HEAD~3' 'HEAD~3^{tree}'; printf 'fin_unnumbered_sql_blob=%s\n' "$FIN_UNNUMBERED_SQL_BLOB"; } > "$EV/git-identity.txt"
echo 'IDENTITY PASS'
