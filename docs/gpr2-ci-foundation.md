# GPR-2 CI Foundation — universal independent acceptance infrastructure

Status: **IMPLEMENTED — PENDING INDEPENDENT REVIEW.** Branch `feature/gpr2-ci-foundation`, baseline `main`
`9bd684806f0d87d802387abb141d9a88d950ceba` (tree `fb4d5724a5af1164d6dc46bfddc0be49776453f7`).
Not merged, not run on GitHub-hosted runners, no deployment. A green run of this workflow is a **technical gate**, never an
acceptance verdict; independent review and the owner/coordinator decision remain separate steps (CLAUDE.md, *Acceptance*).

## 1. What changes and what does not

| Path | Change |
|---|---|
| `.github/workflows/gpr2-acceptance.yml` | **new** universal manual workflow: `authorize` → `runtime` → `seal` |
| `.github/acceptance/lib/*.mjs`, `lib/pg-cluster.sh` | **new** harness (Node built-ins only, bash, jq) |
| `.github/acceptance/profiles/*.json` | **new** stage registry: `r04-cp02`, `r04-main-integration`, `stage-template` |
| `.github/acceptance/approvers.txt` | **new** dispatcher allowlist (`Shamil9586`) |
| `.github/acceptance/tests/*` | **new** harness self-tests (unit, PostgreSQL lifecycle, synthetic end-to-end) |
| `.github/acceptance/archive-evidence.sh` | **new** owner/reviewer helper for durable archival |
| `docs/gpr2-ci-foundation*.md` | **new** this document and the independent acceptance assignment |
| `docs/gpr2-independent-acceptance-ci.md` | one pointer line added at the top |

Unchanged, byte for byte: `.github/workflows/gpr2-independent-acceptance.yml` and its four scripts in `.github/acceptance/*.sh`
(the **frozen R04 reference** that produced run 39788979618), `.github/workflows/claude.yml`, the CR01 workflows, all product code,
all product tests (`apps/`, `packages/`, `infra/`, `scripts/`, `tests/`), `package.json` and `package-lock.json`.

## 2. Architecture

