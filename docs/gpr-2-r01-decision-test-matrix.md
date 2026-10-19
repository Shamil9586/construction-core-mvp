# GPR-2 R01 — decision-to-test matrix

Generated from `tests/helpers/gpr2-decision-index.ts` by `scripts/gpr2-r01-matrix.ts`; `tests/gpr2-r01-traceability.test.ts` fails if this file differs from the generator's output.

Base commit `48f3ce7e9c50b8bbaac67c6c3e4a7e0b94af7409`. Normative sources (NOT in this repository; sha256): Technical Design `b80ba7315509b9a011b87a45957f7e9a3eaf802624c1ca241f7072fab8879368`, Implementation Roadmap `a4c27d19a731b0d32a70c75a14af4f04c289ff93007d4ed78fe308a6ab434f76`.

**Status words describe R01 contract coverage only — never how much behaviour exists.** `CONTRACT_PINNED` — everything the Roadmap assigns to R01 for the decision (types, enums, transitions, errors, schemas, grants) is fixed and tested. `CONTRACT_PARTIAL` — R01 fixes only the part named under "R01 pins"; the rest belongs to the listed stages. `LATER_STAGE` — nothing for R01 to pin. **No row claims the decision is implemented** (TD §0: LOCKED → DESIGNED); "Accepted by" are the independent acceptance scenarios of TD §15 that will accept it, not results.

Coverage of the 46 decisions: 8 pinned · 31 partial · 7 later stage.

## Matrix

| ID | Decision | R01 contract coverage | R01 tests | Protected tests | Accepted by (every scenario, ranges expanded) | Stages |
|---|---|---|---:|---:|---|---|
| D01 | Work is the schedule unit: one identity, one entry, one bar | CONTRACT_PARTIAL | 6 | 0 | A01, A25 | R05, R11, R18, R19, R20, R21, R22 |
| D02 | BoQ staging, exact split before Work creation, retry-safe | CONTRACT_PARTIAL | 2 | 0 | A02, A20 | R15, R16, R17, R21 |
| D03 | Corporate classification + object tree + separate object finish registry | LATER_STAGE | 0 | 0 | A01, A03 | R05, R11, R18, R20, R21 |
| D04 | Original ledger, current approved quantity, nested allocations | CONTRACT_PARTIAL | 6 | 2 | A04, A05, A06 | R02, R03, R04, R06, R07, R19, R21 |
| D05 | One WorkType model: object creation, Admin publication | CONTRACT_PARTIAL | 6 | 0 | A03, A19 | R01, R03, R05, R07, R12, R15, R21 |
| D06 | Versioned finish template, stage occurrences, overrides, preview/confirm | CONTRACT_PARTIAL | 2 | 0 | A07 | R05, R07, R21 |
| D07 | Versioned working calendars, elapsed cure, backward planning with preview | CONTRACT_PARTIAL | 2 | 0 | A08, A09, A10 | R10, R14, R21 |
| D08 | Schedule edges separate from zonal release; explicit SC policy | CONTRACT_PARTIAL | 3 | 1 | A11, A23 | R08, R09, R21 |
| D09 | Early Work: nullable assignments and cost, eligibility instead of fake values | CONTRACT_PARTIAL | 2 | 0 | A12 | R04, R21 |
| D10 | One operative GPR-2; legacy archived or removed only by manifest | CONTRACT_PARTIAL | 2 | 1 | A25, A29 | R19, R20, R21, R22 |
| D11 | РП draft → submit → deputy approve / return; the old approved plan stays until replaced | CONTRACT_PINNED | 13 | 0 | A13, A19 | R01, R03, R07, R11, R12, R15, R20, R21 |
| D12 | Fixed Name / Start / End columns; drag and typed date are one command | CONTRACT_PARTIAL | 2 | 0 | A14 | R14, R18, R21 |
| D13 | One baseline projection for GPR / O01 / W01 / C01 / notifications | CONTRACT_PARTIAL | 8 | 0 | A15 | R13, R18, R21 |
| D14 | NO_APPROVED_GPR: no dates, no verdict | CONTRACT_PINNED | 2 | 0 | A16 | R13, R18, R21 |
| D15 | NOT_INCLUDED: independent production fact, no invented plan | CONTRACT_PINNED | 1 | 0 | A16 | R13, R18, R21 |
| D16 | Inclusion or exclusion with reason for every Work; scope fence at submit / approve | CONTRACT_PINNED | 7 | 0 | A13, A17 | R11, R12, R20, R21 |
| D17 | Quantity approval independent of schedule approval; baseline quantity snapshot | CONTRACT_PARTIAL | 3 | 0 | A04, A18 | R06, R07, R11, R13, R18, R21 |
| D18 | РП proposes a quantity; deputy approves or returns; PTO review is optional | CONTRACT_PINNED | 11 | 0 | A19 | R01, R03, R07, R12, R15, R21 |
| D19 | Progress by the current quantity; an exclusion is not a fact | CONTRACT_PARTIAL | 2 | 2 | A04, A05, A06, A23 | R02, R03, R04, R06, R07, R08, R09, R19, R21 |
| D20 | One surface change; stage effects atomic; local quantities independent | LATER_STAGE | 0 | 0 | A07 | R05, R07, R21 |
| D21 | A finish change never rewrites the source Work or its facts | CONTRACT_PARTIAL | 5 | 0 | A21, A22 | R09, R17, R18, R21 |
| D22 | Suitability is separate from RP / SC and recorded by the РП | CONTRACT_PINNED | 5 | 1 | A21, A23 | R08, R09, R17, R18, R21 |
| D23 | ResultUse: source ids, scope, quantity, basis; no copy, no double count | CONTRACT_PARTIAL | 3 | 1 | A21, A22 | R09, R17, R18, R21 |
| D24 | Reuse is shown as references in the expansion, never as a duplicate row | LATER_STAGE | 0 | 0 | A21 | R09, R17, R18, R21 |
| K01 | Batch estimate import → labor atoms → reviewed allocations → worker-labor KPI | CONTRACT_PARTIAL | 9 | 0 | A20, A26, A27, A28 | R15, R16, R17, R18, R21 |
| K02 | REBASELINE_REQUIRED withholds the verdict of the affected Work only | CONTRACT_PARTIAL | 2 | 0 | A18 | R11, R13, R18, R21 |
| K03 | The РП records an external suitability decision; no internal approval | CONTRACT_PINNED | 5 | 0 | A21, A22, A23 | R08, R09, R17, R18, R21 |
| K04 | Uniform working days, object timezone, elapsed curing, frozen calendars | CONTRACT_PARTIAL | 2 | 0 | A08, A09, A10 | R10, R14, R21 |
| C01 | Work-only schedule aggregate (no WEU-level items) | CONTRACT_PARTIAL | 2 | 0 | A01, A25 | R11, R20 |
| C02 | One active object finish registry; legacy mapping read-only | LATER_STAGE | 0 | 0 | A03, A25 | R05, R19 |
| C03 | Importer is not the BoQ parser; WorkType is not Admin-only | CONTRACT_PARTIAL | 2 | 0 | A02, A03, A26 | R05, R15, R16, R17 |
| C04 | Nullable early Work; one authoritative fact resolver | CONTRACT_PARTIAL | 2 | 0 | A12 | R02, R04 |
| C05 | Original / current ledger with hierarchical caps | CONTRACT_PARTIAL | 3 | 0 | A04, A05, A06 | R06, R07 |
| C06 | Shared surface change and local stage differences | LATER_STAGE | 0 | 0 | A07 | R05, R07 |
| C07 | Zone-scoped release and explicit SC policy | LATER_STAGE | 0 | 2 | A11, A23 | R08 |
| C08 | Baseline snapshot with quantity; quantity-only rebaseline | CONTRACT_PARTIAL | 2 | 0 | A18 | R11, R12, R13 |
| C09 | One ScheduleProjection API for every consumer | CONTRACT_PARTIAL | 3 | 0 | A15, A16 | R13, R18, R21 |
| C10 | Explicit grants, separate submit / return / approve, fresh authorization | CONTRACT_PINNED | 20 | 1 | A13, A19 | R01, R11, R12 |
| C11 | Omissions and the new-Work race: snapshot, reasons, scope token, recheck | CONTRACT_PARTIAL | 2 | 0 | A17 | R11, R12 |
| C12 | Reuse without copying evidence | CONTRACT_PARTIAL | 2 | 1 | A21, A22, A23 | R09 |
| C13 | Persisted source mode; the first WEU must not turn 300 into 0 | CONTRACT_PARTIAL | 2 | 2 | A05, A25 | R02, R04, R19 |
| C14 | Calendar engine, edge set, backplan, Gantt | CONTRACT_PARTIAL | 2 | 0 | A08, A09, A10, A14 | R10, R14, R18 |
| C15 | One RP / INTERNAL_SC resolver with deterministic ties; known-at vs effective-at | LATER_STAGE | 0 | 1 | A24 | R02 |
| C16 | Consistent snapshots, optimistic versions and revalidation under lock | CONTRACT_PARTIAL | 16 | 1 | A06, A17, A30 | R03, R07, R12 |
| C17 | Unknown LIVE, version-only runner, migrations on boot | CONTRACT_PARTIAL | 2 | 1 | A25, A29 | R00, R03, R19, R20, R21, R22 |
| C18 | Decision-to-test matrix; replace only cancelled expectations; keep protected suites | CONTRACT_PARTIAL | 7 | 0 | A01, A02, A03, A04, A05, A06, A07, A08, A09, A10, A11, A12, A13, A14, A15, A16, A17, A18, A19, A20, A21, A22, A23, A24, A25, A26, A27, A28, A29, A30 | R00, R01, R02, R03, R04, R05, R06, R07, R08, R09, R10, R11, R12, R13, R14, R15, R16, R17, R18, R19, R20, R21, R22 |

