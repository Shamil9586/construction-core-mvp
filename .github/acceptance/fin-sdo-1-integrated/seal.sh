#!/usr/bin/env bash
# usage: seal.sh <evidence_dir>   Runs even after failures. Writes RESULT.md (technical gate only) and SHA256SUMS over everything else.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; EV="${1:?evidence dir}"; mkdir -p "$EV"
# shellcheck disable=SC1091
source "$HERE/candidate.env"
{
  echo '# FIN-SDO-1 integrated native route — TECHNICAL GATE ONLY'
  echo
  echo "Candidate: \`$CANDIDATE_SHA\` (tree \`$CANDIDATE_TREE\`). Integrated code base: \`$INTEGRATED_BASE_SHA\`."
  echo 'Chain tested: numbered migrations 001-037 (product main fc98aae) then the UNNUMBERED FIN SQL loaded by the native scripts.'
  echo
  echo '**Not claimed by this run:** FIN1-25 (no numbered FIN migration; conditional 040 follows GPR 038 and 039, not integrated), acceptance, merge, LIVE, deployment.'
  echo 'A green run is executor/CI evidence; the independent reviewer must verify identity, raw logs, exit codes, teardown and run negative probes.'
  echo
  echo '| check | state | seconds |'; echo '|---|---|---|'
  [[ -f "$EV/checks.tsv" ]] && awk -F'\t' '{print "| "$1" | "$2" | "$3" |"}' "$EV/checks.tsv" || echo '| (no checks recorded) | NOT_RUN | - |'
} > "$EV/RESULT.md"
rm -f "$EV/SHA256SUMS"
( cd "$EV" && find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > SHA256SUMS )
