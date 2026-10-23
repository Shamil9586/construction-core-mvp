#!/usr/bin/env bash
# shellcheck disable=SC2015 # ok()/bad() always succeed, so "cond && ok || bad" is a safe if/else here
# Construction Core — GPR-2 CI Foundation: positive and negative tests of the disposable PostgreSQL lifecycle (F-CI-01, F-CI-02).
# Must run as an UNPRIVILEGED user with passwordless sudo (exactly the GitHub-hosted runner model) on a host with PostgreSQL binaries.
# Every cluster it creates lives under /var/tmp/gpr2-accept-9900NN-* (or 99001NN) on port 54329 (or 55432 for the "foreign" instance) and is removed.
#   bash .github/acceptance/tests/pg-cluster.test.sh [evidence-dir]
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/../lib"
FROZEN_STOP="$HERE/../postgres-stop.sh"
MAJOR="${GPR2_PG_MAJOR:-16}"; PG_BIN="/usr/lib/postgresql/$MAJOR/bin"
EV="${1:-$(mktemp -d /tmp/gpr2-pgtest.XXXXXX)}"; mkdir -p "$EV"
pass=0; fail=0; results=()
[[ "$(id -u)" != 0 ]] || { echo 'run as an unprivileged user with passwordless sudo (like the hosted runner)'; exit 64; }
sudo -n true || { echo 'passwordless sudo is required'; exit 64; }

ok()   { pass=$((pass+1)); results+=("PASS $1"); echo "PASS $1"; }
bad()  { fail=$((fail+1)); results+=("FAIL $1: $2"); echo "FAIL $1: $2"; }
pgc()  { local id="$1"; shift; env GITHUB_RUN_ID="$id" GITHUB_RUN_ATTEMPT=1 GPR2_EVIDENCE_OUT="$EV/$id" GPR2_PG_MAJOR="$MAJOR" "$@"; }
field() { jq -r ".$2" "$EV/$1/postgres/cleanup.json" 2>/dev/null; }
port_free() { ! pg_isready -q -h 127.0.0.1 -p "${1:-54329}" -t 2; }
foreign_start() {  # an unrelated instance (NOT ours) on 55432 that must survive every cleanup
  sudo install -d -o postgres -g postgres -m 0700 /var/tmp/gpr2-foreign /var/tmp/gpr2-foreign/data
  sudo -u postgres "$PG_BIN/initdb" -D /var/tmp/gpr2-foreign/data -U postgres --auth=trust >/dev/null 2>&1
  sudo -u postgres "$PG_BIN/pg_ctl" -D /var/tmp/gpr2-foreign/data -l /var/tmp/gpr2-foreign/log -w -o "-c port=${1:-55432} -c listen_addresses=127.0.0.1 -c unix_socket_directories=/var/tmp/gpr2-foreign -c cluster_name=foreign" start >/dev/null
}
alive() { [[ -n "$1" ]] && kill -0 "$1" 2>/dev/null; }
classified() {  # the independent classifier's verdict (classify.mjs evaluateCleanup) on the cleanup.json this script wrote
  node --input-type=module -e "import fs from 'node:fs'; import { evaluateCleanup } from '$LIB/classify.mjs'; process.exit(evaluateCleanup(JSON.parse(fs.readFileSync(process.argv[1], 'utf8'))).ok ? 0 : 1)" "$EV/$1/postgres/cleanup.json"
}
serving() { ps -eo args= | grep -F -- "postgres -D $1" | grep -vF grep >/dev/null; }   # a postmaster is still serving this data directory
foreign_stop() { sudo -u postgres "$PG_BIN/pg_ctl" -D /var/tmp/gpr2-foreign/data -m fast -w stop >/dev/null 2>&1; sudo rm -rf /var/tmp/gpr2-foreign; }

echo "== evidence: $EV"
port_free 54329 || { echo 'port 54329 is busy before the tests; refusing'; exit 2; }

