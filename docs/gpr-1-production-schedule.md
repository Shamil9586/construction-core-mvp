# GPR-1 — Production Schedule («График производства работ»)

First vertical slice of the production-planning layer: **one** general production schedule per Object, built from the production
model that already exists, measured against the production fact that already exists.

Baseline: `origin/main` @ `3ad27dd214b4ae844e96e2060ac4b4a25ad661eb`. Branch: `feature/construction-schedule`.
Code: `packages/domain/schedule.ts` (rules), `apps/backend/src/schedule-service.ts` (+ `schedule-scope.ts`, `schedule-validation.ts`,
`modules/schedule/`), `infra/pending/gpr-1_production_schedule.sql` (schema), `apps/frontend/src/screens/GPR/` (+ O01 / W01 blocks).

## Locked principles (what this slice does NOT do)

* Object-centric: the schedule is addressed through the Object (`objects/:objectId/schedule…`); no screen or API mixes two Objects.
* **One** schedule. There is no weekly / monthly / daily plan entity; calendar views are a later projection of the same entries.
* **No second Work model.** Work, Work Execution Unit, Quantity Portion, zone, contractor, RP fact and Internal СК are reused as they are.
* **No duplicated quantity.** The schedule stores dates and order. Planned quantity, unit, zone and executor are read from the production
  model on every request; physical progress is derived from RP fact on every request. Nothing is copied, so nothing can drift.
* No financial quantity, no customer quantity "for the schedule", no CPM, no Gantt engine, no company-wide Gantt (C01 is a later phase).
* The schedule feeds nothing in PTO / ИД / СДО / readiness, and none of them feeds the schedule.

## Model map — what is reused, what is new

| Concept | Existing source (reused) | Role in GPR |
|---|---|---|
| Object | `objects` | The schedule's owner; every row carries `object_id`, a database trigger refuses a cross-object reference |
| Work | `works` | Identity of the work; name; the work's own planned window is only a **suggested default** when adding a scope |
| Execution scope / zone | `work_execution_units` (`location` = zone) | **The scheduled scope.** One schedule entry = one execution unit (a zone) |
| Planned quantity, unit | `work_execution_units.planned_quantity` / `unit` (or the work, for a work with no units) | Read, never stored |
| Executor | `work_execution_units.contractor_id` → `contractors` | Read, never stored |
| Quantity Portion | `quantity_portions` | Not scheduled by itself (see "Chosen scope"); its facts roll up to the unit |
| Physical fact | `portion_quantity_confirmations` (`RP_FACT`, latest per portion; append-only) | **The only schedule progress source** (`progressSource: "RP_FACT"`) |
| Internal СК accepted quantity | `portion_quantity_confirmations` (`INTERNAL_SC`) | Shown **next to** the fact as «Принято СК», never merged into it, never an input |
| Customer СК quantity | `portion_quantity_confirmations` (`CUSTOMER_SC`) | Not read at all |
| Technological gate | `work_dependencies` | Untouched. The schedule's "follows" reference is **advisory** and separate |
| Audit | `audit_logs` | Every schedule mutation writes there (who / when / before / after) |
| **New** `schedule_items` | — | Stable identity of a planned scope (one per unit / per whole-work) |
| **New** `schedule_revisions` | — | A version of an Object's schedule: `DRAFT → APPROVED → SUPERSEDED`, or `DRAFT → DISCARDED` |
| **New** `schedule_revision_entries` | — | The dates / order of an item **inside one revision**; frozen on approval |
| **New** `schedule_delay_categories` | — | A tenant's additions / renames / switch-offs on the built-in delay categories |
| **New** `schedule_delay_reasons` | — | Why a scope is late (append-only evidence) |

### Chosen scope

The schedule plans **execution units** (a zone of a work: «Штукатурка стен · 1 этаж»). Reasons:

* a unit already carries zone, contractor, planned quantity and unit — the exact columns the GPR table needs, so there is nothing to invent;
* different zones of one work legitimately have different dates (1 этаж Mar 1–15, 2 этаж Mar 10–30) and different executors — a per-work
  row could not say so, and "one row per generic work type" is explicitly not wanted;
* progress of a unit is the sum of its portions' latest RP facts, so partial progress (portions reported one by one) is natural.

A work with **no** execution units may be scheduled as a whole (`execution_unit_id IS NULL`). The service refuses to mix the two: a work with
units is planned through its units, and a work already scheduled as a whole cannot also be scheduled by unit in the same draft. If a work
scheduled as a whole later gains units, the row stays valid and carries the note «У работы появились участки — разбейте график по участкам при ближайшей корректировке».
Portion-level planning (a flow chart per portion) is deliberately **not** done — portions are fact-reporting slices, not planning scopes —
and can be added later without a schema change to the items already created (a new item kind), see "Deferred".

