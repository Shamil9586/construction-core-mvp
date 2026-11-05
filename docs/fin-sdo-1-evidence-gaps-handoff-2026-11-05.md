# FIN-SDO-1 — executor handoff addendum: FIN1-05 / FIN1-23 closure and CI-only route

**Status:** `IMPLEMENTED — PENDING INDEPENDENT REVIEW`. Executor evidence only; not an acceptance verdict. FIN-SDO-1 overall NOT ACCEPTED.
No Actions were dispatched; no PR, merge, LIVE, production DB, deployment, numbered FIN SQL or migration number.

## Identities (all published to GitHub; read back through the GitHub API)
| Item | Value |
|---|---|
| Code candidate (pinned by the CI route) | `Shamil9586/construction-core-mvp@c867dc0de12f4f3fbe544c1172a95b5e6176d4cb`, tree `ae78a4cd5cd584cd626914422031b2902b6841db`, parent `ce90f3a8…`, branch `feature/fin-sdo-1-evidence-gaps-fin105-fin123-20261105` |
| Integrated code base (already source-reviewed) | `3be8259ef5d4f69f353c8f5045d52d9c14576918`, tree `4ea177c11f5b58bb1e99fafd2700779bbf347e85` |
| Candidate vs `3be8259` | exactly 2 paths: the handoff note and `scripts/fin-sdo-1-isolated-evidence-gaps-verify.ts` (blob `cc6c016f9d8b5fdd98e22156730aeba99145293d`, 356 lines, test only) |
| CI-only proposal | `ci/fin-sdo-1-integrated-native-20261105@1ce0065a8ba894d26356fbc5c1c7a3194e46c6f8`, tree `f1a6d22af3e4f7a1453e656e8fc4dfdd973e6221`, parent = main `fc98aae5…`; workflow blob `ca9c7d0a877a3672654682af1d91e0850952fbdc`, README `d9fe1f9e…`, `candidate.env` `ea7db95b…`, `run-checks.sh` `2b74d5d4…`, `seal.sh` `e432405a…`, `verify-identity.sh` `cb507f95…` |
| FIN SQL | unchanged `design/fin-sdo-1/schema-UNNUMBERED.sql` blob `2c5e24e5a866ca7882841a1a79b52c97a0e7f91e`; `packages/domain/index.ts` still equals main (`68e804a3…`) |

## What the new script proves (native PG 16.15, real HTTP, restricted FIN LOGIN)
* **FIN1-05:** DB layer refuses UNALLOCATED with a contractor/party id, a second UNALLOCATED per tenant, NOT_SPECIFIED with a number, KNOWN without/blank number,
  duplicate scopes, cross-tenant FKs, NULL canonical key parts. HTTP layer: UNALLOCATED+NOT_SPECIFIED commits with no contractor, no historical party and no "no contract" wording;
  it stays a separate canonical line from KNOWN and from real parties (four distinct keys, amounts unmerged); 12 invalid combinations are refused (400/403/422) with **zero writes**
  (row counts of both tenants unchanged); discovery and reads write nothing.
* **FIN1-23:** an open `REPEATABLE READ READ ONLY` snapshot on one connection (same backend pid) is unchanged by a concurrent committed correction and does not block the writer;
  a negative control shows a non-snapshot two-statement read **is** torn (so the invariant checker is not vacuous); a bounded stress (14 corrections vs 4 HTTP readers incl.
  read-only GENERAL_DIRECTOR + 2 direct snapshot readers, each reading twice per snapshot) found 0 inconsistent reads (≈170–320 reads, 15 distinct revisions).
* DEC-01 and the restricted boundary are re-asserted under the same load (PTO 403, cross-tenant NO_PLAN, GD cannot write, direct SELECT 42501) and a scope guard asserts exactly the 12 FIN-1 tables.

## Executor evidence (local, disposable loopback PG 16.15; raw logs are in the ephemeral session scratchpad, not published)
| Run | Result |
|---|---|
| chain 001–037 → pg/service/http/protected/sec01-f01 → evidence-gaps, three consecutive runs | each exit 0, 10 PASS / 0 FAIL |
| mutation 1: drop UNALLOCATED singleton index + NOT_SPECIFIED CHECK | script FAILS (`UNEXPECTED SQL SUCCESS: a second UNALLOCATED scope`) |
| mutation 2: reader `READ COMMITTED READ ONLY` instead of `REPEATABLE READ` | deterministic snapshot test and stress FAIL (`two reads of one snapshot differ`); an earlier version of the stress did **not** discriminate and was strengthened |
| reviewer-owned `fin-sdo-1-sec01-f02-negative.mjs` on chain 001–037, CI-like `core/` layout | 16 PASS, exit 0 |
| dry-run of the CI scripts (`verify-identity`, `run-checks`, `seal`) on an exact checkout of `c867dc0` | 13/13 checks PASS, manifest verified (42 files, SHA256SUMS sha256 `865d35f4…aa4b3`); identity gate refuses a stray file, a wrong commit and an allowlist mismatch; failure path records `NOT_RUN`; DB guard refuses non-loopback URL |
| typecheck / unit (56 tests) | exit 0 / 56 pass |
Limits of the dry-run: local clone is shallow so one identity assertion (`is-shallow-repository`) was removed in a throw-away copy only; the Actions YAML itself has **never executed** (YAML parses; no actionlint available).

## Status of criteria
| Criterion | Status |
|---|---|
| FIN1-05 | PASS (executor-run, mutation-checked); independent review pending |
| FIN1-23 | PASS (executor-run, mutation-checked); independent review pending |
| FIN1-25 | **BLOCKED / NOT CLAIMED**: no numbered FIN SQL; conditional `040` only after exact integrated GPR 038 → 039. 001–037 + UNNUMBERED is not FIN1-25 evidence |
| Hosted PG16 + real HTTP run on `c867dc0` | **NOT RUN** (needs owner authorization below) |
| Differential full `npm test` | unchanged from the earlier handoff (no new merged-only failure); `main` red due to GPR R06b trigger 037 vs old fixture (Work 500 / WEU 1000.2468) — separate GPR task, **not touched** |

## Minimal permission for ONE exact-SHA CI run
1. Independent review of the CI branch `ci/fin-sdo-1-integrated-native-20261105@1ce0065` and the candidate `c867dc0`.
2. Owner-authorized **CI-only product PR** of that branch into `main` (adds only `.github/workflows/fin-sdo-1-integrated-native.yml` and `.github/acceptance/fin-sdo-1-integrated/**`; no product source), reviewed and merged by the coordinator route (workflow must be on `main` to be dispatchable).
3. Owner-authorized **single** `workflow_dispatch` of `FIN-SDO-1 integrated native (CI-only, exact candidate)` on `main` with confirmation `APPROVE-FIN-INTEGRATED-NATIVE-C867DC0D` (the workflow also requires actor `Shamil9586`, `run_attempt == 1`). No secrets/permissions change, no other workflow.
