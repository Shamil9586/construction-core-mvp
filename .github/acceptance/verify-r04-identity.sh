#!/usr/bin/env bash
set -euo pipefail
ROOT="${GITHUB_WORKSPACE:?GitHub Actions workspace required}"
mkdir -p "$ROOT/gpr2-ci-evidence"
cd "$ROOT"
CAND="b882fd0a35fe93d5f85d6be1ccd7dfdc6982f67d"
TREE="2f5d3648b330c30642a08b62e7737834dbe25ec2"
CP01="169ae902fafaf0f836464b2741af4bf98afd6a3b"
CP01_TREE="bb77c3f5437661670ca9fc59b7dea78ac3128fb4"
R04="e7ddcf63900e3a6d9f8d69d4815d54dfacc07260"
R04_TREE="bedaabff1d96094ee678133d56c37000a765f32d"
BASE="92fcf6d047fd22453349260432dbc65590386a17"
BASE_TREE="b32c75756c9e4eb6f71e8c55e103482ca4591820"
verify() {
 local label="$1" expression="$2" expected="$3" actual
 actual="$(git -C core rev-parse "$expression")"
 [[ "$actual" == "$expected" ]] || { echo "REFUSED $label: $actual != $expected" >&2; exit 2; }
}
verify candidate HEAD "$CAND"
verify candidate_tree 'HEAD^{tree}' "$TREE"
verify parent HEAD^ "$CP01"
verify parent_tree 'HEAD^^{tree}' "$CP01_TREE"
verify original_r04 HEAD^^ "$R04"
verify original_r04_tree 'HEAD^^^{tree}' "$R04_TREE"
verify base HEAD^^^ "$BASE"
verify base_tree 'HEAD^^^{tree}' "$BASE_TREE"
[[ -z "$(git -C core status --porcelain)" ]] || { echo 'REFUSED dirty candidate checkout' >&2; exit 2; }
git -C core diff --check "$BASE..$CAND"
{
  echo "candidate=$CAND"
  echo "candidate_tree=$TREE"
  echo "parent=$CP01"
  echo "original_r04=$R04"
  echo "base=$BASE"
  echo "workflow_sha=${GITHUB_SHA:-unknown}"
  echo "run_id=${GITHUB_RUN_ID:-unknown}"
  echo "run_attempt=${GITHUB_RUN_ATTEMPT:-unknown}"
  echo "review_mode=READ_ONLY_DISPOSABLE_LOCAL"
  git -C core log --format='%H %s' -4
} > "$ROOT/gpr2-ci-evidence/git-identity.txt"
cat "$ROOT/gpr2-ci-evidence/git-identity.txt"
