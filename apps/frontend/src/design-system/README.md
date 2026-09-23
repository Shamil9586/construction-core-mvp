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

**F4 — first product screens:** C01 Company Control Center, O01 Object
Overview, W01 Work Card, under `screens/`, driven by `view-models/status.ts`,
`c01.ts`, `o01.ts`, `w01.ts`. Every screen is an `AppShell` composition built
only from already-accepted components — `Breadcrumb`, `PageHeader`,
`DataTable`, `ObjectRow`, `WorkSummaryRow`, `PlanFact`, `ProgressBar`,
`StatusBadge`, `Button` — plus one screen-local part per screen for markup no
existing component covers (C01's attention queue, O01's object-details `dl`,
W01's schedule-dates `dl`). O01 is the first and only user of the `display`
type style, exactly the "one use per screen" its own doc comment names.

Two gaps the domain model does not close, recorded rather than papered over:

- No API field gives a confirmed *per-object schedule* status — only
  per-work `Work.scheduleStatus` and the mixed `ObjectSummary.healthStatus`
  (which folds in issues, staleness and late ИД/СДО alongside schedule
  variance) exist. Neither is presented as one: C01's portfolio "График"
  column and O01's schedule card both show a stated absence
  (`NO_SCHEDULE_STATUS`) rather than either an invented aggregate or a
  mixed field wearing a schedule label. See the second corrective patch
  below for the two attempts that came before this.
- W01's specified work definition (type, finish type, layer/pie, execution
  conditions, zone) and its "confirmed 498 of 500" СК figure both go beyond
  what `Work`/`Inspection` can express today. Only the work type renders;
  finish type, layer, conditions and zone are left out entirely, the same
  choice F1 recorded for `WorkIdentityCard`'s missing slots. The real
  `buildW01ViewModel` adapter only ever produces `Accepted` (a status, from
  `work.accepted`, with no quantity attached), `Pending` or `NotSubmitted` —
  never a confirmed figure. The three-figure demonstration the product spec
  asks for is shown with an explicit, documented override in the preview only
  (`demoConfirmedQuantity` in `preview/Gallery.tsx`), not as a capability real
  data can reach.

Data is typed mock view-models over real `types/api.ts` shapes
(`screens/demo/fixtures.ts`), not a fabricated backend contract, and not
wired into `main.tsx` — the same isolation F0–F3 kept, verified the same way.

Gates (original F4 pass): `npm run build` PASS; `npm run typecheck:strict`
PASS; `npm run test:ds` 89/89 PASS (17 new, in
`tests/design-system/screens.spec.ts`); `npm test` 64/64 PASS. `npm run
test:browser` NOT RUN, same basis as F2/F3.

**F4 corrective patch (independent Work review):** five findings, all in the
view-model/data-boundary layer — architecture and screen composition were
accepted as shipped. Full detail is in the header comments of
`view-models/status.ts`, `c01.ts`, `o01.ts` and `w01.ts`; summarised here:

1. **No frontend-invented object status.** `aggregateScheduleStatus` — a
   worst-wins reduction of `Work[].scheduleStatus` into a synthetic per-object
   figure — is gone. Every object-level badge now reads
   `ObjectSummary.healthStatus` directly, via the new `healthStatusPresentation`.
2. **Unknown never reads as positive.** `aggregateScheduleStatus`'s own
   fallback silently resolved an unrecognised status to `GREEN`. Removing the
   function removed the bug with it; both status-mapping functions default an
   unrecognised value to `Neutral`, covered directly in
   `tests/view-models.test.ts`.
3. **СК confirmation is never inferred from `accepted`.** `WorkConfirmation`'s
   `Confirmed` variant used to restate `actualQuantity` under a "confirmed"
   caption whenever `work.accepted` was true — an inference `POST
   /inspections/:id/accept` (no quantity field) never supports. It is now
   `Accepted`, a status with no number attached; `ConfirmedQuantity` (an
   explicit figure) exists in the type but is reachable only through a
   labelled demo override, never the real adapter.
4. **"No data" and "no problems" no longer collapse.** An object with
   `healthStatus: 'GRAY'` used to fall out of C01's attention loop
   indistinguishably from a genuinely clean object. `unevaluatedObjectCount`
   now carries that fact explicitly, and the screen renders a distinct
   message for it, independent of whether the queue also has real items.
5. **Blocker reasons reach the screen.** O01's works table showed only a
   generic "Заблокировано" badge for a blocked work; `work.blockers`'s actual
   reasons were computed (via `workStatusPresentation`) but never displayed.
   `O01ViewModel.blockedWorks` now carries them through unedited, rendered in
   a new, conditional "Блокировки в производстве" section.

