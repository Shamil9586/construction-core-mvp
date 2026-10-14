---
name: frontend-architecture
description: Structure, layering and file-placement rules for the Construction Core frontend (React 19 + TypeScript + Vite, apps/frontend). Use this whenever adding or moving a frontend file, creating a component, screen, hook, data-access module or type, wiring data from the API into a screen, or deciding where something belongs. Also use before any refactor under apps/frontend, whenever the question is "where does this go", and whenever a screen needs data the backend may not have.
---

# Frontend architecture — Construction Core

The frontend implements a **fixed** Visual Baseline v1. Product architecture, business
processes, UX architecture, MVP scope, roles and the C01/O01/W01 model are settled
upstream and are not renegotiated here. When the design and the code disagree, the
design wins and the divergence gets recorded — it does not get silently "improved".

## Layering

Dependencies point downward only. A lower layer never imports an upper one. All paths
below are under `apps/frontend/src/`.

```
Two independent chains meet only at the screen. They never cross lower down.

  Data chain                           Presentation chain

  app/        routes, session,         screens/
              runtime context,           ↓
              route-level hooks        design-system/   components
    ↓                                    ↓
  screens/                             design-system/tokens/   values
    ↓
  view-models/   derivation
    ↓
  data/          fetching, DataProvider, *Api.ts modules, validateSnapshot
    ↓
  types/api.ts   payload shape (types/schedule.ts for the schedule API)

  http.ts, auth/   shared by data/ (response parsing, session token)
  formatters/      pure value → string. Used by view-models and screens.
                   Not a dependency of design-system.
```

`app/` is the composition root: the route table (`AppRoutes.tsx`, `routePaths.ts`),
session bootstrap (`SessionGate.tsx`), the runtime context, and route components under
`app/routes/` that pick a screen, call `data/` and view-model builders, and pass the
result down. Route-level hooks (`useSchedule`, `useDocumentationRegistry`, …) also live
there. `screens/` render view-models with design-system components.

**The design system depends on its own tokens and nothing else.** Nothing under
`design-system/` imports from `data/`, `types/` (API shapes), `view-models/`,
`screens/`, `app/`, `formatters/`, domain models or business rules. A component that
reaches for any of those has stopped being reusable, has become a one-screen
component, and has made the Figma mapping untrue. Components receive finished display
strings and plain numbers as props; deciding what those values should be is the data
chain's job, not theirs.

## Placement

| What | Where |
|---|---|
| Token values (all three layers) | `design-system/tokens/tokens.css` |
| Typed token references and measurements | `design-system/tokens/tokens.ts` (re-exported by `tokens/index.ts`) |
| Type-scale classes | `design-system/tokens/typography.css` |
| Presentational component | `design-system/{navigation,data,controls}/<Name>/<Name>.tsx` (+ `.module.css`, `index.ts`), re-exported from `design-system/index.ts` |
| Screen | `screens/<ScreenName>/index.tsx` + local parts and `.module.css` |
| Route component, session and runtime wiring | `app/` (route components in `app/routes/`) |
| API→screen derivation | `view-models/<screen>.ts` |
| Fetching and API write functions | `data/` — `DataProvider` implementations and one `*Api.ts` module per API area |
| Snapshot shape check | `data/validateSnapshot.ts` |
| Shared value formatting | `formatters/` |
| API response types | `types/api.ts` (schedule API: `types/schedule.ts`) |
| HTTP response parsing, session token | `http.ts`, `auth/` |

There is no `services/` directory, no `design-system/cards/` and no separate
`tokens/{primitive,semantic,component}.ts` files. Do not create them to match older
notes; place new code in the locations above.

## Data flow

The backend is the source of truth and returns JSON. Every screen follows the same
path: `data/` fetches (the snapshot through the `DataProvider` chosen in
`selectDataProvider.ts`, other areas through `data/*Api.ts`) → `types/api.ts`
describes the payload, and `validateSnapshot.ts` rejects a malformed snapshot →
`view-models` derive exactly what the screen renders → `screens` pass plain props into
design-system components. Components receive finished values, never raw API objects — a
component that reaches into `work.financial.buckets` has quietly become domain logic.

Derivation the backend does not do belongs in `view-models/`, not in a component.
A known case is the object-level attention selector for C01.

Schedule compliance is the exception to "derive it in the frontend": it is calculated by
the backend and the frontend only presents it. The Object's approved GPR (production
schedule; `data/scheduleApi.ts`, `types/schedule.ts`, `docs/gpr-1-production-schedule.md`)
is the single source of schedule compliance:

- the object-level schedule conclusion on O01 (`NO_BASELINE` / `ON_TRACK` / `DELAYED`)
  comes from the approved GPR;
- O01 per-work compliance derives from the approved GPR entries
  (`view-models/schedule.ts`); a work with no approved baseline or no entry says so in
  words and never defaults to "on schedule";
- W01 shows the work's own GPR summary and its physical state separately.

Do not use the legacy `work.scheduleStatus` for O01/W01 schedule compliance, and do not
calculate delay, planned progress or an object-level conclusion in a view-model or
component. View-models map the GPR response into display strings and presentation
variants, and combine the backend-calculated entry states of one work the way the GPR
document describes (any delay wins). `work.scheduleStatus` remains only the input of
C01's portfolio attention.

`DataProvider` covers the read side only. Write actions that have no mock counterpart
(for example `data/executionUnitsApi.ts`) are standalone modules gated on a real
session, not extra `DataProvider` methods.

## Reusing what already exists

Reuse, do not re-derive: `apps/frontend/src/http.ts` (`parseResponse`, hardened
non-JSON error handling — treat as frozen), `auth/sessionToken.ts` for the bearer
token, and the existing `data/*Api.ts` helpers (they all send the bearer header and
route responses through `parseResponse`).

