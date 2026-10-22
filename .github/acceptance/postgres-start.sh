#!/usr/bin/env bash
set -euo pipefail
ROOT="/var/tmp/gpr2-accept-${GITHUB_RUN_ID:?Missing run ID}"
PG_BIN="/usr/lib/postgresql/16/bin"
OUT="${GITHUB_WORKSPACE:?Missing workspace}/gpr2-ci-evidence"
mkdir -p "$OUT"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql-16 postgresql-client-16 > "$OUT/postgresql-package-install.log"
[[ -x "$PG_BIN/initdb" && -x "$PG_BIN/pg_ctl" ]] || { echo 'PostgreSQL 16 unavailable' >&2; exit 2; }
sudo install -d -o postgres -g postgres -m 0700 "$ROOT"
sudo install -d -o postgres -g postgres -m 0700 "$ROOT/data"
sudo -u postgres "$PG_BIN/initdb" -D "$ROOT/data" -U postgres -E UTF8 --auth-local=trust --auth-host=trust > "$OUT/postgresql-initdb.log"
sudo -u postgres "$PG_BIN/pg_ctl" -D "$ROOT/data" -o '-c cluster_name=gpr2-p1-isolated -c port=54329 -c listen_addresses=127.0.0.1 -c timezone=UTC' -l "$ROOT/pg.log" -w start
# Reject anything except the runner-owned localhost cluster before any tests create databases.
psql "$GPR2_ISOLATED_PG_URL" -XAt -F '|' -c "SELECT current_setting('cluster_name'), inet_server_addr()::text, current_setting('port'), current_database()" > "$OUT/postgresql-identity.txt"
IFS='|' read -r cluster address port db < "$OUT/postgresql-identity.txt"
[[ "$cluster" == 'gpr2-p1-isolated' && "$address" == '127.0.0.1' && "$port" == '54329' && "$db" == 'postgres' ]] || {
  echo 'REFUSED: PostgreSQL isolation mismatch' >&2; exit 2;
}
echo "PostgreSQL isolation verified: cluster=$cluster addr=$address port=$port db=$db"
