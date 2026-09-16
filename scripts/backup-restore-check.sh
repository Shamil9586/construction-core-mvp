#!/usr/bin/env bash
# Test environment only. Restore into a NEW database; never overwrite/drop one.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v docker >/dev/null || { echo 'Docker is required; no backup/restore was performed.' >&2; exit 2; }
if [[ ${CONFIRM_TEST_ENVIRONMENT:-} != yes ]]; then
  echo 'Set CONFIRM_TEST_ENVIRONMENT=yes only for the dedicated test deployment.' >&2
  exit 2
fi
umask 077
mkdir -p backups
restore_db="recovery_$(date -u +%Y%m%d%H%M%S)_${RANDOM}_test"
backup_path="backups/${restore_db}.dump"
docker compose exec -T db pg_isready -U construction -d construction
# Write to .partial first so a failed dump cannot be mistaken for a usable backup.
docker compose exec -T db pg_dump -U construction -d construction -Fc > "${backup_path}.partial"
mv "${backup_path}.partial" "$backup_path"
docker compose exec -T db createdb -U construction "$restore_db"
docker compose exec -T db pg_restore -U construction -d "$restore_db" --exit-on-error --single-transaction < "$backup_path"
docker compose exec -T db psql -U construction -d "$restore_db" -v ON_ERROR_STOP=1 <<'SQL'
SELECT version FROM schema_migrations ORDER BY version;
SELECT count(*) AS objects FROM objects;
SELECT count(*) AS works FROM works;
SELECT count(*) AS audit_entries FROM audit_logs;
SELECT count(*) AS closings, coalesce(sum(amount),0) AS amount FROM financial_closings;
BEGIN;
CREATE TABLE recovery_write_probe(id uuid PRIMARY KEY, amount numeric(18,2));
INSERT INTO recovery_write_probe VALUES(gen_random_uuid(),0.10);
SELECT amount FROM recovery_write_probe;
ROLLBACK;
SQL
printf 'Restore command and SQL smoke completed. Backup: %s; isolated recovery database: %s\n' "$backup_path" "$restore_db"
printf 'Recovery database retained for inspection. Application DATABASE_URL was not changed.\n'
