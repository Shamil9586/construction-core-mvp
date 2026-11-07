# FIN-SDO-1 FIN1-25 numbered-sequence route — PARKED (review-only, cannot run as committed)

Adapts the already-run `fin-sdo-1-integrated` route (run 42168671326, independently reviewed) to the chain
**GPR 001-039 (incl. 038 R07, 039 R08) → FIN as the next numbered migration (040, conditional)**. Every pin is `PENDING`:
`verify-identity.sh` refuses PENDING and the candidate checkout ref is a non-existent placeholder, so a dispatch cannot start testing anything.

## What differs from the integrated route (the minimal adaptation)
| Area | integrated route | this route |
|---|---|---|
| Schema source | `design/…UNNUMBERED.sql` loaded by `pg-verify` | the ledger: runner applies 001..039, then the numbered FIN file; `FIN_SDO_SCHEMA_APPLIED=1` |
| Added checks | — | `migrate-plan-all`, `seq-pre`, `seq-post`, `seq-rerun`, `seq-tamper` (`scripts/fin-sdo-1-isolated-sequence-verify.ts`) |
| Identity | diff-vs-base allowlist, 37 files | diff-vs-GPR-main allowlist, PRE+1 files, FIN last and the only `fin_sdo` file, 001..PRE byte-identical to GPR main, PENDING refused |
| Guards | `! grep … ` (no-op under `set -e`) | `if … then fail` — every guard can actually fail |
| Teardown | first `postgres:16` container, no post-stop state | the job's own service id (`job.services.postgres.id`), `docker inspect` state and TCP 5432 closed after stop, `docker ps -a` before |

## Activation (separate gates; none is decided by this PR)
1. GPR 038 and 039 integrated in product `main`, native-verified, independently accepted (PRs #34 / #32 are NOT integration).
2. Coordinator authorizes FIN migration 040 and decides the migration-runner treatment of DML inside `CREATE FUNCTION` bodies
   (`MIGRATION_NOT_ADDITIVE` today — see `docs/fin-sdo-1-fin125-preparation-2026-11-06.md` finding B1 on the FIN candidate branch).
3. A candidate commit exists = integrated main + FIN code + `infra/040_fin_sdo_1_quarterly_planning.sql`, source-reviewed at its exact SHA.
4. A reviewed PR fills `candidate.env`, `candidate-allowed-paths.txt`, this workflow's `ref:` and confirmation (four edits, no logic).
5. Owner-authorized single dispatch (actor `Shamil9586`, `main`, attempt 1). Limit for the FIN1-25 gate: 1 main run + at most 2 corrective runs, each corrective run on a NEW exact SHA with its own source review.

## Evidence to verify (reviewer)
`git-identity.txt`, `candidate-diff-names.txt`, `infra-inventory.txt` (PRE+1 sequential, FIN last), `infra-sha256.txt`, `checks.tsv` (18 rows, no FAIL/NOT_RUN),
every `*.exit` = 0, `fin-seq/catalog-pre.json` + `migrate-*.log`, `teardown.txt` (`docker_stop_exit=0`, `container_state_after_stop`, `port_5432_after_stop=closed`),
`run-identity.txt`, `SHA256SUMS`. Not claimed: acceptance, FIN overall, GPR 038/039 acceptance, LIVE/production, role provisioning.