Gates (corrective patch 1): `npm run build` PASS; `npm run typecheck:strict`
PASS; `npm run test:ds` 92/92 PASS (3 new browser tests, plus one W01 preview
section added — `w01-accepted` — to exercise finding 3's real, non-demo
adapter path); `npm test` 78/78 PASS (14 new, in the new
`tests/view-models.test.ts`, testing the view-model functions directly rather
than through a browser). `npm run test:browser` NOT RUN, same basis as
before.

**F4 corrective patch 2 (independent Work review, re-review):** three
blockers, all still in the view-model/data-boundary layer. The first
corrective patch's own fix for finding 1 turned out to be a second instance
of the same mistake — full detail in the header comments of
`view-models/status.ts`, `c01.ts`, `o01.ts` and `w01.ts`; summarised here:

1. **`healthStatus` is not a schedule status either.** Patch 1 replaced the
   invented worst-wins aggregate with `healthStatusPresentation(object.healthStatus)`
   for every object-level badge — but `healthStatus` deliberately mixes in
   critical/overdue issues, staleness and late ИД/СДО, so reading its `RED` as
   "Есть отставание" or `GREEN` as "По графику" still asserted a
   schedule-specific claim the value does not confirm. `healthStatusPresentation`
   is removed; C01's portfolio row and O01's schedule card now show
   `NO_SCHEDULE_STATUS` — a stated absence — because no API field gives a
   confirmed per-object schedule status today. A C01 portfolio row's amber
   highlight now follows the attention queue directly (does this object have a
   confirmed reason in `attention`?) rather than a badge colour that carries no
   signal any more.
2. **Real `Inspection.status` values, not "any inspection = Pending".**
   `buildW01ViewModel`'s non-accepted branch used to collapse every inspection
   record into `Pending` regardless of its actual status. Studied against
   `apps/backend/src/service.ts` (`addIssue`/`inspectionAction` both gate on
   the same four-status "still open" set) and the legacy app's own
   `stateNames`: `WAITING`/`IN_REVIEW`/`REINSPECTION` stay `Pending`;
   `ISSUES_FOUND` and `REJECTED` get their own `IssuesFound`/`Rejected` kinds;
   an unrecognised status resolves to `Unknown`, distinct from `NotSubmitted`
   (no inspection at all). `Accepted` still carries no quantity, unchanged from
   patch 1.
3. **Attention no longer gates on `healthStatus`.** Patch 1's
   `unevaluatedObjectCount` skipped an object entirely once `healthStatus`
   read `GRAY`, before ever checking its `blockers` or `scheduleStatus` — but
   `ObjectHealthService`'s own `blocked` signal requires `delayDays > 0`, so a
   work can carry real `blockers` while `healthStatus` still reads `GRAY`,
   and that confirmed problem was being silently hidden behind "insufficient
   data". Every object's `blockers` and `scheduleStatus` are now checked
   directly and unconditionally; "unevaluated" is its own independent fact
   (no work has a real, non-`GRAY` schedule reading *and* no confirmed
   problem exists), never a side effect of a mixed field. A confirmed problem
   and an unevaluated object elsewhere in the same portfolio are both
   reported, at once. An empty portfolio gets its own message
   (`C01_NO_OBJECTS_LABEL`), distinct from both "no problems" and
   "insufficient data".

Gates (corrective patch 2): `npm run build` PASS; `npm run typecheck:strict`
PASS; `npm run test:ds` 94/94 PASS (2 new browser tests); `npm test` 85/85
PASS (21 in `tests/view-models.test.ts`, several replacing patch 1's own
tests that had pinned `healthStatus === schedule status`). `npm run
test:browser` NOT RUN, same basis as before.

**F4 corrective patch 3 (independent Work review, second re-review):** one
remaining blocker, accepting patches 1 and 2 in full. Full detail in
`view-models/c01.ts`'s header comment; summarised here:

**C01 partial data evaluation.** Patch 2's own "insufficient data" check —
`objectWorks.some(known reading)` — had the same shape of bug one level
down: *one* known work was enough to mark the *whole object* fully
evaluated, even when another work on the same object was `GRAY` or carried
an unrecognised status. An object with one GREEN work and one GRAY work used
to read as clean; it should read as incomplete. Problem detection
(`blocked`/`hasRed`/`hasYellow`, each an existence check — `.some()` was
always the right shape there) and data completeness
(`hasCompleteScheduleData`, now `.every()` over all of an object's works,
plus an explicit `objectWorks.length > 0` guard so zero works is never
vacuously "complete") are fully independent checks. Neither `healthStatus`
nor any other object-level field is used for completeness — only the
object's own works.

Gates (corrective patch 3): `npm run build` PASS; `npm run typecheck:strict`
PASS; `npm run test:ds` 94/94 PASS (unchanged — none of the four demo
objects in `screens/demo/fixtures.ts` happens to mix a known and an unknown
work, so this fix has no visible effect on the existing preview; covered
instead by four new pure tests matching the review's own numbered list).
`npm test` 89/89 PASS (4 new). `npm run test:browser` NOT RUN, same basis as
before.
