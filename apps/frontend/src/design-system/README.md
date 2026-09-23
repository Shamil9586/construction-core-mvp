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

## Status

**F0 complete** — tokens, type scale, Inter, tabular figures.

Components land from F1. Five of them — `ConfirmedVolume`, `ZoneRow`, `Sequence`,
and the identity slots of `WorkIdentityCard` — depend on capabilities the domain
model does not yet express. They will not be filled with placeholder text: a block
whose data cannot exist is not rendered at all.