## Per decision

### D01 — Work is the schedule unit: one identity, one entry, one bar

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** §4–5, §10; A01, A25
- **Accepted by (A-scenarios, expanded):** A01, A25 · **Stages:** R05, R11, R18, R19, R20, R21, R22
- **R01 pins:** The change-set entry has no execution-unit/WEU/portion field and sending one is an error; one entry per Work in the draft payload; its dates are real calendar days, checked by arithmetic (an impossible date is a 422 DATE_MALFORMED, never a 500). Schema, uniqueness constraint and Gantt are R11/R18.
- **R01 tests:** `gpr2-r01-contracts` › D01/C01: a GPR entry is one Work<br>`gpr2-r01-http` › contract violations over HTTP<br>`gpr2-r01-openapi` › D01/D08/D16/K03 in the document<br>`gpr2-r01-corrective-domain` › R01-B01: the reviewer<br>`gpr2-r01-corrective-domain` › R01-B01: malformed shapes<br>`gpr2-r01-corrective-http` › R01-B01 (HTTP)
- **Protected (existing) tests:** —

### D02 — BoQ staging, exact split before Work creation, retry-safe

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** §7; A02, A20
- **Accepted by (A-scenarios, expanded):** A02, A20 · **Stages:** R15, R16, R17, R21
- **R01 pins:** Exact-sum rule for a split (1000 = 700 + 300, no tolerance) in decimal strings; the import-batch STATES (TD §7.3) are fixed (edges are left to R15); BoQ upload / allocations / commit commands, Idempotency-Key and scope fence declared in the register.
- **R01 tests:** `gpr2-r01-decimal` › D02/D04: a split or an allocation must add up<br>`gpr2-r01-lifecycle` › the lifecycle catalogue is exactly the six
- **Protected (existing) tests:** —

### D03 — Corporate classification + object tree + separate object finish registry

- **R01 contract coverage:** LATER_STAGE · **TD:** §4–5; A01, A03
- **Accepted by (A-scenarios, expanded):** A01, A03 · **Stages:** R05, R11, R18, R20, R21
- **R01 pins:** No contract in TD §11 beyond the object-adaptation grant (see D05). Registry, mapping and area scopes are R05.
- **R01 tests:** —
- **Protected (existing) tests:** —

### D04 — Original ledger, current approved quantity, nested allocations

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** §5–6; A04–A06
- **Accepted by (A-scenarios, expanded):** A04, A05, A06 · **Stages:** R02, R03, R04, R06, R07, R19, R21
- **R01 pins:** Original / current / baseline / RP-fact are four different fields; an unproven original is UNKNOWN_LEGACY = null (never 0, never the current figure); NULL ≠ 0; decimals are exact strings; BELOW_PROTECTED_QUANTITY exists as a 422 code. Tables, caps and the protected floor are R06/R07.
- **R01 tests:** `gpr2-r01-contracts` › D04/D19, §6.3 case 1<br>`gpr2-r01-contracts` › D04/C05: an unproven original<br>`gpr2-r01-contracts` › NULL vs 0 in the quantities<br>`gpr2-r01-decimal` › NULL is not zero<br>`gpr2-r01-decimal` › D02/D04: a split<br>`gpr2-r01-versions-errors` › error contract: the status table
- **Protected (existing) tests:** `f12.1-customer-sc-zero-accept` › F12-QTY-03: Customer SC ACCEPT with an explicit quantity of 0 is refused<br>`f12-final-corrective-postgres-concurrency` › FINAL-R01 (HTTP): N genuinely concurrent createExecutionUnit

