# GPR-2 P1-B — evidence package for independent acceptance (R02 + R03)

This directory is the **evidence of the executor**, not an acceptance. Nothing here has been accepted; acceptance belongs to the independent reviewer
and the specialised R03b check. R04 has **not** been started.

| File | What it holds |
|---|---|
| [`../gpr-2-p1-b-report-a.md`](../gpr-2-p1-b-report-a.md) | **Report A** — the short brief for the independent reviewer |
| [`environment.md`](environment.md) | identity of the test environment and the **proof of PostgreSQL isolation** |
| `results/baseline-678e795.tsv` | every test file at the **base** commit, exit code per file |
| `results/r02-<sha>.tsv` | every test file at the exact R02 SHA |
| `results/p1b-<sha>.tsv` | every test file at the exact R03 (P1-B) SHA |
| `results/stages/*.tsv` | the focused run of each sub-stage SHA (R03a, R03b, R03c, R03d) |
| `results/p1b-shard*.tsv`, `results/p1b-rerun.tsv` | the raw shard tables and the unchanged re-run of six files whose legacy suites require a database name ending `_test` |
| `results/protected-concurrency/` | the four protected native concurrency suites at the R03b SHA |
| `native-r03a/ native-r03c/ native-r03d/` | JSON recorded by the native tests of each stage |
| `r03b/` | **separate evidence for R03b**: native-PostgreSQL logs and the JSON the tests record (lock matrix timeline, A06 interleaving, exclusive writers, stress) |
| `superseded/` | runs kept because they **found defects in the executor's own work**: the first R02 candidate (five tests pinned the end of the migration chain), the R03d stage before the checksum fix, and the shard-name failures |

## Reproduce

```bash
# 1. an isolated PostgreSQL (any 16/17; the marker below is what the harness insists on)
initdb -D /var/tmp/gpr2-isolated-pg/data -U postgres --auth=trust -E UTF8
echo "cluster_name = 'gpr2-p1-isolated'" >> /var/tmp/gpr2-isolated-pg/data/postgresql.conf
pg_ctl -D /var/tmp/gpr2-isolated-pg/data -o "-p 54329 -c listen_addresses=127.0.0.1 -c timezone=UTC" -l /var/tmp/gpr2-isolated-pg/pg.log start

# 2. a checkout of the exact SHA (never the working copy of someone else's branch)
git worktree add --detach /var/tmp/p1b <SHA> && ln -s "$PWD/node_modules" /var/tmp/p1b/node_modules && cd /var/tmp/p1b

# 3. every test file on a freshly created database, an exit code per file
export GPR2_ISOLATED_PG_URL=postgresql://postgres:x@127.0.0.1:54329/postgres
scripts/gpr2-p1-run-tests.sh /var/tmp/out tests/*.test.ts      # summary.tsv, total.txt, logs/
npx tsc --noEmit && npm run typecheck:strict
```

`scripts/gpr2-p1-run-tests.sh` and `tests/helpers/gpr2-native-pg.ts` both refuse a server whose `cluster_name` is not `gpr2-p1-isolated` or whose address is not loopback, and
never read `DATABASE_URL` / `E2E_*` / `PG*` from the caller's environment.
