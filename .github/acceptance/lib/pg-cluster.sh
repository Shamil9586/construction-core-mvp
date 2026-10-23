#!/usr/bin/env bash
# Construction Core — GPR-2 CI Foundation: disposable native PostgreSQL cluster lifecycle (start | stop | status).
#
# Corrects F-CI-01 (LOW): the frozen R04 postgres-stop.sh tested "$ROOT/data/PG_VERSION" as the unprivileged runner user. The cluster
# directory is mode 0700 owned by `postgres`, so that test is false, the stop is skipped and `|| true` hides any failure — a green
# cleanup step proved nothing. Here every filesystem probe of the cluster runs with the postgres/root privilege it needs, the stop is
# verified from four independent angles, every outcome is written to cleanup.json, and an unexpected failure exits non-zero.
#
# Isolation: the cluster is a fresh initdb under /var/tmp/gpr2-accept-<run_id>-<attempt>, loopback only, port 54329, cluster_name
# gpr2-p1-isolated, unix socket inside its own directory. The script only ever signals the postmaster whose postmaster.pid names that
# exact data directory and port; it never touches any other PostgreSQL instance (they are recorded before/after as evidence).
#
# Environment:
#   GPR2_EVIDENCE_OUT  evidence directory (required)          GITHUB_RUN_ID / GITHUB_RUN_ATTEMPT  select the cluster root
#   GPR2_PG_MAJOR      PostgreSQL major (default 16)          GPR2_PG_INSTALL=1  apt-install the server packages first (CI)
#   GPR2_PG_CTL_STOP_TIMEOUT  seconds for a fast stop (default 60)
#   GPR2_PG_BIN        test-only override of the binaries directory (must still contain initdb/pg_ctl/postgres)
set -uo pipefail

CMD="${1:-}"
PORT=54329
CLUSTER_NAME=gpr2-p1-isolated
MAJOR="${GPR2_PG_MAJOR:-16}"
[[ "$MAJOR" =~ ^1[4-8]$ ]] || { echo "pg-cluster: unsupported PostgreSQL major '$MAJOR'" >&2; exit 64; }
PG_BIN="${GPR2_PG_BIN:-/usr/lib/postgresql/$MAJOR/bin}"
RUN_ID="${GITHUB_RUN_ID:-}"; ATTEMPT="${GITHUB_RUN_ATTEMPT:-1}"
ROOT="/var/tmp/gpr2-accept-${RUN_ID}-${ATTEMPT}"
OUT="${GPR2_EVIDENCE_OUT:-}"
STOP_TIMEOUT="${GPR2_PG_CTL_STOP_TIMEOUT:-60}"

die() { echo "pg-cluster: $*" >&2; exit 2; }
[[ -n "$OUT" ]] || die 'GPR2_EVIDENCE_OUT is required'
[[ "$ROOT" =~ ^/var/tmp/gpr2-accept-[0-9]+-[0-9]+$ ]] || die "refusing cluster root '$ROOT' (needs numeric GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT)"
[[ "$STOP_TIMEOUT" =~ ^[0-9]+$ ]] || die 'GPR2_PG_CTL_STOP_TIMEOUT must be an integer'
mkdir -p "$OUT/postgres"
DATA="$ROOT/data"
SOCK="$ROOT/socket"
ADMIN_URL="postgresql://postgres:x@127.0.0.1:${PORT}/postgres"