### D05 — One WorkType model: object creation, Admin publication

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** §5, §11; A03, A19
- **Accepted by (A-scenarios, expanded):** A03, A19 · **Stages:** R01, R03, R05, R07, R12, R15, R21
- **R01 pins:** Publication request lifecycle PENDING → APPROVED | REJECTED (reject needs a reason); the Admin holds the one explicit publication grant, the РП may only propose; object-adaptation grant for the РП. The single WorkType table, alias and "rejection keeps the object type" postcondition are R05a.
- **R01 tests:** `gpr2-r01-lifecycle` › WORK_TYPE_PUBLICATION_REQUEST: the allowed transitions<br>`gpr2-r01-permissions` › "no new Admin business grants"<br>`gpr2-r01-permissions` › no automatic new-grants-from-enum<br>`gpr2-r01-http` › "no new Admin business grants": ADMIN is refused<br>`gpr2-r01-permissions` › A19 (domain): the §11.3 role matrix<br>`gpr2-r01-http` › A19 (HTTP): the whole role matrix
- **Protected (existing) tests:** —

### D06 — Versioned finish template, stage occurrences, overrides, preview/confirm

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** §5, §10; A07
- **Accepted by (A-scenarios, expanded):** A07 · **Stages:** R05, R07, R21
- **R01 pins:** finish-system preview is pure (no Idempotency-Key, no write); confirm is idempotent, versioned and scope-fenced (Work generation). Template tables and occurrences are R05c/R05d.
- **R01 tests:** `gpr2-r01-contracts` › every command states how it is guarded<br>`gpr2-r01-contracts` › D16/C11/C16: exactly the scope-sensitive commands
- **Protected (existing) tests:** —

### D07 — Versioned working calendars, elapsed cure, backward planning with preview

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** §8; A08–A10
- **Accepted by (A-scenarios, expanded):** A08, A09, A10 · **Stages:** R10, R14, R21
- **R01 pins:** Lag units are two distinct kinds (WORKING_DAYS vs ELAPSED_HOURS) and a lag value is a decimal string; calendar create/patch commands are РП grants; backplan-preview is pure. The calendar engine is R10, DAG/backplan R14.
- **R01 tests:** `gpr2-r01-contracts` › D08: dependency types are FS / SS / FF<br>`gpr2-r01-contracts` › every command states how it is guarded
- **Protected (existing) tests:** —

### D08 — Schedule edges separate from zonal release; explicit SC policy

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** §9; A11, A23
- **Accepted by (A-scenarios, expanded):** A11, A23 · **Stages:** R08, R09, R21
- **R01 pins:** Edge types are FS / SS / FF; SF is refused explicitly with UNSUPPORTED_DEPENDENCY_TYPE; a Work cannot depend on itself. Zonal release and the SC policy are R08.
- **R01 tests:** `gpr2-r01-contracts` › D08: dependency types are FS / SS / FF<br>`gpr2-r01-http` › contract violations over HTTP<br>`gpr2-r01-openapi` › D01/D08/D16/K03 in the document
- **Protected (existing) tests:** `f8.1-final-corrective-patch` › F8.1 Final: 500 planned / 500 RP fact / 100 Internal SC confirmed

### D09 — Early Work: nullable assignments and cost, eligibility instead of fake values

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** §5, §9; A12
- **Accepted by (A-scenarios, expanded):** A12 · **Stages:** R04, R21
- **R01 pins:** null is never serialised as 0 (unknown cost cannot become 0); Work create / assignments are catalogued under the EXISTING rules, R01 widens nothing. Nullable columns and eligibility are R04.
- **R01 tests:** `gpr2-r01-decimal` › NULL is not zero<br>`gpr2-r01-contracts` › the guarded surface
- **Protected (existing) tests:** —

### D10 — One operative GPR-2; legacy archived or removed only by manifest

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** §13; A25, A29
- **Accepted by (A-scenarios, expanded):** A25, A29 · **Stages:** R19, R20, R21, R22
- **R01 pins:** R01 changes nothing in the legacy contour: the /v2 surface is off unless GPR2_CONTRACT_ROUTES=enabled, GPR-1 routes and error bodies are untouched, no migration is added (the chain still ends at 025), the register has no delete/drop command, an approved revision can only be superseded.
- **R01 tests:** `gpr2-r01-flag-off` › flag absent<br>`gpr2-r01-lifecycle` › D11: a returned revision is final
- **Protected (existing) tests:** `gpr-1-schedule-postgres` › A1 fresh native chain

### D11 — РП draft → submit → deputy approve / return; the old approved plan stays until replaced

- **R01 contract coverage:** CONTRACT_PINNED · **TD:** §8, §11; A13, A19
- **Accepted by (A-scenarios, expanded):** A13, A19 · **Stages:** R01, R03, R07, R11, R12, R15, R20, R21
- **R01 pins:** GPR_REVISION lifecycle (submit / discard / approve / return / supersede) with positive and exhaustive negative tests; explicit grants (РП: SCHEDULE_AUTHOR, deputy: SCHEDULE_REVIEW); return needs a reason; approval needs a different person; approval carries its mandatory fence (input fingerprint + at least one expected source version); HTTP role matrix; changed-role replay; the aggregate behind the {id} is verified before replay. Behaviour behind the gate is R11/R12.
- **R01 tests:** `gpr2-r01-lifecycle` › GPR_REVISION: the allowed transitions<br>`gpr2-r01-lifecycle` › GPR_REVISION: every other<br>`gpr2-r01-lifecycle` › D11: a returned revision is final<br>`gpr2-r01-lifecycle` › A19 (separation)<br>`gpr2-r01-permissions` › C10/D11<br>`gpr2-r01-http` › C10/D11<br>`gpr2-r01-http` › A19 changed-role replay<br>`gpr2-r01-openapi` › every command that performs a lifecycle transition<br>`gpr2-r01-corrective-http` › R01-B04: the order<br>`gpr2-r01-corrective-http` › R01-B04: authorization before replay covers the aggregate too<br>`gpr2-r01-corrective-openapi` › R01-B05: schedule.revision.submit in the served document<br>`gpr2-r01-permissions` › A19 (domain): the §11.3 role matrix<br>`gpr2-r01-http` › A19 (HTTP): the whole role matrix
- **Protected (existing) tests:** —

### D12 — Fixed Name / Start / End columns; drag and typed date are one command

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** §10; A14
- **Accepted by (A-scenarios, expanded):** A14 · **Stages:** R14, R18, R21
- **R01 pins:** The register has ONE change-set command pair (changes/preview → changes/apply) and no drag-specific route; an apply names the exact preview it confirms. The UI is R18.
- **R01 tests:** `gpr2-r01-contracts` › §11.2: the register is the design<br>`gpr2-r01-contracts` › A10: an apply names the exact preview
- **Protected (existing) tests:** —

