# GPR-2 R02 — one fact resolver, persisted source mode, honest known-at

Stage **R02a–R02c** of the GPR-2 Implementation Roadmap (P1, offline implementation). Base: `678e795f8802a76ac025f28b0d698351af8b7721`. Normative sources
(sha256, verified before work began): Technical Design `b80ba7315509b9a011b87a45957f7e9a3eaf802624c1ca241f7072fab8879368`, Roadmap
`a4c27d19a731b0d32a70c75a14af4f04c289ff93007d4ed78fe308a6ab434f76`. Decisions: C13, C15 (D19 for physical progress); scenarios A05, A24.

R02 changes **no business rule** of the protected F8.x / F12.x flows. It replaces seven private "latest fact" computations with one, makes the source of a
Work's actual quantity an explicit persisted fact instead of a side effect of creating an execution unit, and makes "what did the system know on T" answerable.

## What was wrong (baseline `678e795`)

| Defect | Where | Effect |
|---|---|---|
| "Has a unit ⇒ read portions" | `resolveActualQuantity()` used by `read-service.ts`, `service.ts transition()`, `schedule-scope.ts` | a Work with legacy actual 300 and one EMPTY execution unit reads **0** (C13) |
| Seven independent "latest" queries | `DISTINCT ON … recorded_at DESC` (documentation-scope, aosr-service, transition), `ORDER BY recorded_at DESC, created_at DESC` (schedule-scope), array order of `ORDER BY recorded_at` (read-service), `MAX()` group (customer SC ×3) | an exact tie is decided by heap/array order — different readers pick different rows (C15) |
| Ties and "when" | no sequence on confirmations, no known-at | a tie is silently resolved; "as of T" is a pseudo-snapshot |

## The contract

### Pure resolver — `packages/domain/gpr2/fact-resolver.ts`

* `resolveLatestConfirmation(rows, {knownAt})` — RP_FACT / INTERNAL_SC of **one** portion. Latest `recordedAt`; an exact tie is ordered by `sequence` (BigInt) when **every**
  tied row has one; a tie whose candidates agree on the quantity is `RESOLVED/EQUAL_QUANTITIES`; any other tie is `UNKNOWN_TIE` with the candidates listed. The answer
  never depends on the order the rows arrive in (tested over all permutations).
* `resolveCustomerScGroup(rows, {knownAt})` — CUSTOMER_SC keeps the F12.1 grouped semantics: the whole latest-timestamp group goes to `resolveCustomerScLatestGroup()` **unchanged**.
* `resolveWorkFact(evidence, {knownAt})` → `{ mode, modeProvenance, state, quantity, legacyQuantity, portionQuantity, unknownPortionIds }`.
  * **persisted mode** (`LEGACY_WORK` | `PORTION`) decides the source; `modeProvenance = PERSISTED`;
  * **unclassified** (`persistedMode === null`, every Work that exists today) is read from its evidence and flagged `DERIVED_UNCLASSIFIED`: no portion has a fact ⇒ the legacy
    figure (so an empty unit takes nothing away: **300 stays 300**, A05); portion facts and no legacy fact ⇒ portions (exactly the pre-R02 reading); both ⇒ the pre-R02 reading
    (portions) with `state = OVERLAP_UNRECONCILED` and the legacy figure still returned — **never summed, never hidden**;
  * `state ∈ KNOWN | NONE_REPORTED | UNKNOWN_TIE | HISTORY_UNAVAILABLE | OVERLAP_UNRECONCILED | NOT_YET_KNOWN`; `quantity` is `null` when it cannot be stated — never a guess;
  * a unit measured differently from the Work is never added in (F8.1-04, kept).
* `evaluatePortionFactModeTransition()` — the guarded edge (below). `resolveCompletionObservedAt()` — see known-at.

### SQL side — `apps/backend/src/fact-resolver.ts`

Fetches only. Instants leave PostgreSQL as canonical **microsecond** text (`to_char(… 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`) — a JS `Date` has milliseconds and could tie or reorder
instants PostgreSQL distinguishes. The latest group is selected **inside PostgreSQL** on the native `timestamptz` (`MAX(recorded_at)` + equality join), so a current-state read pulls
only the rows that can decide. `loadPortionFigures`, `loadWorkFacts`, `loadWorkEvidence`, `loadConfirmations` all take the caller's connection `c`.

Consumers now routed through it: `read-service.ts` (portion figures, customer-SC group, Work actual quantity), `service.ts` (`transition()` predecessor completeness and internal SC,
`requestPortionInspection` RP fact, `resolvePackageReadiness` customer-SC group), `schedule-scope.ts`, `documentation-scope.ts`, `aosr-service.ts`. A source-level test
(`gpr2-r02-single-resolver.test.ts`) fails if a private "latest" query or a call to `resolveActualQuantity()` reappears in the backend.

### Migration `026_gpr2_fact_source.sql` (class: additive)