as_pg() { sudo -n -u postgres "$@"; }
priv() { sudo -n "$@"; }
pg_ctl_status() { as_pg "$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; echo $?; }   # 0 running, 3 not running, 4 no/invalid data dir
port_state() { pg_isready -q -h 127.0.0.1 -p "$PORT" -t 3 >/dev/null 2>&1; echo $?; }      # 0 accepting, 1 rejecting, 2 no response
postmasters() {  # every postgres postmaster on the host as "pid<TAB>args", for foreign-instance evidence
  ps -eo pid=,ppid=,args= | awk '$3 ~ /(^|\/)postgres$/ && $0 ~ / -D / {pid=$1; $1="";$2=""; sub(/^ +/,""); print pid "\t" $0}' | sort
}
pid_alive() {  # a zombie awaiting reaping is not a live server
  local st; st="$(ps -o stat= -p "$1" 2>/dev/null | tr -d ' ')"; [[ -n "$st" && "$st" != Z* ]]
}
wait_pid_gone() { local i; for ((i = 0; i < 20; i++)); do pid_alive "$1" || return 0; sleep 0.5; done; return 1; }
json_list() { jq -Rn '[inputs | select(length>0)]'; }

start() {
  if [[ "${GPR2_PG_INSTALL:-0}" == 1 ]]; then
    priv apt-get update -qq || die 'apt-get update failed'
    # shellcheck disable=SC2024 # the log belongs to the runner user, only apt needs root
    priv env DEBIAN_FRONTEND=noninteractive apt-get install -y "postgresql-$MAJOR" "postgresql-client-$MAJOR" > "$OUT/postgres/package-install.log" 2>&1 \
      || die "apt-get install postgresql-$MAJOR failed (see postgres/package-install.log)"
  fi
  for b in initdb pg_ctl postgres; do [[ -x "$PG_BIN/$b" ]] || die "PostgreSQL $MAJOR binary $PG_BIN/$b is unavailable"; done
  for t in pg_isready psql jq; do command -v "$t" >/dev/null || die "$t is required"; done
  priv test -e "$ROOT" && die "cluster root $ROOT already exists: refusing to reuse a stale cluster"
  [[ "$(port_state)" == 2 ]] || die "127.0.0.1:$PORT already answers: refusing to start next to an unknown server"
  postmasters > "$OUT/postgres/foreign-postmasters-before.tsv"

  priv install -d -o postgres -g postgres -m 0700 "$ROOT" "$DATA" "$SOCK" || die 'cannot create cluster directories'
  as_pg "$PG_BIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C.UTF-8 --auth-local=trust --auth-host=trust > "$OUT/postgres/initdb.log" 2>&1 \
    || { as_pg "$PG_BIN/initdb" -D "$DATA" -U postgres -E UTF8 --auth-local=trust --auth-host=trust > "$OUT/postgres/initdb.log" 2>&1 || die 'initdb failed'; }
  as_pg "$PG_BIN/pg_ctl" -D "$DATA" -l "$ROOT/server.log" -w -t 60 \
    -o "-c cluster_name=$CLUSTER_NAME -c port=$PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$SOCK -c timezone=UTC -c fsync=on" start \
    > "$OUT/postgres/pg_ctl-start.log" 2>&1 || die 'pg_ctl start failed'

  # Identity: refuse anything but this run's own cluster before a single test database is created.
  local row cluster addr port db datadir version
  row="$(psql "$ADMIN_URL" -XAt -F '|' -c "SELECT current_setting('cluster_name'), inet_server_addr()::text, current_setting('port'), current_database(), current_setting('data_directory'), current_setting('server_version')" 2>"$OUT/postgres/identity.err")" \
    || die 'cannot query the new cluster'
  IFS='|' read -r cluster addr port db datadir version <<<"$row"
  if [[ "$cluster" != "$CLUSTER_NAME" || ! "$addr" =~ ^127[.]0[.]0[.]1(/32)?$ || "$port" != "$PORT" || "$db" != postgres || "$datadir" != "$DATA" ]]; then
    die "REFUSED: PostgreSQL isolation mismatch ($row)"
  fi
  jq -n --arg cluster "$cluster" --arg addr "$addr" --arg port "$port" --arg db "$db" --arg datadir "$datadir" --arg version "$version" \
        --arg major "$MAJOR" --arg root "$ROOT" --arg pid "$(priv head -1 "$DATA/postmaster.pid")" \
        --arg full "$(psql "$ADMIN_URL" -XAt -c 'SELECT version()')" \
    '{status:"RUNNING_VERIFIED", cluster_name:$cluster, address:$addr, port:($port|tonumber), database:$db, data_directory:$datadir,
      server_version:$version, server_version_full:$full, major:($major|tonumber), root:$root, postmaster_pid:($pid|tonumber), loopback_only:true}' \
    > "$OUT/postgres/identity.json"
  printf '%s|%s|%s|%s\n' "$cluster" "$addr" "$port" "$db" > "$OUT/postgres/identity.txt"
  echo "PostgreSQL isolation verified: cluster=$cluster addr=$addr port=$port db=$db data=$datadir version=$version"
}

