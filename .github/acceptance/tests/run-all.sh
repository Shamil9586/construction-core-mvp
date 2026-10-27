#!/usr/bin/env bash
# Construction Core — GPR-2 CI Foundation: run every harness self-test and print one PASS/FAIL/SKIP/NOT RUN line per suite.
#   bash .github/acceptance/tests/run-all.sh [evidence-dir]
# Optional tools: ACTIONLINT / SHELLCHECK (paths). The PostgreSQL and end-to-end suites need an unprivileged user with passwordless
# sudo; when invoked as root they are re-run as RUN_AS_USER (default: runner) if that user exists, otherwise reported NOT RUN.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; ACC="$(cd "$HERE/.." && pwd)"; TOP="$(cd "$ACC/../.." && pwd)"
EV="${1:-$(mktemp -d /tmp/gpr2-selftest.XXXXXX)}"; mkdir -p "$EV"; chmod 0777 "$EV" 2>/dev/null || true
declare -a lines; overall=0
rec() { lines+=("$(printf '%-10s %s' "$1" "$2")"); [[ "$1" == FAIL ]] && overall=1; }
suite() { local name="$1"; shift; if "$@" > "$EV/$name.log" 2>&1; then rec PASS "$name"; else rec FAIL "$name (see $EV/$name.log)"; fi; }

AL="${ACTIONLINT:-$(command -v actionlint || true)}"; SC="${SHELLCHECK:-$(command -v shellcheck || true)}"
if [[ -n "$AL" ]]; then suite actionlint "$AL" ${SC:+-shellcheck "$SC"} "$TOP/.github/workflows/gpr2-acceptance.yml" "$TOP/.github/workflows/gpr2-independent-acceptance.yml"; else rec 'NOT RUN' 'actionlint (tool not installed)'; fi
if [[ -n "$SC" ]]; then suite shellcheck "$SC" "$ACC"/lib/*.sh "$ACC"/tests/*.sh "$ACC/archive-evidence.sh"; else rec 'NOT RUN' 'shellcheck (tool not installed)'; fi
suite profiles node "$ACC/lib/profile.mjs" validate-all "$ACC/profiles"
suite harness-unit node --test "$HERE/harness.test.mjs"
suite r05-harness node --test "$HERE/r05-harness.test.mjs"

as_user() {
  if [[ "$(id -u)" != 0 ]]; then "$@"; return; fi
  local u="${RUN_AS_USER:-runner}"; id "$u" >/dev/null 2>&1 || return 99
  local copy="/var/tmp/gpr2-selftest-harness"; rm -rf "$copy"; mkdir -p "$copy"; cp -r "$ACC" "$copy/"; chmod -R a+rX "$copy"
  local script; script="$copy/acceptance/tests/$(basename "$1")"; shift
  sudo -u "$u" env PATH="$PATH" HOME="$(getent passwd "$u" | cut -d: -f6)" PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-}" GPR2_SYNTH_NODE_MODULES="${GPR2_SYNTH_NODE_MODULES:-}" bash "$script" "$@"
}
if command -v sudo >/dev/null && [[ -x /usr/lib/postgresql/${GPR2_PG_MAJOR:-16}/bin/initdb ]]; then
  as_user "$HERE/pg-cluster.test.sh" "$EV/pg" > "$EV/pg-cluster.log" 2>&1; rc=$?
  if [[ $rc == 99 ]]; then rec 'NOT RUN' 'pg-cluster (needs an unprivileged sudo user)'; elif [[ $rc == 0 ]]; then rec PASS "pg-cluster ($(tail -1 "$EV/pg-cluster.log"))"; else rec FAIL "pg-cluster (see $EV/pg-cluster.log)"; fi
  if [[ -d "${GPR2_SYNTH_NODE_MODULES:-/opt/npm-tools/node_modules}/tsx" && -d "${GPR2_SYNTH_NODE_MODULES:-/opt/npm-tools/node_modules}/playwright" ]]; then
    as_user "$HERE/e2e-synthetic.sh" "$EV/e2e" > "$EV/e2e-synthetic.log" 2>&1; rc=$?
    if [[ $rc == 99 ]]; then rec 'NOT RUN' 'e2e-synthetic (needs an unprivileged sudo user)'; elif [[ $rc == 0 ]]; then rec PASS "e2e-synthetic ($(tail -1 "$EV/e2e-synthetic.log" | cut -c1-40))"; else rec FAIL "e2e-synthetic (see $EV/e2e-synthetic.log)"; fi
  else rec 'NOT RUN' 'e2e-synthetic (no node_modules with tsx + playwright; set GPR2_SYNTH_NODE_MODULES)'; fi
else rec 'NOT RUN' 'pg-cluster and e2e-synthetic (sudo or PostgreSQL binaries unavailable)'; fi
printf '%s\n' "${lines[@]}" | tee "$EV/selftest-summary.txt"
exit $overall
