# Claude Code GitHub automation — Phase 2 hardening

Status: **PROPOSED / pending independent review and owner acceptance**.
Baseline: `main` at `1ebfc95d720af063105cff83a200e80020d40856` (PR #3).
Scope: GitHub Actions configuration only; no production, database, Bitrix24
or Render changes.

## Read-only review workflow

- Trigger: a comment containing `@claude` on an **open pull request**,
  either in the conversation or inline review; ordinary issues and closed
  pull requests are intentionally excluded.
- Authorisation: only GitHub account `Shamil9586`, user ID `329431095`.
- `GITHUB_TOKEN`: `contents: read` and `pull-requests: write` only.
  PR-write covers both conversation comments (GitHub Issues comment API)
  and inline PR review comments. No `issues: write`, `actions: read`
  or `id-token: write` is granted.
- The Action receives the job-scoped `${{ github.token }}` explicitly
  via `github_token`. Without this override, Action v1 obtains a
  separate installed GitHub App token using GitHub OIDC, requiring
  `id-token: write` and potentially retaining `contents: write`
  independently of the job's declared permissions.
- The Claude OAuth secret remains a GitHub Secrets expression only.
- Editing tools and Bash are disallowed; an instruction further forbids
  file changes, commits, branches, pushes, PR creation, merge, deployment,
  migrations and credential access.
- Checkout does not persist credentials. A timeout and turn cap apply.

Read-only here means **repository contents cannot be modified**; writing
the reply comment remains intentionally possible. Tool filtering is defence
in depth, not the primary permission boundary. PR content can still contain
malicious instructions; never expose production credentials to this job.

## Engineering mode — NOT ENABLED

Issue → implementation → Pull Request requires a different, explicitly
authorised workflow with its own narrow permissions, branch/path policy
and independent security review. No direct main updates, auto-merge,
production deploys, migrations or credentials. The first engineering
test must be a harmless documentation-only task with CI and independent
acceptance. Do not promote this read-only workflow into a write workflow
by merely increasing its token permissions.

## Acceptance gates

1. Static YAML/security review and exact SHA + changed-file verification.
2. After a separate owner-authorised merge, post a read-only `@claude`
   question on a disposable open PR and verify it responds without modifying
   files, creating commits, pushing or creating branches.
3. Verify non-owner PR comments, owner comments on ordinary issues and
   comments on closed PRs all skip execution.
4. Verify logs show the explicit job token and **no GitHub App OIDC exchange**.
5. Check repo branch protection and required CI checks in GitHub Settings.
6. Do not claim runtime acceptance or end-to-end Issue → implementation
   automation based on this PR or the previous PoC run.

The successful run `39556662232` applies to the old workflow only.
For `issue_comment`, GitHub loads the workflow from the default branch;
a draft PR containing workflow changes cannot prove new runtime behaviour.
