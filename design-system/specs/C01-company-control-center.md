# C01 — Company Control Center · UX specification

Purpose: let a director see the whole portfolio at a glance and choose **one object** to open.
C01 is a *selector with attention triage*, not a workspace. Selecting an object leads to O01.

## Content contract

| Visible (allowed) | Forbidden on C01 |
|---|---|
| Portfolio: one row per object (name, meta, responsible) | ИД details (packages, statuses, remarks) |
| Physical readiness «Физическая готовность СМР» per object (% + bar) | Quality-control (СК) workflow, inspections, remarks |
| Schedule status per object — **only when a confirmed per-object schedule field exists** (see Gap G1) | Financial closing / payment / КС details |
| Attention queue («Требует внимания») | SDO workflow details |
| Reason for each attention item (named, one sentence) | Mixed totals across objects as a single "health" score |
| Single action per item: open object | Operational actions on works (they belong to W01) |

Readiness shown per object is physical СМР only. No combined «Готово».

## Layout (desktop ≥ 1024)

1. `PageHeader` — eyebrow «ИСПОЛНИТЕЛЬНЫЙ ОБЗОР», title «Портфель объектов».
2. Portfolio `DataTable` (`ObjectRow`): columns = Object · Responsible · СМР (value + ProgressBar) · График.
3. «Требует внимания» list: `StatusBadge` + object name + reason + «Открыть объект».
4. Optional line: insufficient-data notice (see states).

Attention queue is ordered: confirmed blocker → confirmed delay → schedule risk. Within a tier: stable by object name.
Row highlight (`tone=Attention`) mirrors queue membership only.

## States

| State | Trigger (from view-model) | Presentation |
|---|---|---|
| **Normal** | portfolio > 0, attention = 0, unevaluated = 0 | Table; section «Требует внимания» shows «Проблем по графику производства работ не выявлено» |
| **Attention required** | ≥1 attention item | Highlighted rows + queue items with reasons |
| **Multiple issues** | ≥2 attention items, and/or one object with several reasons | Queue grouped one entry per object; reasons listed inside the entry (max 3 visible, «ещё N» expands); never collapse into one count-only badge |
| **Empty portfolio** | portfolio = 0 | Table `Empty` («Объектов нет») + «Нет объектов для оценки графика». No zeros, no "all clear" |
| **Insufficient data** (overlay on any state) | some object has incomplete schedule data | Separate muted line «Недостаточно данных…»; independent of the queue. *No data ≠ no problems* |
| Loading / Error | data boundary | `DataTable` `Loading` skeleton / `Error` with retry |

Each state is independent: a confirmed problem and an unevaluated object may be shown together.

## Validation checklist

- [ ] No ИД / СК workflow / finance text or controls on screen.
- [ ] Every status badge has a text label; colour never alone.
- [ ] Unknown / no data renders neutral «Нет данных», never green, never 0.
- [ ] Every attention item states its reason in words.
- [ ] One object per row, one open-object action per item; no cross-object aggregate "health".
- [ ] Readiness bar is not coloured by status.

## Gaps (documented, not implemented)

- **G1 — per-object schedule status.** The API exposes only per-work `scheduleStatus` and the mixed
  `healthStatus`. The «График» column therefore shows `NO_SCHEDULE_STATUS` today. The brief lists schedule status
  as visible on C01: **DPAR** — a confirmed per-object schedule field/definition from the backend/domain owners.
  Until then the UI must not derive it from `healthStatus` or from colour.