| Change | Existing rows |
|---|---|
| `works.fact_source_mode text NULL`, CHECK `IN ('LEGACY_WORK','PORTION')` added `NOT VALID` then validated; **no default** | all stay `NULL` = never classified |
| `portion_quantity_confirmations.confirmation_seq bigint NULL` + sequence default + partial unique index | all stay `NULL` — **not back-filled**: numbering legacy rows would invent an order that cannot be proven |
| `work_fact_source_mode_history` (append-only, trigger-written) | new, empty |
| trigger `works_fact_source_mode_guard` | the only permitted change of the column is `LEGACY_WORK → PORTION` for a Work with `actual_quantity = 0` and no `work_progress` row; `NULL → x`, `PORTION → x`, `x → NULL` are refused |
| trigger `works_fact_source_mode_record` | writes the history row for every change (actor/basis from `gpr2.actor` / `gpr2.basis`), so no path can skip it |

No existing application code writes the column except the edge below. **Classifying real Works is R19**; this migration classifies nothing and cannot be made to by the application.

### The persisted mode in `recordPortionFact`

| Work | First/any portion fact |
|---|---|
| persisted `PORTION` | recorded |
| persisted `LEGACY_WORK`, legacy fact present | **refused** (`У работы есть факт, внесённый по работе в целом …`), no row written, mode unchanged |
| persisted `LEGACY_WORK`, no legacy fact | recorded; the Work goes to `PORTION` once; the trigger records it (race-tested: exactly one transition) |
| **unclassified (`NULL`)** | recorded **as before R02**; overlap with a legacy fact is reported as `OVERLAP_UNRECONCILED` |

Creating an execution unit, a layer or a portion is never a transition and never calls the verdict. The legacy `progress()` additionally refuses a persisted `PORTION` Work.

### Known-at / as-of (R02c)

* **KNOWN-AT** = what the system knew on T: rows are filtered by their immutable insertion instant `created_at`; ordering inside the visible rows uses `recorded_at`. A fact recorded
  "for" an earlier instant but learned later is **invisible in the past** (tested to the microsecond on real tables).
* **EFFECTIVE-AT** = what belongs to the execution date T. The tables carry no execution date (`recorded_at` is an insertion default identical to `created_at` for every writer), so the
  contract answers `EFFECTIVE_DATE_NOT_RECORDED` explicitly instead of passing known-at off as effective-at.
* A Work that did not exist on T is `NOT_YET_KNOWN`; a positive legacy figure with **no** progress history is `HISTORY_UNAVAILABLE` at any past T.
* `resolveCompletionObservedAt(evidence, target)` — the instant that **started the present uninterrupted run** at or above the target, `provenance = SYSTEM_RECORDED_CREATED_AT`
  (when the system learned of it, not a claim about when people finished). A run that cannot be traced to its start (legacy figure without history, unorderable tie) is `UNKNOWN`
  with a reason; "completed but date unknown" is therefore expressible (`COMPLETED_COMPLETION_DATE_UNKNOWN`, TD §8.3) — wiring it into the schedule projection is R13.

## Interpretations to confirm at acceptance

1. **Unclassified Works keep the pre-R02 recording behaviour.** The protected F8.1 / F12.1 / documentation suites record portion facts on seeded Works that carry legacy progress. A hard
   refusal there fails protected files (measured: `documentation-foundation`, `f12.1-customer-sc-zero-accept`, `f12.1-fact-freeze-customer-sc`, `f8.1-quantity-confirmation`) unless their fixtures are edited. R02 therefore enforces the strict gate on **persisted** modes only and reports the
   overlap on unclassified Works. This matches the Roadmap's own gate ("классификация реальных Work и любое включение нового source mode — только R19"). If the reviewer wants the gate on
   unclassified Works too, it is a one-line change in `evaluatePortionFactModeTransition()` plus new fixtures for those suites — a decision, not a defect fix.
2. **No column default.** A default would classify every future Work implicitly. R04/R15 (Work creation) set the mode explicitly.
3. **Read model.** *(Corrected by R02-001, see below; the first R02 candidate rendered an unknown figure as `0.0000`.)* `works[].actualQuantity` is `null` when the resolver cannot state a figure (`UNKNOWN_TIE`, `HISTORY_UNAVAILABLE`, `NOT_YET_KNOWN`), with `factState` and `factUnknown` saying so; a confirmed zero stays `"0.0000"`. Guards use `null` and fail closed.

## R02-001 — an unknown fact is not a confirmed zero (corrective)

Independent acceptance found that `ReadService.snapshot()` replaced the resolver's `null` by `"0.0000"`, so an unknown figure fed progress, the schedule status, the closing potential, the dependency blockers and the object / dashboard aggregates as a certain zero. Behaviour now, for a Work whose `actualQuantity` is `null`:

