# Component usage rules

Components depend on tokens only. They take finished display strings/numbers; meaning is decided in view-models.

| Component | Use for | Rules |
|---|---|---|
| **ProgressBar** | Share of planned volume done | **Shows progress only.** Never coloured by status; 100 gets no completion styling; `null` = empty track + caption «Нет данных» (never a confident 0). Needs a `label`; `decorative` only when the % is written next to it. One bar = one measured quantity (physical СМР); never a composite of СМР + ИД + СК |
| **StatusBadge** | One visual state + required text label | **Visual state only; no hidden business meaning.** The variant is chosen by the caller from confirmed data. Label is mandatory. `Delayed` and `Attention` share one amber on purpose. `Blocked` only from named blockers, never from RED/colour. Unknown → `Neutral` «Нет данных» |
| **PlanFact** | Plan next to Fact (and confirmed figures) | Separate figures; no computed delta, no п.п. |
| **LinkedStage** | Linked-stage summary | No merged "overall" figure |
| **DataTable / ObjectRow / WorkSummaryRow** | Lists of objects / works | One object context per table on operational screens; `Empty`/`Loading`/`Error` states mandatory; row activator is a button |
| **Button** | Actions | One primary per view; arrow = navigation only |
| **AppShell / Sidebar / Breadcrumb / PageHeader** | Chrome | No routing inside; ids come from the screen |

## Colours
Colour carries **no construction meaning**. It never encodes ИД, СК, SDO, finance, role or object type. Semantic fills always
ship with text. `background.selected` marks selection, not state. Shadow belongs to overlays only.

## Composition rules
- Contours get separate blocks: physical readiness, СК, ИД, СДО, closing. No merged «Готово».
- Empty ≠ zero; no data ≠ no problems; unknown ≠ positive.
- New components need: purpose, props, states, a11y notes, usage/forbidden examples here **before** implementation, and a gallery entry + `tests/design-system` spec when built.
- A block whose data cannot exist is not rendered (no placeholders).