# T1 positive: start -> identity -> stop -> verified removal
if pgc 990001 bash "$LIB/pg-cluster.sh" start >"$EV/t1.log" 2>&1 && jq -e '.status=="RUNNING_VERIFIED" and .cluster_name=="gpr2-p1-isolated" and .port==54329 and .loopback_only' "$EV/990001/postgres/identity.json" >/dev/null; then
  if pgc 990001 bash "$LIB/pg-cluster.sh" stop >>"$EV/t1.log" 2>&1 && [[ "$(field 990001 status)" == STOPPED_VERIFIED && "$(field 990001 root_exists_after)" == false ]] && port_free && [[ ! -e /var/tmp/gpr2-accept-990001-1 ]] && [[ -s "$EV/990001/postgres/server.log" ]]; then
    ok 'T1 start, identity, verified stop, root removed, server log preserved'
  else bad T1 "stop not verified: $(cat "$EV/990001/postgres/cleanup.json" 2>/dev/null)"; fi
else bad T1 "start failed: $(tail -3 "$EV/t1.log")"; fi

# T2 stop without a cluster: explicit NOT_STARTED, success
if pgc 990002 bash "$LIB/pg-cluster.sh" stop >"$EV/t2.log" 2>&1 && [[ "$(field 990002 status)" == NOT_STARTED ]]; then ok 'T2 stop without a cluster reports NOT_STARTED explicitly'; else bad T2 "$(cat "$EV/t2.log")"; fi

# T3 F-CI-01 reproduction: the frozen R04 stop script, run unprivileged against a 0700 cluster dir, exits 0 but leaves the server running
ROOT3=/var/tmp/gpr2-accept-990003
sudo install -d -o postgres -g postgres -m 0700 "$ROOT3" "$ROOT3/data"
sudo -u postgres "$PG_BIN/initdb" -D "$ROOT3/data" -U postgres --auth=trust >/dev/null 2>&1
sudo -u postgres "$PG_BIN/pg_ctl" -D "$ROOT3/data" -l "$ROOT3/pg.log" -w -o "-c port=54329 -c listen_addresses=127.0.0.1 -c unix_socket_directories=$ROOT3 -c cluster_name=gpr2-p1-isolated" start >/dev/null
[[ -f "$ROOT3/data/PG_VERSION" ]] && unpriv_sees=true || unpriv_sees=false
GITHUB_RUN_ID=990003 GITHUB_WORKSPACE="$EV/frozen" bash "$FROZEN_STOP"; frozen_rc=$?
if [[ "$frozen_rc" == 0 && "$unpriv_sees" == false ]] && ! port_free; then
  ok "T3 F-CI-01 reproduced: frozen postgres-stop.sh exit 0, unprivileged PG_VERSION test=false, server still answering on 54329"
else bad T3 "could not reproduce (rc=$frozen_rc unpriv_sees=$unpriv_sees port_free=$(port_free && echo y || echo n))"; fi
sudo -u postgres "$PG_BIN/pg_ctl" -D "$ROOT3/data" -m fast -w stop >/dev/null 2>&1; sudo rm -rf "$ROOT3"

# T4 refuse a stale cluster root
sudo install -d -m 0700 /var/tmp/gpr2-accept-990004-1
if ! pgc 990004 bash "$LIB/pg-cluster.sh" start >"$EV/t4.log" 2>&1 && grep -q 'already exists' "$EV/t4.log"; then ok 'T4 refuses to reuse a stale cluster root'; else bad T4 "$(cat "$EV/t4.log")"; fi
sudo rm -rf /var/tmp/gpr2-accept-990004-1

# T5 refuse to start when something else answers on 54329; the foreign server is left untouched
foreign_start 54329
if ! pgc 990005 bash "$LIB/pg-cluster.sh" start >"$EV/t5.log" 2>&1 && grep -q 'already answers' "$EV/t5.log" && ! port_free 54329; then ok 'T5 refuses to start next to an unknown server on 54329 and leaves it running'; else bad T5 "$(cat "$EV/t5.log")"; fi
pgc 990005 bash "$LIB/pg-cluster.sh" stop >>"$EV/t5.log" 2>&1
! port_free 54329 && [[ "$(field 990005 status)" == NOT_STARTED ]] && ok 'T5b stop for this run does not touch the foreign server' || bad T5b "$(cat "$EV/990005/postgres/cleanup.json")"
foreign_stop

