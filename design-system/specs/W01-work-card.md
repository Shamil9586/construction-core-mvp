# W01 — Work Card · UX specification

The central production entity. Everything about one work on one object; reachable from O01.

## Required blocks (order top → bottom)

### 1. Work definition
Work type · finish type · layers/pie (layer composition) · execution conditions · zone.
Rendered as a labelled `dl`. **Today only work type exists in `Work`** — other fields are **not rendered**
(no placeholders). **DPAR G2:** domain model fields for finish type, layers/pie, conditions, zone.
When they exist: layers/pie is an ordered list (bottom → top), each with material/thickness; absent value ≠ empty string.

### 2. Production
Plan · Fact · Performers · schedule dates · readiness `ProgressBar` (volume only) · blockers (named reasons).
Plan and Fact are separate `PlanFact` items; no difference is computed.

### 3. Confirmation — three separate, side-by-side items
| Item | Meaning | Rule |
|---|---|---|
| **RP fact** | Volume reported by the responsible person | A figure; never labelled "accepted" |
| **Internal SC confirmation** | Internal СК decision / confirmed volume | Own badge/figure; never auto-filled from RP fact |
| **Customer SC confirmation** | Customer СК decision / confirmed volume | Own badge/figure; never auto-filled from Internal SC |

Shown as three columns (stack on narrow). Differences between them are *visible by juxtaposition only*, never merged or auto-corrected.
Status vocabulary (existing): Принято / На проверке / Есть замечания / Отклонено / Не предъявлено / Статус не определён.
`accepted` never implies a quantity. **DPAR G3:** today a single «Подтверждение СК» exists; the Internal-vs-Customer split and
confirmed-quantity figures require domain/API support.

### 4. History (immutable)
Chronological, append-only log of fact entries and confirmation decisions: timestamp · actor + role · action · figure · comment.
- No edit, delete, reorder or "correct" affordance on any entry.
- A change is a **new** entry referencing the previous one (e.g. «Отозвано / Исправлено» as a new row), the old row stays visible.
- Each entry is attributed to exactly one of RP fact / Internal SC / Customer SC; entries are never merged across the three.
**DPAR G4:** history/audit read model shape.

### 5. Separate contours (existing, unchanged)
Execution units, ИД («Исполнительная документация») and СДО sections exist below as **separate contours**, each own heading and
status. They must not contribute to readiness or to the Confirmation block, and no combined «Готово» is allowed.

## States

| State | Presentation |
|---|---|
| Not started | Fact «—» (no data), readiness empty-track + «Нет данных», confirmation «Не предъявлено» |
| In progress | Plan/Fact/readiness; confirmation per item |
| Fact reported, not confirmed | Fact shown; Internal/Customer SC «На проверке» or «Не предъявлено» |
| Confirmed (partial) | Confirmed figures beside fact; difference not computed |
| Issues found / Rejected | Attention badge with the decision; history gets a new entry |
| Blocked | «Причины блокировки» card, named reasons |
| Role-restricted | Sections hidden entirely (not disabled) when role excluded; no hint of restricted data |

## Validation checklist
- [ ] Three confirmation items distinct, labelled, never merged.
- [ ] No edit/delete on history; corrections are additive.
- [ ] Fact ≠ acceptance in wording and layout.
- [ ] Physical readiness unaffected by ИД/СДО.
- [ ] No placeholder text for data that cannot exist.
