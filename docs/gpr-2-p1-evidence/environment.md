# Test environment and PostgreSQL isolation (P1-B)

## Environment

| | |
|---|---|
| Host | disposable cloud container (`Linux 6.18.44-fc-v139`), no network path to LIVE configured for any test |
| Node / npm | v22.22.0 / 10.9.4 (the version `.github/workflows` use) |
| PostgreSQL | **16.15** (Ubuntu 16.15-0ubuntu0.24.04.1), started by the executor for this run only |
| Cluster | `cluster_name = gpr2-p1-isolated`, `listen_addresses = 127.0.0.1`, port `54329`, data directory `/var/tmp/gpr2-isolated-pg/data` (outside the repository), `TimeZone = UTC`, `max_connections = 100`, `trust` authentication on the loopback only |
| Repository base | `678e795f8802a76ac025f28b0d698351af8b7721` |
| Normative documents (sha256, verified before work began) | Technical Design `b80ba7315509b9a011b87a45957f7e9a3eaf802624c1ca241f7072fab8879368` · Roadmap `a4c27d19a731b0d32a70c75a14af4f04c289ff93007d4ed78fe308a6ab434f76` — the same two values `docs/gpr-2-r01-contracts.md` records |

## Isolation — what was checked and how

1. **No production credential exists in the container.** The environment contains no `DATABASE_URL`, `PG*`, `E2E_*`, `POSTGRES_*`, `RENDER*` or `BITRIX*` variable (counted: 0) before the cluster
   was started; the executor was given none. LIVE PostgreSQL, Render and Bitrix24 were not contacted at any point.
2. **The server is the executor's own and says so.** `tests/helpers/gpr2-native-pg.ts` (`assertIsolatedPostgres`) refuses to run unless the URL comes **only** from `GPR2_ISOLATED_PG_URL`, its host is
   loopback or a unix-socket directory, `current_setting('cluster_name') = 'gpr2-p1-isolated'` (a marker set in that cluster's own `postgresql.conf`, which no application server has) and
   `inet_server_addr()` is loopback or null. The values it saw are recorded per run in `r03b/r02-isolation.json`, `r03b/r03a-isolation.json`, … (version, cluster, port, address, data directory,
   database, `productionCredentialsUsed: false`).
3. **Databases are disposable and named.** Every native test creates `gpr2_p1_<label>_<random>` from `template0` and is allowed to DROP only a name with that prefix. The legacy suites that
   create databases of their own (`construction_test`, `gpr_*`, `org1_*`, `role_cleanup_*`, …) were run through `scripts/gpr2-p1-run-tests.sh`, which re-creates `construction_test` before
   every file and passes the legacy URLs itself.
4. **The harness scrubs the caller's environment.** `scrubConnectionEnvironment()` removes `DATABASE_URL`, `E2E_*`, `PG*`, `POSTGRES_*` before the backend is imported (the backend reads its
   connection at import time); the R01 tests additionally pin `DB_MODE=pglite` and assert the pool is in-memory.
5. **Nothing was deployed, merged or pushed to `main`; no Render or Bitrix24 setting was read or changed; no legacy backfill ran on any data.** The only data the tests touch is `seed()` demo data and
   rows the tests insert themselves.

## What the isolation does *not* prove

It proves where the tests ran, not how LIVE is configured. LIVE schema, deployed SHA and Render auto-deploy settings are **unknown** to the executor (I-LIVE is closed to this stage by design).
