---
name: frontend-architecture
description: Structure, layering and file-placement rules for the Construction Core frontend (React 19 + TypeScript + Vite, apps/frontend). Use this whenever adding or moving a frontend file, creating a component, page, hook, service or type, wiring data from the API into a screen, or deciding where something belongs. Also use before any refactor under apps/frontend, whenever the question is "where does this go", and whenever a screen needs data the backend may not have.
---

# Frontend architecture — Construction Core

The frontend implements a **fixed** Visual Baseline v1. Product architecture, business
processes, UX architecture, MVP scope, roles and the C01/O01/W01 model are settled
upstream and are not renegotiated here. When the design and the code disagree, the
design wins and the divergence gets recorded — it does not get silently "improved".

## Layering

Dependencies point downward only. A lower layer never imports an upper one.

```
Two independent chains meet only at the screen. They never cross lower down.

  Data chain                          Presentation chain

  screens/                            screens/
    ↓                                   ↓
  view-models/   derivation          design-system/   components
    ↓                                   ↓
  services/      fetching            tokens/          values
    ↓
  types/ + API   payload shape

  formatters/    pure value → string. Used by view-models and screens.
                 Not a dependency of design-system.
```

**The design system depends on tokens and nothing else.** It must not import from
`services/`, `types/` (API shapes), `view-models/`, `screens/`, domain models or business
rules — and not from `formatters/` either. A component that reaches for any of those has
stopped being reusable, has become a one-screen component, and has made the Figma mapping
untrue. Components receive finished display strings and plain numbers as props; deciding
what those values should be is the data chain's job, not theirs.

## Placement

| What | Where |
|---|---|
| Token definitions | `design-system/tokens/{primitive,semantic,component}.ts` |
| Presentational component | `design-system/{navigation,cards,data,controls}/<Name>.tsx` |
| Screen | `screens/<ScreenName>/index.tsx` + local parts |
| API→screen derivation | `view-models/<screen>.ts` |
| Fetching, query keys | `services/` |
| Shared value formatting | `formatters/` |
| API response types | `types/api.ts` |

## Data flow

The backend is the source of truth and returns untyped JSON. Every screen follows the
same path: `services` fetch → `types/api.ts` describes the payload → `view-models`
derive exactly what the screen renders → `screens` pass plain props into design-system
components. Components receive finished values, never raw API objects — a component
that reaches into `work.financial.buckets` has quietly become domain logic.

Derivation the backend does not do belongs in `view-models/`, not in a component. Two
known cases: the per-object schedule aggregate (the API only exposes per-work
`scheduleStatus`), and the object-level attention selector for C01.

## Reusing what already exists

Reuse, do not re-derive: `apps/frontend/src/http.ts` (hardened non-JSON error handling —
treat as frozen), the `api()` bearer wrapper, TanStack Query, react-hook-form + zod.
`Gantt.tsx` is outside the C01/O01/W01 baseline and stays as it is.

## Missing capability vs missing data

These are different and must render differently.

- **Capability absent** — the model cannot express the thing at all (confirmed СК
  volume, zones, finish type, sequence). Do not render the block. Do not invent a
  placeholder, a dash, a zero or an explanatory sentence. The pattern is already
  specified as `V-05 No internal inspection`: the block is simply not output. A
  placeholder here reads as "nothing has been submitted yet", which is a false
  statement about the business.
- **Data absent** — the model can express it, this record has no value. That is a
  legitimate component state: `NoData`, `NotSubmitted`, `Empty`, `—`.

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
