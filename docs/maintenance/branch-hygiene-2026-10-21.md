# Construction Core — GitHub Branch Hygiene Inventory

**Status: READ-ONLY INVENTORY / DELETE CANDIDATES NOT AUTHORISED BY THIS DOCUMENT.** 21 October 2026.

Repo: `Shamil9586/construction-core-mvp`. Canonical main: `92fcf6d047fd22453349260432dbc65590386a17`. Snapshot: **13 remote branches including main**. GitHub reports `main.protected=false`; `/rulesets` returns an empty array. Branch protection detail API returned permission denied for the connected GitHub App: administration access must be provided separately to configure protections.

GitHub ancestry compare `main...branch`: nine non-main branch HEADs are ancestors of main (ahead 0), and three remain divergent.

| Branch | SHA | Main relationship | Proposed action |
|---|---|---|---|
| `main` | `92fcf6d047fd22453349260432dbc65590386a17` | canonical | **KEEP** |
| `feature/design-f13-1-ui-validation` | `a0b5a159e72e48a4acc4b8e28a9efee13b47350a` | 2 ahead / 90 behind; 12 docs absent | **KEEP** until F13.1 reconciliation accepted |
| `security/claude-readonly-phase2` | `85fd335a08bda56c79d1e6567d53670299f1e03a` | 19 ahead / 11 behind; Draft PR #4 | **KEEP** / active review |
| `verify/p1b-3f047344-20261021` | `05d59ece2054fd10b03e4d2ddc4b6d05a361e49c` | 2 ahead / 4 behind; one-time independent CI workflow | **KEEP** until evidence retention decided; then archive |
| `feature/frontend-visual-baseline-v1` | `2bc89d7c9f0d2febaab55bae08f992ce590ab5b9` | ancestor / 32 behind | **KEEP** — tracked by both Render LIVE services |
| `fix/cr01-startup-contract-and-docs` | `1dc70fc123c6ca756b87f816f0f8290f098b2181` | ancestor / 18 behind | **KEEP** — deployed backend SHA, until release dependency review |
| `archive/pre-b374-publication-2026-10-01` | `14ba13bc11b7e6a82771f4371262db3e7e4534c7` | ancestor / 90 behind | **KEEP** historical checkpoint or replace with reviewed tag |
| `integration/cr01-gpr2-r01` | `678e795f8802a76ac025f28b0d698351af8b7721` | ancestor / 14 behind | ARCHIVE/TAG candidate; not urgent |
| `chore/claude-engineering-setup-v1` | `78573e6d398ef9b6ab0d7d5530af9ef31ca11807` | ancestor / 13 behind | DELETE CANDIDATE after dependency check |
| `chore/claude-github-action-poc` | `ee8b9333d233eb4b32bc02382013d025a10c4d6e` | ancestor / 12 behind | DELETE CANDIDATE after dependency check |
| `claude/compassionate-meitner-jtqval` | `9a40252408936a03e1e29e39671a2b823a1f42cf` | ancestor / 27 behind | DELETE CANDIDATE after dependency check |
| `claude/gifted-albattani-p1uav9` | `3f0473447d8d1534bb99a54b406a9e879c0ebaf5` | ancestor / 4 behind; PR #5 merged | DELETE CANDIDATE after evidence/reference check |
| `fix/cr01-api-startup-no-auto-migrations` | `544ca38a120007849c74bbe34f0376278b670e60` | ancestor / 24 behind | DELETE CANDIDATE after dependency check |

### LIVE guard

Previous read-only Render service inspection established both services follow `feature/frontend-visual-baseline-v1`, not `main`; frontend auto-deploy On Commit, backend auto-deploy Off. Currently deployed backend SHA is `1dc70fc...` (also preserved by its source branch). **Do not delete/rename either dependency branch without separate Render release planning.**

### Safeguarded cleanup procedure — NOT executed

1. Refresh all remote HEAD SHAs; if any moved, stop for that branch.
2. Review open PRs (PR #4 must be retained) and external dependencies (Render, evidence runners, active Claude sessions).
3. Preserve immutable refs/tags for any branch whose unique reference is still needed, especially independent CI provenance and historical architecture checkpoints.
4. Delete only specifically authorised, verified *fully integrated* branches. Do not use force pushes; record each deleted exact SHA.
5. Keep `main`, the old design branch, security PR #4 branch and deploy-tracked branches intact.
6. Configure main ruleset/branch protection **separately using repo administration**: mandatory PR review, required checks once real CI exists, block force-push/deletion; account for GitHub automation permissions. Current app cannot inspect/set branch protection due to missing admin rights.

No Git refs have been deleted by this inventory. This document authorises no deployments, migrations, secrets operations, or product changes.