### D13 — One baseline projection for GPR / O01 / W01 / C01 / notifications

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** §8, §10; A15
- **Accepted by (A-scenarios, expanded):** A15 · **Stages:** R13, R18, R21
- **R01 pins:** ScheduleProjection shape, the eleven states in §8.4 priority order, the categorical verdicts, the nullability invariants per state, the identity a comparison needs (approved baseline revision, calendar version, timezone, evaluation date, operative dates, positive baseline quantity), verdict ↔ lag ↔ gap coherence, and the source-version metadata of TD §5.1/§10.3/§12.2. The calculation, the service and every consumer switching to it are R13/R18/R21.
- **R01 tests:** `gpr2-r01-contracts` › §8.4 priority order<br>`gpr2-r01-contracts` › D14: no approved GPR<br>`gpr2-r01-contracts` › K02: REBASELINE_REQUIRED<br>`gpr2-r01-corrective-projection` › R01-B07 negative case 1<br>`gpr2-r01-corrective-projection` › R01-B07 positives<br>`gpr2-r01-corrective-projection` › R01-B07: verdict, lag and gap agree<br>`gpr2-r01-corrective-projection` › R01-B07: identity and format<br>`gpr2-r01-corrective-projection` › R01-B07: every projection carries
- **Protected (existing) tests:** —

### D14 — NO_APPROVED_GPR: no dates, no verdict

- **R01 contract coverage:** CONTRACT_PINNED · **TD:** §8; A16
- **Accepted by (A-scenarios, expanded):** A16 · **Stages:** R13, R18, R21
- **R01 pins:** A NO_APPROVED_GPR projection must carry no baseline, dates, quantity, gap, lag or verdict; a lag of 0 is still a lag (null ≠ 0); and no state that compares with a baseline (ON_PLAN, BEHIND, COMPLETED_*) is valid without an approved baseline. Computing the state is R13.
- **R01 tests:** `gpr2-r01-contracts` › D14: no approved GPR<br>`gpr2-r01-corrective-projection` › R01-B07 negative case 1
- **Protected (existing) tests:** —

### D15 — NOT_INCLUDED: independent production fact, no invented plan

- **R01 contract coverage:** CONTRACT_PINNED · **TD:** §8–9; A16
- **Accepted by (A-scenarios, expanded):** A16 · **Stages:** R13, R18, R21
- **R01 pins:** A NOT_INCLUDED projection has an approved revision but no operative dates, quantity, gap, lag or verdict for this Work.
- **R01 tests:** `gpr2-r01-contracts` › D15: a Work outside the approved GPR
- **Protected (existing) tests:** —

### D16 — Inclusion or exclusion with reason for every Work; scope fence at submit / approve

- **R01 contract coverage:** CONTRACT_PINNED · **TD:** §8, §12; A13, A17
- **Accepted by (A-scenarios, expanded):** A13, A17 · **Stages:** R11, R12, R20, R21
- **R01 pins:** An omission is INCLUDED or EXCLUDED and EXCLUDED always has a reason; exactly the scope-sensitive commands carry expectedScopeVersion (schedule submit / approve, quantity create / submit / approve, finish-system confirm, BoQ commit); a changed scope is a 409 of its own. The fence under lock is R12.
- **R01 tests:** `gpr2-r01-contracts` › D16/C11: every Work is included or excluded<br>`gpr2-r01-contracts` › D16/C11/C16: exactly the scope-sensitive commands<br>`gpr2-r01-versions-errors` › C16/D16: stale aggregate version<br>`gpr2-r01-http` › contract violations over HTTP<br>`gpr2-r01-openapi` › Idempotency-Key and the version tokens appear exactly where the register says<br>`gpr2-r01-corrective-domain` › R01-B03: a well-formed fence passes<br>`gpr2-r01-corrective-openapi` › R01-B05: for every mounted command
- **Protected (existing) tests:** —

### D17 — Quantity approval independent of schedule approval; baseline quantity snapshot

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** §6, §8; A04, A18
- **Accepted by (A-scenarios, expanded):** A04, A18 · **Stages:** R06, R07, R11, R13, R18, R21
- **R01 pins:** Quantity authoring / review are separate grants and a separate lifecycle from the schedule; baselineQuantity is its own projection field (never the current quantity). The immutable snapshot table is R11, invalidation R13.
- **R01 tests:** `gpr2-r01-lifecycle` › QUANTITY_CHANGE_REQUEST: the allowed transitions<br>`gpr2-r01-permissions` › A19 (domain): the §11.3 role matrix<br>`gpr2-r01-contracts` › D04/D19, §6.3 case 1
- **Protected (existing) tests:** —

### D18 — РП proposes a quantity; deputy approves or returns; PTO review is optional

- **R01 contract coverage:** CONTRACT_PINNED · **TD:** §6, §11; A19
- **Accepted by (A-scenarios, expanded):** A19 · **Stages:** R01, R03, R07, R12, R15, R21
- **R01 pins:** QUANTITY_AUTHOR (РП) / QUANTITY_REVIEW (deputy); QUANTITY_CHANGE_REQUEST lifecycle with a reason on return, a separate approver, ONE editing command that is an in-place edit in DRAFT and the correction RETURNED → DRAFT (a new submission version; past versions and decisions stay immutable) and is refused in SUBMITTED / APPROVED, and an approval that carries its mandatory fence; the PTO review note is a separate non-approving command held by NOBODY by default (see risks: "if allowed" is not defined by the design).
- **R01 tests:** `gpr2-r01-lifecycle` › QUANTITY_CHANGE_REQUEST: the allowed transitions<br>`gpr2-r01-lifecycle` › QUANTITY_CHANGE_REQUEST: every other<br>`gpr2-r01-lifecycle` › A19 (separation)<br>`gpr2-r01-lifecycle` › R01-B02: PATCH quantity-change-requests/{id} is expressible<br>`gpr2-r01-lifecycle` › R01-B02: state × operation matrix<br>`gpr2-r01-lifecycle` › R01-B02: the role that may edit a draft<br>`gpr2-r01-corrective-http` › R01-B02 (HTTP)<br>`gpr2-r01-corrective-http` › R01-B03 (HTTP): approve / commit without the common fence<br>`gpr2-r01-http` › N01 default-deny over HTTP<br>`gpr2-r01-permissions` › A19 (domain): the §11.3 role matrix<br>`gpr2-r01-http` › A19 (HTTP): the whole role matrix
- **Protected (existing) tests:** —