# T6 a foreign instance on another port survives our full lifecycle and is recorded as untouched
foreign_start 55432
pgc 990006 bash "$LIB/pg-cluster.sh" start >"$EV/t6.log" 2>&1 && pgc 990006 bash "$LIB/pg-cluster.sh" stop >>"$EV/t6.log" 2>&1
if [[ "$(field 990006 status)" == STOPPED_VERIFIED && "$(field 990006 foreign_instances_untouched)" == true ]] && ! port_free 55432 && port_free 54329; then ok 'T6 foreign instance on 55432 untouched (recorded), ours stopped'; else bad T6 "$(cat "$EV/t6.log")"; fi
foreign_stop

# T7 a postmaster.pid that does not name our data dir/port: refuse to signal, FAILED, non-zero exit (failure is not swallowed)
pgc 990007 bash "$LIB/pg-cluster.sh" start >"$EV/t7.log" 2>&1
PIDF=/var/tmp/gpr2-accept-990007-1/data/postmaster.pid
sudo cp "$PIDF" "$EV/t7.pid.bak"; sudo sed -i '2s|.*|/var/lib/postgresql/16/main|' "$PIDF"
pgc 990007 bash "$LIB/pg-cluster.sh" stop >>"$EV/t7.log" 2>&1; rc=$?
if [[ "$rc" != 0 && "$(field 990007 status)" == FAILED ]] && ! port_free && jq -e '.problems|map(test("refusing to signal"))|any' "$EV/990007/postgres/cleanup.json" >/dev/null; then
  ok 'T7 mismatched postmaster.pid: refused to signal, FAILED, exit non-zero, server untouched'
else bad T7 "rc=$rc $(cat "$EV/990007/postgres/cleanup.json")"; fi
sudo cp "$EV/t7.pid.bak" "$PIDF"; sudo chown postgres:postgres "$PIDF"
pgc 990007 bash "$LIB/pg-cluster.sh" stop >>"$EV/t7.log" 2>&1 && [[ "$(field 990007 status)" == STOPPED_VERIFIED ]] && ok 'T7b after restoring the pid file the same cluster stops verified' || bad T7b "$(cat "$EV/990007/postgres/cleanup.json")"

# T8 crashed server (SIGKILL): stale pid file detected, removed, cleanup still verified with a note
pgc 990008 bash "$LIB/pg-cluster.sh" start >"$EV/t8.log" 2>&1
pid8="$(sudo head -1 /var/tmp/gpr2-accept-990008-1/data/postmaster.pid)"; sudo kill -9 "$pid8"; sleep 2
pgc 990008 bash "$LIB/pg-cluster.sh" stop >>"$EV/t8.log" 2>&1; rc=$?
if [[ "$rc" == 0 && "$(field 990008 status)" == STOPPED_VERIFIED && "$(field 990008 stop_mode)" == already_stopped ]] && jq -e '.notes|map(test("stale postmaster.pid"))|any' "$EV/990008/postgres/cleanup.json" >/dev/null && [[ ! -e /var/tmp/gpr2-accept-990008-1 ]]; then
  ok 'T8 crashed postmaster: stale pid file handled, verified, noted'
else bad T8 "rc=$rc $(cat "$EV/990008/postgres/cleanup.json")"; fi

# T9 fast stop that cannot finish in time escalates to immediate and says so
pgc 990009 bash "$LIB/pg-cluster.sh" start >"$EV/t9.log" 2>&1
pgc 990009 env GPR2_PG_CTL_STOP_TIMEOUT=0 bash "$LIB/pg-cluster.sh" stop >>"$EV/t9.log" 2>&1; rc=$?
st9="$(field 990009 status)"
if [[ "$rc" == 0 && ( "$st9" == STOPPED_VERIFIED_AFTER_ESCALATION || "$st9" == STOPPED_VERIFIED ) ]] && port_free; then
  ok "T9 zero stop timeout handled ($st9, mode $(field 990009 stop_mode))"