```
workflow_dispatch (main only, owner only)
  inputs: profile, candidate_sha, confirmation = "APPROVE-TEST-ONLY <profile> <sha>"
        │
        ▼
┌─ authorize ─ ubuntu-24.04 · contents:read · NO candidate code ───────────────────────────────┐
│ harness checkout @ github.sha (sparse .github/acceptance)                                    │
│ authorize.mjs: repo, event, ref, actor AND triggering_actor ∈ approvers.txt, profile exists,  │
│   validates strictly, status ACTIVE, SHA is full and registered, confirmation restates both   │
│ checkout candidate by SHA (fetch-depth 0, no credentials) → identity.mjs: SHA, tree, pinned   │
│   lineage, baseline ancestry + tree, clean tree, not shallow, git diff --check                │
│ artifact: authorization-run<id>-a<n>                                                          │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
        ▼ outputs (all regex-validated values from the profile)
┌─ runtime ─ ubuntu-24.04 · contents:read · no secrets · no dependency cache ──────────────────┐
│ harness @ github.sha + candidate @ SHA; identity re-verified BEFORE any candidate code         │
│ npm ci (candidate lockfile) → pg-cluster.sh start (PG 16, 127.0.0.1:54329, gpr2-p1-isolated)  │
│ → playwright install --with-deps chromium → run-profile.mjs (harness-owned runner)           │
│ → pg-cluster.sh stop (always; verified; cleanup.json) → artifact raw-run<id>-a<n> (7 days)    │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
        ▼ (always, if authorize succeeded)
┌─ seal ─ ubuntu-24.04 · contents:read · NO candidate code ────────────────────────────────────┐
│ fresh harness @ github.sha; candidate identity re-verified a third time, independently       │
│ seal.mjs: classify raw evidence against the profile FROM THE WORKFLOW COMMIT, bind identity, │
│   profile digest, run/attempt; manifest.json + SHA256SUMS; SUMMARY.md to the job summary      │
│ artifact gpr2-acceptance-<stage>-<profile>-<sha12>-run<id>-a<n> (90 days); job fails unless   │
│   TECHNICAL_GATES_PASSED                                                                     │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

Design choices:

- **Registry, not workflow edits.** A stage is a JSON profile. Adding R05 never edits the workflow; it adds a reviewed profile.
- **Harness-owned runner.** The frozen R04 workflow executed the candidate's own `scripts/gpr2-p1-run-tests.sh`, i.e. the candidate
  could redefine how its results were counted. `run-profile.mjs` lives on main and is the only runner.
- **Exact oracles.** Every node-test file has an exact `expect_tests`; every Playwright check an exact `expect_passed`. A deleted,
  renamed or newly skipped test changes the count and fails the gate.
- **Three identity checks** (authorize, runtime-before-execution, seal) and a profile digest carried from `authorize` to `seal`.
- **Immutable references.** The harness is checked out at `github.sha` (not `main`, which can move between jobs); the candidate by
  full SHA only. Third-party actions are pinned by commit SHA (verified against the tags with `git ls-remote` on 22.10.2026):
  `actions/checkout@11bd719… v4.2.2`, `actions/setup-node@49933ea… v4.4.0`, `actions/upload-artifact@ea165f8… v4.6.2`,
  `actions/download-artifact@d3f86a1… v4.3.0` — the first three are the pins already proven in run 39788979618.

## 3. Profile registry (stage registration)

`.github/acceptance/profiles/<profile_id>.json`, schema `construction-core/gpr2-acceptance-profile@1`, validated by
`lib/profile.mjs` (unknown keys, short SHAs, `..` paths, free-form commands, impossible combinations are rejected).

| Field | Meaning |
|---|---|
| `stage`, `profile_id`, `status` | `ACTIVE` (runnable) · `TEMPLATE` (never runnable, no candidates) · `RETIRED` |
| `baseline.sha/tree` | authorised baseline of the stage; must be an ancestor of every candidate |
| `candidates[]` | `sha`, `tree`, `lineage[]` (pinned ancestors `HEAD^`, `HEAD~2`, `HEAD^2`…), optional `diff_check_from`, `approval` (owner decision reference) |
| `runtime` | `ubuntu-24.04`, exact Node version, PostgreSQL major, job timeout, `requires: postgres/chromium` |
| `checks[]` | `node-test` (files + exact counts, per-file timeout, fresh DB per file), `playwright` (root config + exact pass count), `npm-script` (named `package.json` script) |
| `class` | `NATIVE_POSTGRESQL`, `PURE_PGLITE`, `UNIT`, `BROWSER_CHROMIUM`, `TYPECHECK_BUILD`, `MIGRATION` — reported separately; a `PURE_PGLITE` check may not require native PostgreSQL and a `NATIVE_POSTGRESQL` check must |
| `mandatory`, `allow_skip` | a mandatory check may never allow skips; optional checks are reported but do not gate |

Committed profiles:

- **`r04-cp02`** — frozen equivalent of the accepted R04 gates: candidate `b882fd0a…` (tree `2f5d3648…`), lineage
  CP-01 `169ae902…` → R04 `e7ddcf63…` → base `92fcf6d0…`; native PostgreSQL 7 files / **27** tests, PGlite migration runner **16**,
  Chromium `playwright.gpr-1.config.ts` **22** = 65, plus verified PostgreSQL cleanup.
- **`r04-main-integration`** — the same gates against the integrated main merge `9bd68480…` (tree `fb4d5724…`, parents
  `8376cd3c…` + `3002489e…` → `b882fd0a…`) **plus `npm run build`** (type-check + Vite build). Shows how an integration commit is
  verified; its build gate has never been executed (§11).
- **`stage-template`** — R05 starting point: stage suites, previous-stage compatibility (R02–R04 native), PGlite, browser, build.

## 4. Authorisation model

A dispatch runs only if **all** hold (job-level `if` + `authorize.mjs`, both on main):

1. repository `Shamil9586/construction-core-mvp`, event `workflow_dispatch`, ref `refs/heads/main`;
2. `github.actor` **and** `github.triggering_actor` (re-runs) are approved (job `if` and `approvers.txt`);
3. the profile id is well-formed, exists at the workflow commit, validates, is `ACTIVE`;
4. the candidate is a full lowercase 40-hex SHA **registered in that profile** — registration happens only through a reviewed PR to
   main, so "exists in a PR" or "is on a branch" never authorises execution;
5. the confirmation restates the exact profile and SHA (prevents a mistaken dispatch with a pre-filled form);
6. the fetched commit matches the registered tree, lineage and baseline, is clean and not shallow.

## 5. PostgreSQL infrastructure and the F-CI-01 correction

`lib/pg-cluster.sh start|stop|status` replaces the frozen start/stop scripts for the universal path.

**F-CI-01 (LOW, nonblocking) — reproduced and corrected.** The frozen `postgres-stop.sh` tests `"$ROOT/data/PG_VERSION"` as the
runner user; the cluster directory is `0700 postgres`, so the test is false, the stop branch is skipped and the step exits 0.
Self-test **T3** reproduces this on a real PostgreSQL 16.15 cluster: frozen script exit 0, unprivileged `PG_VERSION` test false,
server still answering on 54329. The new implementation:

- creates `/var/tmp/gpr2-accept-<run_id>-<attempt>` (run **and** attempt; numeric only), refuses a stale root and an occupied port,
  uses its own unix-socket directory, `cluster_name=gpr2-p1-isolated`, loopback, port 54329, and verifies `cluster_name`, server
  address, port, database **and `data_directory`** before any test database exists (`postgres/identity.json`);
- performs every probe of the cluster with `sudo`/`postgres` privilege; signals only the postmaster whose `postmaster.pid` names
  exactly this data directory and port **and** that the process table ties to this root (otherwise refuses, `FAILED`, exit 1);
- establishes ownership from the process table, never from a file, a port or an argument (F-CI-02). `-D` names the *configuration*
  directory — a foreign cluster can use our data dir for config only while its real `data_directory` is elsewhere — so `-D` alone proves
  nothing. A **postmaster** is the cluster's own only if it is the `postgres` binary, its argv has `-D <data dir>`, its cwd (the kernel's
  record of the effective data directory; shown as `(deleted)` after an unlink) is exactly `<data dir>`, and it matches the pid, start time
  and boot id recorded in `identity.json` at start-up. Processes with cwd inside the root are *members*. A process that names
  `-D <data dir>` but does not serve it is `config_only` (ambiguous, possibly foreign); one that serves it but contradicts the recorded
  identity is `postmaster_unverified` (restart / pid reuse). Neither is ever signalled or assumed ours, and either one makes the cleanup
  `FAILED` with the root preserved. A responding port is only an observation, classified `none` / `owned` / `foreign` / `unknown`
  (listener pid, else the server's `data_directory`); it is never grounds to signal anything, and an `unknown` listener blocks a removal;
- stops by SIGINT (fast; escalates to SIGQUIT = immediate and says so) sent to the verified postmaster only. `pg_ctl stop` is not used: it
  resolves the data directory from configuration (and refuses a directory without `PG_VERSION`). The signal is sent by the same privileged
  process that re-classifies the pid at that instant, so a pid that was reused, restarted or is not provably ours is never signalled;
  the check-to-signal window is that process's own few microseconds (no pidfd is available from shell);
- verifies: `pg_ctl status` = 3 (when `PG_VERSION` exists), no `postmaster.pid`, the pid is gone (zombies excluded, 10 s grace), no
  process tied to the root, and the port is not answered by this cluster or by an unidentifiable listener; only then removes the root
  and verifies it is gone; handles a crashed server's stale pid file;
- never treats a missing `PG_VERSION`, `postmaster.pid` or root as proof that a server is gone. Start-up evidence of a running server
  (`identity.json` `RUNNING_VERIFIED`) is closed only by a stop performed by the cleanup (`termination_evidence: stopped_by_cleanup`),
  a stale `postmaster.pid` of a dead pid, or an earlier verified stop of the same run — otherwise `FAILED` and the root is preserved;
- preserves the server log, records other PostgreSQL instances before/after and fails if that set changed;
- writes `postgres/cleanup.json` and exits non-zero on any unexpected failure. Statuses: `STOPPED_VERIFIED[_AFTER_ESCALATION]` (a
  cluster existed and its termination is proven), `NOT_STARTED` (no root, no start-up evidence, no owned process; a foreign listener
  on the port is irrelevant), `REMOVED_UNINITIALISED` (root without `PG_VERSION`/`postmaster.pid`, no start-up evidence, no owned
  process, port not ours), `FAILED`. The record also carries the start-up status, owned processes before/after, port observations
  before/after, ambiguous processes, stop method and `shutdown_proof`. The seal job's `postgres-cleanup` gate (`classify.mjs` `evaluateCleanup`) accepts a
  success status only when the rest of the record agrees with it (e.g. `NOT_STARTED` is rejected when the pre-cleanup port observation
  identifies the cluster as `owned`; a listener called `owned` must be backed by an owned process); a legacy-shaped, ambiguous or
  contradictory record is `FAIL`.

Each native test file runs alone on a freshly recreated `construction_test` (DROP … WITH (FORCE) / CREATE), after re-checking the
cluster identity, with `DATABASE_URL`, `PG*`, `E2E_*`, `POSTGRES_*` and any `*TOKEN*/*SECRET*/*PASSWORD*` variables scrubbed and
only the isolated URLs set. Pure/PGlite checks get no database URL at all.

## 6. Chromium / Playwright

Pinned Playwright from the candidate lockfile (`npx --no-install`), Chromium installed with `--with-deps`, `--retries=0`,
`--trace=retain-on-failure`, screenshots on failure (config), `list` + JSON reporter. The JSON report is the oracle:
`expected == expect_passed`, `unexpected == flaky == 0`, `skipped == 0`, total tests == expected. Viewports are those of the suite
(GPR-1 / R04 W01 at 1440 and 390 px). The real browser suite is unchanged; no mocking is introduced.

## 7. Evidence format and storage specification

Sealed package (`gpr2-acceptance-<stage>-<profile>-<sha12>-run<id>-a<attempt>`):

```
acceptance-result.json   git identity, GitHub run identity, environment, per-check/per-file results, gate, statement
SUMMARY.md               human summary (also written to the run's job summary page)
authorization.json       who dispatched what, decision and refusals
identity-seal.json       third, independent identity verification
manifest.json            every file: path, bytes, sha256 (+ run identity and gate)
SHA256SUMS               sha256sum-compatible list of every file incl. manifest.json
raw/identity-runtime.json, raw/environment.json, raw/runtime-summary.json, raw/npm-ci.log, raw/playwright-install.log
raw/postgres/{identity.json, cleanup.json, server.log, initdb.log, pg_ctl-*.log, *postmasters*.tsv}
raw/checks/<id>/{result.json, logs/*.log, junit/*.xml, evidence/, report.json, playwright.log, test-results/}
```

Environment captured: OS / runner image version, kernel, Node, npm, git, psql client, PostgreSQL server version and identity,
Playwright and Chromium versions and path, candidate `package-lock.json` sha256, provisioning outcomes.

Result vocabulary: `PASS`, `FAIL`, `SKIP`, `NOT RUN`, `ENVIRONMENT BLOCKED` (never merged; a missing test file is `FAIL`).
Gate: `TECHNICAL_GATES_PASSED` · `TECHNICAL_GATES_FAILED` (any mandatory FAIL/SKIP, identity or cleanup refused) ·
`INCONCLUSIVE_ENVIRONMENT_BLOCKED` (a mandatory check BLOCKED / NOT RUN, nothing failed).

**Retention — verified facts (GitHub Docs, read 22.10.2026).** Artifacts and logs default to 90 days; a public repository allows
1–90 days, a private one 1–400; `retention-days` cannot exceed the repository/organisation limit; downloading artifacts needs a
signed-in account with read access. Release assets: up to 1000 per release, each < 2 GiB, no stated expiry.

> **Action needed:** the accepted R04 artifact `gpr2-r04-independent-runtime-evidence` (id 12430542723, run 39788979618, digest
> `sha256:6d2d0cf3ec7bf9810f494681b193f788e3da20d981ba8dffad60c164ffa9acf3`) was uploaded with `retention-days: 14` on 22.10.2026,
> so it expires around **05.11.2026**. Preserve it before then (§7.2).

### 7.1 Tiers

| Tier | Where | Lifetime | Who / permission |
|---|---|---|---|
| 1 | Sealed Actions artifact + run page job summary | 90 days | automatic, `contents: read` |
| 2 | Text evidence index in the repo: `docs/acceptance-evidence/<stage>/<profile>/run-<id>-a<n>/` (`acceptance-result.json`, `SUMMARY.md`, `manifest.json`, `SHA256SUMS`, `ARCHIVE.md`) | permanent, reviewed, in Git history | reviewer/owner via a normal PR |
| 3 | Full sealed zip as an asset of a pre-release tagged `acceptance-evidence/<stage>/<profile>/run-<id>-a<n>` at the workflow SHA | permanent, free | **owner decision** (needs `contents: write`; done from the owner's own `gh`, never by CI) |

`archive-evidence.sh <run_id> [attempt]` downloads the sealed artifact, verifies it with the verifier **and profile as they were
at the run's workflow SHA**, writes the Tier-2 index and prints (never runs) the Tier-3 `gh release create` command.
No external or paid storage is introduced. CI never receives write permission for archival.

### 7.2 Preserving the frozen R04 evidence (owner, before 05.11.2026)

```bash
gh run download 39788979618 -R Shamil9586/construction-core-mvp -n gpr2-r04-independent-runtime-evidence -D r04-evidence
(cd r04-evidence && find . -type f -print0 | sort -z | xargs -0 sha256sum) > r04-evidence.SHA256SUMS
zip -qr gpr2-r04-independent-runtime-evidence-run39788979618.zip r04-evidence r04-evidence.SHA256SUMS
gh release create acceptance-evidence/r04/frozen/run-39788979618-a1 gpr2-r04-independent-runtime-evidence-run39788979618.zip \
  -R Shamil9586/construction-core-mvp --target 8376cd3c299d24545ceafe318366bb7be89d9c6b --prerelease \
  --title 'Accepted R04 runtime evidence (run 39788979618)' --notes 'Frozen R04 acceptance evidence; artifact 12430542723'
```

(`8376cd3` is the workflow commit of that run.) Commit `r04-evidence.SHA256SUMS` plus a short README under
`docs/acceptance-evidence/r04/frozen/run-39788979618-a1/` through a reviewed PR.

### 7.3 Sensitive data

The repository is public, so artifacts are readable by any signed-in GitHub user. Evidence contains only synthetic test data,
disposable `trust`-auth clusters on loopback and the literal placeholder password `x`; no secret is mapped into any job and the
runner scrubs token/secret/password variables from the test environment. Before Tier 3 publication the owner should still skim
`SUMMARY.md` and the logs, as with any public release.

## 8. Security assessment

| Control | Implementation |
|---|---|
| Least privilege | workflow `permissions: {}`; each job only `contents: read`; no `id-token`, `actions`, `packages`, `pull-requests` |
| No secrets / production | no `secrets.*` anywhere; `DATABASE_URL=''`; `AUTH_MODE=mock`; no Render, Bitrix24, LIVE PostgreSQL references; only loopback PostgreSQL |
| No merge / deploy / migration to LIVE | no write token, no deploy step, no `db:migrate`; migrations only run inside tests on the disposable cluster |
| Controlled execution | owner-only manual dispatch on main; registered SHA + tree; explicit confirmation; no `pull_request`, `push` or comment triggers |
| Credentials | `persist-credentials: false` on every checkout; no dependency cache (prevents a candidate from poisoning caches used by main) |
| Untrusted code containment | candidate code runs only in `runtime`; authorisation and sealing run on separate runners where it never executed; seal reads the profile from the workflow commit and re-verifies identity |
| Injection | inputs are passed through `env`, never interpolated into scripts; job outputs are regex-validated; `actionlint` + `shellcheck` clean |
| Separation | test workflow is separate from `claude.yml` and from any deployment path; frozen R04 workflow untouched |

Residual risks (accepted by design, documented for the reviewer):

1. Inside `runtime` the candidate runs with the hosted runner's passwordless `sudo`; it could alter that job's raw evidence
   (including `cleanup.json`). Sealing makes later tampering detectable and binds results to the reviewed candidate, but cannot
   make a malicious *registered* candidate honest — which is why registration requires review. The runner VM is ephemeral and the
   job holds only a read-only token for a public repository.
2. `npm ci` executes the candidate's dependency lifecycle scripts (as the accepted R04 run did).
3. The approver allowlist is duplicated (job `if` + `approvers.txt`) and must be changed in both through a reviewed PR.
4. Recommended owner-side hardening (repository settings, not done here): protect `main` (required review for
   `.github/**`, e.g. CODEOWNERS), and optionally an Environment `gpr2-acceptance` with a required reviewer that the `runtime` job
   would reference.

Observations outside this scope (not modified): `claude.yml` (PR №4 / Claude Automation) triggers on any comment containing
`@claude`, holds `contents/pull-requests/issues: write` and `id-token: write`, and uses tag-pinned actions (`@v6`, `@v1`); its M1-A
security acceptance is still open per `docs/gpr2-independent-acceptance-ci.md` — **INFORMATIONAL**, for that separate review.
The CR01 workflows run on pushes to two named branches with read-only tokens and no secrets — **INFORMATIONAL**.

## 9. Compatibility with the accepted R04 baseline

- The frozen workflow and scripts are byte-identical; run 39788979618 and its evidence remain the authoritative R04 record.
- `r04-cp02` reproduces the same 8 files, 65 tests, the same runner image, Node 22.22.0, PostgreSQL 16, cluster marker and port.
  Deliberate differences, each stricter: harness-owned runner instead of the candidate's script; exact per-file counts instead of
  "exit 0 and `22 passed` in the log"; the PGlite file runs without any database URL (it never used one: it imports
  `helpers/gpr2-isolation` and sets `DB_MODE=pglite`); cleanup is verified and gating; three identity checks; sealed evidence.
- No product behaviour, product test or R04 business logic is touched.

## 10. Operating instructions

1. **Register a new GPR-2 stage.** Copy `profiles/stage-template.json` to `profiles/<id>.json`; set `stage`, `title`, the
   authorised `baseline`, `status: ACTIVE`; keep `candidates: []` until a candidate exists. Validate:
   `node .github/acceptance/lib/profile.mjs validate .github/acceptance/profiles/<id>.json`.
2. **Select its required tests.** List every file with its exact `expect_tests` in the right `class`; keep the previous-stage
   native suites as a mandatory compatibility check; set the exact browser `expect_passed`; keep `typecheck-build`. Never mark a
   check optional without a written owner decision (record it in `notes`).
3. **Approve a candidate.** Add `{sha, tree, lineage, diff_check_from, approval}` (full SHAs from `git rev-parse <sha>`,
   `<sha>^{tree}`, `<sha>^`, …) through a reviewed PR to main. The PR merge **is** the candidate approval. The candidate must be
   fetchable from this repository (pushed to a review branch).
4. **Launch an isolated verification.** Actions → *GPR-2 Acceptance (universal, isolated)* → Run workflow → branch `main`;
   `profile=<id>`, `candidate_sha=<sha>`, `confirmation=APPROVE-TEST-ONLY <id> <sha>`; or
   `gh workflow run gpr2-acceptance.yml -R Shamil9586/construction-core-mvp --ref main -f profile=<id> -f candidate_sha=<sha> -f "confirmation=APPROVE-TEST-ONLY <id> <sha>"`.
5. **Obtain evidence.** Run page → job summary; artifact `gpr2-acceptance-…-run<id>-a<n>`:
   `gh run download <run_id> -R Shamil9586/construction-core-mvp -n <artifact name> -D evidence`.
6. **Perform independent acceptance.** In a checkout at the run's workflow SHA:
   `node .github/acceptance/lib/verify-evidence.mjs evidence --profile .github/acceptance/profiles/<id>.json --expect-candidate <sha> --expect-run <run_id>`,
   then review per `.claude/skills/independent-acceptance` (the technical gate is one input, not the verdict).
7. **Authorise integration.** The owner/coordinator decides; archive the evidence (Tier 2 PR via `archive-evidence.sh`, Tier 3
   release by the owner); then a separate integration PR. Nothing in this workflow merges or deploys.

Harness self-test (local, disposable): `bash .github/acceptance/tests/run-all.sh` (see the file header for prerequisites).

## 11. F-TEST-01 (LOW, nonblocking) — proposal only, not implemented

`tests/gpr-1-browser/r04-early-work.spec.ts:23–27` derives the expected UI label from `GET /works/:id/schedule`
(`schedule.hasBaseline` / `schedule.summary`). If the backend misreported the GPR state, the UI would follow it and the assertion
would still pass: the API is acting as the oracle for the UI of the same system. The fixture state is independently known per test
(test 1: object «Тест после удаления ролей» with an approved GPR, asserted via `/objects/:id/schedule`; test 2: an object created
in the test without a GPR). Proposed change — pass the expected label from the test and keep the API answer as a cross-check:

```diff
-async function assertEarlyWorkW01(page, request, headers, token, object, work, width) {
+async function assertEarlyWorkW01(page, request, headers, token, object, work, width, expected: string) {
     const schedule = await getOk(request, `/works/${work.id}/schedule`, headers);
     expect(schedule.objectWorkId).toBe(work.id);
-    const expected = schedule.hasBaseline ? (schedule.summary === null ? SCHEDULE_LABEL.NOT_SCHEDULED : null) : SCHEDULE_LABEL.NO_BASELINE;
-    expect(expected, '…').not.toBeNull();
+    // cross-check only: the oracle is the fixture state fixed by the test, not the API
+    expect(schedule.hasBaseline).toBe(expected === SCHEDULE_LABEL.NOT_SCHEDULED);
+    if (expected === SCHEDULE_LABEL.NOT_SCHEDULED) expect(schedule.summary).toBeNull();
@@ test 1
-        await assertEarlyWorkW01(page, request, headers, token, object, work, width);
+        await assertEarlyWorkW01(page, request, headers, token, object, work, width, SCHEDULE_LABEL.NOT_SCHEDULED);
@@ test 2
-        await assertEarlyWorkW01(page, request, headers, pm.token, object, work, width);
+        await assertEarlyWorkW01(page, request, headers, pm.token, object, work, width, SCHEDULE_LABEL.NO_BASELINE);
```

This edits an accepted R04 product test (count stays 22) and therefore needs **owner approval and its own PR/candidate**
(`test/gpr2-r04-f-test-01-independent-oracle`, registered as a new candidate in a profile and run through this workflow). It is
deliberately **not** part of the CI Foundation branch.

## 12. Verification performed (local, disposable) and limitations

Local environment: Ubuntu 24.04.5, Node 22.22.0, PostgreSQL 16.15, Chromium 141.0.7390.37 (Playwright 1.56.0), actionlint 1.7.7
(release checksum verified), shellcheck 0.10.0; tests run as an unprivileged user with passwordless sudo (the hosted-runner model).

| Suite | Result |
|---|---|
| actionlint (new + frozen workflow) / shellcheck (all harness shell) | PASS / PASS |
| profile validation (3 profiles) | PASS |
| harness unit tests `tests/harness.test.mjs` | 61 tests: 61 PASS, 0 FAIL, 0 SKIP |
| PostgreSQL lifecycle `tests/pg-cluster.test.sh` (real PG 16 clusters) | 14 PASS, 0 FAIL (incl. F-CI-01 reproduction T3) |
| synthetic end-to-end `tests/e2e-synthetic.sh` (real PG 16 + real Chromium) | 14 PASS, 0 FAIL |
| R04 product suites through the new harness (`r04-cp02`, `r04-main-integration`) | **NOT RUN — ENVIRONMENT BLOCKED**: this session's egress policy refuses `registry.npmjs.org` (proxy `403`), so `npm ci` of the candidate is impossible |
| GitHub-hosted run of `gpr2-acceptance.yml` | **NOT RUN** — not authorised; `workflow_dispatch` also requires the workflow on `main` |

Known limitations: the hosted behaviour of `apt-get install postgresql-16`, `playwright install --with-deps`, artifact upload and
download is inferred from the frozen workflow's successful run, not re-executed; `npm run build` on `9bd68480` has never been run by
this work.
