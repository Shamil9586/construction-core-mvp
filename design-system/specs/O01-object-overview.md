# O01 — Object Overview · UX specification

Purpose: production picture of **one** object — identity, physical readiness, schedule, and the reasons production is
delayed or blocked — with entry to Work Cards.

## Content contract

| Visible (allowed) | Forbidden on O01 |
|---|---|
| Object identity: name, code, address, customer, organisation, project lead, start/planned finish | SC (СК) workflow details: inspections, remarks, accept/reject |
| «Физическая готовность СМР» (one display figure + ProgressBar) | ИД workflow: packages, statuses, signatures |
| Schedule: plan-to-date vs fact (two separate figures) | Financial details: closing, payments, KS forms |
| Works table (name, performer, plan, fact, СМР %, status) | Blending readiness with documentation or money |
| Production reasons: named blockers per work. Reason categories named by the context: material delays, decisions not issued, mobilisation problems, production blockers — each shown only when backed by confirmed data | Team administration (see `object-team-ux.md`; read-only display only) |

Readiness is factual СМР execution; it is not reduced when ИД/СДО/closing is incomplete, nor raised by them.

## Layout

Breadcrumb `Портфель › Object` → `PageHeader` → identity `dl` → [Readiness card | Schedule card] →
Works `DataTable` → «Блокировки в производстве» (only when blockers exist).

## States

| State | Trigger | Presentation |
|---|---|---|
| **On schedule** | Confirmed schedule reading says on track *(requires G1)* | Neutral-to-positive badge «По графику» (exact wording per context) next to plan/fact; no extra emphasis |
| **Delayed** | Confirmed delay reading *(requires G1)* or work-level delayed | Amber badge «Есть отставание» with the plan/fact figures visible; delayed works get `tone=Attention` |
| **Production blocked** | ≥1 work has named `blockers` | «Блокировки в производстве» card listing each work and its reasons verbatim; works table row badge «Заблокировано». Blocked is **never** inferred from RED/colour |
| **No schedule data** (current default) | No confirmed per-object status | Plan and fact shown; badge replaced by stated absence «Нет данных» |
| Empty works | works = 0 | Table `Empty` («Работ пока нет») |
| Loading / Error | data boundary | Skeleton / retry |

Delayed ≠ blocked: a work may be one, both or neither; they have independent presentation and independent data.

## Validation checklist

- [ ] Only one `display`-scale number on the screen (readiness).
- [ ] Plan and fact are two figures; no computed difference, no п.п.
- [ ] No SC/ИД/finance widgets, links or counts.
- [ ] Blockers show reason text, not only a badge.
- [ ] Back path to C01 via breadcrumb; no sibling-object switcher that mixes objects.