else bad T9 "rc=$rc $(cat "$EV/990009/postgres/cleanup.json")"; fi

# T10 refuses a non-numeric run id (no arbitrary root path can be targeted)
if ! env GITHUB_RUN_ID='../../etc' GPR2_EVIDENCE_OUT="$EV/t10" bash "$LIB/pg-cluster.sh" stop >"$EV/t10.log" 2>&1 && grep -q 'refusing cluster root' "$EV/t10.log"; then ok 'T10 refuses a non-numeric cluster root'; else bad T10 "$(cat "$EV/t10.log")"; fi

# ---- F-CI-02: a missing PG_VERSION must never be read as "no server is running" -------------------------------------------------------------
# T11 (N1) running owned cluster, PG_VERSION vanished. pg_ctl refuses the directory (status 4, stop 1), so the pre-correction script concluded
# "initdb never completed", deleted the root under a live server and reported success. Now the postmaster is proven ours from the process table
# (cwd + -D argument), stopped, verified gone, and only then is the root removed.
pgc 990011 bash "$LIB/pg-cluster.sh" start >"$EV/t11.log" 2>&1
R11=/var/tmp/gpr2-accept-990011-1; sudo rm -f "$R11/data/PG_VERSION"
pgc 990011 bash "$LIB/pg-cluster.sh" stop >>"$EV/t11.log" 2>&1; rc=$?
if [[ "$rc" == 0 && "$(field 990011 status)" == STOPPED_VERIFIED && "$(field 990011 stop_method)" == signal && "$(field 990011 termination_evidence)" == stopped_by_cleanup && "$(field 990011 startup_status)" == RUNNING_VERIFIED ]] \
   && [[ ! -e $R11 ]] && port_free && ! serving "$R11/data" && classified 990011; then
  ok 'T11 F-CI-02 N1: running cluster without PG_VERSION is stopped via the verified postmaster, then removed; classifier agrees'
else bad T11 "rc=$rc $(cat "$EV/990011/postgres/cleanup.json")"; fi
sudo -u postgres "$PG_BIN/pg_ctl" -D "$R11/data" -m immediate stop >/dev/null 2>&1; sudo rm -rf "$R11"

# T11b same, with postmaster.pid deleted too: no file names the server any more, only the process table does
pgc 990017 bash "$LIB/pg-cluster.sh" start >"$EV/t11b.log" 2>&1
R17=/var/tmp/gpr2-accept-990017-1; sudo rm -f "$R17/data/PG_VERSION" "$R17/data/postmaster.pid"
pgc 990017 bash "$LIB/pg-cluster.sh" stop >>"$EV/t11b.log" 2>&1; rc=$?
if [[ "$rc" == 0 && "$(field 990017 status)" == STOPPED_VERIFIED && "$(field 990017 stop_method)" == signal ]] && [[ ! -e $R17 ]] && port_free && ! serving "$R17/data" && classified 990017; then
  ok 'T11b F-CI-02 N1: PG_VERSION and postmaster.pid both gone, server still found and stopped through the process table'
else bad T11b "rc=$rc $(cat "$EV/990017/postgres/cleanup.json")"; fi
sudo rm -rf "$R17"

# T12 (N1/N2) the server cannot be stopped (SIGSTOP: it never handles SIGINT/SIGQUIT): FAILED, non-zero, root and server preserved, never a success
pgc 990012 bash "$LIB/pg-cluster.sh" start >"$EV/t12.log" 2>&1
R12=/var/tmp/gpr2-accept-990012-1; pm12="$(sudo head -1 "$R12/data/postmaster.pid")"; sudo rm -f "$R12/data/PG_VERSION"; sudo kill -STOP "$pm12"
pgc 990012 env GPR2_PG_CTL_STOP_TIMEOUT=1 bash "$LIB/pg-cluster.sh" stop >>"$EV/t12.log" 2>&1; rc=$?
if [[ "$rc" != 0 && "$(field 990012 status)" == FAILED && -d $R12/data ]] && alive "$pm12" && jq -e '.problems|map(test("did not stop"))|any' "$EV/990012/postgres/cleanup.json" >/dev/null && ! classified 990012; then
  ok 'T12 F-CI-02 N1/N2: unstoppable owned server -> FAILED, exit non-zero, data directory and server preserved, classifier rejects'
