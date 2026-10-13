# infra/pending — migrations without a final number

A feature branch that needs a schema change but must not pick a production migration number (parallel branches would collide) puts an
**idempotent** `*.sql` here. `scripts/migrate.ts` applies these files after the numbered `infra/NNN_*.sql` chain, once each, tracked by file
name in `schema_pending_migrations`. The numbered-chain tests (no gaps / head version) are unaffected because nothing here has a number.

Integration: the coordinator moves each file to the next free number (`git mv infra/pending/x.sql infra/0NN_x.sql`) after all parallel
migrations are placed. Because the SQL is idempotent, a database that already applied it from here simply re-confirms it under the number.

Currently pending: `bitrix-disk-1-file-storage.sql` (BITRIX-DISK-1; see docs/bitrix-disk-1-storage.md §9).
