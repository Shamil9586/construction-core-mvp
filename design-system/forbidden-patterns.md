# Forbidden patterns (reject in review)

| # | Pattern | Why |
|---|---|---|
| F1 | Mixed operational screen across several objects | Object is chosen first |
| F2 | A single "overall readiness/health/Готово" combining СМР, СК, ИД, СДО, money | Contours are independent |
| F3 | Readiness reduced/raised by ИД, СДО or closing | Physical readiness is independent |
| F4 | Treating execution fact as acceptance; showing `accepted` as a quantity | Fact ≠ acceptance |
| F5 | Merging, auto-filling or "correcting" RP fact / Internal SC / Customer SC | They must stay distinct |
| F6 | Edit/delete/reorder on history entries | History is immutable |
| F7 | Deriving a status from a colour (RED ⇒ blocked/delayed) or colour from a business rule | Colour has no construction meaning |
| F8 | ProgressBar coloured by status or showing a completion state | Progress only |
| F9 | StatusBadge without label, or carrying hidden meaning | Visual state only |
| F10 | Unknown/no data shown as green or 0 | Unknown ≠ positive; empty ≠ zero |
| F11 | Percent-point deltas, relative deviations, renamed differences | Percentages only as `%` |
| F12 | Showing ИД/СК workflow/finance on C01; SC/ИД/finance on O01 | Content contracts |
| F13 | Hardcoded object/work ids or hex values/px outside tokens | Token discipline |
| F14 | Placeholder text for data that cannot exist | Don't render absent blocks |
| F15 | UI that implies "manager changed ⇒ team deleted" | Team belongs to the object |
| F16 | Components importing services/types/view-models/formatters | Layering |
| F17 | Shadow on non-overlays; decorative gradients/animations; marketing-style layout | Dense operational UI |
| F18 | Silently improving on the spec | Divergences are recorded, not quietly fixed |