## Planning: draft → approved baseline → corrections

1. **Draft.** Someone with `SCHEDULE_EDIT` creates a draft (one per object, enforced by a partial unique index), adds scopes
   (unit / whole work) with `plannedStart`, `plannedFinish`, optional `sequence`, optional `predecessorItemId`. Nothing in a draft is
   authoritative: it is never used to measure delay.
2. **Approve.** Someone with `SCHEDULE_APPROVE` approves the draft **exactly as they saw it** (the request carries the draft's `version`; if
   it changed, they get a 409 and re-read). The draft becomes the object's current baseline; the previous baseline (if any) becomes
   `SUPERSEDED`. Approved entries are frozen — **by a database trigger, not only by the service**: an UPDATE / DELETE of an approved
   revision's dates is refused for any writer.
3. **Correction.** The same flow from the current baseline: the new draft is cloned from it, and its approval requires a
   `correctionReason` and at least one real change against the baseline. The old revision stays exactly as it was. While a correction is
   in preparation the **approved** dates keep measuring the delay; only approval switches the baseline.
4. **History.** Every approved / superseded revision is listed with who prepared / approved it, when, the approval comment, the correction
   reason and the exact diff against the revision it replaced (added / removed / changed with before → after). Each current entry also
   shows how far corrections moved it against the **first** approved plan (`baselineShift`) — so a plan cannot silently drift to hide a delay.
5. No heavyweight workflow: no multi-step approval chain, no notifications, no comments threads. Draft → approve is one act.

Audit (`audit_logs`, entity → action): `ScheduleRevision` CREATE_DRAFT / DISCARD / APPROVE / APPROVE_CORRECTION, `ScheduleEntry`
ADD / EDIT / REMOVE (before / after dates and order), `ScheduleDelayReason` RECORD / RESOLVE, `ScheduleDelayCategory` CREATE / UPDATE.

## Progress, status and delay (derived — never typed)

Progress source (all views): **RP fact** = the quantity the project manager reported, summed over the unit's portions (latest per portion).
There is **no** way to enter an actual quantity, a percentage or a colour into the schedule (the API has no such field).

| View | Fact shown | Accepted quantity shown |
|---|---|---|
| GPR table, O01 conclusion, W01 summary | RP fact («Факт РП») | Internal СК accepted («Принято СК») as a separate captioned line, only where it exists |
| Customer СК | not read | not read |

Physical completion is **independent of ПТО / ИД / СДО / closing / money**: a scope is `COMPLETED` when RP fact ≥ planned quantity, whatever
СК, AOSR, scheme, package or СДО say. Global readiness semantics are not changed (`ProgressCalculationService` is reused as it is).

Rules, on a civil date `today` (the server's today, or `?asOf=YYYY-MM-DD` for a what-if / test), from the **approved** dates:

* **Planned progress** — the accepted linear plan (business rule 2): 0 before the start, 100 from the finish date on, linear between.
* **Выполнено** (`COMPLETED`) — RP fact ≥ planned quantity. Never delayed.
* **Есть отставание** (`DELAYED`) — behind the linear plan by **at least one whole calendar day**. `delayDays` = `floor` of the lag in
  days to the equivalent date of the linear plan at the current fact (business rule 3, not a CPM forecast), computed with exact decimals.
  A lag below one day is not a delay (49 % against 50 % mid-flow raises no alarm); a scope that has not started a day after its start
  date, or is unfinished on its finish date, always does. `delayKind`: `START` (nothing reported), `PROGRESS` (reported but behind),
  `FINISH` (finish date reached).
* **В работе** (`IN_PROGRESS`) — fact > 0, not behind. **Не начато** (`NOT_STARTED`) — no fact (or a reported 0), start not passed.
* "Should have started / should be underway / should be finished" (`expectedPhase`: `NOT_DUE` / `UNDERWAY` / `DUE_COMPLETE`) is the calendar
  alone, shown separately from the fact so management can compare the two.
* A fact never reported is `—`, not `0 %`. Reported quantity above the plan is flagged (`overperformed`) and the percentage is clamped at 100.

**Object conclusion** (O01): `NO_BASELINE` (no approved schedule — claims nothing, never «По графику») / `ON_TRACK` («По графику») /
`DELAYED` («Есть отставание» — any entry delayed). No finance, ИД, ПТО or СДО input exists in that function. Also returned: counts per state,
the largest delay, how many production scopes are **not** in the schedule, how many open delay reasons exist.

**Work summary** (W01): the work's own entries only — first start, last finish, aggregated state (any delay wins; else all completed;
else all not-started; else in progress), largest delay, number of entries and their zones. No other work of the object is revealed.