### D19 — Progress by the current quantity; an exclusion is not a fact

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** §6; A04–A06, A23
- **Accepted by (A-scenarios, expanded):** A04, A05, A06, A23 · **Stages:** R02, R03, R04, R06, R07, R08, R09, R19, R21
- **R01 pins:** excludedQuantity / addedQuantity are separate from rpFactQuantity; a fact above current is INTEGRITY_CONFLICT, never clamped; current = 0 is NOT_APPLICABLE, never 100 %; remaining is exact and null when the data is not valid. Percent computation is R06.
- **R01 tests:** `gpr2-r01-contracts` › D04/D19, §6.3 case 1<br>`gpr2-r01-contracts` › §6.1: a fact above the current task
- **Protected (existing) tests:** `f12.1-fact-freeze-customer-sc` › F12-QTY-04: Customer SC presentation freezes RP Fact too<br>`f12-final-r06-auth-safe-idempotency` › FINAL-R06: an idempotency-key replay never bypasses the authorization

### D20 — One surface change; stage effects atomic; local quantities independent

- **R01 contract coverage:** LATER_STAGE · **TD:** §5–6; A07
- **Accepted by (A-scenarios, expanded):** A07 · **Stages:** R05, R07, R21
- **R01 pins:** The design fixes no payload or error contract for surface changes beyond the quantity request lifecycle (D17/D18); R07c owns the atomic batch.
- **R01 tests:** —
- **Protected (existing) tests:** —

### D21 — A finish change never rewrites the source Work or its facts

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** §9; A21–A22
- **Accepted by (A-scenarios, expanded):** A21, A22 · **Stages:** R09, R17, R18, R21
- **R01 pins:** The external-outcome record is append-only: its only transition is a correction that supersedes it (with a reason); there is no edit / delete command, and no generic PATCH of a Work's quantity, fact or suitability exists.
- **R01 tests:** `gpr2-r01-lifecycle` › FINISH_CHANGE_RECORD: the allowed transitions<br>`gpr2-r01-lifecycle` › K03/D22/D23<br>`gpr2-r01-contracts` › §11.2 closing note<br>`gpr2-r01-corrective-domain` › R01-B03: finish-change.record-correction requires a reason<br>`gpr2-r01-corrective-http` › R01-B03 (HTTP): finish-change.record-correction requires a reason
- **Protected (existing) tests:** —

### D22 — Suitability is separate from RP / SC and recorded by the РП

- **R01 contract coverage:** CONTRACT_PINNED · **TD:** §9; A21, A23
- **Accepted by (A-scenarios, expanded):** A21, A23 · **Stages:** R08, R09, R17, R18, R21
- **R01 pins:** Only the РП holds the record grant; no lifecycle, command, route or permission speaks of approving suitability; the deputy and ADMIN cannot record. Persistence of outcomes is R09.
- **R01 tests:** `gpr2-r01-lifecycle` › K03/D22/D23<br>`gpr2-r01-contracts` › §11.2 closing note<br>`gpr2-r01-contracts` › A19 (register)<br>`gpr2-r01-http` › A19 (HTTP): the whole role matrix<br>`gpr2-r01-openapi` › D01/D08/D16/K03 in the document
- **Protected (existing) tests:** `f12.1-customer-sc-zero-accept` › F12-QTY-03: Customer SC ACCEPT with an explicit quantity of 0 is refused

### D23 — ResultUse: source ids, scope, quantity, basis; no copy, no double count

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** §5, §9; A21–A22
- **Accepted by (A-scenarios, expanded):** A21, A22 · **Stages:** R09, R17, R18, R21
- **R01 pins:** ResultUse lifecycle REGISTERED → SUPERSEDED | RETRACTED, each with a reason, with no APPROVED / REJECTED state and no command that could create one. Links, slices and conservation guards are R09b.
- **R01 tests:** `gpr2-r01-lifecycle` › RESULT_USE: the allowed transitions<br>`gpr2-r01-lifecycle` › RESULT_USE: every other<br>`gpr2-r01-lifecycle` › K03/D22/D23
- **Protected (existing) tests:** `f12-final-corrective-postgres-concurrency` › FINAL-R03: two concurrent first-uses of one unattached ordinary attachment

### D24 — Reuse is shown as references in the expansion, never as a duplicate row

- **R01 contract coverage:** LATER_STAGE · **TD:** §10; A21
- **Accepted by (A-scenarios, expanded):** A21 · **Stages:** R09, R17, R18, R21
- **R01 pins:** A UI decision (R18). R01 contributes only that the register has no reuse-as-Work route.
- **R01 tests:** —
- **Protected (existing) tests:** —

### K01 — Batch estimate import → labor atoms → reviewed allocations → worker-labor KPI

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** §7; A20, A26, A28
- **Accepted by (A-scenarios, expanded):** A20, A26, A27, A28 · **Stages:** R15, R16, R17, R18, R21
- **R01 pins:** The general physical percent exists only for COMPLETE coverage with a positive worker denominator AND a known numerator (every other state: null, never 0 or 100; an unknown earned total is not 0 and not 100 %); a zero denominator is ZERO_WORKER_DENOMINATOR, never COMPLETE; nine coverage states; the commit carries the common approve/commit fence; N01 review capability is default-deny and object-scoped; estimate commit cannot bypass the review. Parsers and mappings are R16/R17.
- **R01 tests:** `gpr2-r01-contracts` › K01/§7.6<br>`gpr2-r01-corrective-projection` › R01-B07 negative case 2<br>`gpr2-r01-corrective-projection` › R01-B07 negative case 3<br>`gpr2-r01-corrective-projection` › R01-B07: the labor percent is bounded<br>`gpr2-r01-corrective-domain` › R01-B03: approve / commit without the common fence<br>`gpr2-r01-permissions` › N01: ESTIMATE_MAPPING_REVIEW is default-deny<br>`gpr2-r01-permissions` › N01: an assignment grants the capability only<br>`gpr2-r01-http` › N01 default-deny over HTTP<br>`gpr2-r01-guard-order` › N01: the capability is never implied
- **Protected (existing) tests:** —

### K02 — REBASELINE_REQUIRED withholds the verdict of the affected Work only

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** §6, §8; A18
- **Accepted by (A-scenarios, expanded):** A18 · **Stages:** R11, R13, R18, R21
- **R01 pins:** A REBASELINE_REQUIRED projection keeps the previous baseline dates and quantity visible and carries no verdict and no current lag. Invalidation events and clearing by a new approved revision are R13.
- **R01 tests:** `gpr2-r01-contracts` › K02: REBASELINE_REQUIRED<br>`gpr2-r01-corrective-projection` › R01-B07 positives
- **Protected (existing) tests:** —

### K03 — The РП records an external suitability decision; no internal approval