else bad T12 "rc=$rc alive=$(alive "$pm12" && echo y || echo n) $(cat "$EV/990012/postgres/cleanup.json")"; fi
sudo kill -CONT "$pm12" 2>/dev/null; for _ in $(seq 1 60); do alive "$pm12" || break; sleep 0.5; done
# the server is now gone, but deleted files are not proof: with RUNNING_VERIFIED evidence and no stale pid it is still not a success
sudo rm -f "$R12/data/postmaster.pid"
pgc 990012 bash "$LIB/pg-cluster.sh" stop >>"$EV/t12.log" 2>&1; rc=$?
if [[ "$rc" != 0 && "$(field 990012 status)" == FAILED && -d $R12/data ]] && jq -e '.problems|map(test("shutdown cannot be proven"))|any' "$EV/990012/postgres/cleanup.json" >/dev/null && ! classified 990012; then
  ok 'T12b F-CI-02 B: RUNNING_VERIFIED + missing PG_VERSION/postmaster.pid is not proof of termination -> FAILED, root preserved'
else bad T12b "rc=$rc $(cat "$EV/990012/postgres/cleanup.json")"; fi
sudo rm -rf "$R12"

# T16 same strictness with PG_VERSION present: server shut down behind our back, no stale pid, RUNNING_VERIFIED -> FAILED
pgc 990016 bash "$LIB/pg-cluster.sh" start >"$EV/t16.log" 2>&1
R16=/var/tmp/gpr2-accept-990016-1; sudo -u postgres "$PG_BIN/pg_ctl" -D "$R16/data" -m fast -w stop >/dev/null 2>&1
pgc 990016 bash "$LIB/pg-cluster.sh" stop >>"$EV/t16.log" 2>&1; rc=$?
if [[ "$rc" != 0 && "$(field 990016 status)" == FAILED && -d $R16/data ]] && ! classified 990016; then ok 'T16 F-CI-02 B: server stopped by someone else, no stale-pid evidence -> FAILED (shutdown by this cleanup not shown)'; else bad T16 "rc=$rc $(cat "$EV/990016/postgres/cleanup.json")"; fi
sudo rm -rf "$R16"

# T13 (N3) uncertain ownership: our postmaster.pid is forged to name a FOREIGN live postmaster. It must not be signalled, nothing is deleted, no success.
foreign_start 55432
fpid="$(sudo head -1 /var/tmp/gpr2-foreign/data/postmaster.pid)"
pgc 990013 bash "$LIB/pg-cluster.sh" start >"$EV/t13.log" 2>&1
R13=/var/tmp/gpr2-accept-990013-1; real13="$(sudo head -1 "$R13/data/postmaster.pid")"; sudo sed -i "1s/.*/$fpid/" "$R13/data/postmaster.pid"
pgc 990013 bash "$LIB/pg-cluster.sh" stop >>"$EV/t13.log" 2>&1; rc=$?
if [[ "$rc" != 0 && "$(field 990013 status)" == FAILED && -d $R13/data ]] && alive "$fpid" && ! port_free 55432 \
   && jq -e '.problems|map(test("not provably this cluster"))|any' "$EV/990013/postgres/cleanup.json" >/dev/null && ! classified 990013; then
  ok 'T13 F-CI-02 N3: pid file naming a foreign postmaster -> refused, FAILED, foreign server untouched, root preserved'
else bad T13 "rc=$rc fpid_alive=$(alive "$fpid" && echo y || echo n) $(cat "$EV/990013/postgres/cleanup.json")"; fi
sudo sed -i "1s/.*/$real13/" "$R13/data/postmaster.pid"
pgc 990013 bash "$LIB/pg-cluster.sh" stop >>"$EV/t13.log" 2>&1 && [[ "$(field 990013 status)" == STOPPED_VERIFIED ]] && alive "$fpid" && ok 'T13b once the pid file is true again our cluster stops verified; the foreign server still runs' || bad T13b "$(cat "$EV/990013/postgres/cleanup.json")"
foreign_stop