TanStack Query, react-hook-form and zod are project dependencies, but at the baseline
they are used only by the legacy entry `main.tsx`; the `app/`, `data/` and `screens/`
layers do not use them. Do not assume they are the default for new code in those
layers without checking the neighbouring files first.

`main.tsx` (the legacy entry with its local `api()` wrapper), `ContractorPanel.tsx`
and `Gantt.tsx` sit outside the `app/` composition root and stay as they are.

## Token layers

`design-system/tokens/tokens.css` defines three cascading layers in one file:

| Layer | Prefix | Used by a component? |
|---|---|---|
| primitive | `--cc-p-*` | **No** — review failure |
| semantic | `--cc-background-*`, `--cc-text-*`, `--cc-status-*`, … | Yes |
| component | `--cc-card-*`, `--cc-table-*`, `--cc-badge-*`, … | Yes |

`tokens.ts` holds typed references to those variables plus the few measurements logic
needs as numbers; values are not duplicated into TypeScript. See the
`design-system-engineering` skill for how to build and change tokens.

## Missing capability vs missing data

These are different and must render differently.

- **Capability absent** — the model cannot express the thing at all. Do not render the
  block. Do not invent a placeholder, a dash, a zero or an explanatory sentence. The
  pattern is already specified as `V-05 No internal inspection`: the block is simply
  not output. A placeholder here reads as "nothing has been submitted yet", which is a
  false statement about the business.
- **Data absent** — the model can express it, this record has no value. That is a
  legitimate component state: `NoData`, `NotSubmitted`, `Empty`, `—`.

### Capability status at the baseline

Classified individually from source. Re-check the cited files before relying on a row;
do not extend it by assumption.

| Capability | Status | Evidence and limit |
|---|---|---|
| RP_FACT quantity | Implemented | `data/executionUnitsApi.ts` `recordPortionFact` (`portions/:id/fact`) and `createQuantityPortion`; rendered by `screens/W01/ExecutionSection.tsx`. The backend refuses new fact once a non-rejected SC inspection exists on the portion. |
| INTERNAL_SC confirmed quantity | Implemented for portions | `requestInternalScInspection`, `acceptInspection(…, quantity)`, `rejectInspection`; `QuantityPortion.internalScAccepted` / `internalScConfirmedQuantity`. A portion-scoped accept requires the inspector's own quantity. A whole-work inspection (no portion) still carries no quantity. |
| CUSTOMER_SC confirmed quantity | Backend model only | `PortionConfirmationSource`, `InspectionType`, `customerScAccepted` / `customerScConfirmedQuantity` on portions, and a backend rule that an accepted CUSTOMER_SC quantity is greater than zero. `view-models/w01.ts` deliberately does not read it and W01 has no customer-SC UI; the frontend never requests a `CUSTOMER_SC` inspection. |
| Zones | Partial | `WorkExecutionUnit.location` (nullable) shown by `ExecutionSection.tsx`; schedule entries carry `zone` (`types/schedule.ts`); documentation packages carry a portion `zone`. `Work` itself has no zone, so a work with no execution units has none. |
| Finish type | Not rendered | `WorkExecutionUnit.finishTypeId` exists in the snapshot type, but `GET /dictionaries` does not resolve a name and no view-model or screen reads it. |
| Work layers | Not rendered | `executionUnitLayers` are in the snapshot; no view-model or screen reads them. |
| Sequencing | Partial | Work-level `WorkDependency` (`FINISH_TO_START` only) feeds `blockers`; the GPR schedule has per-entry `sequence`, `predecessorItemId` and an advisory `followsPredecessor`. W01 renders no sequence block. |

Quantity sources stay separate: **RP_FACT** (the production fact recorded by the Project
Manager, РП), **INTERNAL_SC** (internal construction control) and **CUSTOMER_SC**
(customer construction control) never overwrite one another and are never merged into
one number.
`CUSTOMER_ACCEPTED` is a different, package-level source used by the documentation
registry and AOSR.

## Do not touch from the frontend

`apps/backend/**`, `packages/domain/**`, `infra/**`, `apps/frontend/src/http.ts`, the
auth model (opaque bearer in `sessionStorage`), and `vite.config.ts` `root`/`proxy`/
`outDir`. Changes there are a separate, separately-approved workstream.

## Product boundaries

Design Rules §17. The frontend does not introduce CRM entities — deals, leads,
sales, sales tasks — new user roles, or new business processes. BIM, AI features
and a regulatory reserve are not added without a separate decision.

This bites in ordinary moments, not dramatic ones: a "quick" status field on an
object, an extra role to make a permission check simpler, a task list bolted onto
a work card. Each looks like a small frontend convenience and each quietly extends
the product model. When a screen seems to need one, the need is evidence that the
design or the domain model should change first, through UX → Design → Frontend.

## Navigation contract

Routing carries identity, and the identity is real data, never a fixed string.

- Preserve the current `objectId` across every transition within an object.
- Preserve the current `workId` once a work is selected.
- Validate that the work belongs to the object before rendering a work screen. A
  mismatched pair is a routing error, not a screen to render — the whole point of
  the contract is that a work card cannot show a fact belonging to a different
  object.
- Preserve a correct return path: going back from a work lands on that work's
  object, not on a remembered or default one.

`CC-024` and `W-024-07` appear throughout the Phase 1 prototype and the design
specifications. They are demonstration values. They must never be hardcoded as
identifiers, defaults, fallbacks or test fixtures outside an explicitly
demonstration scenario — a fallback to a demo id turns a routing bug into a screen
that confidently shows the wrong object's data.
