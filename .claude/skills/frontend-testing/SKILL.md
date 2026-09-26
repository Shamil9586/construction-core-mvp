---
name: frontend-testing
description: Testing rules for the Construction Core frontend — which gates exist, what the current Playwright suite pins, how to change UI without breaking it, and how to add coverage for new design-system components and screens. Use before editing any file under apps/frontend, before renaming a CSS class or a visible Russian string, when a Playwright spec fails, when adding tests, and before reporting that a change passes.
---

# Frontend testing — Construction Core

## The gates

| Gate | Command | Scope |
|---|---|---|
| Type + build | `npm run build` | `tsc --noEmit` over apps/packages/scripts/tests, then Vite build. Fast, run it constantly. |
| Node tests | `npm test` | `tests/*.test.ts` — backend, domain, HTTP errors, rate limit, startup contract. Frontend work must keep these green but rarely touches them. |
| Browser | `npm run test:browser` | Playwright, `tests/browser/`, one worker, 1440×1000, `ru-RU`. Starts its own API and Vite. |

Run `npm run build` before every commit. It is the gate that catches type regressions in
seconds, and it is the one that a strict-mode mistake would break first.

## What the browser suite currently pins

`tests/browser/` holds `contractors.spec.ts`, `director.spec.ts`, `workflow.spec.ts`, and
they are coupled to the *current* markup, not to behaviour. They assert on CSS classes —
`.portfolio-object`, `.objects-grid .object-card h2`, `.kpi-number`, `.chain-work.RED`,
`details.RED`, `.page-heading`, `.kpi-grid .ant-card` — on antd internals such as
`.ant-tabs-tabpane-active`, `.ant-descriptions-item-label`, `.ant-modal-close`, and on
exact Russian strings including «Куда смотреть сегодня», «Панель», «Объекты»,
«Субподрядчики», «Начать работу».

So: renaming a class, replacing an antd component, or rewording a heading in the existing
screens breaks the suite even when the application is correct. Check the specs before
such a rename, and treat updating them as part of the same change rather than a follow-up.

New design-system work is additive and should not disturb any of this. If it does, that
is information — something was edited that the plan said to leave alone.

## The pre-existing failure

`docs/status.md` records the full Playwright suite as **FAIL** with more than one failure
signature (a tab-click timeout in `workflow.spec.ts:6`, and a separate login-heading
timeout), while the targeted Core 2.1 specs pass. This is an open, unresolved
test-stability gate that predates the frontend workstream.

Because of that, a red suite is not by itself evidence that a frontend change broke
something. Compare against the base — the tag `frontend-v1-before-implementation` points
at the branch point. Reproduce the failure there before attributing it to new work, and
say plainly which signature is old and which is new. Never report the suite as passing
because the relevant spec passed in isolation; state exactly what was run.

## Adding coverage

Design-system components are pure and deterministic, so they are cheap to test directly —
variants, states, the `NoData` path, and the keyboard contract. There is no component test
runner wired up yet; if one is introduced, it is an additive dev dependency and a new
script, and it must not change the three gates above.

For screens, prefer role- and text-based Playwright selectors over CSS classes, so new
specs do not repeat the coupling that makes the existing ones fragile.

## Reporting results

Report what actually ran and what it actually said. If a gate was skipped, say it was
skipped. If a test fails, quote the output. "Build and tests pass" is only true when both
were executed in this session.

## Recording a stage result

Each stage records its own gate results and does not inherit or absorb anyone
else's. Three rules keep the record readable:

- **"NOT RUN" is a result.** When a gate was not executed, write NOT RUN and the
  reason. Do not omit the row, and do not substitute a related gate that did run.
- **Baseline failures stay separate.** The pre-existing Playwright failures belong
  to the baseline, not to the stage being reported. They are listed under their
  own heading, neither re-tested nor cleared by a stage that did not run them.
- **Claim only what was measured.** "The design system is not imported by the
  application, verified by the absence of these markers in the build output" is a
  measurement. "The legacy interface is pixel-for-pixel unchanged" is not — no
  visual comparison was made. Say the first, never the second.