| Consumer | Output |
|---|---|
| Work | `actualQuantity: null`, `factState`, `factUnknown: true`, `actualProgress: null`, `variance: null` |
| Schedule status (dashboard `ScheduleStatusService`) | `GRAY`, `delayDays: 0`; `plannedProgress` (plan only) is still stated |
| Closing funnel | `financial = { physical: null, potential: null, buckets: null, closed, factUnknown: true }` — `closed` does not depend on the fact |
| Dependency | the successor is **blocked** with the reason «факт выполнения не определён (<state>) — следующий переход не разрешён» (it is not reported as «не завершена»; the write-side guard was already fail-closed) |
| Attention queue | one GRAY item «Факт выполнения не определён» (no delay item, no duplicate «Нет актуального факта», `moneyImpact: null`) |
| Object | `actualProgress: null`, `potential: null`, `unknownFactWorks: n`; the known part is shown beside: `actualProgressKnownPart`, `potentialKnownPart` (the latter stripped for `CONTRACTOR_VIEWER`) |
| Dashboard | `potentialClosing: null`, every `buckets` value `null`, `unknownFactWorks`, and `potentialClosingKnownPart` / `bucketsKnownPart` |

When no Work of the object / portfolio is unknown the aggregates are exactly what they were. A Work nobody has reported on keeps its previous reading (`"0.0000"`, GRAY); a confirmed zero is a real zero (RED when overdue, `potential "0.00"`). Frontend: `Work.actualQuantity` is `string | null`; `workExecutionState` has a fourth value `UNKNOWN` («Факт не определён») instead of constructing a `Decimal` from `null`; the existing formatters already print `—` for `null`.

**Not changed (limitation, needs a decision):** the GPR-1 schedule module (`packages/domain/schedule.ts`, `schedule-scope.ts`) has no «unknown» state — four management states only. A scope whose fact is unknown there is still read as «nothing reported» (for a PORTION Work) or from the legacy column (for a LEGACY_WORK Work with a tie), exactly as before R02-001; giving it a fifth state changes the GPR-1 contract, its frontend validation and the object conclusion, which is outside this corrective.
   New additive fields on every Work: `factState`, `factSourceMode`, `factSourceModeProvenance`.
4. **Ties.** An exact tie needs identical `recorded_at`, i.e. rows of one transaction (or legacy data). `confirmation_seq` orders rows of one transaction by statement order.
5. **Existing tests changed — six, all because they pinned the END of the migration chain** (any additive migration invalidates that, C17 numbers migrations from the real ledger): `gpr2-r01-traceability` (exactly 25 files → the baseline chain through 025 intact, later files gap-free); `gpr-1-schedule-postgres` A1 (`files.at(-1) === 025` → 025 directly follows 024; its pinned hash in `tests/helpers/gpr2-decision-index.ts` is updated deliberately, citing C17); `org1-company-structure-postgres` (`slice(17)` → `slice(17, 25)`); `pbx5a-bitrix-notifications-postgres` (exactly 1–25 → 1–25 intact and gap-free); `role-cleanup-migration-postgres` and `bitrix-disk-1-storage` (literal head `25` → number of numbered files). No business assertion was weakened; the first R02 candidate failed these five and the failing run is kept as evidence.

## Not done in R02 (by design)

No Work is classified; no legacy backfill; no schedule/K02 consumer of `completionObservedAt` (R13); no HTTP route for the as-of read (the functions are the contract; the R01 `/v2` register is
unchanged and still `501`). The scoped strict `TS2345` listed among the known limitations is **not touched and not claimed fixed** (`npm run typecheck:strict` printed no error in this
environment at baseline and after R02; that is an observation, not a fix).

## Evidence map

| Decision / scenario | Test |
|---|---|
| C13, A05 — empty unit keeps 300; unclassified and classified | `gpr2-r02-consumers` (A05 blocks), `gpr2-r02-fact-resolver` (R02b) |
| C13 — strict gate on a classified Work; trigger-written history; DB guard | `gpr2-r02-consumers` (C13 block, database guard block) |
| C13 under a real race | `gpr2-r02-fact-resolver-pg` (second test; native PostgreSQL) |
| C15, A24 — ties, sequence, agreeing tie, CUSTOMER_SC group, every reader agrees | `gpr2-r02-fact-resolver`, `gpr2-r02-consumers` (A24 block) |
| C15 — no second resolver | `gpr2-r02-single-resolver` |
| A24 — known-at, future-known fact invisible, completion provenance | `gpr2-r02-fact-resolver` (R02c), `gpr2-r02-consumers` (known-at block) |
| A25/A29-style — migration on 025-shaped data leaves protected rows byte-identical | `gpr2-r02-fact-resolver-pg` (first test; native PostgreSQL) |
| Protected F8.x / F12.x unchanged | the unmodified suites, run per file on the isolated cluster (see the P1-B package) |

Run (pure + PGlite): `node --import tsx --test tests/gpr2-r02-fact-resolver.test.ts tests/gpr2-r02-consumers.test.ts tests/gpr2-r02-single-resolver.test.ts`.
Native: `GPR2_ISOLATED_PG_URL=postgresql://…@127.0.0.1:<port>/postgres node --import tsx --test tests/gpr2-r02-fact-resolver-pg.test.ts` (refuses any server whose `cluster_name` is not `gpr2-p1-isolated`).
