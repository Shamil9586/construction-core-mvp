#!/usr/bin/env bash
# Construction Core — GPR-2 CI Foundation: disposable native PostgreSQL cluster lifecycle (start | stop | status).
#
# Corrects F-CI-01 (LOW): the frozen R04 postgres-stop.sh tested "$ROOT/data/PG_VERSION" as the unprivileged runner user. The cluster
# directory is mode 0700 owned by `postgres`, so that test is false, the stop is skipped and `|| true` hides any failure — a green
# cleanup step proved nothing. Here every filesystem probe of the cluster runs with the postgres/root privilege it needs, the stop is
# verified from four independent angles, every outcome is written to cleanup.json, and an unexpected failure exits non-zero.
#
# Isolation: the cluster is a fresh initdb under /var/tmp/gpr2-accept-<run_id>-<attempt>, loopback only, port 54329, cluster_name
# gpr2-p1-isolated, unix socket inside its own directory. The script only ever signals a postmaster proven to serve that exact data
# directory (cwd, -D, binary, recorded start time; see owned_scan) and whose postmaster.pid, if present, agrees; it never touches any
# other PostgreSQL instance (they are recorded before/after as evidence). Ambiguous ownership fails closed.
#
# Environment:
#   GPR2_EVIDENCE_OUT  evidence directory (required)          GITHUB_RUN_ID / GITHUB_RUN_ATTEMPT  select the cluster root
#   GPR2_PG_MAJOR      PostgreSQL major (default 16)          GPR2_PG_INSTALL=1  apt-install the server packages first (CI)
#   GPR2_PG_CTL_STOP_TIMEOUT  seconds to wait for a fast (SIGINT) shutdown before escalating to immediate (default 60)
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
owned_json() { jq -Rn '[inputs | select(length>0) | split("\t") | {pid: (.[0]|tonumber), role: .[1], cwd: (.[2] // ""), start_ticks: (.[3] // ""), boot_id: (.[4] // ""), exe: (.[5] // ""), argv: ((.[6] // "") | if . == "" then [] else split("\u001f") end)}]' <<<"$1"; }
cmdline_us() { priv bash -c 'mapfile -d "" -t a < "/proc/$1/cmdline" && printf "%s\037" "${a[@]}"' _ "$1"; }   # argv of a pid, each element terminated by US (0x1f)
proc_ticks() { local s f; s="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1; s="${s##*) }"; read -ra f <<<"$s"; printf '%s' "${f[19]:-}"; }   # starttime (clock ticks since boot)

# Ownership is proven from the process table and the exact cluster root, never from files, a port or an argument (F-CI-02, R1, C1).
# `-D` names the CONFIGURATION directory: a foreign cluster can use $DATA only for its config files while its real data_directory is
# elsewhere. So a postgres whose argv has `-D $DATA` is NOT thereby ours. The kernel-truth of a postmaster's effective data directory is its
# cwd (it chdir()s into it). A process may be SIGNALLED only as role `postmaster`, which requires the COMPLETE start-up identity that start()
# recorded to be present and to match what is observed — a missing field is a failure to prove, never an optional match:
#   recorded pid, process start time (clock ticks), Linux boot id, executable path, exact argv; observed: postgres binary, `-D $DATA`, cwd == $DATA
#   (an unlinked directory shows as "(deleted)"). Roles:
#   postmaster             all of the above match
#   postmaster_unverified  serves $DATA (postgres, -D, cwd) but the identity is absent / incomplete / different (restart, pid reuse, nothing
#                          recorded): present, NEVER signalled, blocks every removal
#   member                 cwd inside $ROOT (backends / auxiliaries, or anything else holding the root)
#   config_only            names `-D $DATA` but is not provably serving it (cwd elsewhere): possibly a FOREIGN cluster. Ambiguous: never
#                          signalled, never assumed ours, and its presence blocks every removal.
# Output: "pid<TAB>role<TAB>cwd<TAB>start_ticks<TAB>boot_id<TAB>exe<TAB>argv(US-joined)". Exit non-zero when the scan itself is unreliable
# (callers must then fail closed). `kill <pid> <SIG>` re-classifies the pid and signals it inside the SAME privileged process, only when it
# is at that instant a verified postmaster (exit 4 otherwise), so the check-to-signal window is microseconds, not a round trip.
SCAN_SRC=$(cat <<'SCAN'
root="$1"; data="$2"; rpid="$3"; rticks="$4"; rboot="$5"; rexe="$6"; rargv="$7"; action="${8:-list}"; target="${9:-}"; sig="${10:-}"
readlink "/proc/$$/cwd" >/dev/null 2>&1 || exit 3
boot="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)" || boot=""
complete=0; [[ "$rpid" =~ ^[0-9]+$ && "$rticks" =~ ^[0-9]+$ && -n "$rboot" && "${rexe##*/}" == postgres && -n "$rargv" && -n "$boot" ]] && complete=1
classify() {
  local d="/proc/$1" cwd exe st f ticks argvj i named=0 role="" argv=()
  cwd="$(readlink "$d/cwd" 2>/dev/null)" || cwd=""; cwd="${cwd% (deleted)}"
  exe="$(readlink "$d/exe" 2>/dev/null)" || exe=""; exe="${exe% (deleted)}"
  st="$(cat "$d/stat" 2>/dev/null)" || st=""; st="${st##*) }"; read -ra f <<<"$st"; ticks="${f[19]:-}"
  { mapfile -d '' -t argv < "$d/cmdline"; } 2>/dev/null || argv=()
  argvj="$(IFS=$'\037'; printf '%s' "${argv[*]}")"
  if [[ "${argv[0]##*/}" == postgres ]]; then
    for ((i = 1; i < ${#argv[@]}; i++)); do
      if [[ "${argv[i]}" == "-D" && "${argv[i+1]:-}" == "$data" ]] || [[ "${argv[i]}" == "-D$data" ]]; then named=1; fi
    done
  fi
  if ((named)); then
    if [[ "${exe##*/}" == postgres && "$cwd" == "$data" ]]; then
      role=postmaster_unverified
      if ((complete)) && [[ "$1" == "$rpid" && "$ticks" == "$rticks" && "$boot" == "$rboot" && "$exe" == "$rexe" && "$argvj" == "$rargv" ]]; then role=postmaster; fi
    else role=config_only; fi
  elif [[ "$cwd" == "$root" || "$cwd" == "$root"/* ]]; then role=member; fi
  [[ -n "$role" ]] && printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$role" "$cwd" "$ticks" "$boot" "$exe" "$argvj"
  return 0
}
if [[ "$action" == kill ]]; then
  [[ "$target" =~ ^[0-9]+$ && "$sig" =~ ^(INT|QUIT)$ ]] || exit 64
  out="$(classify "$target")"
  [[ "${out%%$'\t'*}" == postmaster ]] || exit 4
  kill -"$sig" "$target" 2>/dev/null || exit 5
  exit 0
fi
for d in /proc/[0-9]*; do
  pid="${d#/proc/}"; [ "$pid" = "$$" ] && continue
  out="$(classify "$pid")"
  [[ -n "$out" ]] && printf '%s\t%s\n' "$pid" "$out"
done
exit 0
SCAN
)
REC_PID=""; REC_TICKS=""; REC_BOOT=""; REC_EXE=""; REC_ARGV=""   # recorded start-up identity (stop() fills them ONLY from a complete identity.json)
run_scan() { priv bash -c "$SCAN_SRC" scan "$ROOT" "$DATA" "$REC_PID" "$REC_TICKS" "$REC_BOOT" "$REC_EXE" "$REC_ARGV" "$@"; }
owned_scan() { run_scan list; }
only_owned() { awk -F'\t' 'NF && $2 != "config_only"' <<<"$1"; }
only_ambiguous() { awk -F'\t' '$2 == "config_only"' <<<"$1"; }
only_unverified() { awk -F'\t' '$2 == "postmaster_unverified"' <<<"$1"; }
owned_postmasters() { awk -F'\t' '$2 == "postmaster" {print $1}' <<<"$1"; }
owned_pid_list() { awk -F'\t' 'NF {printf "%s%s(%s)", sep, $1, $2; sep = " "}' <<<"$1"; }
wait_owned_gone() {  # poll until no process is tied to the root (children of a killed postmaster need a moment); prints the last scan
  local i s
  for ((i = 0; i < 20; i++)); do s="$(owned_scan)" || return 1; [[ -z "$(only_owned "$s")" ]] && break; sleep 0.5; done
  printf '%s' "$s"
}
listener_pids() {  # pids LISTENing on the port (empty when it cannot be determined)
  local out=""
  if command -v ss >/dev/null; then out="$(priv ss -H -ltnp "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2)"; fi
  if [[ -z "$out" ]] && command -v lsof >/dev/null; then out="$(priv lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null)"; fi
  sort -u <<<"$out" | xargs echo
}
# A port that answers is an observation to interpret, never proof of ownership. $1 = owned_scan output.
# Sets RESP_EXIT (pg_isready), RESP = none | owned | foreign | unknown, RESP_DETAIL.
observe_port() {
  local lp l dd
  RESP_EXIT="$(port_state)"; RESP_DETAIL=""
  if [[ "$RESP_EXIT" == 2 ]]; then RESP=none; RESP_DETAIL="nothing answers on 127.0.0.1:$PORT"; return; fi
  lp="$(listener_pids)"
  if [[ -n "$lp" ]]; then
    for l in $lp; do
      if awk -F'\t' -v p="$l" '$1 == p {f = 1} END {exit !f}' <<<"$1"; then RESP=owned; RESP_DETAIL="listener pid $l is tied to $ROOT"; return; fi
    done
    RESP=foreign; RESP_DETAIL="listener pid(s) $lp are not tied to $ROOT"; return
  fi
  dd="$(PGCONNECT_TIMEOUT=3 psql "$ADMIN_URL" -XAt -c "SELECT current_setting('data_directory')" 2>/dev/null)" || dd=""
  if [[ "$dd" == "$DATA" ]]; then RESP=owned; RESP_DETAIL="the responding server reports our data_directory"
  elif [[ -n "$dd" ]]; then RESP=foreign; RESP_DETAIL="the responding server reports data_directory $dd"
  else RESP=unknown; RESP_DETAIL="the listener could not be identified (no listener pid, no readable data_directory)"; fi
}
SIGNALLED=""
# $1 = pid. The only way this script ever stops a server (pg_ctl stop is NOT used: it resolves the data directory from the configuration, which
# is exactly what a foreign cluster can point at $DATA). Each signal is sent by run_scan only if the pid is, at that instant, a verified
# postmaster of this root; a pid that was reused, restarted or is not provably ours is never signalled. Sets SIGNALLED=INT|QUIT.
signal_owned_postmaster() {
  local p="$1" sig i n
  for sig in INT QUIT; do
    run_scan kill "$p" "$sig" || { pid_alive "$p" && return 1; return 0; }
    SIGNALLED="$sig"
    if [[ "$sig" == INT ]]; then n=$((STOP_TIMEOUT * 2)); else n=30; fi
    for ((i = 0; i < n; i++)); do pid_alive "$p" || return 0; sleep 0.5; done
  done
  ! pid_alive "$p"
}

# Evidence that a start was attempted and did not complete (C2). $1 phase, $2 true|false = the server launch (pg_ctl start) was already issued, $3 reason.
# stop() reads it: a launched-but-unverified start is never treated as "never started", and no RUNNING_VERIFIED is ever issued for it.
start_fail() {
  jq -n --arg phase "$1" --argjson launched "$2" --arg reason "$3" --arg root "$ROOT" --arg at "$(date -u +%FT%TZ)"     '{status:"START_FAILED", phase:$phase, server_launch_issued:$launched, reason:$reason, root:$root, at:$at}' > "$OUT/postgres/startup-failure.json" 2>/dev/null
  die "$3"
}

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

  priv install -d -o postgres -g postgres -m 0700 "$ROOT" "$DATA" "$SOCK" || start_fail ROOT_CREATE false 'cannot create cluster directories'
  as_pg "$PG_BIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C.UTF-8 --auth-local=trust --auth-host=trust > "$OUT/postgres/initdb.log" 2>&1 \
    || { as_pg "$PG_BIN/initdb" -D "$DATA" -U postgres -E UTF8 --auth-local=trust --auth-host=trust > "$OUT/postgres/initdb.log" 2>&1 || start_fail INITDB false 'initdb failed'; }
  as_pg "$PG_BIN/pg_ctl" -D "$DATA" -l "$ROOT/server.log" -w -t 60 \
    -o "-c cluster_name=$CLUSTER_NAME -c port=$PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$SOCK -c timezone=UTC -c fsync=on" start \
    > "$OUT/postgres/pg_ctl-start.log" 2>&1 || start_fail SERVER_START true 'pg_ctl start failed'

  # Identity: refuse anything but this run's own cluster before a single test database is created.
  local row cluster addr port db datadir version
  row="$(psql "$ADMIN_URL" -XAt -F '|' -c "SELECT current_setting('cluster_name'), inet_server_addr()::text, current_setting('port'), current_database(), current_setting('data_directory'), current_setting('server_version')" 2>"$OUT/postgres/identity.err")" \
    || start_fail IDENTITY_QUERY true 'cannot query the new cluster'
  IFS='|' read -r cluster addr port db datadir version <<<"$row"
  if [[ "$cluster" != "$CLUSTER_NAME" || ! "$addr" =~ ^127[.]0[.]0[.]1(/32)?$ || "$port" != "$PORT" || "$db" != postgres || "$datadir" != "$DATA" ]]; then
    start_fail IDENTITY_MISMATCH true "REFUSED: PostgreSQL isolation mismatch ($row)"
  fi
  # Process identity (C1): RUNNING_VERIFIED is only ever written with ALL fields present and observed to agree with each other, because stop()
  # will signal nothing it cannot match against them: pid, start time, boot id, executable, exact argv, effective data directory (cwd).
  local pmpid ticks boot exe pcwd argv_us
  pmpid="$(priv head -1 "$DATA/postmaster.pid" 2>/dev/null)"; [[ "$pmpid" =~ ^[0-9]+$ ]] || start_fail PROCESS_IDENTITY true "postmaster.pid has no usable pid ('$pmpid')"
  ticks="$(proc_ticks "$pmpid")"; [[ "$ticks" =~ ^[0-9]+$ ]] || start_fail PROCESS_IDENTITY true "cannot read the start time of postmaster pid $pmpid"
  boot="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)"; [[ -n "$boot" ]] || start_fail PROCESS_IDENTITY true 'cannot read the Linux boot id'
  exe="$(priv readlink "/proc/$pmpid/exe" 2>/dev/null)"; pcwd="$(priv readlink "/proc/$pmpid/cwd" 2>/dev/null)"; argv_us="$(cmdline_us "$pmpid")"
  [[ "${exe##*/}" == postgres && "$pcwd" == "$DATA" && -n "$argv_us" ]] || start_fail PROCESS_IDENTITY true "postmaster pid $pmpid is not the expected postgres serving $DATA (exe '$exe', cwd '$pcwd')"
  jq -n --arg argv_us "$argv_us" --arg d "$DATA" '($argv_us | split("\u001f") | .[:-1]) as $a | ($a | index("-D")) as $i | $i != null and $a[$i + 1] == $d' | grep -qx true \
    || start_fail PROCESS_IDENTITY true "postmaster pid $pmpid was not started with -D $DATA"
  jq -n --arg cluster "$cluster" --arg addr "$addr" --arg port "$port" --arg db "$db" --arg datadir "$datadir" --arg version "$version" \
        --arg major "$MAJOR" --arg root "$ROOT" --arg pid "$pmpid" --arg ticks "$ticks" --arg boot "$boot" --arg exe "$exe" --arg pcwd "$pcwd" --arg argv_us "$argv_us" \
        --arg full "$(psql "$ADMIN_URL" -XAt -c 'SELECT version()')" \
    '{status:"RUNNING_VERIFIED", cluster_name:$cluster, address:$addr, port:($port|tonumber), database:$db, data_directory:$datadir,
      server_version:$version, server_version_full:$full, major:($major|tonumber), root:$root, loopback_only:true,
      postmaster_pid:($pid|tonumber), postmaster_start_ticks:$ticks, boot_id:$boot, postmaster_exe:$exe, postmaster_cwd:$pcwd,
      postmaster_argv:($argv_us | split("\u001f") | .[:-1])}' > "$OUT/postgres/identity.json.tmp" \
    && mv -f "$OUT/postgres/identity.json.tmp" "$OUT/postgres/identity.json" || start_fail PROCESS_IDENTITY true 'could not write identity.json'
  printf '%s|%s|%s|%s\n' "$cluster" "$addr" "$port" "$db" > "$OUT/postgres/identity.txt"
  echo "PostgreSQL isolation verified: cluster=$cluster addr=$addr port=$port db=$db data=$datadir version=$version postmaster=$pmpid"
}

list_json() { if (($#)); then printf '%s\n' "$@"; fi | json_list; }
cleanup_succeeded() { case "$1" in STOPPED_VERIFIED|STOPPED_VERIFIED_AFTER_ESCALATION|NOT_STARTED|REMOVED_UNINITIALISED) return 0 ;; *) return 1 ;; esac; }

# Status vocabulary (classify.mjs evaluateCleanup enforces the same table on the evidence this writes):
#   STOPPED_VERIFIED[_AFTER_ESCALATION]  a cluster existed; its termination is proven (stopped here, or a stale postmaster.pid of a dead pid, or an earlier verified stop)
#   NOT_STARTED            no cluster root, no startup evidence, no process tied to the root (a foreign listener on the port is irrelevant)
#   REMOVED_UNINITIALISED  root without PG_VERSION, no startup evidence, no postmaster.pid, no process tied to the root, port not answered by us
#   FAILED                 anything else. The root is deleted only when every proof held; otherwise it is preserved with the evidence.
stop() {
  local status=FAILED mode=none method=none termination=not_applicable log_copy=not_applicable
  local pid_file_dir="" pid_file_port="" pid="" problems=() notes=() proof=() pms=() before after pm
  local startup=NONE recorded_pid="" prior_status="" root_before=false version_before=false pidfile_before=false
  local scan=ok owned_before="" owned_now="" owned_after="" refused=false uninit=false stopped_here=false
  local scan_out="" ambig_before="" ambig_after="" unverified="" own_ids=""
  local id_state=ABSENT id_missing=() idj="" signals=() stale_pid="" exited
  local resp_before resp_before_detail resp_before_exit resp_after resp_after_detail resp_after_exit

  # Evidence that exists BEFORE this cleanup touches anything: the start-up identity, whether a start was attempted, any earlier cleanup record.
  # id_state: ABSENT (no identity.json) | COMPLETE | INCOMPLETE (a field is missing or invalid) | CORRUPT (unparsable, not an object, wrong status
  # or naming another cluster). Only COMPLETE feeds REC_*, i.e. only COMPLETE can ever make a process signal-eligible (C1).
  if [[ -e "$OUT/postgres/identity.json" ]]; then
    if idj="$(jq -c . "$OUT/postgres/identity.json" 2>/dev/null)" && [[ "$(jq -r type <<<"$idj")" == object ]]; then
      startup="$(jq -r 'if .status == "RUNNING_VERIFIED" then "RUNNING_VERIFIED" else "IDENTITY_UNREADABLE" end' <<<"$idj")"
      mapfile -t id_missing < <(jq -r --arg root "$ROOT" --arg data "$DATA" --argjson port "$PORT" '
        [ (if .status == "RUNNING_VERIFIED" then empty else "status" end),
          (if (.postmaster_pid | type) == "number" and .postmaster_pid > 0 and (.postmaster_pid | floor) == .postmaster_pid then empty else "postmaster_pid" end),
          (if (.postmaster_start_ticks | type) == "string" and (.postmaster_start_ticks | test("^[0-9]+$")) then empty else "postmaster_start_ticks" end),
          (if (.boot_id | type) == "string" and (.boot_id | length) > 0 then empty else "boot_id" end),
          (if (.postmaster_exe | type) == "string" and ((.postmaster_exe | split("/") | last) == "postgres") then empty else "postmaster_exe" end),
          (if (.postmaster_argv | type) == "array" and (.postmaster_argv | length) > 0 and all(.postmaster_argv[]; type == "string") and ((.postmaster_argv | index("-D")) as $i | $i != null and .postmaster_argv[$i + 1] == $data) then empty else "postmaster_argv" end),
          (if .data_directory == $data then empty else "data_directory" end),
          (if .root == $root then empty else "root" end),
          (if .port == $port then empty else "port" end) ] | .[]' <<<"$idj")
      if ((${#id_missing[@]} == 0)); then id_state=COMPLETE
      elif printf '%s\n' "${id_missing[@]}" | grep -qxE 'status|data_directory|root|port'; then id_state=CORRUPT; else id_state=INCOMPLETE; fi
    else startup=IDENTITY_UNREADABLE; id_state=CORRUPT; id_missing=(unparsable); fi
    if [[ "$id_state" == COMPLETE ]]; then
      recorded_pid="$(jq -r .postmaster_pid <<<"$idj")"; REC_PID="$recorded_pid"; REC_TICKS="$(jq -r .postmaster_start_ticks <<<"$idj")"; REC_BOOT="$(jq -r .boot_id <<<"$idj")"
      REC_EXE="$(jq -r .postmaster_exe <<<"$idj")"; REC_ARGV="$(jq -r '.postmaster_argv | join("\u001f")' <<<"$idj")"
    fi
  elif [[ -e "$OUT/postgres/pg_ctl-start.log" ]] || jq -e '.server_launch_issued == true' "$OUT/postgres/startup-failure.json" >/dev/null 2>&1; then startup=START_ATTEMPTED_UNVERIFIED; fi
  prior_status="$(jq -r '.status // empty' "$OUT/postgres/cleanup.json" 2>/dev/null)" || prior_status=""

  postmasters > "$OUT/postgres/postmasters-before-stop.tsv"
  priv test -e "$ROOT" && root_before=true
  priv test -f "$DATA/PG_VERSION" && version_before=true
  priv test -f "$DATA/postmaster.pid" && pidfile_before=true
  if scan_out="$(owned_scan)"; then :; else scan=failed; scan_out=""; problems+=('process-ownership scan failed: cannot establish that no owned postmaster is running'); fi
  owned_before="$(only_owned "$scan_out")"; ambig_before="$(only_ambiguous "$scan_out")"; unverified="$(only_unverified "$scan_out")"
  own_ids="$(awk -F'\t' 'NF {printf "%s ", $1}' <<<"$owned_before")"
  observe_port "$owned_before"; resp_before="$RESP"; resp_before_detail="$RESP_DETAIL"; resp_before_exit="$RESP_EXIT"

  if [[ "$scan" == failed ]]; then
    : # fail closed: nothing is signalled or deleted without a reliable view of the process table
  elif [[ -n "$ambig_before" ]]; then
    problems+=("process(es) $(owned_pid_list "$ambig_before") name -D $DATA but their working directory (the effective data_directory) is elsewhere: possibly a foreign cluster using this directory for configuration only. Ownership is not established; nothing was signalled or deleted")
  elif [[ -n "$unverified" ]]; then
    problems+=("postmaster $(owned_pid_list "$unverified") serves $DATA but its identity cannot be proven against the recorded start-up identity (state $id_state${id_missing[*]:+, missing/invalid: ${id_missing[*]}}; recorded pid ${REC_PID:-none}, start time ${REC_TICKS:-none}): it is never signalled on an unproven identity. Data directory preserved. Recovery: confirm by hand that this process is yours (\`sudo ls -l /proc/<pid>/cwd\`), stop it with \`sudo -u postgres pg_ctl -D $DATA -m fast stop\`, then re-run the cleanup or delete $ROOT")
  elif [[ "$root_before" == false ]]; then
    if [[ -n "$owned_before" ]]; then
      problems+=("cluster root $ROOT does not exist but process(es) tied to it are running ($(owned_pid_list "$owned_before")); not signalled, nothing to verify them against")
    elif [[ "$resp_before" == owned ]]; then
      problems+=("cluster root $ROOT does not exist but 127.0.0.1:$PORT is answered by this cluster ($resp_before_detail)")
    elif [[ "$startup" == NONE ]]; then
      status=NOT_STARTED
      [[ "$resp_before" == none ]] || notes+=("127.0.0.1:$PORT answers ($resp_before: $resp_before_detail) but no cluster was started here; nothing was touched")
    elif [[ "$prior_status" == STOPPED_VERIFIED* && "$id_state" == COMPLETE ]]; then
      status=STOPPED_VERIFIED; mode=already_stopped; termination=prior_verified_stop
      proof+=("an earlier cleanup of this run recorded $prior_status; the root is gone and no process is tied to it")
    else
      problems+=("startup evidence is $startup but cluster root $ROOT is gone and no earlier verified stop is recorded: shutdown cannot be proven")
    fi
  else
    if priv test -e "$ROOT/server.log"; then
      if priv cat "$ROOT/server.log" > "$OUT/postgres/server.log" 2>/dev/null; then log_copy=ok; else log_copy=failed; problems+=('server log could not be preserved'); fi
    elif [[ "$startup" == RUNNING_VERIFIED ]]; then log_copy=failed; problems+=('server log is missing although the server was verified running')
    else log_copy=absent; notes+=('no server log exists: the server was never launched from this root'); fi
    if [[ "$pidfile_before" == true ]]; then
      pid="$(priv sed -n 1p "$DATA/postmaster.pid")"; pid_file_dir="$(priv sed -n 2p "$DATA/postmaster.pid")"; pid_file_port="$(priv sed -n 4p "$DATA/postmaster.pid")"
      if [[ "$pid_file_dir" != "$DATA" || "$pid_file_port" != "$PORT" ]]; then
        problems+=("postmaster.pid names $pid_file_dir:$pid_file_port, not $DATA:$PORT — refusing to signal it"); refused=true
      elif [[ ! "$pid" =~ ^[0-9]+$ ]]; then
        problems+=("postmaster.pid has no usable pid ('$pid') — refusing to signal anything"); refused=true
      elif pid_alive "$pid" && ! owned_postmasters "$owned_before" | grep -qx -- "$pid"; then
        problems+=("postmaster.pid names live pid $pid, which is not provably this cluster's postmaster — refusing to signal it"); refused=true
      fi
    fi

    if [[ "$refused" == true ]]; then
      : # never signal or delete a cluster that is not provably ours
    elif [[ "$version_before" == false && "$startup" == NONE && "$pidfile_before" == false && -z "$owned_before" && ( "$resp_before" == none || "$resp_before" == foreign ) ]]; then
      # initdb never completed AND nothing shows a server ever started from here AND the process table is clean: only now is "uninitialised" a fact.
      uninit=true
      proof+=("PG_VERSION absent, no postmaster.pid, no startup evidence, no process tied to $ROOT, 127.0.0.1:$PORT not answered by this cluster ($resp_before)")
      [[ "$resp_before" == none ]] || notes+=("127.0.0.1:$PORT is answered by a foreign instance ($resp_before_detail); it was not touched")
    else
      [[ "$version_before" == true ]] || notes+=("PG_VERSION is absent: pg_ctl refuses this directory, so only the process table decides whether a server runs")
      # Stop exactly the postmaster the process table proves is ours (cwd == $DATA, -D, exe, recorded start time), re-proven inside the privileged
      # process that sends each signal. pg_ctl stop is deliberately not used: it resolves the data directory from configuration a foreign cluster
      # can point at us. Never by port, never by name, never an unverified pid.
      mode=already_stopped
      if scan_out="$(owned_scan)"; then
        owned_now="$(only_owned "$scan_out")"
        mapfile -t pms < <(owned_postmasters "$owned_now")
        for pm in "${pms[@]}"; do
          SIGNALLED=""
          if [[ "$pidfile_before" == true && "$pid" != "$pm" ]]; then
            mode=failed; problems+=("postmaster.pid names pid $pid but the verified postmaster is $pm: inconsistent, refusing to signal")
          elif signal_owned_postmaster "$pm"; then
            signals+=("$pm $SIGNALLED true")
            method=signal; stopped_here=true
            if [[ "$SIGNALLED" == QUIT ]]; then mode=immediate; notes+=("SIGINT (fast shutdown) of pid $pm did not finish within ${STOP_TIMEOUT}s; escalated to SIGQUIT (immediate)"); else mode=fast; fi
            notes+=("verified postmaster pid $pm was signalled directly (SIG$SIGNALLED) after its cwd, -D argument, binary and recorded start time matched $DATA")
            proof+=("verified postmaster pid $pm exited after SIG$SIGNALLED")
          else signals+=("$pm ${SIGNALLED:-none} false"); mode=failed; problems+=("owned postmaster pid $pm did not stop (or is no longer provably ours); data directory preserved"); fi
        done
      else scan=failed; problems+=('process-ownership scan failed before the stop'); fi
      [[ "$stopped_here" != true ]] || termination=stopped_by_cleanup

      if priv test -e "$DATA/postmaster.pid" && [[ "$pid" =~ ^[0-9]+$ ]] && ! pid_alive "$pid"; then
        notes+=("stale postmaster.pid of a server that is no longer running (pid $pid) was removed")
        priv rm -f -- "$DATA/postmaster.pid" || problems+=('could not remove stale postmaster.pid')
        proof+=("postmaster.pid named pid $pid, which is not alive")
        stale_pid="$pid"
        if [[ "$id_state" == COMPLETE && "$pid" == "$REC_PID" ]]; then [[ "$termination" != not_applicable ]] || termination=stale_pidfile_dead_pid
        else notes+=("the stale pid $pid is not evidence of termination: it does not match a complete recorded identity (state $id_state, recorded pid ${REC_PID:-none})"); fi
      fi
      # Verification from independent angles; each must agree that THIS cluster is gone.
      if [[ "$version_before" == true ]]; then [[ "$(pg_ctl_status)" == 3 ]] || problems+=('pg_ctl status still reports a server (or cannot read the data directory)'); fi
      ! priv test -e "$DATA/postmaster.pid" || problems+=('postmaster.pid still present')
      if [[ "$pid" =~ ^[0-9]+$ ]] && ! wait_pid_gone "$pid"; then problems+=("postmaster pid $pid is still alive 10s after stop"); fi
      if scan_out="$(wait_owned_gone)"; then
        owned_now="$(only_owned "$scan_out")"
        [[ -z "$owned_now" ]] || problems+=("process(es) tied to the cluster root are still running: $(owned_pid_list "$owned_now")")
        [[ -z "$(only_ambiguous "$scan_out")" ]] || problems+=("process(es) $(owned_pid_list "$(only_ambiguous "$scan_out")") name -D $DATA but are not provably serving it; ownership not established")
      else scan=failed; owned_now=""; problems+=('process-ownership scan failed after the stop'); fi
      observe_port "$owned_now"
      case "$RESP" in
        owned)   problems+=("127.0.0.1:$PORT is still answered by this cluster ($RESP_DETAIL)") ;;
        unknown) problems+=("127.0.0.1:$PORT still answers and its owner cannot be established ($RESP_DETAIL); not treated as ours, not signalled, not assumed foreign") ;;
        foreign) notes+=("127.0.0.1:$PORT is answered by a foreign instance ($RESP_DETAIL); it was not touched") ;;
      esac
      if [[ -n "$recorded_pid" ]] && pid_alive "$recorded_pid" && [[ -z "$owned_now" ]]; then
        notes+=("recorded postmaster pid $recorded_pid is alive but not tied to this cluster (pid reused); it was not signalled")
      fi
      # Earlier evidence of a running server is never closed by absence of files: it needs a stop performed here or independent evidence of death.
      case "$startup" in
        RUNNING_VERIFIED|IDENTITY_UNREADABLE)
          [[ "$id_state" == COMPLETE ]] || problems+=("startup identity is $id_state${id_missing[*]:+ (missing/invalid: ${id_missing[*]})}: which process was started, and therefore whether it is gone, cannot be proven")
          [[ "$termination" != not_applicable ]] || problems+=("startup evidence is $startup but no stop was performed here and nothing independently evidences its termination (a missing PG_VERSION or postmaster.pid is not proof): shutdown cannot be proven") ;;
      esac
      if [[ "$version_before" == false && "$termination" == not_applicable ]]; then
        problems+=("PG_VERSION is absent and the cluster is not provably uninitialised (startup evidence $startup, postmaster.pid $pidfile_before, port: $resp_before — $resp_before_detail); data directory preserved")
      fi
      if ((${#problems[@]} == 0)); then proof+=("process table: no process is tied to $ROOT after the stop"); fi
    fi

    if [[ ${#problems[@]} -eq 0 ]]; then
      if priv rm -rf --one-file-system -- "$ROOT" && ! priv test -e "$ROOT"; then
        if [[ "$uninit" == true ]]; then status=REMOVED_UNINITIALISED
        elif [[ "$mode" == immediate ]]; then status=STOPPED_VERIFIED_AFTER_ESCALATION; else status=STOPPED_VERIFIED; fi
      else problems+=("cluster root $ROOT could not be removed"); fi
    fi
  fi

  postmasters > "$OUT/postgres/postmasters-after-stop.tsv"
  # every postmaster except the ones proven ours must be unchanged; a foreign one that merely names -D $DATA is deliberately NOT excluded
  before="$(awk -F'\t' -v ids="$own_ids" 'BEGIN {n = split(ids, a, " "); for (i = 1; i <= n; i++) skip[a[i]] = 1} !($1 in skip)' "$OUT/postgres/postmasters-before-stop.tsv" | sort)"
  after="$(awk -F'\t' -v ids="$own_ids" 'BEGIN {n = split(ids, a, " "); for (i = 1; i <= n; i++) skip[a[i]] = 1} !($1 in skip)' "$OUT/postgres/postmasters-after-stop.tsv" | sort)"
  local foreign_untouched=true; [[ "$before" == "$after" ]] || foreign_untouched=false
  [[ "$foreign_untouched" == true ]] || problems+=('the set of other PostgreSQL instances changed during cleanup')
  # Final observation, after any removal: nothing owned may remain, and no success may stand next to an owned or unidentifiable listener.
  if scan_out="$(owned_scan)"; then :; else scan=failed; scan_out=""; problems+=('final process-ownership scan failed'); fi
  owned_after="$(only_owned "$scan_out")"; ambig_after="$(only_ambiguous "$scan_out")"
  [[ -z "$ambig_after" ]] || problems+=("process(es) $(owned_pid_list "$ambig_after") name -D $DATA without provably serving it (ambiguous ownership) after cleanup")
  [[ -z "$owned_after" ]] || problems+=("process(es) tied to the cluster root exist after cleanup: $(owned_pid_list "$owned_after")")
  observe_port "$owned_after"; resp_after="$RESP"; resp_after_detail="$RESP_DETAIL"; resp_after_exit="$RESP_EXIT"
  [[ "$resp_after" != owned ]] || problems+=("127.0.0.1:$PORT is answered by this cluster after cleanup ($resp_after_detail)")
  if [[ "$resp_after" == unknown && "$status" != NOT_STARTED ]] && cleanup_succeeded "$status"; then problems+=("127.0.0.1:$PORT answers after cleanup and its owner cannot be established ($resp_after_detail)"); fi
  if cleanup_succeeded "$status" && ((${#problems[@]})); then status=FAILED; fi

  local root_exists signals_json recorded_json=null
  root_exists="$(priv test -e "$ROOT" && echo true || echo false)"
  signals_json="$(printf '%s\n' "${signals[@]}" | jq -Rn '[inputs | select(length > 0) | split(" ") | {pid: (.[0]|tonumber), signal: .[1], exited: (.[2] == "true")}]')"
  if [[ "$id_state" == COMPLETE ]]; then recorded_json="$(jq -c '{pid: .postmaster_pid, start_ticks: .postmaster_start_ticks, boot_id: .boot_id, exe: .postmaster_exe, argv: .postmaster_argv, data_directory: .data_directory}' <<<"$idj")"; fi
  jq -n --arg status "$status" --arg mode "$mode" --arg method "$method" --arg root "$ROOT" --arg log "$log_copy" --argjson foreign "$foreign_untouched" \
        --argjson root_exists "$root_exists" --argjson root_before "$root_before" --argjson version_before "$version_before" --argjson pidfile_before "$pidfile_before" \
        --arg startup "$startup" --arg recorded_pid "$recorded_pid" --arg termination "$termination" --arg scan "$scan" \
        --argjson owned_before "$(owned_json "$owned_before")" --argjson owned_after "$(owned_json "$owned_after")" \
        --argjson ambig_before "$(owned_json "$ambig_before")" --argjson ambig_after "$(owned_json "$ambig_after")" \
        --arg id_state "$id_state" --argjson id_missing "$(list_json "${id_missing[@]}")" --argjson recorded "$recorded_json" --argjson signals "$signals_json" \
        --arg stale_pid "$stale_pid" --arg prior_status "$prior_status" \
        --arg rbe "$resp_before_exit" --arg rb "$resp_before" --arg rbd "$resp_before_detail" --arg rae "$resp_after_exit" --arg ra "$resp_after" --arg rad "$resp_after_detail" \
        --argjson proof "$(list_json "${proof[@]}")" --argjson problems "$(list_json "${problems[@]}")" --argjson notes "$(list_json "${notes[@]}")" --arg at "$(date -u +%FT%TZ)" \
    '{status:$status, stop_mode:$mode, stop_method:$method, root:$root, root_exists_after:$root_exists,
      startup_status:$startup, recorded_postmaster_pid:($recorded_pid | if . == "" then null else tonumber end),
      root_existed_before:$root_before, pg_version_present_before:$version_before, postmaster_pid_file_before:$pidfile_before,
      owned_process_scan:$scan, owned_processes_before:$owned_before, owned_processes_after:$owned_after,
      ambiguous_processes_before:$ambig_before, ambiguous_processes_after:$ambig_after,
      startup_identity:{state:$id_state, missing:$id_missing, recorded:$recorded}, signals:$signals,
      stale_pidfile:($stale_pid | if . == "" then null else {pid: tonumber, alive: false} end), prior_cleanup_status:($prior_status | if . == "" then null else . end),
      port_before:{pg_isready_exit:($rbe|tonumber), responder:$rb, detail:$rbd}, port_after:{pg_isready_exit:($rae|tonumber), responder:$ra, detail:$rad},
      port_54329_pg_isready_exit:($rae|tonumber), termination_evidence:$termination, shutdown_proof:$proof,
      server_log_copy:$log, foreign_instances_untouched:$foreign, problems:$problems, notes:$notes, verified_at:$at}' > "$OUT/postgres/cleanup.json"
  echo "PostgreSQL cleanup: $status (mode=$mode)"
  if ((${#problems[@]})); then printf '  - %s\n' "${problems[@]}"; fi
  cleanup_succeeded "$status"
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
