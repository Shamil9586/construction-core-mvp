---
name: frontend-testing
description: Testing rules for the Construction Core frontend — which gates exist, what the current Playwright suite pins, how to change UI without breaking it, and how to add coverage for new design-system components and screens. Use before editing any file under apps/frontend, before renaming a CSS class or a visible Russian string, when a Playwright spec fails, when adding tests, and before reporting that a change passes.
---

# Frontend testing — Construction Core

## The gates

Commands below are the scripts defined in the root `package.json` at the baseline.
This file documents what exists; it does not record that any of them passed.

| Gate | Command | Scope |
|---|---|---|
| Type + build | `npm run build` | `tsc --noEmit` (root `tsconfig.json`, `"strict": false`, over `apps`, `packages`, `scripts`, `tests`), then the Vite build. Run it constantly. |
| Strict type check | `npm run typecheck:strict` | `tsc --noEmit -p apps/frontend/tsconfig.strict.json` — `strict: true` over the new frontend layers (`design-system`, `formatters`, `types`, `view-models`, `screens`, `preview`, `app`, `data`, `auth`). A separate gate: it is not part of `npm run build`. |
| Node tests | `npm test` | `node --import tsx --test tests/*.test.ts` — backend, domain, HTTP errors, and also frontend view-model and data-boundary unit tests (for example `app-data-boundary`, `f8.1-w01-viewmodel`, `gpr-1-viewmodel`). No browser. Some files need Postgres (PGlite or embedded). |
| Product browser suite | `npm run test:browser` | Playwright, `playwright.config.ts`, `tests/browser/` (`contractors`, `director`, `workflow` specs), one worker, 1440×1000, `ru-RU`. Starts its own API and Vite server. |
| Design-system browser suite | `npm run test:ds` | Playwright, `playwright.ds.config.ts`, `tests/design-system/` (`components`, `table`, `shell`, `screens`, `app`, `f7-runtime-mode` specs). Starts only the Vite dev server — no API, no database. It is a Playwright browser suite, not Jest or Vitest, and it renders the preview page and the app, which under the Vite dev server default to the mock data provider unless `VITE_DATA_PROVIDER` is set. |
| Feature browser suites | `npm run test:f6-browser`, `test:f7-browser`, `test:f8.1-browser`, `test:f8.2-browser`, `test:pbx2-browser`, `test:pbx3a-browser`, `test:obj1-browser`, `test:org1-browser`, `test:id-auto-1-browser`, `test:gpr-1-browser`, `test:id-auto-2-browser`, `test:f7-prod` | One `playwright.<name>.config.ts` and one `tests/<name>-browser/` directory each. Several start a dedicated test backend (`tests/<name>-browser/server.ts`) plus Vite. Run the suite that matches the area you changed. |

Further configs exist without an npm script (`playwright.f8.2.1`, `f8.3`, `f11.2`–`f11.5`,
`bitrix-disk-1`); run them with `npx playwright test --config <file>`. `build:core`
(`--mode core`) builds the Core entry and needs an explicit `VITE_DATA_PROVIDER`.

Run `npm run build` before every commit. For code under `apps/frontend/src/` that the
strict config covers, also run `npm run typecheck:strict`; it is the gate that catches
strict-mode mistakes the root build does not report.

## What the product browser suite pins

`tests/browser/` holds `contractors.spec.ts`, `director.spec.ts` and `workflow.spec.ts`,
and they are coupled to the *legacy* markup (`main.tsx`), not to behaviour. They assert on
CSS classes — `.portfolio-object`, `.objects-grid .object-card h2`, `.kpi-number`,
`.chain-work.RED`, `details.RED`, `.page-heading`, `.kpi-grid .ant-card` — on antd
internals such as `.ant-tabs-tabpane-active`, `.ant-descriptions-item-label`,
`.ant-modal-close`, and on exact Russian strings including «Куда смотреть сегодня»,
«Панель», «Объекты», «Субподрядчики», «Начать работу».

So: renaming a class, replacing an antd component, or rewording a heading in the legacy
screens breaks that suite even when the application is correct. Check the specs before
such a rename, and treat updating them as part of the same change rather than a follow-up.

New design-system and `app/`/`screens/` work is covered by the separate `tests/design-system/`
and feature suites above. Re-check which spec asserts on the markup or string you are
about to change before editing it; the specs, not this file, are the source of truth.

## Historical evidence: the Core 2.1 Playwright failure

This section is historical evidence, not a current result. `docs/status.md` (last
updated 19.09.2026, covering Core 2.1) recorded the full product Playwright suite
(`contractors` + `director` + `workflow` specs) as **FAIL** with more than one failure
signature — a tab-click timeout at `workflow.spec.ts:6` and a separate login-heading
timeout in the second `workflow.spec.ts` test — while the two targeted Core 2.1 specs
passed. That document did not attribute the failures to a single cause or declare them
baseline-equivalent. Nothing in this file
re-ran the suite or shows it as currently failing or currently passing.

How to use it: a red product suite is not by itself evidence that a frontend change broke
something. Reproduce the failure on the base commit before attributing it to new work, and
say plainly which signature is old and which is new. Never report the suite as passing
because the relevant spec passed in isolation; state exactly what was run. The comment
in `playwright.ds.config.ts` explains that the design-system suite is kept in its own
config so a component result is never confused with a product-suite result.

## Adding coverage

- Pure logic (view-models, formatters, data-boundary helpers): add a `tests/*.test.ts`
  file; it runs under `npm test` with `node:test` and needs no browser.
- Design-system components and screens: add or extend a spec under `tests/design-system/`
  (`npm run test:ds`). There is no Jest or Vitest component runner in the project; do not
  introduce one as a side effect of adding coverage. A new test runner would be an
  additive dev dependency and script that needs its own approval, and it must not change
  the gates above.
- A feature with its own backend fixtures follows the existing `tests/<name>-browser/`
  plus `playwright.<name>.config.ts` pattern.

For screens, prefer role- and text-based Playwright selectors over CSS classes, so new
specs do not repeat the coupling that makes the legacy ones fragile.

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
