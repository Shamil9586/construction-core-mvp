---
name: design-system-engineering
description: How to build and change Construction Core design-system components and tokens — the primitive → semantic → component layering, the typography scale, spacing and grid spans, and the product invariants the visual layer must preserve. Use whenever creating or editing anything under design-system/, choosing a colour, size or radius, adding a component variant, formatting a number, percentage or quantity, or implementing a block from the Visual Baseline. Also use the moment you are about to hardcode a hex value or a px number.
---

# Design system engineering — Construction Core

Sources of truth: `Construction_Core_Design_Rules_v1.md`, `01_Visual_Design_System_v1.md`,
`02_Component_Library_Specification.md`, `05_Design_Decisions.md`. When code and spec
disagree, the spec wins.

## Token layering

Three layers, and components may only read the top two:

```
primitive   raw values — colour steps, sizes, font values.      Never used in a component.
semantic    purpose — background.page, text.primary,            Used in components.
            status.delayed.fill, action.primary, focus.ring
component   per-component values — sidebar.*, card.*, table.*    Used in components.
```

A component referencing a primitive directly is a review failure (decision D-02). The
reason is practical: `amber` does not tell you whether it may be applied to an
unconfirmed volume; `status.attention.fill` does. The indirection is also what makes a
dark theme possible later by redefining only `semantic` — which is why the layering is
kept even though v1 ships one light theme (D-13).

Hardcoded hex values and px numbers inside components defeat all of this. If a value is
missing from the tokens, add it to the right layer rather than inlining it.

## Typography

16 styles, named exactly as the tokens: `display`, `metric-xl`, `metric-lg`, `metric-md`,
`heading-page`, `heading-section`, `heading-card`, `body-lg`, `body`, `body-strong`, `ui`,
`ui-strong`, `label`, `label-strong`, `meta`, `eyebrow`. Inter, weights 400/500/600.

All numeric styles use tabular figures (`font-feature-settings: "tnum"`). The product is
built on comparing numbers down a column — 500 against 498, 75% against 62%. Proportional
digits break that vertical alignment and the comparison stops working (D-06).

`display` appears once per screen (physical readiness on O01). Critical reasons and
actions never sit in `meta` or `eyebrow` — 10–11px carries service context only.

## Layout

12 columns, column 77px, gutter 20px. Block widths are whole spans — **271 / 368 / 756 /
1144** — not the prototype's 268/364/370/376/380/744/748 (decision D-01). Spacing is the
4px scale: 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40. Radius: card 10, button 7, badge and row
6, progress 3, overlay 14. Focus ring 2px, offset 3px.

Shadow is reserved for `ContextOverlay` and nothing else (D-10). Cards separate by border
and background, not elevation.

## Invariants the visual layer must not break

These are product rules, not preferences. Each has a recorded reason.

- **Percentages only as `%`.** Never "п.п.", never a relative deviation, never the
  arithmetic difference of two percentages renamed. Correct: "План на дату 75% · факт 62%"
  plus the status "Есть отставание" (Design Rules §7).
- **Fact of performance and СК confirmation are two separate figures**, always side by
  side, never merged and never auto-corrected. A 500/498 gap is not a defect, an error or
  a block (§8).
- **Colour accompanies status, never replaces it.** Every semantic fill carries a text
  label (§16). A badge without text does not exist in this system.
- **`Delayed` and `Attention` share one amber.** Do not introduce a second step — it
  would invent a risk scale the product model does not have (D-07). The label carries the
  difference.
- **Progress bar is never semantic.** Always the neutral blue fill. Amber-on-delay would
  make 62% read as a quality or acceptance judgement (D-08).
- **Selected is not a status.** `background.selected` marks the chosen zone; the status
  lives in the badge (D-09).
- **Contours stay separate.** Physical СМР readiness, СК, ИД and СДО each have their own
  block and their own state. No combined "Готово" indicator anywhere (§6, §14, §15).
- **Empty is not zero.** Absent data renders as "Нет данных" or "—". `0` appears only
  when it is a real zero.
- **A status is never derived from a colour.** `StatusBadge` renders a status that was
  already decided from confirmed data or an existing domain rule; it does not translate a
  colour code into a business meaning. Concretely: `RED` is a schedule-variance severity
  produced by `ScheduleStatusService`, so it must not be read as "Заблокировано".
  «Заблокировано» has its own real source — `works[].blockers[]`, which carries named
  reasons. Mapping colour to business state invents a rule the product does not have.

## Formatting rules

Formatters live outside the design system, in `formatters/`, and are used by view-models
and screens — not by components. They are pure functions with no React, shared so the same
value never appears in two spellings. Locale `ru-RU`. Unit is separated from the value and
rendered as `meta`: "500" + "м² · физически выполнено". Dates via `Intl`, not string
slicing.
