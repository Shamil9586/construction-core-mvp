---
name: typescript-engineering
description: TypeScript conventions for the Construction Core frontend — the strictness boundary, typing an untyped API surface, modelling component variants, and keeping `any` out of new code. Use when writing or reviewing any .ts/.tsx under apps/frontend, when defining component props that have variants or states, when mapping backend JSON into a view model, when tsc reports an error, and before touching any tsconfig.
---

# TypeScript engineering — Construction Core

## The strictness boundary

The repository root `tsconfig.json` has `"strict": false` and covers `apps`, `packages`,
`scripts`, `tests`. **Do not flip it globally.** The backend, the domain package and the
legacy frontend were written under the loose setting; turning strict on repo-wide
produces hundreds of errors in code this workstream is not allowed to change, and
`npm run build` (which runs `tsc --noEmit`) would fail for reasons unrelated to the work.

New design-system and screen code is strict-clean by discipline instead: explicit
parameter and return types, no implicit `any`, no non-null assertions to silence the
compiler. A local `tsconfig` with `strict: true` over the new directories is the way to
get the compiler to enforce this without touching the global gate — keep it additive and
keep the root gate green.

## Typing the API boundary

`ReadService.snapshot()` and the controllers return untyped JSON, and fields are
denormalised in ways that are not obvious from the endpoint name. Describe the payload
once in `types/api.ts` and narrow there. After that boundary, `any` should not appear.

The existing frontend types everything as `any` (`function stages(data: any, works: any[])`).
That is the state being moved away from; do not copy the pattern into new files, and do
not "fix" the old files as a side effect of unrelated work.

## Variants

Component variants come from the Component Library Specification and are closed sets.
Model them as string-literal unions, not enums and not `string`:

```ts
type StatusBadgeVariant = 'OnTrack' | 'Delayed' | 'Attention' | 'Blocked' | 'Neutral';
```

Unions give exhaustiveness checking: a `switch` over the variant with a `never` default
makes the compiler point at every call site when a variant is added. Enums add a runtime
object for no benefit here, and `string` silently accepts typos that render as a missing
style rather than an error.

Where a component has mutually exclusive shapes — a value present versus genuinely
absent — prefer a discriminated union over optional fields, so "no data" cannot be
confused with "zero":

```ts
type Measure =
  | { kind: 'value'; amount: number; unit: string }
  | { kind: 'noData' };
```

This is not stylistic. `0 м²` (a real zero on floor 2) and `—` (nothing submitted) are
different business facts, and optional-number props lose that distinction.

## Nullability

Backend percentages are genuinely nullable: `ProgressCalculationService.calculate()`
returns `null` when planned quantity is zero, and `ScheduleStatusService` returns
`plannedProgress: null` for undated work. Keep `| null` in the types and handle it —
defaulting to `0` at the type level is how a missing measurement turns into a false `0%`
on screen.

## Money and quantities

Values arrive as strings (`numeric` columns, `Decimal.toFixed(2)`). Do not coerce with
`Number()` for arithmetic on money. The repo already depends on `decimal.js`; use it, or
keep the string and only format it.
