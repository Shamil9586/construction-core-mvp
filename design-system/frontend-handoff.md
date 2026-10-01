# Frontend handoff (F13.1)

No backend contract changes. Everything maps onto existing components and view-models.

## Component mapping

| Screen block | Component(s) | View-model |
|---|---|---|
| Shell | `AppShell`, `Sidebar` | — |
| Header/breadcrumb | `PageHeader`, `Breadcrumb` | — |
| C01 portfolio | `DataTable` + `ObjectRow` | `buildC01ViewModel().portfolio` |
| C01 attention queue | screen-local list + `StatusBadge` + `Button` | `.attention`, `.unevaluatedObjectCount` |
| O01 identity | screen-local `dl` | `buildO01ViewModel().details` |
| O01 readiness | `ProgressBar(Block)` + `display` type | `.readiness` |
| O01 schedule | `PlanFact` | `.schedule` |
| O01 works | `DataTable` + `WorkSummaryRow` | `.works` |
| O01 blockers | screen-local lists | `.blockedWorks` |
| W01 production | `PlanFact`, `ProgressBar`, `dl` | `buildW01ViewModel()` |
| W01 confirmation | `PlanFact` / `StatusBadge` ×3 | `.confirmation` (extend per G3) |
| W01 definition / history / team | **new screen-local parts** (no new DS component until reused twice) | needs G2 / G4 / T1 |

## Screen states to implement/verify

C01: normal · attention · multiple issues · empty · insufficient data · loading · error.
O01: on schedule · delayed · production blocked · no schedule data · empty works · loading · error.
W01: not started · in progress · fact reported · confirmed · issues found/rejected · blocked · role-restricted.
Each state needs a preview/gallery fixture (typed mock over `types/api.ts`) and a `tests/design-system` assertion.

## Responsive recommendations

Existing breakpoint: `max-width: 639px` (sidebar becomes overlay). Recommendations:
- ≥1024: full layout as in specs. 640–1023: readiness/schedule cards stack to one column; tables keep all columns, horizontal scroll inside the table container only.
- <640: sidebar overlay; W01 confirmation triple stacks vertically in fixed order RP fact → Internal SC → Customer SC; attention items stack badge → text → action; table rows may switch to a two-line row (name + key figures) without dropping СМР% or status.
- Same content hierarchy at all widths; nothing hidden that is present on desktop except by explicit disclosure.
- Verify at 1440, 1024, 768, 390.

## Implementation notes
- Keep the layering: screens → view-models → DS → tokens. Wording of attention reasons lives in view-models.
- Never derive status from colour; extend view-models, not components.
- Unknown values default to `Neutral`.
- Add tests with each state; run `npm run build`, `typecheck:strict`, `test:ds`, `npm test` before claiming done.

## Open Design proposals requiring architecture review
| ID | Proposal |
|---|---|
| G1 | Confirmed per-object schedule status (C01 column, O01 badge) |
| G2 | Work definition fields: finish type, layers/pie, conditions, zone |
| G3 | Separate Internal SC / Customer SC confirmations with confirmed quantities |
| G4 | Immutable history/audit read model for fact and confirmations |
| T1 | Object team/assignment model with periods and responsibilities |
| T2 | Permissions for team view/edit |
| X1 | ~~Missing context document~~ — resolved in F13.1.1: `docs/design/Construction-Core-Parallel-Design-Context.md` |
