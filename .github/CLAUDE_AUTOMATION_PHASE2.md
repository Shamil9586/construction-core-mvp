# Claude Automation Phase 2 — H1/M1 corrective

Status: **CORRECTIVE CANDIDATE, NOT INDEPENDENTLY ACCEPTED**.
Baseline main: 1ebfc95d720af063105cff83a200e80020d40856.
Scope: only .github/; no product, secrets, database or LIVE changes.

## H1: Split the trust boundary into two jobs

**analyze** has only contents: read. It fetches bounded, inert PR metadata
and file patches through the GitHub REST API, checks out the trusted
main branch, and runs pinned Claude Code Action in agent mode with an
explicit prompt and the job's read-only token. It cannot obtain a
PR-write token: none is provisioned in this job. The pinned Action can
still put its READ-only token into the remote Git URL, but no token
capable of modifying PRs is placed in Claude-accessible files or env.
No GitHub App OIDC token exchange is used. The action is configured with
Read, Glob and Grep, forbidding Bash, Edit, Write, network and agent tools.
These restrictions are defense in depth; the token privilege boundary
is the primary control.

**publish** starts only after successful analysis. Its job receives
contents: read (for checkout of main) and pull-requests: write. There is
no Claude process and no external code from the PR in this job. A
trusted Python publisher validates the structured report (JSON keys,
sizes, severities, control characters, URLs, mentions and obvious
token-shaped strings), checks owner identity and LIVE PR open state
again, then creates one PR conversation comment. Validation failures
stop publication. No report text is executed as a command or code.
The job token can in principle update PR metadata via the GitHub API,
but the publisher uses only a single static comment endpoint; this
residual API scope must be considered by the independent reviewer.

Both jobs explicitly checkout ref: main, without persisted checkout
credentials. PR head or PR merge branch code is never checked out
or executed. There is no auto-merge or deployment step.

## Trigger: conversation comments only

Only issue_comment: created is enabled, with the same owner login
Shamil9586, immutable GitHub user ID 329431095, @claude mention and
open-Pull-Request guard in both jobs. Regular Issues, closed PRs and
non-owner comments are excluded.

IMPORTANT COMPATIBILITY LIMITATION: pull_request_review_comment
(inline diff comments) is intentionally DISABLED. GitHub documents
that this event uses a PR merge ref, where the workflow itself may
come from a contributor-controlled PR. Enabling it with OAuth secret
or write permissions undermines trusted-workflow isolation. The owner
may trigger review using an ordinary conversation comment instead.
Restoring inline support needs a separate safe design and owner approval.

## M1: Untrusted PR data

An owner request, PR title/body and changed-file patches are captured
as data only. Only the triggering owner's comment is forwarded; other
comments are excluded. Inputs are bounded to 60 changed files, 3500
characters of each patch, 8000 characters of PR body, 2000 characters
of owner request and 65536 bytes of total JSON context. Excess input
fails closed. PR source is never executed. Claude is explicitly told
that all PR-provided content is untrusted and must not issue commands.
Its output is subject to JSON schema and an independent publisher
validator with strict report sizes. Semantic prompt injection risk is
reduced, not mathematically eliminated.

## Dependencies

Checkout pinned at d23441a48e516b6c34aea4fa41551a30e30af803 (v6).
Claude Code Action pinned at a5a423f75c251dcbff8a74e99f83b2cb03c72bfa
(target commit of annotated v1).
No new external Actions or AI frameworks.

## Gate checklist

1. Exact diff restricted to .github/ scripts, docs and workflow.
2. Offline synthetic tests are defined in
   .github/scripts/test_claude_phase2_security.py; run them with
   python3 -m unittest discover -s .github/scripts -p 'test_*.py' -v.
3. Independent re-review must verify H1, M1, token separation,
   default-branch checkout, identity guards and output validation.
4. NO Actions runtime was performed. A separate owner authorization
   is required for use of repo secrets, runtime test and eventual merge.
5. After separately authorized merge: disposable PR verifies response
   and rejection scenarios, no source writes, no deployment.
6. Issue-to-implementation engineering automation remains OUT OF SCOPE.

Status: CORRECTIVE IMPLEMENTED, PENDING INDEPENDENT REVIEW, NO MERGE.
