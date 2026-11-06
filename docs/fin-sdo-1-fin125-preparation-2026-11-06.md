# FIN-SDO-1 — FIN1-25 preparation (executor), 2026-11-06

**Status:** `IMPLEMENTED — PENDING INDEPENDENT REVIEW` (test-only candidate + parked CI route). Executor evidence only; not a verdict.
FIN-SDO-1 overall NOT ACCEPTED. **FIN1-25: NOT VERIFIED / BLOCKED** (see §5). No numbered FIN SQL published, no Actions dispatched in this cycle
(**CI limit used: 0 of 1 main + 2 corrective**), no product merge, LIVE, production PostgreSQL, deployment, secrets or permission change.

## 1. Baseline read from GitHub
| Item | Value |
|---|---|
| product main | `516935803f2c211a660df33cae4a48b706ef77a1` (PR #35 merged: integrated native workflow) |
| docs main | `b5cdac31a8e23ced0d075e2a24e53e3011389ee4`; the four registries + instruction + acceptance protocol unchanged (blobs `db4aa265…`, `6fe04021…`, `a979ff48…`, `17dd10e7…`, `4b6711a1…`, `18fe3d60…`) |
| evidence main | `f670452ff3d85e1240ee96c5016b09e0a29b3548` (only F02 run 41463191837 archived) |
| already PASS, not repeated | run `42168671326/1` on `c867dc0d…`: FIN1-05, FIN1-23 and the 001–037 native gate (independent review, docs `b5cdac3`); F02 SEC-01 on `1d89ecd3…` |
| candidate of this cycle | `feature/fin-sdo-1-sequence-gate-20261106` (K2 below) — adds tests + 3 SQL `REVOKE` lines + whitespace; **no `infra/` file** |

## 2. Dependency matrix GPR 038 → 039 → FIN 040
| Step | Source | State on GitHub | Native evidence | Integration |
|---|---|---|---|---|
| 037 | main | merged (R06b) | independent PASS (run 41982683052) | in main |
| **038** R07 | Draft PR #34 `52313e10…`, `infra/038_gpr2_r07_quantity_approval_surface.sql` | open, Draft, not merged | independent **source** PASS; native NOT VERIFIED | **not integrated** |
| **039** R08 | Draft PR #32 `e40c5fc4…`, `infra/039_gpr2_r08_zonal_release.sql` | open, Draft, not merged | independent review of older head `6132f50` = **CORRECTIONS REQUIRED**; head `e40c5fc` not re-reviewed; native NOT VERIFIED | **not integrated** |
| **040** FIN | coordinator conditional reservation (docs `2026-11-05-fin-sdo-1-migration-040-conditional.md`) | **no file published** (this cycle publishes none) | this cycle: local model only | blocked on 038/039 + runner decision |
Ordering is a numbering/sequence rule, not a data dependency: the two GPR branches are **siblings of `fc98aae`** (neither contains the other) and FIN references no GPR object.

## 3. SQL compatibility (static, automated; then dynamic)
* Created names: 038 → 24, 039 → 23, FIN → 53. **Collisions: none** (FIN∩038, FIN∩039, 038∩039 all empty); every FIN-created object is `fin_*`.
* ALTERed by 038: `work_quantity_versions`, `work_allocation_versions`, `gpr2_surface_effects`; `CREATE OR REPLACE r06b_pointer_guard` (038). 039 alters nothing. FIN alters only `fin_*`. **Overlap with FIN's external references (`tenants`, `users`, `objects`, `contractors`): none.** 039 references no 038 object; FIN references no `gpr2_*`/`r0x` object.
* FIN catalog facts: 12 tables, 12 SECURITY DEFINER functions, 0 `GRANT`, 10→13 `REVOKE`, 0 RLS/policy, 0 `DO` blocks, 0 dynamic SQL.
* **Dynamic model (local, disposable PG 16.15; NOT a merge of R07/R08 code — only their two SQL files overlaid on `c867dc0`)**: runner applies 001–039, then FIN as 040: ledger 40 sequential; FIN native suites on the ledger-applied schema: pg 28, service 22, http 11, protected 58, sec01-f01 73, evidence-gaps 10, reviewer F02 probe 16 — all exit 0.

## 4. Findings (exact file, SHA, scenario, minimal correction)
| ID | Finding | Evidence | Correction | Status |
|---|---|---|---|---|
| **B1 — BLOCKING for FIN1-25** | `scripts/migration-runner.ts` (main blob of `c867dc0`; line 69–76 `destructiveStatements`) rejects a numbered FIN file: `MIGRATION_NOT_ADDITIVE: …contains: DELETE FROM, UPDATE … SET`. All 5 hits are runtime DML **inside `CREATE FUNCTION` bodies on `fin_*` tables** (`fin_sdo_update_edit_buffer`: DELETE+UPDATE; `fin_sdo_commit_edit_buffer`: UPDATE); there is no top-level destructive statement and no `DO` block. The scanner's own doc says function bodies are removed but `executableText()` strips only comments. | `node scripts/migrate.ts --plan` on the model tree | **Coordinator/R03d-owner decision.** Recommended minimal patch (§7): exempt only `CREATE FUNCTION … AS $tag$ body $tag$`; DO blocks, signatures and every other statement stay scanned (fail closed). 10/10 adversarial probes and the existing 16 R03d tests pass. Alternatives: class `contract` (misclassifies an additive change, adds a deploy gate) or rewriting FIN to hide DML (rejected: weakens review, needs dynamic SQL). **Not applied to product code by the executor.** | **OPEN — decision** |
| B2 | `fin_assert_quarter_book`, `fin_assert_history_links` (SECURITY DEFINER trigger functions) had no `REVOKE … FROM PUBLIC` (`design/fin-sdo-1/schema-UNNUMBERED.sql` blob `2c5e24e5…`). Not callable (`trigger functions can only be called as triggers`) but violates S-01 "PUBLIC revoked on every FIN function". Found by the new gate. | `seq-post` FAIL, then PASS | 3 `REVOKE ALL … FROM PUBLIC` lines (also `fin_guard_book_identity`). Trigger firing needs no EXECUTE; all suites re-run green on both the 001–037+UNNUMBERED path and the numbered model. | **FIXED in K1** |
| B3 | Trailing whitespace on two comment lines of the FIN SQL would make a numbered copy fail `git diff --check`. | identity gate | comment-only whitespace strip | **FIXED in K2** |
| B4 | Merged `fin-sdo-1-integrated/verify-identity.sh`: `! grep -qi 'fin' infra-inventory.txt` can never fail under `set -e` (a leading `!` is exempt from errexit; reproduced). Practical risk was low (allowlist + count guards cover it) but the stated guard was inert and the independent source review did not flag it. | reproduced in bash | new route uses `if … then fail` | **FIXED in the parked route**; the merged route is left untouched (it is the reviewed artifact of run 42168671326) |
| B5 | Teardown of the merged route selects the first `postgres:16` container and records no post-stop state (reviewer's own limitation). | review 2026-11-06 | parked route addresses `job.services.postgres.id`, records `docker inspect` state and TCP 5432 closed after stop | **IMPROVED in parked route** |
| B6 | GPR R06b trigger 037 vs legacy fixtures (Work 500 / WEU 1000.2468) — separate GPR task. | independent GPR report | none by FIN | **not touched** |

## 5. Why FIN1-25 is not claimed
FIN1-25 needs the exact integrated sequence 001–040 on a candidate that contains a *numbered* FIN file. Today: 038/039 are Draft PRs (not integrated), 040 is conditional and unpublished, and B1 would make the runner refuse the numbered file. The local model above is evidence of **compatibility**, not of integration. Publishing `infra/040_*.sql` or dispatching a run now would produce evidence the independent review cannot accept (not the real chain) and would spend the CI limit.

## 6. What the new gate proves (`scripts/fin-sdo-1-isolated-sequence-verify.ts`, phases)
`pre` — ledger 1..N sequential, no FIN row, no `fin_*` object; **application boot writes nothing** (ledger + non-FIN catalog fingerprint unchanged), FIN routes off by default (404), routes-on without schema/DSN fail closed (observed 401); saves the non-FIN catalog fingerprint.
`post` — exactly one FIN file = N+1 with no gap; rows 1..N byte-identical to before; FIN ledger row additive, checksum = sha256(file), body identical to `schema-UNNUMBERED.sql` (only the leading comment block may differ); **non-FIN catalog fingerprint equals the pre-FIN snapshot** (columns, constraints, indexes, triggers, functions incl. body hash/ACL/owner, views, table ACL/RLS, policies, extensions, event triggers, types); exactly the 12 FIN-1 tables; 12 SECURITY DEFINER with pinned `search_path`, no PUBLIC EXECUTE, no dynamic SQL; DML only on `fin_*`; no PUBLIC table privilege, no RLS/policy; no FK into `fin_*` from outside, FKs out only to the 4 core tables; no FIN function body names a GPR/production/F8.3 object.
`rerun` — runner re-run is a no-op. `tamper` — a changed FIN ledger checksum is refused (`MIGRATION_CHANGED_AFTER_APPLY`) and restored.
Sensitivity (executor mutations, all caught): extra index on `objects` after `pre`; 040 body edited; FIN numbered 041 (gap); and the genuine B2 defect.
Real HTTP + security negatives on the ledger-applied schema: the unchanged F02-era suites (restricted LOGIN, bearer-derived tenant, role matrix, cross-tenant, replay/CAS, forced SQLSTATE, cache headers) + FIN1-05/23 + the reviewer-owned F02 probe.

## 7. Proposed runner patch (diff only — NOT applied to product code; decision B1)
```diff
--- a/scripts/migration-runner.ts
+++ b/scripts/migration-runner.ts
@@ -66,10 +66,19 @@ const DESTRUCTIVE: [RegExp, string][] = [
+/**
+ * The body of a CREATE [OR REPLACE] FUNCTION is not executed by the migration: it is stored, and its DML runs later, under the function's own
+ * guards. Only that body is removed from the destructive scan. The signature (no ';' and no '$' may occur between FUNCTION and the opening
+ * dollar-quote, so the match can never swallow a following statement) and everything else stay visible; a DO block, which DOES run at migration
+ * time, is never exempt. If the pattern does not match, the text is simply scanned as before (fail closed).
+ */
+export function withoutFunctionBodies(text: string): string {
+    return text.replace(/(\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b[^;$]*?\bAS\s+)\$([A-Za-z_]*)\$[\s\S]*?\$\2\$/gi, '$1 ');
+}
 export function destructiveStatements(sql: string): string[] {
-    const text = executableText(sql).split(';').map(statement =>
+    const text = withoutFunctionBodies(executableText(sql)).split(';').map(statement =>
```
Adversarial probes (all PASS): function body with DELETE/UPDATE exempt; clauses after the body; `DO $$ … DELETE … $$` flagged; a `DO` right after a function not hidden; single-quoted function body cannot swallow a later `DO`; top-level `DELETE`/`DROP`/`UPDATE` flagged; trailing `ALTER TABLE … DROP COLUMN` flagged; nested dollar tags. A product change needs its own tests + review (R03d owner).

## 8. CI route (parked) and execution plan
* Existing, checked and reused: `fin-sdo-1-integrated-native.yml` (run-once, merged), `fin-sdo-1-sec01-f02-independent.yml` (pinned to F02, 001–028), `gpr2-acceptance.yml` (stage regex `R\d\d|GPR2-*`, scrubs `DATABASE_URL` → unusable for FIN scripts), `cr01-*` (unrelated). Infrastructure available in CI: PG16 service, Node 22.22.0, Chromium, real HTTP.
* New: `ci/fin-sdo-1-sequence-native-20261106` — `fin-sdo-1-sequence-native.yml` + `.github/acceptance/fin-sdo-1-sequence/**`. Minimal adaptation of the merged route (table in its README). **All pins PENDING ⇒ cannot run.** Local end-to-end dry-run on a model candidate: identity PASS, 18/18 checks PASS, manifest 64 files verified.
* Activation steps and the limit (1 main + ≤2 corrective runs, each corrective on a new exact SHA with source review) are in that README.

## 9. Independent acceptance plan (FIN1-25)
1. Reviewer reads K2 source (tests + REVOKE + whitespace only), the parked route, and decides B1.
2. After 038/039 integration + coordinator decision on 040 and B1: candidate commit pinned; source review of the exact numbered file (body-identical to the reviewed schema).
3. One owner-authorized dispatch; reviewer verifies artifact digest, `SHA256SUMS`, identity files, 18 exit files, `teardown.txt` (stop exit, container state, port closed), then runs own negatives (e.g. direct SQL as the restricted LOGIN, tampered checksum, wrong number).
4. Durable archival of the original artifact in the private evidence repository (precedent: F02 `runs/fin-sdo-1/sec01-f02/…`).

## 10. Identities (this cycle)
| Item | SHA |
|---|---|
| K1 `1ca65827…` (tests + REVOKE) → **K2 `fc1c27d2e91403021dd948f52fc0d2010bb8cc84`**, tree `99d47952dcd8bb8372e9a3bfab1050307195a5c8`, parent K1 → parent `c5561d14…` (published handoff) | branch `feature/fin-sdo-1-sequence-gate-20261106` |
| K2 blobs | `fin-sdo-1-isolated-sequence-verify.ts` `dbb52a1c41b54c3e35d067d1a1b0c68833530098`; `…pg-verify.ts` `b3be4174d88290b8db04c845b3f6379a091f21e5`; `schema-UNNUMBERED.sql` `a29c20d3927d782677fc57ca73d459a611a96b9c` |
| Parked CI route | `ci/fin-sdo-1-sequence-native-20261106@c85d5b33fbbdc96d9bea4e6daa7e60c1717675ef`, tree `331bfb32c0160c4fb0c4dd26847556dd304fa1d7`, parent main `516935803f…` |
Local evidence (ephemeral scratchpad, not published): model dry-run SHA256SUMS sha256 `43224562ed78a8bc395f6a869aa29e89e511d19d60bdc2d517754a4dfe73950b` (64 files).
