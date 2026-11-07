#!/usr/bin/env bash
# Runs BEFORE any candidate code executes. usage: verify-identity.sh <core_dir> <evidence_dir>
# FIN1-25 route. Refuses PENDING pins. Proves: exact SHA/tree, full history, clean tree, GPR main is an ancestor, the candidate differs from GPR main by
# EXACTLY the allowlist, numbered migrations are 001..PRE+1 strictly sequential, the only FIN-numbered file is the last one, nothing else FIN-named.
# NOTE: every guard is written as `if ...; then fail; fi` — a leading `!` is exempt from `set -e` and would silently never fail.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE="${1:?core dir}"; EV="${2:?evidence dir}"
# shellcheck disable=SC1091
source "$HERE/candidate.env"
mkdir -p "$EV"
fail() { echo "IDENTITY FAIL: $*" >&2; exit 1; }
for v in CANDIDATE_SHA CANDIDATE_TREE GPR_MAIN_SHA GPR_MAIN_TREE PRE_COUNT CONFIRMATION; do
  val="${!v:-}"; if [[ -z "$val" || "$val" == *PENDING* ]]; then fail "$v is PENDING/empty — this route is parked until a reviewed PR pins one exact candidate"; fi
done
if grep -q PENDING "$HERE/candidate-allowed-paths.txt"; then fail "candidate-allowed-paths.txt is PENDING"; fi
g() { git -C "$CORE" "$@"; }
[[ "$(g rev-parse HEAD)" == "$CANDIDATE_SHA" ]] || fail "HEAD != CANDIDATE_SHA"
[[ "$(g rev-parse 'HEAD^{tree}')" == "$CANDIDATE_TREE" ]] || fail "tree mismatch"
[[ "$(g rev-parse --is-shallow-repository)" == false ]] || fail "shallow checkout"
[[ -z "$(g status --porcelain --untracked-files=all)" ]] || fail "dirty checkout"
g merge-base --is-ancestor "$GPR_MAIN_SHA" HEAD || fail "GPR_MAIN_SHA is not an ancestor of the candidate"
[[ "$(g rev-parse "$GPR_MAIN_SHA^{tree}")" == "$GPR_MAIN_TREE" ]] || fail "GPR_MAIN_TREE mismatch"
g diff --check "$GPR_MAIN_SHA" HEAD || fail "whitespace errors in diff"
g diff --name-only "$GPR_MAIN_SHA" HEAD | LC_ALL=C sort > "$EV/candidate-diff-names.txt"
if ! LC_ALL=C sort "$HERE/candidate-allowed-paths.txt" | diff -u - "$EV/candidate-diff-names.txt"; then fail "candidate differs from GPR main by paths outside the allowlist"; fi
( cd "$CORE/infra" && ls -1 *.sql | LC_ALL=C sort ) > "$EV/infra-inventory.txt"
want=$((PRE_COUNT + 1))
[[ "$(wc -l < "$EV/infra-inventory.txt")" -eq "$want" ]] || fail "expected $want numbered migrations"
n=0
while read -r f; do n=$((n+1)); printf -v pfx '%03d_' "$n"; [[ "$f" == "$pfx"* ]] || fail "migration sequence broken at $f (expected prefix $pfx)"; done < "$EV/infra-inventory.txt"
if [[ "$(grep -ci 'fin_sdo' "$EV/infra-inventory.txt")" -ne 1 ]]; then fail "exactly one fin_sdo migration expected"; fi
if ! tail -1 "$EV/infra-inventory.txt" | grep -q '^[0-9]*_fin_sdo_1_.*\.sql$'; then fail "the FIN migration must be the last numbered file"; fi
( cd "$CORE/infra" && sha256sum *.sql ) > "$EV/infra-sha256.txt"
# GPR migrations 001..PRE must be byte-identical to GPR main (FIN may not edit an older migration)
( cd "$CORE/infra" && for f in $(head -n "$PRE_COUNT" "$EV/infra-inventory.txt"); do
    [[ "$(git -C "$CORE" rev-parse "HEAD:infra/$f")" == "$(git -C "$CORE" rev-parse "$GPR_MAIN_SHA:infra/$f")" ]] || { echo "IDENTITY FAIL: $f differs from GPR main" >&2; exit 1; }
  done )
{ g rev-parse HEAD 'HEAD^{tree}'; printf 'gpr_main=%s\ngpr_main_tree=%s\n' "$GPR_MAIN_SHA" "$GPR_MAIN_TREE"; } > "$EV/git-identity.txt"
echo 'IDENTITY PASS'
