# CR01 PostgreSQL 18 restore preflight — REVIEW ONLY

**Project:** Construction Core / ООО СЗ «Гор-Строй»

**Decision:** On 2026-11-06 owner authorized preparing the candidate and then explicitly authorized publishing a **CI-only Draft PR**. This does **not** authorize merge, Actions dispatch, changing any secret, production PostgreSQL, Render, or deployment.

## Purpose

Verify a PostgreSQL 18 directory-format logical export can be restored in a new disposable PostgreSQL 18 instance. The first stage proves **only the synthetic fixture**, not the owner's real backup. The Render CR01 recovery-test database (#4) must **not** be deleted on the basis of this PR or a synthetic PASS.

## Provenance and status

- Base product `main` commit: `516935803f2c211a660df33cae4a48b706ef77a1`.
- Original backup stored on the owner's Windows computer; not uploaded to GitHub or ChatGPT.
- Owner has manually checked that the `.dir.tar.gz` can be listed with `tar -tzf` and computed SHA-256. This is **not** a verified PostgreSQL restore.
- Existing workflow sources examined: `cr01-full-regression-postgres.yml` (PostgreSQL 17), `fin-sdo-1-integrated-native.yml` (PostgreSQL 16), and isolated GPR PostgreSQL 16 infrastructure.
- Main repo visibility: public. Never upload raw database exports, restored tables, credentials or signed storage URLs to the repo, PR, issues, workflow input, logs or artifacts.
- Render web resource auto-deploys from product `main`. Do **not merge** this Draft PR until a separate release/infrastructure decision is made.

## Files and safety constraints

1. `.github/workflows/cr01-pg18-restore-preflight.yml` is `workflow_dispatch` **only**, guarded by GitHub owner actor, exact reviewed main SHA, confirmation text and attempt 1. There are no push or PR triggers.
2. `.github/acceptance/cr01-pg18-restore/restore_check.py` checks local SHA, tar member types, paths, archive format, fixed runner-loopback-only PostgreSQL 18 identity, empty target and a restricted DB owner before using `pg_restore --single-transaction --exit-on-error --no-owner --no-acl`.
3. `.github/acceptance/cr01-pg18-restore/test_archive_safety.py` tests valid synthetic archive, traversal rejection, symlink rejection, missing and duplicate catalogs.
4. Real archive ingestion is deliberately **not implemented** in the workflow. No new credentials, secrets, deployment or external API calls are needed for this synthetic preflight.

## Independent review gates before any dispatch

- Review exact commit SHA and tree of this Draft PR. Compare workflow/restore script to baseline, trace permissions, Docker image, non-superuser and loopback assumptions, check no archive upload path and no automatic triggers.
- Re-run source-level negative tests independently. Verify no secret reads, artifact uploads, network egress to Render, or changes to production.
- Review archive parser resource limits, error logging, executable boundaries and sanitization; publish reviewer findings against exact SHA and GitHub path.
- If accepted, request **separate** authorization to integrate/dispatch this synthetic CI. The PR's existence is not authorization to run it.
- The synthetic CI does not prove the actual exported backup is restorable.

## Real export remains a separate task

A secure transfer mechanism for the actual backup from the owner's computer into an isolated test runner is **not yet implemented, reviewed or authorized**. Requirements: never place bytes, credentials or private signed URLs into any publicly accessible repository, GitHub input or logs; protect storage and data access, use short-lived identity, check original SHA inside the runner, restrict retention and egress, destroy the data after verification. A separate explicit owner decision and independent security review must precede any real-data run.

Even after a real PG18 restoration PASS, verify other external consumers of Render DB #4 and preserve a second offline copy before proposing database deletion.

## Status

| Gate | Status |
|---|---|
| Local synthetic archive safety unit tests | PASS (author/local; 5 tests) |
| Source files read back from GitHub | PASS (publication readback) |
| Independent reviewer | PENDING |
| Hosted PG18 synthetic runtime | NOT VERIFIED; not dispatched |
| Secure real backup transfer | BLOCKED / not approved |
| Real backup restored | NOT VERIFIED |
| Render database #4 deletion | NOT AUTHORIZED |

**Approval boundary:** EXECUTOR → GITHUB → INDEPENDENT REVIEWER → COORDINATOR. Do not merge or deploy without a separate owner decision.
