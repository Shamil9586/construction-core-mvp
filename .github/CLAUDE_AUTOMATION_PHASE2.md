# Claude Automation Phase 2 — M1-A/M1-B Final Narrow Corrective

**Status: CORRECTIVE IMPLEMENTED / NOT INDEPENDENTLY ACCEPTED / NO MERGE.**

Baseline for PR #4: `1ebfc95d720af063105cff83a200e80020d40856`.
Current main (21 October 2026): `92fcf6d047fd22453349260432dbc65590386a17`.
Reviewed prior candidate: `2ef16d39fb9eefa08deb24b2b25925f6a0415dbf`.
No P1-B, product, database, LIVE, secrets or deployment modifications.

## H1 retained — separate privilege domains

`analyze` has only `contents: read` and runs Claude Code Action at its
original pinned SHA `a5a423f75c251dcbff8a74e99f83b2cb03c72bfa`
with explicit job-scoped read-only `github_token`. The Action may write its
read-only token to the checkout's Git origin URL, but this job has no
PR-write token. No GitHub App OIDC flow, `id-token: write` or write
permission for repository contents is granted.

`publish` executes independently, only after successful analysis. It has
`contents: read` and `pull-requests: write` for PR conversation comments.
Claude and untrusted PR code are **never executed in this privileged job**.
The publisher checks the original comment identity and live PR state again
and accepts only a validated bounded JSON report; it sends one POST to
the PR conversation-comment endpoint. This token's GitHub API scope still
exceeds comment-only; the narrow client is the compensating control.

Both jobs checkout trusted `ref: main` without persisted credentials.
Only `issue_comment: created` on open PR conversations is enabled.
Login `Shamil9586`, immutable user ID `329431095` and an `@claude`
mention are required in both job conditions. Ordinary Issues, closed PRs
and nonowner comments skip. Inline `pull_request_review_comment`
remains disabled for untrusted PR-merge-ref security reasons.

## M1-A — zero model tools / direct prompt input

The context-preparation script fetches PR metadata and bounded file
patches using a READ-only token, creates an inert one-line JSON value,
and puts it in `GITHUB_OUTPUT` as `context=...`. The workflow injects
`steps.context.outputs.context` **directly into the Action's prompt**;
Claude is no longer asked to use Read to open a JSON file.

The pinned Action still copies the process environment (including OAuth)
into its SDK options; it is **not** claimed that the OAuth value disappears
from the runner's memory. Instead, the model's operational tool paths are
disabled through these combined settings:

- `--tools "Read"`: SDK/CLI base tool selection, narrowed from the default.
- `--disallowedTools "*"`: wildcard deny removes every tool, including
  Read, Bash, filesystem, write, network and MCP tools.
- No `--allowedTools` is passed. Such a flag grants automatic permission,
  not a hard tool whitelist.
- `--strict-mcp-config` with `--mcp-config '{"mcpServers":{}}'` ignores
  discovered MCP settings and provides no custom server.
- `--setting-sources user` excludes project/local repository settings.
  The hosted runner is ephemeral, though upstream Action user-level setup
  and pinned SDK semantics still require an authorized runtime check.
- Agent mode is forced with an explicit `prompt`; the pinned Action's
  `prepareMcpConfig` does not add GitHub MCP servers when there are no
  `--allowedTools` entries or commit signing option.

`--tools ""` was **not** used: the pinned Action's shell-quote parser
converts empty values to a boolean/null extraArg rather than reliably
passing the requested empty CLI string. The nonempty base set plus
universal deny is reviewable and fail-closed subject to actual runtime
verification. Synthetic checks alone cannot prove the exact live SDK
tool inventory.

## M1-B — inert GitHub-flavored Markdown output

The publisher **does not trust a URL blacklist**. The AI summary and
individual finding texts are each rendered as literal fenced code blocks
under trusted Markdown headings. The opening and closing delimiter is
chosen to be longer than every run of matching fence characters in
that specific untrusted text, so embedded Markdown links, images,
HTML, reference definitions, autolinks, mentions, code fences and
protocol-relative, javascript: or data: URLs cannot escape as Markdown.
The output remains human readable (but rich-text formatting within AI
text is intentionally disabled).

Characters from control, format, surrogate, private-use/unassigned and
Unicode line/paragraph separator categories are rejected, apart from
ordinary newline/tab. Strict report schema, field counts/size limits,
severity allowlist and global comment length guard remain in force.
Malformed input fails before any GitHub API POST. No output is evaluated,
executed, imported as code or fed into a shell.

## Reproducible synthetic checks

Offline `unittest` suite:
`python3 -m unittest discover -s .github/scripts -p 'test_*.py' -v`

It includes owner/PR gates, untrusted context caps, synthetic read-token
step-output passing, Markdown-injection variants, rejection of Unicode
controls, malformed/overlong report rejection and independent publishing
job authorization. The workflow test checks exact permission separation,
complete tool denial, strict empty MCP configuration and action SHA pins.

**This corrective has not undergone GitHub Actions execution with OAuth
credentials, independent H1/M1 security acceptance or final CI gate.**
A separate authorization is needed before runtime testing or merge.

## Main integration compatibility

PR #4 remains on the older `1ebfc95...` ancestry. The newer accepted
P1-B R02/R03 work is on `main` at `92fcf6...`. The branch is not
rebased or merged. A separate integration review must confirm a safe
merge tree and any protection/CI requirements before advancing PR #4.

**STOP: DO NOT MERGE.**
