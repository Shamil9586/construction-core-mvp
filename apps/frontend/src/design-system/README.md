# Construction Core — Design System

Implements Visual Design System v1 over the approved product architecture. The
screens it serves are fixed: **C01** Company Control Center, **O01** Object
Overview, **W01** Work Card.

Sources of truth, in order of precedence:

1. `Construction_Core_Design_Rules_v1.md`
2. `01_Visual_Design_System_v1.md`
3. `02_Component_Library_Specification.md`
4. `05_Design_Decisions.md`

Where the code and the specification disagree, the specification wins and the
divergence is recorded — it is not quietly improved.

## Layers

```
   Data                                Presentation

   screens/                            screens/
     ↓                                   ↓
   view-models/                        design-system/
     ↓                                   ↓
   services/                           tokens/
     ↓
   types/ + API

   formatters/  — used by view-models and screens, never by components
```

The design system depends on **tokens and nothing else**. No imports from
`services/`, `types/`, `view-models/`, `screens/`, `formatters/`, domain models or
business rules. A component that reaches for any of those has stopped being
reusable and has made the Figma mapping untrue.

## Tokens

Values live in `tokens/tokens.css` as three cascading layers:

| Layer | Prefix | Used by a component? |
|---|---|---|
| primitive | `--cc-p-*` | **No** — review failure |
| semantic | `--cc-background-*`, `--cc-text-*`, `--cc-status-*`, … | Yes |
| component | `--cc-card-*`, `--cc-table-*`, `--cc-badge-*`, … | Yes |

`tokens/tokens.ts` holds typed *references* to those variables plus the few
measurements logic needs as numbers. Values are never duplicated into TypeScript:
two copies of `#245B85` drift apart, and the drift stays invisible until two
shades of one blue appear on the same screen.

## Type scale

Sixteen global classes in `tokens/typography.css`, named after the tokens:
`cc-type-display`, `cc-type-metric-xl`, … `cc-type-eyebrow`.

Each declares font-family, font-size, line-height, font-weight, letter-spacing and
margin — all six. The legacy global stylesheet styles bare `h1`, `h2`, `p`,
`small` and `strong`, and any property left undeclared is inherited from it.

Apply `ccScope` (`SCOPE_CLASS`) to a design-system subtree to re-establish the
baseline and enable tabular figures.

### Known residual leak

One legacy rule still reaches through: `small { display: block }`. It sets a
property the meta style does not declare, and declaring `display` on a text style
would break every block use of it, so it is left alone.

The mitigation is to not use the element: meta text is a `<span>` with
`cc-type-meta`, never a bare `<small>`. A browser test asserts that no component
renders one. Size, leading, weight, tracking and margin are all held correctly —
verified in the browser against `h1`, `h2`, `p`, `small` and `strong` with the
legacy sheet loaded *after* the design system, which is the harder ordering.

## Invariants

- Percentages only as `%`. No п.п., no relative deviation, no renamed difference
  of two percentages.
- Fact of performance and СК confirmation are two separate figures, side by side,
  never merged, never auto-corrected.
- Colour accompanies a status, never replaces it. Every semantic fill carries a
  text label.
- `Delayed` and `Attention` share one amber. A second step would invent a risk
  scale the product does not have.
- The progress bar is never coloured by status.
- `background.selected` marks a selection, not a state.
- Shadow belongs to the overlay alone.
- Contours stay separate: physical readiness, СК, ИД and СДО each have their own
  block. There is no combined "Готово" anywhere.
- Empty is not zero. `0` appears only where zero was measured.
- A status is never derived from a colour. `StatusVariant` is a visual vocabulary;
  which one a record deserves is decided in a view-model from confirmed data and
  existing domain rules.

## Status semantics

Three separate signals arrive from the backend. They answer different questions
and none of them is converted into another.