stop() {
  local status=FAILED mode=none log_copy=not_applicable pid_file_dir="" pid_file_port="" pid="" problems=() notes=() before after
  postmasters > "$OUT/postgres/postmasters-before-stop.tsv"
  if ! priv test -e "$ROOT"; then
    status=NOT_STARTED
  elif ! priv test -f "$DATA/PG_VERSION"; then
    # The root exists but initdb never completed: nothing can be running from it; remove the remains.
    if priv rm -rf --one-file-system -- "$ROOT" && ! priv test -e "$ROOT"; then status=REMOVED_UNINITIALISED; else problems+=('could not remove incomplete cluster root'); fi
  else
    if priv cat "$ROOT/server.log" > "$OUT/postgres/server.log" 2>/dev/null; then log_copy=ok; else log_copy=failed; problems+=('server log could not be preserved'); fi
    if priv test -f "$DATA/postmaster.pid"; then
      pid="$(priv sed -n 1p "$DATA/postmaster.pid")"; pid_file_dir="$(priv sed -n 2p "$DATA/postmaster.pid")"; pid_file_port="$(priv sed -n 4p "$DATA/postmaster.pid")"
      if [[ "$pid_file_dir" != "$DATA" || "$pid_file_port" != "$PORT" ]]; then
        problems+=("postmaster.pid names $pid_file_dir:$pid_file_port, not $DATA:$PORT — refusing to signal it")
      fi
    fi
    if [[ -n "$pid_file_dir" && ( "$pid_file_dir" != "$DATA" || "$pid_file_port" != "$PORT" ) ]]; then
      : # refused above: never signal or delete a cluster that is not provably ours
    else
      case "$(pg_ctl_status)" in
        0) if as_pg "$PG_BIN/pg_ctl" -D "$DATA" -m fast -w -t "$STOP_TIMEOUT" stop > "$OUT/postgres/pg_ctl-stop.log" 2>&1; then mode=fast
           else notes+=("fast stop did not complete within ${STOP_TIMEOUT}s; escalated to immediate")
                if as_pg "$PG_BIN/pg_ctl" -D "$DATA" -m immediate -w -t 30 stop >> "$OUT/postgres/pg_ctl-stop.log" 2>&1; then mode=immediate; else mode=failed; problems+=('immediate stop failed'); fi
           fi ;;
        3) mode=already_stopped
           if priv test -e "$DATA/postmaster.pid" && [[ -n "$pid" ]] && ! pid_alive "$pid"; then
             notes+=("stale postmaster.pid of a server that is no longer running (pid $pid) was removed")
             priv rm -f -- "$DATA/postmaster.pid" || problems+=('could not remove stale postmaster.pid')
           fi ;;
        *) mode=unknown; problems+=("pg_ctl status could not read $DATA") ;;
      esac
      # Verification from independent angles; each must agree that THIS cluster is gone.
      [[ "$(pg_ctl_status)" == 3 ]] || problems+=('pg_ctl status still reports a server (or cannot read the data directory)')
      ! priv test -e "$DATA/postmaster.pid" || problems+=('postmaster.pid still present')
      if [[ -n "$pid" ]] && ! wait_pid_gone "$pid"; then problems+=("postmaster pid $pid is still alive 10s after stop"); fi
      [[ "$(port_state)" == 2 ]] || problems+=("127.0.0.1:$PORT still answers")
      ! postmasters | grep -F -- "-D $DATA" >/dev/null || problems+=('a postgres process still serves the data directory')
      if [[ ${#problems[@]} -eq 0 ]]; then
        if priv rm -rf --one-file-system -- "$ROOT" && ! priv test -e "$ROOT"; then
          if [[ "$mode" == immediate ]]; then status=STOPPED_VERIFIED_AFTER_ESCALATION; else status=STOPPED_VERIFIED; fi
        else problems+=("cluster root $ROOT could not be removed"); fi
      fi
    fi
  fi
  postmasters > "$OUT/postgres/postmasters-after-stop.tsv"
  before="$(grep -vF -- "-D $DATA" "$OUT/postgres/postmasters-before-stop.tsv" | sort)"; after="$(grep -vF -- "-D $DATA" "$OUT/postgres/postmasters-after-stop.tsv" | sort)"
  local foreign_untouched=true; [[ "$before" == "$after" ]] || foreign_untouched=false
  [[ "$foreign_untouched" == true ]] || problems+=('the set of other PostgreSQL instances changed during cleanup')
  if [[ "$status" == STOPPED_VERIFIED* && "$foreign_untouched" != true ]]; then status=FAILED; fi
  if ((${#problems[@]})); then printf '%s\n' "${problems[@]}"; fi | json_list > "$OUT/postgres/cleanup-problems.json"
  if ((${#notes[@]})); then printf '%s\n' "${notes[@]}"; fi | json_list > "$OUT/postgres/cleanup-notes.json"
  jq -n --arg status "$status" --arg mode "$mode" --arg root "$ROOT" --arg log "$log_copy" --argjson foreign "$foreign_untouched" \
        --arg root_exists "$(priv test -e "$ROOT" && echo true || echo false)" --arg port_state "$(port_state)" \
        --slurpfile problems "$OUT/postgres/cleanup-problems.json" --slurpfile notes "$OUT/postgres/cleanup-notes.json" --arg at "$(date -u +%FT%TZ)" \
    '{status:$status, stop_mode:$mode, root:$root, root_exists_after:($root_exists=="true"), port_54329_pg_isready_exit:($port_state|tonumber),
      server_log_copy:$log, foreign_instances_untouched:$foreign, problems:$problems[0], notes:$notes[0], verified_at:$at}' > "$OUT/postgres/cleanup.json"
  rm -f "$OUT/postgres/cleanup-problems.json" "$OUT/postgres/cleanup-notes.json"
  echo "PostgreSQL cleanup: $status (mode=$mode)"
  if ((${#problems[@]})); then printf '  - %s\n' "${problems[@]}"; fi
  case "$status" in STOPPED_VERIFIED|STOPPED_VERIFIED_AFTER_ESCALATION|NOT_STARTED|REMOVED_UNINITIALISED) return 0 ;; *) return 1 ;; esac
}

status() {
  local exists=false running=unknown; priv test -e "$ROOT" && exists=true
  [[ "$exists" == true ]] && running="$(pg_ctl_status)"
  jq -n --arg root "$ROOT" --argjson exists "$exists" --arg pg_ctl "$running" --arg port "$(port_state)" '{root:$root, root_exists:$exists, pg_ctl_status:$pg_ctl, pg_isready_exit:($port|tonumber)}'
}

case "$CMD" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) echo 'usage: pg-cluster.sh start|stop|status' >&2; exit 64 ;;
esac
