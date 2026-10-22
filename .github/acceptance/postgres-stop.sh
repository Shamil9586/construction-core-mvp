#!/usr/bin/env bash
set -uo pipefail
ROOT="/var/tmp/gpr2-accept-${GITHUB_RUN_ID:-}"
if [[ "$ROOT" =~ ^/var/tmp/gpr2-accept-[0-9]+$ && -f "$ROOT/data/PG_VERSION" ]]; then
  OUT="${GITHUB_WORKSPACE:-}/gpr2-ci-evidence"
  if [[ -n "${GITHUB_WORKSPACE:-}" ]]; then
    mkdir -p "$OUT"
    sudo cat "$ROOT/pg.log" > "$OUT/postgresql-server.log" || true
  fi
  sudo -u postgres /usr/lib/postgresql/16/bin/pg_ctl -D "$ROOT/data" -m immediate -w stop || true
  sudo rm -rf -- "$ROOT"
fi
