---
name: backend-testing
description: How to select, run and report Construction Core backend tests — the node:test runner, focused file selection, tests/helpers and tests/fixtures, PGlite versus native PostgreSQL, disposable test databases, migration, rollback, idempotency, concurrency, quantity and RBAC regression tests, exact candidate identity and PASS/FAIL/SKIP/NOT RUN/BLOCKED evidence. Use when adding or changing backend or domain tests, diagnosing a failing backend test, changing domain validation, verifying PostgreSQL behaviour, implementing a GPR-2 workflow, or preparing backend acceptance evidence. Frontend and Playwright rules live in frontend-testing.
---

# Backend testing — Construction Core

What to run, against what, and how to report it. Database design rules: `postgres-engineering`;
access rules: `rbac-authorization`; independent verdicts: `independent-acceptance`.

## 1. Commands at the baseline (root `package.json`)

| Command | What it actually does |
|---|---|
| `npm test` | `node --import tsx --test tests/*.test.ts` — every suite, **including native-PostgreSQL suites that create and drop databases** |
| `node --import tsx --test tests/<file>.test.ts` | One or a few focused files — the default during development |
| `npm run build` | `tsc --noEmit` over the whole tree (root `tsconfig.json`, not strict) + Vite build |
| `npm run typecheck:strict` | Strict `tsc` for the frontend layers only (`apps/frontend/tsconfig.strict.json`) — **not** a backend type check |
| `npm run db:migrate` | Applies pending `infra/` migrations to whatever `DATABASE_URL` names. Disposable databases only; never production |
| `npm run db:local` | Starts an embedded native PostgreSQL on `127.0.0.1:54329` (refuses root; data in `.local-pg`) |

Re-read `package.json` before quoting a command; scripts change. Do not add a test framework.

## 2. Focused selection

- Run the files that cover the changed module, plus the protected suites the change could
  affect (Roadmap §5.1; e.g. `tests/f12.1-*.test.ts`, `tests/execution-units.test.ts`,
  `tests/production-execution.test.ts`, `tests/f12-final-r06-auth-safe-idempotency.test.ts`).
- GPR-2 R01 suites: `node --import tsx --test tests/gpr2-r01-*.test.ts` (pure domain + PGlite).
- Full `npm test` is for a candidate about to be reviewed, not for every edit. A Markdown-only
  or `.claude/` change needs no test run; do not start databases, Docker or servers for it.

## 3. Helpers and fixtures

- `tests/helpers/gpr2-isolation.ts` — import **first**: deletes `DATABASE_URL`, `PG*`, `E2E_*`
  database and `POSTGRES_*` variables and pins in-memory PGlite; `assertInMemoryPool()` proves
  it. `apps/backend/src/db.ts` chooses its pool at import time.
- `tests/helpers/gpr2-fixtures.ts`, `gpr2-resources.ts`, `gpr2-matrix.ts`,
  `gpr2-decision-index.ts`, `gpr-fixtures.ts`, `pbx3-fixtures.ts`, `registry-fixtures.ts` —
  reuse before writing new setup.
- `tests/fixtures/gpr2-normative-expectations.json` — extracted from the external GPR-2
  documents; `tests/gpr2-r01-normative-expectations.test.ts` needs `GPR2_TD_PATH` and
  `GPR2_ROADMAP_PATH` (see `docs/gpr-2-r01-contracts.md`).

## 4. PGlite versus native PostgreSQL

- PGlite (`DB_MODE=pglite`, no `DATABASE_URL`): fast SQL, constraint and HTTP-flow checks. The
  adapter serialises every call, so it can **never** show competing transactions, lock waits,
  deadlocks, isolation behaviour or concurrent idempotent inserts.
- Native suites (`tests/*-postgres*.test.ts`, `tests/f8.3-postgres-concurrency.test.ts`,
  `tests/f12-final-corrective-postgres-concurrency.test.ts`,
  `tests/f8.3-migration-011-upgrade.test.ts` and others) default to
  `postgresql://postgres:local-test-only@127.0.0.1:5432/…` and honour `E2E_DATABASE_URL`,
  `E2E_ADMIN_DATABASE_URL`, `E2E_POSTGRES_HOST_URL`. Several `DROP DATABASE`; three share
  `construction_test` — use `--test-concurrency=1`.
- They do not skip when no cluster is reachable: a connection error is **BLOCKED**
  (environment), not a product FAIL and never PASS.
- `.github/workflows/cr01-full-regression-postgres.yml` shows the disposable pattern
  (service container, create `construction_test`, `npm test`).

## 5. Isolated databases

Before running a native suite, read its setup/teardown and confirm the target is a disposable
local or CI cluster. Never give any harness a LIVE or shared URL. Record the server version
(`SELECT version()`) and database identity — without secrets.

## 6. What each kind of change must prove

- **Migration**: fresh apply of the whole chain; upgrade from the previous version with
  representative rows (pattern: `tests/f8.3-migration-011-upgrade.test.ts`); re-run is a no-op;
  SHA-256 of the new file recorded.
- **Transaction rollback**: inject a failure after the first write; assert no partial rows and
  no ledger success (A30).
- **Idempotency**: same key + same payload → same result ids; same key + different payload →
  409; lost-response retry creates nothing new; replay after authorization change refused.
- **Concurrency**: two real connections and a barrier that is proven held before release
  (`withRowLockBarrier()`, `withPackageLockBarrier()`). `Promise.all` alone is not evidence.
- **Quantity invariants**: exact decimal boundaries (HALF_UP, 4 places), caps, zero customer
  acceptance, fact freeze, `NULL` ≠ `0`, integrity conflict not clamped.
- **RBAC**: the negative list in `rbac-authorization` §8, asserting status and no write.
- A test that encodes a cancelled expectation changes only with the decision reference
  (Roadmap §5.2; `docs/gpr-2-r01-decision-test-matrix.md`); never delete a suite wholesale.

## 7. Candidate identity

Every result names the exact full commit SHA tested, a clean or listed-dirty working tree,
the Node version, the database mode (PGlite / native + server version) and the command.

## 8. Evidence classification

```
PASS     executed and passed
FAIL     executed and failed
SKIP     explicitly skipped by the runner or test
NOT RUN  not executed
BLOCKED  could not execute (missing cluster, missing document, no permission)
```

- Report the command, exit status and the runner's pass/fail/skip counts, not a summary word.
- Never report SKIP or NOT RUN as PASS; never call PGlite-only results native concurrency
  coverage; never claim a pass because a test file contains an assertion.
- If native PostgreSQL is unavailable, say so and list what therefore remains unverified.
- No LIVE infrastructure as a test environment; no secrets or connection strings in reports.
