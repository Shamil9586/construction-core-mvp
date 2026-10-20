---
name: independent-acceptance
description: How an independent reviewer accepts or rejects a Construction Core candidate — resolving exact repository/branch/baseline/candidate/tree identity, bounding review scope, separating independently verified evidence from executor claims, classifying findings BLOCKER/HIGH/MEDIUM/LOW/INFORMATIONAL, narrow corrective re-review, and verdict authority. Use when independently reviewing a candidate, verifying a corrective fix, preparing an acceptance verdict, validating an evidence package, comparing Git candidates or examining release readiness. Not for writing the implementation itself.
---

# Independent acceptance — Construction Core

This skill supports a reviewer who did not write the candidate. Using it does not make the
implementation author an independent reviewer. The final integration decision belongs to the
Construction Core coordinator.

## 1. Candidate identity — resolve before reading anything

Record, with full 40-character SHAs:

- repository and branch (or ref) under review;
- exact baseline SHA the task authorised;
- exact candidate SHA (`git rev-parse <ref>`), and tree SHA (`git rev-parse <sha>^{tree}`)
  when equivalence between candidates matters;
- the diff scope: `git diff --name-status <baseline>..<candidate>` and
  `git diff --check <baseline>..<candidate>`.

Never accept on a short SHA alone: resolve it (`git cat-file -t`, `git rev-parse`) and confirm it
is the commit the assignment names. If the baseline or candidate cannot be resolved, stop with
that as the blocker. Check that the candidate's ancestry starts at the authorised baseline, not
at a newer `main`.

## 2. Review scope

- Follow the assignment. Review changed and newly affected behaviour; do not repeat previously
  accepted stages without a concrete reason (a changed dependency, a regression signal).
- Compare the changed-file list with the authorised scope first; an out-of-scope file is a
  finding in itself.
- For GPR-2 stages, check the D/K/C items the stage claims against the external Technical
  Design and Roadmap (checksum-verified copies) and the protected invariants it must not
  weaken (Roadmap §1, §5).

## 3. Evidence sources — keep them separate

1. **Independently verified** — you ran it or inspected it at the exact candidate SHA.
2. **Executor-provided** — logs, reports, screenshots from the author; useful, not proof.
3. **Unverified assertions** — statements with no reproducible support.
4. **Not obtainable** — evidence that could not be produced (e.g. no native PostgreSQL), with
   the reason.

An implementation report is never independent verification. Use the PASS / FAIL / SKIP /
NOT RUN / BLOCKED vocabulary from `backend-testing` §8 for anything executed.

## 4. Findings

Severity:

```
BLOCKER        acceptance impossible: security/isolation breach, data loss, wrong baseline, scope violation
HIGH           approved behaviour or invariant broken, or required evidence missing
MEDIUM         defect with bounded impact, or a gap that must be fixed before integration
LOW            minor defect or inconsistency that does not change behaviour
INFORMATIONAL  observation, no correction required
```

Each finding records: exact location (`path:line@sha`), expected behaviour with its source
(decision, document section, test), observed behaviour, consequence, proof (command and output,
or quoted code), and the required correction.

- Do not inflate severity, and do not declare a defect without a technically supported reason.
- A disagreement between two approved sources is reported as such, not resolved by the reviewer.
- Do not ask for features or redesigns outside the assignment.

## 5. Corrective re-review

When a candidate was already reviewed and a fix arrives, verify only:

- closure of each named finding, against its original proof;
- the exact corrective diff (`git diff <previous-candidate>..<new-candidate>`);
- absence of regressions directly introduced by that diff (rerun the tests touching it).

Do not rerun a full repository audit for one narrow correction. If the fix changes files
outside the finding's area, review those too and say why.

## 6. Verdict

- Use the verdict vocabulary the specific assignment authorises. For Engineering Setup V1 the
  coordinator-facing verdicts are `ACCEPTED FOR INTEGRATION REVIEW` or `CORRECTIONS REQUIRED`.
- Recommend a verdict only once the required evidence is established; otherwise report what
  is missing.
- A verdict names the exact candidate SHA it applies to; a later commit needs its own review.
- A verdict is a recommendation to the coordinator. It does not authorise push, merge,
  deployment, migration or LIVE access.

## 7. Authority

- The author may report `IMPLEMENTED — PENDING INDEPENDENT REVIEW`; the author never
  self-certifies acceptance.
- The reviewer does not modify the candidate, push to its branch or merge it as part of review.
- The Construction Core coordinator makes the integration decision.
