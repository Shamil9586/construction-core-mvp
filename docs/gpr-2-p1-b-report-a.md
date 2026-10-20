# GPR-2 / P1-B — Report A for the independent reviewer (R02 + R03)

**Status of this report: executor's evidence. Nothing here is accepted.** The executor does not and cannot grant ACCEPTED to its own work. R04 has **not** been started (STOP before R04).

Base `678e795f8802a76ac025f28b0d698351af8b7721` · branch `claude/gifted-albattani-p1uav9` (the branch the session was assigned; the brief's *recommended* `feature/gpr2-p1-r02-r04` was not used — see "Open points") · Technical Design sha256 `b80ba731…879368` · Roadmap sha256 `a4c27d19…434f76`
(both verified before work began; the brief's own "EXECUTION TASK" document was **not among the attachments** — only the two normative documents were — so the work follows the brief text, the Roadmap and the Technical Design).

## 1. Exact SHAs (each a self-contained commit; `git log --oneline 678e795..c95eb0b`)

| Stage | SHA | Parent | Own tests | Focused run (exit codes) |
|---|---|---|---|---|
| **R02a–c** fact resolver · persisted source mode · known-at | `7753bb25ab25774eb1c18ce390fecbe7f8632d86` | `678e795` | `gpr2-r02-*` (4 files, 31 tests) | full suite at this SHA: `results/r02-7753bb2.tsv` |
| **R03a** transaction context | `4459cc77380f70eae000ec5fcd05ac784bf6f84b` | R02 | `gpr2-r03a-*` (2 files, 10 tests) | `results/stages/r03a.tsv` |
| **R03b** coordination lock · writer register | `88437ddc760ecad3d38449a84a69766b1abdc0a3` | R03a | `gpr2-r03b-*` (2 files, 18 tests) | `results/stages/r03b.tsv` |
| **R03c** command ledger | `0d8d26f4292816afd5cd2c5d97d31b546796c6c5` | R03b | `gpr2-r03c-*` (2 files, 16 tests) | `results/stages/r03c.tsv` |
| **R03d** controlled migrations | `dd6d1b2bd9a6c316cb5399dfec4d85a0e51d2e17` | R03c | `gpr2-r03d-*` (2 files, 22 tests) | `results/stages/r03d.tsv` (27 files, `tsc` exit 0) |
| R03b polish (comments only) | `5149220aec1370279bc245f49684a53bad48c897` | R03d | — | — |
| Harness: the isolation refusal is itself tested (test-only) → **P1-B code SHA** | `c95eb0b1bdcc405ea6f347ad9418054851d6713e` | polish | `gpr2-p1-isolation-guard` (1 file, 5 tests) | **full suite**: `results/p1b-c95eb0b.tsv` |
| Evidence + this report (docs only) | the branch HEAD that adds this file (a commit cannot cite its own SHA; see `git log -1 -- docs/gpr-2-p1-b-report-a.md`) | P1-B code | — | `git diff c95eb0b HEAD --stat` touches only `docs/` |

The full diff is 46 files, +4 363 / −92 (`git diff --stat 678e795 c95eb0b`). Production code touched: `service.ts`, `read-service.ts`, `schedule-scope.ts`, `documentation-scope.ts`, `aosr-service.ts`, `schedule-service.ts`, `pto-work-assignment-service.ts`, two controllers (one line each), `db.ts`, `scripts/migrate.ts`; everything else is new.

## 2. Contracts implemented (details: `docs/gpr-2-r02-fact-resolver.md`, `docs/gpr-2-r03-transactions-locks-ledger-migrations.md`)

* **R02** One pure resolver (`packages/domain/gpr2/fact-resolver.ts`) + one SQL loader; seven private "latest" computations replaced (a source-level test forbids a new one). RP/INTERNAL_SC: `recordedAt`, then monotonic `confirmation_seq`; an unorderable legacy tie is `UNKNOWN_TIE` (never a guess). CUSTOMER_SC: F12.1 grouped semantics unchanged. **Persisted source mode** `works.fact_source_mode` (`NULL` = never classified, no default, no backfill) + trigger-written history + guard trigger; an empty execution unit no longer takes the legacy figure away (**300 stays 300**, A05); a legacy and a portion figure are never summed. **Known-at** by immutable `created_at`; **effective-at** answered `EFFECTIVE_DATE_NOT_RECORDED`; `NOT_YET_KNOWN`, `HISTORY_UNAVAILABLE`; `completionObservedAt` with provenance `SYSTEM_RECORDED_CREATED_AT`. Migration `026` (additive).
* **R03a** `runCommandTx` / `runSnapshotRead` (REPEATABLE READ READ ONLY); bounded retry of 40001/40P01 only; any `pool` use inside a context throws.
* **R03b** Per-(tenant, object) advisory coordination lock, SHARED/EXCLUSIVE, first statement before any row lock (provable: `pg_current_xact_id_if_assigned()`), bounded wait, 90-row writer register (57 SHARED, 3 EXCLUSIVE, 30 NONE with reasons) closed by an AST test (bypass paths); the 60 coordinated writers all call `coordinate()` first.
* **R03c** `gpr2_command_ledger` (migration `027`, additive) + `runLedgered`: authorize → claim → compare → replay|execute → complete in one transaction; replay hook for the R01 pipeline.
* **R03d** Migration classes, additivity check, ledger checksums, contract gate (never implicit, never at boot), `--plan`; 001–025 byte-identical and pinned.

## 3. Results (every test file, own exit code; PostgreSQL 16.15 isolated cluster)

| Run | Files | Non-zero exit | Tests | Pass | Fail | Skipped |
|---|---|---|---|---|---|---|
| **Baseline** `678e795` (`results/baseline-678e795.tsv`) | 111 | 0 | 1029 | 1028 | 0 | 1 |
| **R02** `7753bb2` | 115 | 0 | 1060 | 1059 | 0 | 1 |
| **P1-B code** `c95eb0b` (`results/p1b-c95eb0b.tsv`) | 124 | 0 | 1131 | 1130 | 0 | 1 |

The P1-B row was produced in three parallel shards (separate databases `construction_test_s0..2`) to fit the time budget. Six files (`acceptance`, `core-2.0-decisions`, `core-2.1-contractors`, `pilot-data-work-category`, `regression-erp-parity`, `workflow`) failed **in the shard run only** because those legacy suites insist the database name end in `_test`, which a shard name does not; they were re-run unchanged through the committed `scripts/gpr2-p1-run-tests.sh` on `construction_test` (6 files, 13 tests, all exit 0) and the merged table substitutes those rows (marked in the `note` column; the failing shard logs are kept in `superseded/p1b-shard-name-failures/`, the raw shard tables in `results/p1b-shard*.tsv`, `results/p1b-rerun.tsv`). It is a harness-naming artefact, not a code failure — but it is a substitution, stated here.

The one skipped test is the same at baseline. `tsc --noEmit` exit 0 and `npm run typecheck:strict` exit 0 at baseline, at R02 and at the P1-B code SHA (`results/*typecheck*`). **The scoped strict `TS2345` limitation is kept in the list of known limitations: it did not reproduce in this environment, which is an observation, not evidence that it was fixed, and nothing was changed to address it.**

New tests: 13 files, 102 tests (pure, PGlite, and native PostgreSQL). Native PostgreSQL covers: migration on 025-shaped data, the mode-transition race (R02); a snapshot across a concurrent commit, abort and failed COMMIT, a real 40001 retry (R03a); lock matrix, A06, exclusive writers, pooled reuse, stress (R03b); concurrent same-key ledger races (R03c); concurrent runners, failure in the middle, upgrade from the old ledger, runner blocked on the lock (R03d).

**Honest record of what went wrong on the way (kept in `results/` and `superseded/`):**
1. The first baseline attempt used a wrong `E2E_POSTGRES_HOST_URL` (missing trailing `/`), so four legacy native suites failed with "database does not exist" and the run hung on an unclosed admin client. That was the executor's environment error, not a code defect; the baseline was redone per file on a fresh database (table above).
2. The first R02 candidate (`be77e62`) **failed five existing tests** that pin the *end* of the migration chain (`gpr-1-schedule-postgres` A1, `org1-company-structure-postgres`, `pbx5a-bitrix-notifications-postgres`, `role-cleanup-migration-postgres`, `bitrix-disk-1-storage`) — any additive migration invalidates them. Fixed in R02 (`7753bb2`) by pinning what they mean (025 directly follows 024; 1–25 intact and gap-free; head = number of files) and, for the one pinned in the R01 index, updating its hash deliberately with the licensing decision (C17). The failing run is `superseded/r02-be77e62.tsv`.
3. The first lock implementation remembered "already held" per **client object**; a pooled connection reused by the next transaction skipped the lock. The native R03b test found it; fixed with a per-transaction token before R03b was committed; a regression test reuses a pooled connection while another session holds EXCLUSIVE.
4. **R03d defect found by the full run, fixed before hand-off.** My first runner refused (`MIGRATION_LEDGER_MISSING_CHECKSUM`) a ledger row that has no checksum; that broke the unmodified `f8.3-migration-011-upgrade` suite, which builds a pre-checksum ledger on purpose. Fixed by amending R03d (`dd6d1b2`): a non-legacy row without a checksum is *reported* as unverified (never refused, never given a checksum it did not earn); a row whose checksum differs from the file is still refused (`MIGRATION_CHANGED_AFTER_APPLY`). The stage was re-run at `dd6d1b2` (`results/stages/r03d.tsv`; the earlier run is `superseded/r03d-pre-dd6d1b2/`), and a PGlite test for the old-style ledger was added.
5. Two sequential full-suite attempts (at `599c6c4`, and at an earlier build of the final commit; both predate the R03d amendment) were **stopped by the executor before completion** to switch to the sharded run; their partial per-file tables (22 and 56 files; the single failure among them is `f8.3-migration-011-upgrade`, the R03d defect of item 4) are kept in `superseded/aborted-partial-runs/` and are not counted anywhere.

## 4. Existing tests changed (all of them; no protected F12.1 / CR01 / PTO / SDO / SC suite was touched — `gpr2-r01-traceability` pins them byte-for-byte and passes)

`gpr2-r01-traceability` (exactly 25 files → baseline chain through 025 intact, later files gap-free) · `gpr-1-schedule-postgres` A1 (`files.at(-1) === 025` → 025 directly follows 024; hash in `tests/helpers/gpr2-decision-index.ts` updated with the decision cited) · `org1-company-structure-postgres` (`slice(17)` → `slice(17, 25)`) · `pbx5a-bitrix-notifications-postgres` (exactly 1–25 → 1–25 intact, gap-free) · `role-cleanup-migration-postgres`, `bitrix-disk-1-storage` (literal head `25` → number of numbered files). No business assertion of any of them was weakened.

## 5. R03b — separate evidence for the specialised check

`docs/gpr-2-p1-evidence/r03b/` (logs + the JSON the tests record) and the R03b section of the R03 document. The reviewer's hooks: (a) `tests/gpr2-r03b-writer-registry.test.ts` — the register is complete (every `transaction()` / pool write is a row), every coordinated writer calls `coordinate()` as the **first statement**, the EXCLUSIVE set is exactly `createWork`, `dependency`, GPR-1 `approveDraft`; (b) `tests/gpr2-r03b-coordination-pg.test.ts` — two-connection races staged by barriers that PostgreSQL itself reports (`pg_stat_activity`, `pg_locks`); (c) the unmodified protected native suites `f8.3-postgres-concurrency`, `f12-final-corrective-postgres-concurrency`, `f12-final-r06-auth-safe-idempotency`, `f12-sdo-03-retry-safety` — green at the R03b SHA `88437dd` (4 files, 18 tests, all exit 0, `results/protected-concurrency/`) and again inside the full-suite run at `c95eb0b`; (d) the **new /v2 scope-changing endpoints stay off** (R01 flag + `501`) until the register is accepted.

## 6. PostgreSQL isolation — confirmation

`docs/gpr-2-p1-evidence/environment.md`: own PostgreSQL 16.15 started for the run, `cluster_name = gpr2-p1-isolated`, loopback only, data directory outside the repository; every native test and `scripts/gpr2-p1-run-tests.sh` refuse any other server; databases are `gpr2_p1_<random>` / re-created `construction_test`; no production credential exists in the container (0 matching variables); LIVE PostgreSQL, Render and Bitrix24 were not contacted; `main` untouched; nothing deployed.

## 7. Interpretations the reviewer is asked to confirm or overturn

1. **Unclassified Works keep today's recording behaviour** (the protected F8.x / F12.x suites record portion facts on seeded Works that carry progress); the strict "no portion fact while a legacy fact exists" gate applies to **persisted** `LEGACY_WORK` only; the overlap on an unclassified Work is reported as `OVERLAP_UNRECONCILED`, never summed. Making the gate universal needs new fixtures for four protected suites — a decision, not a fix.
2. **No column default** for `fact_source_mode`: no Work is classified by R02 (R19 after I-LIVE).
3. **EFFECTIVE-AT is not recorded** → explicit `EFFECTIVE_DATE_NOT_RECORDED`; `completionObservedAt` means "when the system learned", with that provenance.
4. **Lock before object authorisation**: a permitted-but-unauthorised caller can hold an object's lock for milliseconds before refusal (key includes tenant). Short, rate-limited, not an exposure.
5. **`NONE` register rows are decisions** (team/organisation assignment, tenant dictionaries, `commitImport` — it creates *new objects only*, no Work).
6. The `readModel` Work payload gained additive fields `factState`, `factSourceMode`, `factSourceModeProvenance`; `works[].actualQuantity` is `0.0000` with `factState = UNKNOWN_TIE` when the resolver cannot state a figure.

## 8. Not done, by design

No Work classified; no backfill; no LIVE migration/deploy; no R04/R05/P2; no `/v2` handler implemented (all still `501`); no quantity approval (R07) — the EXCLUSIVE section in the A06 test is a probe taking the same lock; no HTTP route for the as-of read; no startup refusal for unapplied migrations (release-plan decision); D01–D24 / K01–K04 untouched.

## 9. Open points that need the owner/coordinator

* **Publication.** Pushing the branch was authorised "при подтверждённой безопасности от автоматического LIVE deployment". What the executor could establish: `.github/workflows` has two workflows, both restricted to other branches (`fix/cr01-*`) plus manual dispatch, `contents: read`, no deploy step and no secrets; there is no `render.yaml`/blueprint in the repository. What it **cannot** establish: which branch the Render services track and whether auto-deploy is on (set in the Render dashboard, which the executor must not read or touch). **Until that is confirmed, nothing has been pushed** and all commits exist only in the session's repository.
* Branch name: assigned `claude/gifted-albattani-p1uav9` vs recommended `feature/gpr2-p1-r02-r04`.
