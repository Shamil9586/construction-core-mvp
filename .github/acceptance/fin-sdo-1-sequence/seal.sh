#!/usr/bin/env bash
# usage: seal.sh <evidence_dir>   Runs even after failures. Writes RESULT.md (technical gate only) and SHA256SUMS over everything else.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; EV="${1:?evidence dir}"; mkdir -p "$EV"
# shellcheck disable=SC1091
source "$HERE/candidate.env" 2>/dev/null
{
  echo '# FIN-SDO-1 FIN1-25 numbered-sequence route — TECHNICAL GATE ONLY'
  echo
  echo "Candidate: \`${CANDIDATE_SHA:-UNKNOWN}\` (tree \`${CANDIDATE_TREE:-UNKNOWN}\`). GPR main: \`${GPR_MAIN_SHA:-UNKNOWN}\`."
  echo "Chain tested: numbered migrations 001-${PRE_COUNT:-?} (GPR, incl. 038 and 039), then the numbered FIN migration $(( ${PRE_COUNT:-0} + 1 )) applied by the migration runner; FIN suites read the schema from the ledger."
  echo
  echo '**Not claimed by this run:** acceptance, FIN overall, product merge, LIVE/production, role provisioning on a real server, GPR 038/039 acceptance (separate gates), FIN-2/3.'
  echo 'A green run is executor/CI evidence. The independent reviewer must verify identity, raw logs, exit codes, teardown (incl. post-stop port state) and run own negatives.'
  echo
  echo '| check | state | seconds |'; echo '|---|---|---|'
  if [[ -f "$EV/checks.tsv" ]]; then awk -F'\t' '{print "| "$1" | "$2" | "$3" |"}' "$EV/checks.tsv"; else echo '| (no checks recorded) | NOT_RUN | - |'; fi
} > "$EV/RESULT.md"
rm -f "$EV/SHA256SUMS"
( cd "$EV" && find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > SHA256SUMS )