- **R01 contract coverage:** CONTRACT_PINNED · **TD:** §9, §11; A21–A23
- **Accepted by (A-scenarios, expanded):** A21, A22, A23 · **Stages:** R08, R09, R17, R18, R21
- **R01 pins:** As D22: no approve-suitability route, permission or state; record-external-outcome and record-correction are РП-only commands; a correction supersedes, it does not edit.
- **R01 tests:** `gpr2-r01-lifecycle` › K03/D22/D23<br>`gpr2-r01-lifecycle` › FINISH_CHANGE_RECORD: every other<br>`gpr2-r01-contracts` › A19 (register)<br>`gpr2-r01-http` › A19 (HTTP): the whole role matrix<br>`gpr2-r01-openapi` › D01/D08/D16/K03 in the document
- **Protected (existing) tests:** —

### K04 — Uniform working days, object timezone, elapsed curing, frozen calendars

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** §8; A08–A10
- **Accepted by (A-scenarios, expanded):** A08, A09, A10 · **Stages:** R10, R14, R21
- **R01 pins:** A projection names its calendar version, the object timezone and the last fully completed local day; lag kinds separate working days from elapsed hours. The engine, DST and cut-off arithmetic are R10.
- **R01 tests:** `gpr2-r01-contracts` › §8.4 priority order<br>`gpr2-r01-contracts` › D08: dependency types
- **Protected (existing) tests:** —

### C01 — Work-only schedule aggregate (no WEU-level items)

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** R11, R20; A01, A25
- **Accepted by (A-scenarios, expanded):** A01, A25 · **Stages:** R11, R20
- **R01 pins:** The change-set entry has no execution-unit field and sending one is an error (the D01 contract); the schema, the uniqueness constraint and the Gantt are R11 / R18.
- **R01 tests:** `gpr2-r01-contracts` › D01/C01: a GPR entry is one Work<br>`gpr2-r01-corrective-domain` › R01-B01: calendar arithmetic
- **Protected (existing) tests:** —

### C02 — One active object finish registry; legacy mapping read-only

- **R01 contract coverage:** LATER_STAGE · **TD:** R05, R19; A03, A25
- **Accepted by (A-scenarios, expanded):** A03, A25 · **Stages:** R05, R19
- **R01 pins:** No R01 contract.
- **R01 tests:** —
- **Protected (existing) tests:** —

### C03 — Importer is not the BoQ parser; WorkType is not Admin-only

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** R05, R15–R17; A02, A03, A26
- **Accepted by (A-scenarios, expanded):** A02, A03, A26 · **Stages:** R05, R15, R16, R17
- **R01 pins:** BoQ and estimate-labor are separate commands with their own stages and a shared РП import grant; WorkType object creation is the РП's, publication the Admin's.
- **R01 tests:** `gpr2-r01-contracts` › A19 (register)<br>`gpr2-r01-lifecycle` › WORK_TYPE_PUBLICATION_REQUEST: the allowed transitions
- **Protected (existing) tests:** —

### C04 — Nullable early Work; one authoritative fact resolver

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** R02, R04; A12
- **Accepted by (A-scenarios, expanded):** A12 · **Stages:** R02, R04
- **R01 pins:** NULL ≠ 0 in every decimal and projection contract. Resolver is R02, nullable columns R04.
- **R01 tests:** `gpr2-r01-decimal` › NULL is not zero<br>`gpr2-r01-contracts` › NULL vs 0 in the quantities
- **Protected (existing) tests:** —

### C05 — Original / current ledger with hierarchical caps

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** R06–R07; A04, A06
- **Accepted by (A-scenarios, expanded):** A04, A05, A06 · **Stages:** R06, R07
- **R01 pins:** Original / current / baseline / fact are separate fields; an unproven original is UNKNOWN_LEGACY = null; decimals are exact strings; BELOW_PROTECTED_QUANTITY exists as a 422 code (the D04 contract). The ledger tables and caps are R06 / R07.
- **R01 tests:** `gpr2-r01-contracts` › D04/C05: an unproven original<br>`gpr2-r01-decimal` › D02/D04: a split<br>`gpr2-r01-versions-errors` › error contract: the status table
- **Protected (existing) tests:** —

### C06 — Shared surface change and local stage differences

- **R01 contract coverage:** LATER_STAGE · **TD:** R05, R07; A07
- **Accepted by (A-scenarios, expanded):** A07 · **Stages:** R05, R07
- **R01 pins:** Like D20: the design fixes no contract for surface changes beyond the quantity request lifecycle; R07c owns the atomic batch.
- **R01 tests:** —
- **Protected (existing) tests:** —

### C07 — Zone-scoped release and explicit SC policy

- **R01 contract coverage:** LATER_STAGE · **TD:** R08; A11, A23
- **Accepted by (A-scenarios, expanded):** A11, A23 · **Stages:** R08
- **R01 pins:** No R01 contract.
- **R01 tests:** —
- **Protected (existing) tests:** `f12.1-customer-sc-zero-accept` › F12-QTY-03: Customer SC ACCEPT with an explicit quantity of 0 is refused<br>`f8.1-final-corrective-patch` › F8.1 Final: 500 planned / 500 RP fact / 100 Internal SC confirmed

### C08 — Baseline snapshot with quantity; quantity-only rebaseline

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** R11–R13; A18
- **Accepted by (A-scenarios, expanded):** A18 · **Stages:** R11, R12, R13
- **R01 pins:** baselineQuantity is a separate projection field; REBASELINE_REQUIRED contract (K02); a quantity-only change is a change-set like any other.
- **R01 tests:** `gpr2-r01-contracts` › K02: REBASELINE_REQUIRED<br>`gpr2-r01-contracts` › D04/D19, §6.3 case 1
- **Protected (existing) tests:** —

### C09 — One ScheduleProjection API for every consumer

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** R13, R18, R21; A15, A16
- **Accepted by (A-scenarios, expanded):** A15, A16 · **Stages:** R13, R18, R21
- **R01 pins:** ScheduleProjection shape, the state priority order and the per-state nullability invariants (the D13 contract); the consumers switch in R13 / R18 / R21.
- **R01 tests:** `gpr2-r01-contracts` › §8.4 priority order<br>`gpr2-r01-contracts` › D14: no approved GPR<br>`gpr2-r01-contracts` › D15: a Work outside the approved GPR
- **Protected (existing) tests:** —

### C10 — Explicit grants, separate submit / return / approve, fresh authorization

