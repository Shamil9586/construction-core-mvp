# Independent acceptance assignment — GPR-2 CI Foundation

You are an independent reviewer. You did not write this candidate. The implementation report
(`docs/gpr2-ci-foundation.md` §12, the PR description) is **executor-provided evidence**, not proof. Follow
`.claude/skills/independent-acceptance/SKILL.md` and `.claude/skills/backend-testing/SKILL.md` §8.

## 1. Identity (resolve before reading anything)

| Item | Value |
|---|---|
| Repository | `Shamil9586/construction-core-mvp` |
| Authorised baseline | `main` `9bd684806f0d87d802387abb141d9a88d950ceba`, tree `fb4d5724a5af1164d6dc46bfddc0be49776453f7` |
| Candidate branch | `feature/gpr2-ci-foundation` |
| Candidate SHA / tree | as stated in the PR (resolve with `git rev-parse` / `<sha>^{tree}`; never accept a short SHA) |

Required: `git merge-base --is-ancestor 9bd68480… <candidate>`; `git diff --name-status 9bd68480..<candidate>` and
`git diff --check 9bd68480..<candidate>`.

## 2. Scope

**In scope:** `.github/workflows/gpr2-acceptance.yml`, `.github/acceptance/{lib,profiles,tests}/**`,
`.github/acceptance/{approvers.txt,archive-evidence.sh}`, `docs/gpr2-ci-foundation*.md`, one line in
`docs/gpr2-independent-acceptance-ci.md`.
**Scope violations (each a BLOCKER):** any change to `apps/`, `packages/`, `infra/`, `scripts/`, `tests/` (product tests),
`package*.json`, `.github/workflows/claude.yml`, `.github/workflows/gpr2-independent-acceptance.yml`, the four frozen
`.github/acceptance/*.sh` scripts, the CR01 workflows; any deployment, secret, or write permission.
Do not re-review R04 product behaviour; it is accepted.

## 3. What to verify independently

### A. Security (highest priority)
1. Every job's `permissions` (expect workflow `{}`, jobs `contents: read` only); no `secrets.*`; no trigger other than
   `workflow_dispatch`; job `if` restricts repository, ref, `actor` and `triggering_actor`.
2. No input or job output reaches a `run:` script by `${{ }}` interpolation except regex-validated outputs (check `authorize.mjs`
   and `profile.mjs` regexes). Try to construct an input that escapes (`profile` with `/`, `..`, quotes, newlines).
3. Candidate code can execute only in `runtime`; `authorize` and `seal` never run `npm`, `npx`, or candidate files. Confirm the
   harness checkout uses `github.sha` and the candidate checkout a full SHA, both with `persist-credentials: false`; confirm no cache.
4. Action pins: resolve each SHA against its tag (`git ls-remote --tags https://github.com/actions/<name>`).
5. Assess the residual risks listed in `docs/gpr2-ci-foundation.md` §8; agree or raise findings.

### B. Authorisation and identity
Run `node --test .github/acceptance/tests/harness.test.mjs` in a full-history clone (expect 61 PASS). Then add **your own**
negative cases (do not rely on the author's list), e.g. a SHA registered in a RETIRED profile, a profile file whose name differs
from `profile_id`, a lineage entry that is correct for SHA but wrong for tree, an approvers.txt entry with trailing spaces.

### C. PostgreSQL lifecycle (F-CI-01)
As an unprivileged user with passwordless sudo and PostgreSQL 16: `bash .github/acceptance/tests/pg-cluster.test.sh`.
Independently confirm T3 (the frozen stop script really leaves the server running) and that `pg-cluster.sh stop` never signals a
cluster it cannot prove is its own. Read `cleanup.json` outputs yourself.

### D. Classification and evidence
1. Review `lib/classify.mjs` against the vocabulary: SKIP ≠ NOT RUN, missing file = FAIL, partial skip = FAIL, exact counts.
2. `bash .github/acceptance/tests/e2e-synthetic.sh` (needs a node_modules with `tsx` + `playwright` and a Chromium; set
   `GPR2_SYNTH_NODE_MODULES`). Open a sealed package and run `verify-evidence.mjs` on it; tamper with one byte and re-run.
3. Confirm `r04-cp02.json` encodes exactly the accepted gates (27 / 16 / 22, same files as the frozen workflow) and that the
   frozen workflow is byte-identical to the baseline (`git diff 9bd68480..<candidate> -- .github/workflows/gpr2-independent-acceptance.yml .github/acceptance/*.sh` is empty).

### E. Hosted runtime (only with separate owner authorisation)
Not authorised by this assignment. If the owner authorises it after the CI-only files are on `main`:

| Run | Inputs | Expected |
|---|---|---|
| 1 | `profile=r04-cp02`, `candidate_sha=b882fd0a35fe93d5f85d6be1ccd7dfdc6982f67d`, `confirmation=APPROVE-TEST-ONLY r04-cp02 b882fd0a35fe93d5f85d6be1ccd7dfdc6982f67d` | `TECHNICAL_GATES_PASSED`; native 27/0/0, PGlite 16/0/0, Chromium 22/0/0; `postgres-cleanup` PASS (`STOPPED_VERIFIED`) — equal to run 39788979618 |
| 2 (optional) | `profile=r04-main-integration`, `candidate_sha=9bd684806f0d87d802387abb141d9a88d950ceba` | same + `typecheck-build`; a build failure is a real finding about main, not about the harness |
| 3 (negative) | `profile=r04-cp02`, `candidate_sha=9bd684806f0d87d802387abb141d9a88d950ceba` with matching confirmation | `authorize` refuses (not registered); `runtime` and `seal` skipped |

Permissions expected on every job: `contents: read`; no secrets. Verify each artifact with `verify-evidence.mjs` at the workflow SHA.

## 4. Evidence classes to keep separate
Independently verified (you ran/inspected it) · executor-provided (author's logs and §12 table) · unverified assertions ·
not obtainable (with reason). The author could not run the R04 product suites through the new harness (npm registry blocked in
the author's environment) — treat any claim about them as unverified until a hosted run exists.

## 5. Findings and verdict
Findings: BLOCKER / HIGH / MEDIUM / LOW / INFORMATIONAL with `path:line@sha`, expected (source), observed, consequence, proof,
correction. Verdict for the coordinator, naming the exact candidate SHA:
`ACCEPTED FOR INTEGRATION REVIEW` or `CORRECTIONS REQUIRED` (or `INCONCLUSIVE — ENVIRONMENT BLOCKED` with the exact blocker).
A verdict authorises no merge, run, deployment or LIVE access.
