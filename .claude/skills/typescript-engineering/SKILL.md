---
name: typescript-engineering
description: TypeScript conventions for the Construction Core frontend — the strictness boundary, typing an untyped API surface, modelling component variants, and keeping `any` out of new code. Use when writing or reviewing any .ts/.tsx under apps/frontend, when defining component props that have variants or states, when mapping backend JSON into a view model, when tsc reports an error, and before touching any tsconfig.
---

# TypeScript engineering — Construction Core

## The strictness boundary

There are two TypeScript gates, and both already exist:

- **Root `tsconfig.json`** has `"strict": false` and covers `apps`, `packages`,
  `scripts`, `tests`. It runs as part of `npm run build` (`tsc --noEmit`, then Vite).
- **`apps/frontend/tsconfig.strict.json`** extends the root config with `"strict": true`,
  `noEmit`, and `lib` `ES2022`/`DOM`/`DOM.Iterable`. Its `include` list is
  `src/design-system`, `src/formatters`, `src/types`, `src/view-models`, `src/screens`,
  `src/preview`, `src/app`, `src/data` and `src/auth` — the layers written under the
  current architecture. Run it with `npm run typecheck:strict`.

Code under those directories must be strict-clean: explicit parameter and return types,
no implicit `any`, no non-null assertions to silence the compiler. Run
`npm run typecheck:strict` for any change there, in addition to `npm run build`; the root
build alone does not enforce strict mode on them.

Files outside that list — the backend, the domain package, scripts, tests, and the legacy
frontend entry (`main.tsx`, `ContractorPanel.tsx`, `Gantt.tsx`) — are not roots of the
strict gate and are checked only under the loose root setting. (A file that a listed file
imports, such as `http.ts`, is still compiled by the strict config when it is imported.)
They were written under the loose setting, and this workstream does not change them as a
side effect.

**Do not flip `strict` in the root `tsconfig.json`, and do not edit
`tsconfig.strict.json` (including its `include` list) as part of ordinary feature work.**
Enabling strict repo-wide, or widening the strict gate to more directories, is a separate
decision that needs its own authorization. If new code lands in a directory the strict
config does not list, say so rather than quietly leaving it unchecked.

## Typing the API boundary

`ReadService.snapshot()` and the controllers return JSON the compiler cannot check, and
fields are denormalised in ways that are not obvious from the endpoint name. Describe the payload
once in `types/api.ts` (schedule API: `types/schedule.ts`); `data/validateSnapshot.ts`
checks the snapshot's shape at runtime. Narrow there. After that boundary, `any` should not appear.

The legacy frontend entry types much of its data as `any` (`main.tsx`, `ContractorPanel.tsx`).
Do not copy that pattern into new files, and do not "fix" the old files as a side effect of
unrelated work.

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