- **R01 contract coverage:** CONTRACT_PINNED · **TD:** R01, R11–R12; A13, A19
- **Accepted by (A-scenarios, expanded):** A13, A19 · **Stages:** R01, R11, R12
- **R01 pins:** Nine explicit GPR-2 permissions outside the Object.values(Permission) surface; ADMIN holds one (publication) and no business grant; separate commands for submit / return / approve; role re-read on every request; the pipeline order authenticate → permission → object scope → nested-resource ownership preflight (tenant-level requests included; default deny until a stage supplies a verified owner lookup) → envelope → replay → execute; legacy grants unchanged.
- **R01 tests:** `gpr2-r01-permissions` › A19 (domain): the §11.3 role matrix<br>`gpr2-r01-http` › A19 (HTTP): the whole role matrix<br>`gpr2-r01-permissions` › "no new Admin business grants"<br>`gpr2-r01-permissions` › no automatic new-grants-from-enum<br>`gpr2-r01-http` › "no new Admin business grants": ADMIN is refused<br>`gpr2-r01-permissions` › unchanged legacy grants<br>`gpr2-r01-permissions` › every role has an explicit row<br>`gpr2-r01-http` › A19 changed-role replay<br>`gpr2-r01-http` › the order is permission → scope → envelope<br>`gpr2-r01-guard-order` › an unauthorised caller reaches NEITHER hook<br>`gpr2-r01-guard-order` › R01-B04 wiring<br>`gpr2-r01-http` › cross-tenant<br>`gpr2-r01-http` › the Idempotency-Key is not an access token<br>`gpr2-r01-corrective-http` › R01-B04: a well-formed id that is MISSING<br>`gpr2-r01-corrective-http` › R01-B04: tenant-level corporate publication<br>`gpr2-r01-corrective-http` › R01-B04: the order<br>`gpr2-r01-corrective-http` › R01-B04: with the PRODUCTION default hooks<br>`gpr2-r01-corrective-http` › R01-B04: a resolver that throws<br>`gpr2-r01-corrective-domain` › R01-B04: ownershipPermits is strict<br>`gpr2-r01-corrective-domain` › R01-B04: every {id} in the register
- **Protected (existing) tests:** `pbx2-department-head-roles` › grant parity: each head role has EXACTLY the bundle

### C11 — Omissions and the new-Work race: snapshot, reasons, scope token, recheck

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** R11–R12; A17
- **Accepted by (A-scenarios, expanded):** A17 · **Stages:** R11, R12
- **R01 pins:** As D16 (reasons, scope token on submit / approve, SCOPE_VERSION_CHANGED). The recheck under the coordination lock is R12.
- **R01 tests:** `gpr2-r01-contracts` › D16/C11: every Work is included or excluded<br>`gpr2-r01-contracts` › D16/C11/C16: exactly the scope-sensitive commands
- **Protected (existing) tests:** —

### C12 — Reuse without copying evidence

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** R09; A21, A23
- **Accepted by (A-scenarios, expanded):** A21, A22, A23 · **Stages:** R09
- **R01 pins:** As D23: ResultUse states and the absence of any copy / approve command.
- **R01 tests:** `gpr2-r01-lifecycle` › RESULT_USE: the allowed transitions<br>`gpr2-r01-lifecycle` › K03/D22/D23
- **Protected (existing) tests:** `f12-final-corrective-postgres-concurrency` › FINAL-R03: two concurrent first-uses of one unattached ordinary attachment

### C13 — Persisted source mode; the first WEU must not turn 300 into 0

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** R02, R04, R19; A05, A25
- **Accepted by (A-scenarios, expanded):** A05, A25 · **Stages:** R02, R04, R19
- **R01 pins:** FACT_SOURCE_MODE lifecycle: the only edge is a reconciliation that no role may perform by hand; creating a first execution unit is not a transition. The persisted column and the resolver are R02.
- **R01 tests:** `gpr2-r01-lifecycle` › C13: creating a first execution unit is not a transition<br>`gpr2-r01-lifecycle` › FACT_SOURCE_MODE: the allowed transitions
- **Protected (existing) tests:** `production-execution` › resolveActualQuantity: with execution units<br>`execution-units` › F8.1: execution unit / layer / quantity portion

### C14 — Calendar engine, edge set, backplan, Gantt

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** R10, R14, R18; A08, A10, A14
- **Accepted by (A-scenarios, expanded):** A08, A09, A10, A14 · **Stages:** R10, R14, R18
- **R01 pins:** Edge types and lag kinds as D07 / D08; one change-set command for typed dates and drag (D12).
- **R01 tests:** `gpr2-r01-contracts` › D08: dependency types<br>`gpr2-r01-contracts` › A10: an apply names the exact preview
- **Protected (existing) tests:** —

### C15 — One RP / INTERNAL_SC resolver with deterministic ties; known-at vs effective-at

- **R01 contract coverage:** LATER_STAGE · **TD:** R02; A24
- **Accepted by (A-scenarios, expanded):** A24 · **Stages:** R02
- **R01 pins:** No R01 contract.
- **R01 tests:** —
- **Protected (existing) tests:** `f12.1-fact-freeze-customer-sc` › F12-QTY-04: Customer SC presentation freezes RP Fact too

### C16 — Consistent snapshots, optimistic versions and revalidation under lock

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** R03, R07, R12; A06, A17, A30
- **Accepted by (A-scenarios, expanded):** A06, A17, A30 · **Stages:** R03, R07, R12
- **R01 pins:** Version tokens (aggregate / scope / revision sequence / source version) as distinct types and canonical strings; STALE_VERSION and SCOPE_VERSION_CHANGED are separate 409s; the command fingerprint (which includes the named source versions of an approve / commit); an open payload is plain JSON that the fingerprint can always canonicalise, so no client mistake is a 500. Snapshots and locks are R03.
- **R01 tests:** `gpr2-r01-versions-errors` › version tokens: canonical decimal-integer strings only<br>`gpr2-r01-versions-errors` › the design has four different<br>`gpr2-r01-versions-errors` › C16/D16: stale aggregate version<br>`gpr2-r01-versions-errors` › A10/§12.4: the command fingerprint<br>`gpr2-r01-openapi` › the patterns in the document are the grammars the parsers enforce<br>`gpr2-r01-corrective-domain` › R01-B03: an open payload is plain JSON<br>`gpr2-r01-corrective-domain` › R01-B03: the nesting bound<br>`gpr2-r01-corrective-domain` › R01-B03: whatever the open-value validator accepts<br>`gpr2-r01-corrective-http` › R01-B03 (HTTP): an open payload that cannot be canonicalised<br>`gpr2-r01-corrective-http` › R01-B03 (HTTP): 300 seeded random<br>`gpr2-r01-corrective-openapi` › R01-B05: the typed payloads<br>`gpr2-r01-corrective-openapi` › R01-B05: signed decimals<br>`gpr2-r01-corrective-openapi` › R01-B05-R1<br>`gpr2-r01-corrective-openapi` › R01-B05-R2<br>`gpr2-r01-corrective-domain` › R01-B05-R1<br>`gpr2-r01-corrective-domain` › R01-B05-R2
- **Protected (existing) tests:** `f12-final-corrective-postgres-concurrency` › FINAL-R01 (HTTP): N genuinely concurrent createExecutionUnit