| Signal | What it is | What it is not |
|---|---|---|
| `scheduleStatus` | Schedule state under the existing schedule contract — `ScheduleStatusService` compares actual against planned progress using the configured variance thresholds | Not a statement about blocking, acceptance, ИД, СДО or quality |
| `healthStatus` | An aggregated attention state for an object. `ObjectHealthService` folds in schedule, critical and overdue issues, staleness, and late ИД (`ptoLate`) and СДО (`sdoLate`) | Not a schedule state, and never mapped automatically to a delay — it mixes contours by design |
| `blockers` | A separate confirmed source: named reasons a work cannot proceed — unfinished predecessor, no СК clearance, critical issue, missing required document | Not derived from any colour or severity code |

No colour is ever converted into a business rule. `StatusVariant` in the design
system is a visual vocabulary of five appearances; which one a record deserves is
decided in a view-model from these signals, never from a colour code.

**`Blocked` in particular is a visual variant only.** It must not be derived from
a colour — not from `scheduleStatus === 'RED'`, not from a `RED` severity, not
from a red anything. A blocking state is a claim about the work and requires
explicit business data to support it: `blockers`, which carries the named reason.
Red means large schedule variance; blocked means something stands in the way.

## Stage record

**F0 — tokens, type scale, Inter, tabular figures.**

What F0 did *not* do: connect the design system to product screens. No module here
is imported by the application, verified by the absence of `cc-p-navy-900`,
`ccScope`, `cc-type-metric` and `Inter Variable` from `dist/frontend/assets`.

Playwright on F0: **NOT RUN.** The baseline failures recorded in `docs/status.md`
are a separate, pre-existing gate and are neither re-tested nor cleared here.

**F1 — first components:** `StatusBadge`, `ProgressBar`, `Button`, `PlanFact`,
`LinkedStage`.

Still to come, and blocked on the domain model rather than on design:
`ConfirmedVolume`, `ZoneRow`, `Sequence`, and the identity slots of
`WorkIdentityCard`. They will not be filled with placeholder text — a block whose
data cannot exist is not rendered at all.

**F2 — table layer:** `DataTable`, `ObjectRow`, `WorkSummaryRow` (see the commit for
the full record; not duplicated here).

**F3 — Application Shell:** `AppShell`, `Sidebar`, `Breadcrumb`, `PageHeader`, under
`design-system/navigation/`.

Pure layout and navigation chrome — no routing. `AppShell` renders the four
landmarks (`aside`/`header`/`main`, plus the `nav` that `Sidebar` renders inside
it) and depends on tokens alone; `Sidebar` takes `items`/`activeKey`/`onNavigate`,
`Breadcrumb` takes `items` with a per-step `onSelect`, and neither calls a router
or stores a route. A screen — or a thin adapter above one — supplies both,
closing over the real `objectId`/`workId` it already has. The design system never
stores, defaults or parses an identifier, so there is nothing here for a stale or
hardcoded id (`CC-024`, `W-024-07`) to hide behind; both only ever appear as this
gallery's own demonstration values, the same status ObjectRow's demo data already
had in F2.

Every property the legacy bare `aside`/`header`/`main` rules set — including at
both of `style.css`'s responsive breakpoints — is re-declared on the matching
class, the discipline the type scale already uses against bare `h1`/`h2`/`small`.
Nav and breadcrumb items are `<button>`s rather than `<a>`s, the choice `ObjectRow`
made for its own row activator, so legacy's `nav a` rule does not match this
markup at all. `SCOPE_CLASS` moves to `AppShell`'s root: this is the first
component meant to sit once at the top of the real application, rather than being
applied per-screen.

Not implemented, per the given scope: C01, O01, W01, API integration, business
logic, domain models, backend changes. `main.tsx` is not touched and does not
import any of this — the same gate F0 recorded, verified the same way: the
absence of `cc-p-navy-900`, `ccScope`, `cc-type-metric` and `Inter Variable` from
`dist/frontend/assets`.

Gates: `npm run build` PASS; `npm run typecheck:strict` PASS (the new files sit
under `src/design-system/**/*`, already covered by `tsconfig.strict.json`);
`npm run test:ds` 65/65 PASS (18 new, in `tests/design-system/shell.spec.ts`);
`npm test` 64/64 PASS. `npm run test:browser` NOT RUN — F3 touches no file it
exercises and the production bundle carries no marker of it, so the baseline
failures in `docs/status.md` remain separate and uncleared, the same basis F2
used.