# T14 (P2) partially initialised root, nothing started, process table clean: REMOVED_UNINITIALISED, success
R14=/var/tmp/gpr2-accept-990014-1
sudo install -d -o postgres -g postgres -m 0700 "$R14" "$R14/data" "$R14/data/base"; sudo -u postgres touch "$R14/data/postgresql.conf"
pgc 990014 bash "$LIB/pg-cluster.sh" stop >"$EV/t14.log" 2>&1; rc=$?
if [[ "$rc" == 0 && "$(field 990014 status)" == REMOVED_UNINITIALISED && ! -e $R14 && "$(field 990014 startup_status)" == NONE ]] && classified 990014; then ok 'T14 F-CI-02 P2: partial initdb remains, no server evidence anywhere -> REMOVED_UNINITIALISED, removed'; else bad T14 "rc=$rc $(cat "$EV/990014/postgres/cleanup.json")"; fi

# T15 (P2+P4) the same next to an independently identified FOREIGN instance on our port: removal proceeds, the foreign server and its data are untouched
foreign_start 54329
fpid="$(sudo head -1 /var/tmp/gpr2-foreign/data/postmaster.pid)"; fver="$(sudo cat /var/tmp/gpr2-foreign/data/PG_VERSION)"
R15=/var/tmp/gpr2-accept-990015-1; sudo install -d -o postgres -g postgres -m 0700 "$R15" "$R15/data"
pgc 990015 bash "$LIB/pg-cluster.sh" stop >"$EV/t15.log" 2>&1; rc=$?
if [[ "$rc" == 0 && "$(field 990015 status)" == REMOVED_UNINITIALISED && "$(field 990015 port_before.responder)" == foreign && ! -e $R15 ]] && alive "$fpid" && ! port_free 54329 \
   && [[ "$(sudo cat /var/tmp/gpr2-foreign/data/PG_VERSION)" == "$fver" && "$(sudo head -1 /var/tmp/gpr2-foreign/data/postmaster.pid)" == "$fpid" ]] && classified 990015; then
  ok 'T15 F-CI-02 P2/P4: foreign instance on 54329 identified as foreign, left running with unchanged data; partial root removed'
else bad T15 "rc=$rc fpid_alive=$(alive "$fpid" && echo y || echo n) $(cat "$EV/990015/postgres/cleanup.json")"; fi
# ...and with startup evidence a listener on the port never turns the same root into a success
mkdir -p "$EV/990018/postgres"; echo '{"status":"RUNNING_VERIFIED","postmaster_pid":1}' > "$EV/990018/postgres/identity.json"
R18=/var/tmp/gpr2-accept-990018-1; sudo install -d -o postgres -g postgres -m 0700 "$R18" "$R18/data"
pgc 990018 bash "$LIB/pg-cluster.sh" stop >"$EV/t18.log" 2>&1; rc=$?
if [[ "$rc" != 0 && "$(field 990018 status)" == FAILED && -d $R18 ]] && alive "$fpid" && ! classified 990018; then ok 'T18 F-CI-02 B/N3: RUNNING_VERIFIED + no PG_VERSION + foreign listener -> FAILED, root preserved, foreign untouched'; else bad T18 "rc=$rc $(cat "$EV/990018/postgres/cleanup.json")"; fi
sudo rm -rf "$R18"; foreign_stop

ls -d /var/tmp/gpr2-accept-99* 2>/dev/null && bad leftovers 'cluster roots left behind' || ok 'no cluster roots left behind'
port_free 54329 && port_free 55432 && ok 'ports 54329 and 55432 free at the end' || bad ports 'a test server is still running'
printf '%s\n' "${results[@]}" > "$EV/results.txt"
echo "TOTAL pass=$pass fail=$fail"
[[ "$fail" == 0 ]]