### C17 — Unknown LIVE, version-only runner, migrations on boot

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** R00, R03, R19–R22; A25, A29
- **Accepted by (A-scenarios, expanded):** A25, A29 · **Stages:** R00, R03, R19, R20, R21, R22
- **R01 pins:** R01 adds no migration file and no boot-time behaviour: the /v2 surface is off by default, and a native test still asserts that the numbered chain ends at 025. All LIVE inventory/migration work is R00b/R03/R19+.
- **R01 tests:** `gpr2-r01-flag-off` › flag absent<br>`gpr2-r01-flag-off` › flag "enabled"
- **Protected (existing) tests:** `gpr-1-schedule-postgres` › A1 fresh native chain

### C18 — Decision-to-test matrix; replace only cancelled expectations; keep protected suites

- **R01 contract coverage:** CONTRACT_PARTIAL · **TD:** Каждый этап; A01–A30
- **Accepted by (A-scenarios, expanded):** A01, A02, A03, A04, A05, A06, A07, A08, A09, A10, A11, A12, A13, A14, A15, A16, A17, A18, A19, A20, A21, A22, A23, A24, A25, A26, A27, A28, A29, A30 · **Stages:** R00, R01, R02, R03, R04, R05, R06, R07, R08, R09, R10, R11, R12, R13, R14, R15, R16, R17, R18, R19, R20, R21, R22
- **R01 pins:** R01 builds the index and verifies it: every D / K / C id appears once with real tests; acceptance and stage columns equal the normative documents (every range expanded); the register of cancelled old expectations is complete, cites real tests and TD decisions, and every registered or protected suite is byte-identical to the base commit (R01 changed none). C18 itself is accepted by A01–A30 across EVERY stage — each stage extends the matrix and replaces only its own cancelled expectations — so R01 can never complete it.
- **R01 tests:** `gpr2-r01-traceability` › every decision<br>`gpr2-r01-traceability` › register of cancelled expectations<br>`gpr2-r01-traceability` › protected and registered suites<br>`gpr2-r01-traceability` › the committed matrix document<br>`gpr2-r01-normative-expectations` › the index equals the normative documents<br>`gpr2-r01-normative-expectations` › the ten discrepancies<br>`gpr2-r01-normative-expectations` › the check can fail
- **Protected (existing) tests:** —

## Register of cancelled expectations (Roadmap §5.2)

R01 changes **none** of these tests. Each is changed by the stage named, citing the decision; `PINNED_SUITES` holds the sha256 of every one of them at the base commit.

### 1. A schedule line is a WEU; a whole Work is refused when it has execution units

- **Replaced by:** One line per Work regardless of WEUs
- **Decisions:** D01, C01 · **Changed in:** R11 (R20 for archive)
- **Tests that assert the old expectation:** `gpr-1-schedule-domain` › approval rules: the first approval needs entries
- **Production anchors:** `packages/domain/schedule.ts` («WORK_SCHEDULED_AS_WHOLE_MESSAGE»); `packages/domain/schedule.ts` («worksScheduledAtBothLevels»)

### 2. A baseline carries no quantity snapshot

- **Replaced by:** Immutable quantity / unit / quantity-version snapshot; a quantity-only diff is a change
- **Decisions:** D17, K02, C08 · **Changed in:** R11
- **Tests that assert the old expectation:** `gpr-1-schedule-postgres` › A2 exact schema<br>`gpr-1-schedule-domain` › revision diff: added / removed / changed with the exact fields
- **Production anchors:** `infra/025_production_schedule.sql` («schedule_revision_entries»)

### 3. The deputy edits and approves

- **Replaced by:** РП edit / submit; deputy approve / return
- **Decisions:** D11, C10 · **Changed in:** R12 (legacy contour retired in R21)
- **Tests that assert the old expectation:** `gpr-1-schedule-domain` › who may do what: view / prepare / approve / explain a delay<br>`gpr-1-schedule-http` › A. authorization: everyone internal may read
- **Production anchors:** `packages/domain/index.ts` («scheduleManage»)
- **Note:** The GPR-1 grants stay untouched in R01 on purpose: the GPR-1 contour is operative until the cutover, and the new /v2 grants live in packages/domain/gpr2.

### 4. Dates, plan and risk are read from Work columns

- **Replaced by:** Only the approved GPR projection; no baseline → null
- **Decisions:** D13, D14, D15, C09 · **Changed in:** R13 / R18 (guard extended to dates, metrics and worker per Roadmap §5.2)
- **Tests that assert the old expectation:** `gpr-ux-d01-viewmodel` › guard: O01 / W01 view-models and screens never read the legacy work.scheduleStatus<br>`view-models` › O01 schedule carries only plan and fact
- **Production anchors:** `apps/backend/src/read-service.ts` («scheduleStatus»)

### 5. Calendar-day interpolation of the plan

- **Replaced by:** Uniform working days on the frozen object calendar
- **Decisions:** K04, C14 · **Changed in:** R10 / R13
- **Tests that assert the old expectation:** `gpr-1-schedule-domain` › planned progress is the accepted linear plan<br>`gpr-1-schedule-domain` › Есть отставание: not started a day after the start date; delay counts whole calendar days<br>`gpr-1-schedule-domain` › delay arithmetic is exact
- **Production anchors:** `packages/domain/schedule.ts` («plannedProgressOn»)

### 6. Adding a WEU automatically changes the source of the actual quantity

- **Replaced by:** A persisted source mode and a safe transition gate
- **Decisions:** C13 · **Changed in:** R02
- **Tests that assert the old expectation:** `production-execution` › resolveActualQuantity: with execution units sharing the work<br>`production-execution` › resolveActualQuantity: execution units exist but none share
- **Production anchors:** `packages/domain/index.ts` («resolveActualQuantity»)
- **Note:** tests/production-execution.test.ts lines 241–258 are ALSO in the protected list (Roadmap §5.1). R02 must keep the PORTION-mode semantics of these assertions and replace only the implicit LEGACY→PORTION switch (the lifecycle contract in R01 already forbids that switch).

### 7. Monetary weights in the general physical readiness

- **Replaced by:** Normative worker labor; incomplete coverage → null
- **Decisions:** K01 · **Changed in:** R17 / R18
- **Tests that assert the old expectation:** —
- **Production anchors:** `apps/backend/src/read-service.ts` («weighted('actualProgress')»)
- **Note:** No existing test asserts the cost weighting (static search of tests/*.test.ts found none): the behaviour lives only in read-service.ts. R17 must ADD the replacing test; there is no old expectation to delete.