## Delay reasons (extensible, separate from СК remarks)

A reason can be recorded only for a scope that is **currently delayed** (the server re-derives the state; a manual «reason» for an on-schedule scope is refused). Fields: scope (item), category, comment (required),
responsible party (a person **or** one of the object's contractors, optional), recorded by, recorded at, `delayDaysAtRecord` (evidence),
status `OPEN` / `RESOLVED` (+ who / when / comment). A reason is append-only evidence: a database trigger refuses any change except the
one-way `OPEN → RESOLVED`. Several reasons per scope are allowed (history of why).

Categories are **open**: built-in defaults («Материалы», «Мобилизация / ресурсы», «Решения / согласования», …) live in code as defaults; a
tenant admin adds, renames, reorders or switches off categories through `POST schedule/delay-categories` (no seed data needed; a recorded
reason keeps a readable category name after the category is retired). Planning delay reasons are **not** СК remarks / issues
(`issues` table) and are never mixed with them.

## Authorization (backend is authoritative; the UI only hides what the backend would refuse)

| Role | View | Prepare (draft) | Approve | Record delay reason |
|---|---|---|---|---|
| ADMIN | ✔ | ✔ | ✔ | ✔ |
| DEPUTY_DIRECTOR | ✔ | ✔ | ✔ | ✔ |
| PROJECT_MANAGER (own object) | ✔ | ✔ | — | ✔ |
| GENERAL_DIRECTOR | ✔ | — | — | — |
| CONSTRUCTION_CONTROL / _HEAD | ✔ | — | — | — |
| PTO / PTO_HEAD | ✔ (PTO: team members of the object) | — | — | — |
| SDO / SDO_HEAD | ✔ | — | — | — |
| CONTRACTOR_VIEWER | — | — | — | — |

Four permissions (`SCHEDULE_VIEW`, `SCHEDULE_EDIT`, `SCHEDULE_APPROVE`, `SCHEDULE_DELAY_REASON`) appended to the `Permission` enum with a
`scheduleGrants` block right after `grants` — no existing role's grant was rewritten (a test asserts it). The retired roles
`CONSTRUCTION_DIRECTOR` / `DoC` / `TECHNICAL_DIRECTOR` are **not** reintroduced. Approval by `GENERAL_DIRECTOR` is a one-line grant change if
the business wants it.

Object scoping is the existing `objectAccess` (tenant, РП owns only their objects, PTO scope): a РП of another object gets 403 on the
schedule and on every record id (reached only through `objects/:objectId/…`, re-checked in the service). A PTO engineer needs membership of
the object's PTO team for the object's schedule; a work-level handoff opens only **that work's** summary (`GET works/:id/schedule`).
Permission is checked before the object is touched (403 reveals nothing about the data). Every mutation runs in one transaction that locks
the object row, so an object's schedule mutations are serialised.

## API

| Route | Purpose | Permission |
|---|---|---|
| `GET objects/:objectId/schedule[?asOf=]` | The object's schedule: baseline measured, conclusion, history, (draft + available scopes for editors) | VIEW |
| `GET works/:workId/schedule[?asOf=]` | One work's summary + entries (W01) | VIEW |
| `POST objects/:objectId/schedule/draft` | Create a draft (clone of the current baseline when one exists) | EDIT |
| `POST …/draft/entries` · `…/entries/:id/edit` · `…/entries/:id/remove` | Add / change dates, order, predecessor / remove a scope | EDIT |
| `POST …/draft/discard` | Discard the draft | EDIT |
| `POST …/draft/approve` | Approve (`version`, `comment`, `correctionReason` for a correction) | APPROVE |
| `POST …/delay-reasons` · `…/delay-reasons/:id/resolve` | Record / close a delay reason | DELAY_REASON |
| `POST schedule/delay-categories` | Add / rename / switch off a category (tenant) | ADMIN_DICTIONARIES |

The schedule is **not** in the company-wide `snapshot` (no schedule data rides it): it is read per Object on demand, so the snapshot — a
shared, frequently edited file — is untouched.

## Ordering and dependencies (simple on purpose)

* `sequence` (int ≥ 1, default = next) orders the table; ties are allowed (parallel stages). Order is a planning sort key, not a lock.
* `predecessorItemId` — optional finish-to-start **reference** to another item **of the same revision** (database composite FK). It is
  **advisory**: it annotates («начинается до окончания предшествующего» when the start is earlier than the predecessor's finish) and never
  blocks production or approval; flow planning overlaps on purpose. Cycles, self-reference and removing an item that others follow are refused.
* The technological gate remains `work_dependencies` (business rule 5), untouched.

## UX

* **Object → «График производства работ»** (`/object/:objectId/schedule`): conclusion card (baseline version, who approved and when,
  calendar answers «Должно было начаться / Должно идти / Должно быть завершено / Есть отставание»), then the table — Работа / участок,
  Исполнитель, План объём, Начало, Окончание, Факт (% + «Факт РП» + «План на дату» + «Принято СК»), Состояние, Отставание — and under a
  delayed row its reasons with a form to add one. Editors also get the draft (dates, order, "follows"), the approve / correct / discard
  actions, and the history. Table first; no Gantt. On narrow screens rows stack as labelled cards (no sideways page scroll).
* **O01** «Состояние графика» card: the object's conclusion from GPR («По графику» / «Есть отставание» / «График не утверждён»), the
  delayed positions by name with days and recorded reasons, and the way into the schedule. The card keeps its original statement whenever
  no schedule is offered to the viewer (role / demo runtime). Physical completion (ФГ) is unchanged: no PTO, ИД or finance is added to it.
* **W01** «График производства работ» block: planned start / finish, state, delay, number of entries and their zones, and a button to the
  object's schedule — not the table. Absent for viewers who cannot read the schedule.
* A delay is never a colour alone: it always reads «Есть отставание» plus a number of days; no «п.п.» is used anywhere.

## Independence from PTO / ИД / СДО / Bitrix Disk

The schedule code imports nothing from documentation, AOSR, packages, СДО or finance (a source-guard test enforces it, and
the frontend schedule modules are guarded the same way). It does not touch document storage or the Bitrix Disk integration, the PTO package
lifecycle or ID-AUTO. Completing a scope's physical fact is not blocked, delayed or implied by any of them.

## Database — PENDING migration (no production number claimed)

`infra/pending/gpr-1_production_schedule.sql` — **additive only**: five new tables with indexes and guard triggers; no existing table or column
is altered. `scripts/migrate.ts` reads only `infra/<digits>_*.sql`, so the file reaches **no** database until promoted.

Requirements the migration encodes (the coordinator should keep them if the file is ever re-cut):

* tenant-scoped composite FKs everywhere (`(tenant_id, id)`); optimistic `version` on drafts / entries / reasons / categories;
* partial unique indexes: one item per unit, one item per whole-work, **one draft** and **one current baseline** per object;
* CHECKs: revision state consistency (provenance columns match the status), a correction needs a reason, `planned_finish ≥ planned_start`,
  predecessor ≠ self, `delay_days_at_record ≥ 1`, a reason names a person **or** a contractor;
* triggers: items immutable and same-object; approved / superseded / discarded revisions never rewritten (only the supersession columns may
  change on `APPROVED → SUPERSEDED`); entries editable only while their revision is a draft; delay reasons append-only except `OPEN → RESOLVED`.

**Promotion (coordinator, at integration):** `git mv infra/pending/gpr-1_production_schedule.sql infra/0NN_production_schedule.sql` using the
next free number at that moment (023 is the highest on the baseline) — **no change to the content**. The GPR test helper applies the pending
file while it sits in `infra/pending/` and does nothing once the ordinary runner has applied it, so the suites pass unchanged on either
side of the rename. The migration is idempotent only through the runner's ledger (like every other migration), not by `IF NOT EXISTS`.

**A database that does not have it yet** (a deploy before promotion): every schedule route answers `503` with «Раздел «График производства
работ» не активирован: схема базы данных ещё не обновлена (миграция GPR-1)» — nothing else in the application depends on the tables, the
O01 / W01 blocks show a quiet «График производства работ не загружен: …» note carrying that message (no verdict is invented), and the rest of the product behaves exactly as before.

## Parallel integration — shared files and likely conflicts

Touched files that other slices may also edit (all changes are small and additive):

| File | Change | Conflict risk |
|---|---|---|
| `packages/domain/index.ts` | 4 enum members + one `scheduleGrants` block after `grants` | Low–medium (other slices add permissions to the same enum) — resolve by keeping both |
| `apps/backend/src/main.ts` | import + register `ProductionScheduleModule` | Low (one line in `imports`) |
| `apps/frontend/src/app/AppRoutes.tsx`, `routePaths.ts` | one route + path helper | Low |
| `apps/frontend/src/app/routes/ObjectRoute.tsx`, `WorkRoute.tsx` | a hook + 2 props each | Low–medium (WorkRoute is busy: PTO / documentation) |
| `apps/frontend/src/screens/O01/index.tsx`, `W01/index.tsx` | 2 optional props + one block each | Low–medium |
| `package.json` | one script `test:gpr-1-browser` | Low |

New files (no conflict): `packages/domain/schedule.ts`, `apps/backend/src/{schedule-service,schedule-scope,schedule-validation}.ts`,
`apps/backend/src/modules/schedule/*`, `infra/pending/gpr-1_production_schedule.sql`, `apps/frontend/src/{types/schedule.ts,data/scheduleApi.ts,
app/useSchedule.ts,app/routes/ScheduleRoute.tsx,view-models/schedule.ts,screens/GPR/*,screens/O01/ScheduleConclusion.*,screens/W01/ScheduleSection.*}`,
`tests/gpr-1-*`, `tests/helpers/gpr-fixtures.ts`, `playwright.gpr-1.config.ts`.

Deliberately **not** touched: `db.ts` (the `insert()` whitelist — explicit SQL is used instead), `types/api.ts`, `DataProvider` / the snapshot,
`docs/permissions.md`, the design-system, any numbered migration, anything of Bitrix Disk, PTO package lifecycle, ID-AUTO, or SDO.
No dependency on the current PTO corrective work and none on Bitrix Disk.

## Known divergences and deliberate deferrals

* **Per-work legacy status.** `works.planned_start/finish` + `scheduleStatus` (GREEN / YELLOW / RED by percentage-point thresholds,
  business rule 2) still drive the per-work badge on O01's work table, W01's header and C01. They are a coarse, work-level window and can
  disagree with the GPR (a zone five days late inside an on-track work). They were **not** changed: they are a real, per-work, confirmed
  figure other screens rely on, and changing it per viewer would make roles disagree. Recommended follow-up (coordinator): once a baseline is
  adopted, derive the per-work badge from the GPR roll-up (`aggregateScheduleStates`) and retire the legacy window.
* **C01 / company view** shows no schedule indicator yet (explicitly a later phase); the per-object conclusion is available per Object only.
* **Gantt / timeline** is not built (table first). The data (start, finish, sequence, follows) is what a timeline needs.
* **Portion-level / flow planning**, calendars (working days), resource levelling, CPM: not built; not needed to answer plan-vs-fact.
* **Approval by GENERAL_DIRECTOR**, multi-step approval and notifications: not built (one-line grant / later phase).
* **External participants** (contractor view of the schedule): `CONTRACTOR_VIEWER` has no access — the schedule carries cross-contractor
  planning and management delay reasons; an external view is a product decision.
* **Time zone:** "today" is the server's civil date (UTC unless the host says otherwise); `?asOf=` fixes a day for tests and what-ifs.

## Tests

| Suite | What it proves |
|---|---|
| `tests/gpr-1-schedule-domain.test.ts` (24) | Pure rules: civil dates, linear plan, states, whole-day delay (exact), conclusion, diff, approval rules, revision life, categories, authorization matrix |
| `tests/gpr-1-schedule-http.test.ts` (16) | Real backend (PGlite) via HTTP: authorization, PTO shell vs membership, object / production-domain tie, cross-object isolation, approval immutability (API **and** SQL), audit, plan-vs-fact with `asOf` through the real RP-fact route, no PTO / SDO / СК influence (+ source guard), partial progress, several portions, delay reasons + provenance, corrections, advisory predecessor, W01 summary, O01 conclusion, tenant isolation |
| `tests/gpr-1-schedule-postgres.test.ts` (8) | Native PostgreSQL (needs a server at `127.0.0.1:5432`): exact schema, guards for any writer, races (two drafts, simultaneous approvals, approval vs edit, duplicate scope, racing corrections) |
| `tests/gpr-1-unprovisioned.test.ts` (1) | A database without the migration: 503 with a clear message, the rest of the app untouched, then live after applying |
| `tests/gpr-1-viewmodel.test.ts` (13) | Frontend presentation: terminology, plan / fact / СК kept apart, O01 / W01 views, API guards, no PTO / money reach |
| `tests/gpr-1-browser/schedule.spec.ts` (7) | Real browser over the real backend: O01, the table (+ layout guards), W01, read-only roles and cross-object, narrow screens, recording a delay reason, a correction |

Run: `node --import tsx --test tests/gpr-1-*.test.ts`; browser: `npm run test:gpr-1-browser` (set `PLAYWRIGHT_CHROMIUM_PATH` if the default
Playwright browser is not installed).
