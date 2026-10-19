/**
 * GPR-2 R01 — the decision-to-test index (Roadmap R01 task 3; TD §2, §3, §15; decision C18).
 *
 * D01–D24 and K01–K04 (TD §2) and C01–C18 (TD §3), each mapped to the tests that guard it TODAY and to the acceptance scenarios (TD §15 A01–A30) that
 * will accept it later. This is NOT a claim that a decision is implemented: TD §0 states LOCKED → DESIGNED, and R01 delivers contracts only. Each
 * row says exactly what R01 pins, and what is left to which stage.
 *
 *   CONTRACT_PINNED   everything the Roadmap assigns to R01 for this decision (types, enums, transitions, errors, schemas, grants) is fixed and tested.
 *   CONTRACT_PARTIAL  R01 fixes only the part named in `pins`; the rest belongs to `stages`, and is accepted by `acceptance`.
 *   LATER_STAGE       there is nothing for R01 to pin; the decision is accepted by `acceptance` in `stages`.
 *
 * `acceptance` and (for C rows) `stages` are read from the Technical Design; for D / K rows `stages` are the Roadmap stages whose Acceptance line names one
 * of the decision's A-scenarios (a mechanical join, not a judgement). Every inclusive range is EXPANDED (`A04–A06` is A04, A05, A06; `A01–A30` is thirty
 * scenarios) — and these two columns are not trusted here: tests/gpr2-r01-normative-expectations.test.ts compares them with a fixture extracted from the two
 * documents by scripts/gpr2-extract-normative.ts, which shares no code with this file (finding R01-B06).
 *
 * The status words describe R01 CONTRACT COVERAGE only — what the contract skeleton fixes and a test can fail on. They are not a measure of how much of the
 * business behaviour exists: no decision is implemented by R01, and a row whose acceptance is spread over every stage (C18) can never be "pinned" by one. `r01Tests` are the new R01 tests; `protectedTests` are existing suites that keep
 * guarding the unchanged guarantees (TD §12.5, Roadmap §5.1). The traceability test verifies that every referenced file exists and contains the fragment.
 */
export const TD_SHA256 = 'b80ba7315509b9a011b87a45957f7e9a3eaf802624c1ca241f7072fab8879368'; // Construction_Core_GPR-2_Final_Technical_Design_2026-10-15.md
export const ROADMAP_SHA256 = 'a4c27d19a731b0d32a70c75a14af4f04c289ff93007d4ed78fe308a6ab434f76'; // Construction_Core_GPR-2_Implementation_Roadmap_2026-10-15.md
export const BASE_SHA = '48f3ce7e9c50b8bbaac67c6c3e4a7e0b94af7409';

export type R01Status = 'CONTRACT_PINNED' | 'CONTRACT_PARTIAL' | 'LATER_STAGE';
export interface TestRef { file: string; fragment: string }
export interface DecisionEntry {
  id: string; title: string; tdSections: string; acceptance: string[]; stages: string[]; r01: R01Status; pins: string; r01Tests: TestRef[]; protectedTests: TestRef[];
}

const f = (file: string) => (fragment: string): TestRef => ({ file: `tests/${file}.test.ts`, fragment });
const DEC = f('gpr2-r01-decimal'), VER = f('gpr2-r01-versions-errors'), PERM = f('gpr2-r01-permissions'), LIFE = f('gpr2-r01-lifecycle'), CON = f('gpr2-r01-contracts');
const HTTP = f('gpr2-r01-http'), ORD = f('gpr2-r01-guard-order'), OFF = f('gpr2-r01-flag-off'), TRACE = f('gpr2-r01-traceability'), OAPI = f('gpr2-r01-openapi');
// The corrective suites (R01-B01 … R01-B07) and the independent check of this very index against the normative documents (R01-B06).
const CDOM = f('gpr2-r01-corrective-domain'), CHTTP = f('gpr2-r01-corrective-http'), COAPI = f('gpr2-r01-corrective-openapi'), CPROJ = f('gpr2-r01-corrective-projection'), NORM = f('gpr2-r01-normative-expectations');
const GPR1_PG = f('gpr-1-schedule-postgres'), PROD_EXEC = f('production-execution');
// Existing protected suites (Roadmap §5.1), by the exact title of the test that guards the guarantee.
const ZERO_ACCEPT = f('f12.1-customer-sc-zero-accept')('F12-QTY-03: Customer SC ACCEPT with an explicit quantity of 0 is refused');
const FACT_FREEZE = f('f12.1-fact-freeze-customer-sc')('F12-QTY-04: Customer SC presentation freezes RP Fact too');
const IDEM_AUTH = f('f12-final-r06-auth-safe-idempotency')('FINAL-R06: an idempotency-key replay never bypasses the authorization');
const PG_IDEMPOTENT = f('f12-final-corrective-postgres-concurrency')('FINAL-R01 (HTTP): N genuinely concurrent createExecutionUnit');
const PG_ATTACHMENT = f('f12-final-corrective-postgres-concurrency')('FINAL-R03: two concurrent first-uses of one unattached ordinary attachment');
const PARTIAL_SC = f('f8.1-final-corrective-patch')('F8.1 Final: 500 planned / 500 RP fact / 100 Internal SC confirmed');
const UNITS_BOUND = f('execution-units')('F8.1: execution unit / layer / quantity portion');
const HEAD_PARITY = f('pbx2-department-head-roles')('grant parity: each head role has EXACTLY the bundle');

// The A19 core, reused by every grant-related row.
const A19 = [PERM('A19 (domain): the §11.3 role matrix'), HTTP('A19 (HTTP): the whole role matrix')];
const NO_ADMIN = [PERM('"no new Admin business grants"'), PERM('no automatic new-grants-from-enum'), HTTP('"no new Admin business grants": ADMIN is refused')];

export const DECISIONS: DecisionEntry[] = [
  // ------------------------------------------------------------------------------------------------------------------------------------- D
  { id: 'D01', title: 'Work is the schedule unit: one identity, one entry, one bar', tdSections: '§4–5, §10; A01, A25', acceptance: ['A01', 'A25'], stages: ['R05', 'R11', 'R18', 'R19', 'R20', 'R21', 'R22'],
    r01: 'CONTRACT_PARTIAL', pins: 'The change-set entry has no execution-unit/WEU/portion field and sending one is an error; one entry per Work in the draft payload; its dates are real calendar days, checked by arithmetic (an impossible date is a 422 DATE_MALFORMED, never a 500). Schema, uniqueness constraint and Gantt are R11/R18.',
    r01Tests: [CON('D01/C01: a GPR entry is one Work'), HTTP('contract violations over HTTP'), OAPI('D01/D08/D16/K03 in the document'), CDOM('R01-B01: the reviewer'), CDOM('R01-B01: malformed shapes'), CHTTP('R01-B01 (HTTP)')], protectedTests: [] },
  { id: 'D02', title: 'BoQ staging, exact split before Work creation, retry-safe', tdSections: '§7; A02, A20', acceptance: ['A02', 'A20'], stages: ['R15', 'R16', 'R17', 'R21'],
    r01Tests: [DEC('D02/D04: a split or an allocation must add up'), LIFE('the lifecycle catalogue is exactly the six')], protectedTests: [], r01: 'CONTRACT_PARTIAL',
    pins: 'Exact-sum rule for a split (1000 = 700 + 300, no tolerance) in decimal strings; the import-batch STATES (TD §7.3) are fixed (edges are left to R15); BoQ upload / allocations / commit commands, Idempotency-Key and scope fence declared in the register.' },
  { id: 'D03', title: 'Corporate classification + object tree + separate object finish registry', tdSections: '§4–5; A01, A03', acceptance: ['A01', 'A03'], stages: ['R05', 'R11', 'R18', 'R20', 'R21'],
    r01: 'LATER_STAGE', pins: 'No contract in TD §11 beyond the object-adaptation grant (see D05). Registry, mapping and area scopes are R05.', r01Tests: [], protectedTests: [] },
  { id: 'D04', title: 'Original ledger, current approved quantity, nested allocations', tdSections: '§5–6; A04–A06', acceptance: ['A04', 'A05', 'A06'], stages: ['R02', 'R03', 'R04', 'R06', 'R07', 'R19', 'R21'],
    r01: 'CONTRACT_PARTIAL', pins: 'Original / current / baseline / RP-fact are four different fields; an unproven original is UNKNOWN_LEGACY = null (never 0, never the current figure); NULL ≠ 0; decimals are exact strings; BELOW_PROTECTED_QUANTITY exists as a 422 code. Tables, caps and the protected floor are R06/R07.',
    r01Tests: [CON('D04/D19, §6.3 case 1'), CON('D04/C05: an unproven original'), CON('NULL vs 0 in the quantities'), DEC('NULL is not zero'), DEC('D02/D04: a split'), VER('error contract: the status table')], protectedTests: [ZERO_ACCEPT, PG_IDEMPOTENT] },
  { id: 'D05', title: 'One WorkType model: object creation, Admin publication', tdSections: '§5, §11; A03, A19', acceptance: ['A03', 'A19'], stages: ['R01', 'R03', 'R05', 'R07', 'R12', 'R15', 'R21'],
    r01: 'CONTRACT_PARTIAL', pins: 'Publication request lifecycle PENDING → APPROVED | REJECTED (reject needs a reason); the Admin holds the one explicit publication grant, the РП may only propose; object-adaptation grant for the РП. The single WorkType table, alias and "rejection keeps the object type" postcondition are R05a.',
    r01Tests: [LIFE('WORK_TYPE_PUBLICATION_REQUEST: the allowed transitions'), ...NO_ADMIN, PERM('A19 (domain): the §11.3 role matrix'), HTTP('A19 (HTTP): the whole role matrix')], protectedTests: [] },
  { id: 'D06', title: 'Versioned finish template, stage occurrences, overrides, preview/confirm', tdSections: '§5, §10; A07', acceptance: ['A07'], stages: ['R05', 'R07', 'R21'],
    r01: 'CONTRACT_PARTIAL', pins: 'finish-system preview is pure (no Idempotency-Key, no write); confirm is idempotent, versioned and scope-fenced (Work generation). Template tables and occurrences are R05c/R05d.',
    r01Tests: [CON('every command states how it is guarded'), CON('D16/C11/C16: exactly the scope-sensitive commands')], protectedTests: [] },
  { id: 'D07', title: 'Versioned working calendars, elapsed cure, backward planning with preview', tdSections: '§8; A08–A10', acceptance: ['A08', 'A09', 'A10'], stages: ['R10', 'R14', 'R21'],
    r01: 'CONTRACT_PARTIAL', pins: 'Lag units are two distinct kinds (WORKING_DAYS vs ELAPSED_HOURS) and a lag value is a decimal string; calendar create/patch commands are РП grants; backplan-preview is pure. The calendar engine is R10, DAG/backplan R14.',
    r01Tests: [CON('D08: dependency types are FS / SS / FF'), CON('every command states how it is guarded')], protectedTests: [] },
  { id: 'D08', title: 'Schedule edges separate from zonal release; explicit SC policy', tdSections: '§9; A11, A23', acceptance: ['A11', 'A23'], stages: ['R08', 'R09', 'R21'],
    r01: 'CONTRACT_PARTIAL', pins: 'Edge types are FS / SS / FF; SF is refused explicitly with UNSUPPORTED_DEPENDENCY_TYPE; a Work cannot depend on itself. Zonal release and the SC policy are R08.',
    r01Tests: [CON('D08: dependency types are FS / SS / FF'), HTTP('contract violations over HTTP'), OAPI('D01/D08/D16/K03 in the document')], protectedTests: [PARTIAL_SC] },
  { id: 'D09', title: 'Early Work: nullable assignments and cost, eligibility instead of fake values', tdSections: '§5, §9; A12', acceptance: ['A12'], stages: ['R04', 'R21'],
    r01: 'CONTRACT_PARTIAL', pins: 'null is never serialised as 0 (unknown cost cannot become 0); Work create / assignments are catalogued under the EXISTING rules, R01 widens nothing. Nullable columns and eligibility are R04.',
    r01Tests: [DEC('NULL is not zero'), CON('the guarded surface')], protectedTests: [] },
  { id: 'D10', title: 'One operative GPR-2; legacy archived or removed only by manifest', tdSections: '§13; A25, A29', acceptance: ['A25', 'A29'], stages: ['R19', 'R20', 'R21', 'R22'],
    r01: 'CONTRACT_PARTIAL', pins: 'R01 changes nothing in the legacy contour: the /v2 surface is off unless GPR2_CONTRACT_ROUTES=enabled, GPR-1 routes and error bodies are untouched, no migration is added (the chain still ends at 025), the register has no delete/drop command, an approved revision can only be superseded.',
    r01Tests: [OFF('flag absent'), LIFE('D11: a returned revision is final')], protectedTests: [GPR1_PG('A1 fresh native chain')] },
  { id: 'D11', title: 'РП draft → submit → deputy approve / return; the old approved plan stays until replaced', tdSections: '§8, §11; A13, A19', acceptance: ['A13', 'A19'], stages: ['R01', 'R03', 'R07', 'R11', 'R12', 'R15', 'R20', 'R21'],
    r01: 'CONTRACT_PINNED', pins: 'GPR_REVISION lifecycle (submit / discard / approve / return / supersede) with positive and exhaustive negative tests; explicit grants (РП: SCHEDULE_AUTHOR, deputy: SCHEDULE_REVIEW); return needs a reason; approval needs a different person; approval carries its mandatory fence (input fingerprint + at least one expected source version); HTTP role matrix; changed-role replay; the aggregate behind the {id} is verified before replay. Behaviour behind the gate is R11/R12.',
    r01Tests: [LIFE('GPR_REVISION: the allowed transitions'), LIFE('GPR_REVISION: every other'), LIFE('D11: a returned revision is final'), LIFE('A19 (separation)'), PERM('C10/D11'), HTTP('C10/D11'), HTTP('A19 changed-role replay'), OAPI('every command that performs a lifecycle transition'), CHTTP('R01-B04: the order'), CHTTP('R01-B04: authorization before replay covers the aggregate too'), COAPI('R01-B05: schedule.revision.submit in the served document'), ...A19], protectedTests: [] },
  { id: 'D12', title: 'Fixed Name / Start / End columns; drag and typed date are one command', tdSections: '§10; A14', acceptance: ['A14'], stages: ['R14', 'R18', 'R21'],
    r01: 'CONTRACT_PARTIAL', pins: 'The register has ONE change-set command pair (changes/preview → changes/apply) and no drag-specific route; an apply names the exact preview it confirms. The UI is R18.',
    r01Tests: [CON('§11.2: the register is the design'), CON('A10: an apply names the exact preview')], protectedTests: [] },
  { id: 'D13', title: 'One baseline projection for GPR / O01 / W01 / C01 / notifications', tdSections: '§8, §10; A15', acceptance: ['A15'], stages: ['R13', 'R18', 'R21'],
    r01: 'CONTRACT_PARTIAL', pins: 'ScheduleProjection shape, the eleven states in §8.4 priority order, the categorical verdicts, the nullability invariants per state, the identity a comparison needs (approved baseline revision, calendar version, timezone, evaluation date, operative dates, positive baseline quantity), verdict ↔ lag ↔ gap coherence, and the source-version metadata of TD §5.1/§10.3/§12.2. The calculation, the service and every consumer switching to it are R13/R18/R21.',
    r01Tests: [CON('§8.4 priority order'), CON('D14: no approved GPR'), CON('K02: REBASELINE_REQUIRED'), CPROJ('R01-B07 negative case 1'), CPROJ('R01-B07 positives'), CPROJ('R01-B07: verdict, lag and gap agree'), CPROJ('R01-B07: identity and format'), CPROJ('R01-B07: every projection carries')], protectedTests: [] },
  { id: 'D14', title: 'NO_APPROVED_GPR: no dates, no verdict', tdSections: '§8; A16', acceptance: ['A16'], stages: ['R13', 'R18', 'R21'],
    r01: 'CONTRACT_PINNED', pins: 'A NO_APPROVED_GPR projection must carry no baseline, dates, quantity, gap, lag or verdict; a lag of 0 is still a lag (null ≠ 0); and no state that compares with a baseline (ON_PLAN, BEHIND, COMPLETED_*) is valid without an approved baseline. Computing the state is R13.',
    r01Tests: [CON('D14: no approved GPR'), CPROJ('R01-B07 negative case 1')], protectedTests: [] },
  { id: 'D15', title: 'NOT_INCLUDED: independent production fact, no invented plan', tdSections: '§8–9; A16', acceptance: ['A16'], stages: ['R13', 'R18', 'R21'],
    r01: 'CONTRACT_PINNED', pins: 'A NOT_INCLUDED projection has an approved revision but no operative dates, quantity, gap, lag or verdict for this Work.',
    r01Tests: [CON('D15: a Work outside the approved GPR')], protectedTests: [] },
  { id: 'D16', title: 'Inclusion or exclusion with reason for every Work; scope fence at submit / approve', tdSections: '§8, §12; A13, A17', acceptance: ['A13', 'A17'], stages: ['R11', 'R12', 'R20', 'R21'],
    r01: 'CONTRACT_PINNED', pins: 'An omission is INCLUDED or EXCLUDED and EXCLUDED always has a reason; exactly the scope-sensitive commands carry expectedScopeVersion (schedule submit / approve, quantity create / submit / approve, finish-system confirm, BoQ commit); a changed scope is a 409 of its own. The fence under lock is R12.',
    r01Tests: [CON('D16/C11: every Work is included or excluded'), CON('D16/C11/C16: exactly the scope-sensitive commands'), VER('C16/D16: stale aggregate version'), HTTP('contract violations over HTTP'), OAPI('Idempotency-Key and the version tokens appear exactly where the register says'), CDOM('R01-B03: a well-formed fence passes'), COAPI('R01-B05: for every mounted command')], protectedTests: [] },
  { id: 'D17', title: 'Quantity approval independent of schedule approval; baseline quantity snapshot', tdSections: '§6, §8; A04, A18', acceptance: ['A04', 'A18'], stages: ['R06', 'R07', 'R11', 'R13', 'R18', 'R21'],
    r01: 'CONTRACT_PARTIAL', pins: 'Quantity authoring / review are separate grants and a separate lifecycle from the schedule; baselineQuantity is its own projection field (never the current quantity). The immutable snapshot table is R11, invalidation R13.',
    r01Tests: [LIFE('QUANTITY_CHANGE_REQUEST: the allowed transitions'), PERM('A19 (domain): the §11.3 role matrix'), CON('D04/D19, §6.3 case 1')], protectedTests: [] },
  { id: 'D18', title: 'РП proposes a quantity; deputy approves or returns; PTO review is optional', tdSections: '§6, §11; A19', acceptance: ['A19'], stages: ['R01', 'R03', 'R07', 'R12', 'R15', 'R21'],
    r01: 'CONTRACT_PINNED', pins: 'QUANTITY_AUTHOR (РП) / QUANTITY_REVIEW (deputy); QUANTITY_CHANGE_REQUEST lifecycle with a reason on return, a separate approver, ONE editing command that is an in-place edit in DRAFT and the correction RETURNED → DRAFT (a new submission version; past versions and decisions stay immutable) and is refused in SUBMITTED / APPROVED, and an approval that carries its mandatory fence; the PTO review note is a separate non-approving command held by NOBODY by default (see risks: "if allowed" is not defined by the design).',
    r01Tests: [LIFE('QUANTITY_CHANGE_REQUEST: the allowed transitions'), LIFE('QUANTITY_CHANGE_REQUEST: every other'), LIFE('A19 (separation)'), LIFE('R01-B02: PATCH quantity-change-requests/{id} is expressible'), LIFE('R01-B02: state × operation matrix'), LIFE('R01-B02: the role that may edit a draft'), CHTTP('R01-B02 (HTTP)'), CHTTP('R01-B03 (HTTP): approve / commit without the common fence'), HTTP('N01 default-deny over HTTP'), ...A19], protectedTests: [] },
  { id: 'D19', title: 'Progress by the current quantity; an exclusion is not a fact', tdSections: '§6; A04–A06, A23', acceptance: ['A04', 'A05', 'A06', 'A23'], stages: ['R02', 'R03', 'R04', 'R06', 'R07', 'R08', 'R09', 'R19', 'R21'],
    r01: 'CONTRACT_PARTIAL', pins: 'excludedQuantity / addedQuantity are separate from rpFactQuantity; a fact above current is INTEGRITY_CONFLICT, never clamped; current = 0 is NOT_APPLICABLE, never 100 %; remaining is exact and null when the data is not valid. Percent computation is R06.',
    r01Tests: [CON('D04/D19, §6.3 case 1'), CON('§6.1: a fact above the current task')], protectedTests: [FACT_FREEZE, IDEM_AUTH] },
  { id: 'D20', title: 'One surface change; stage effects atomic; local quantities independent', tdSections: '§5–6; A07', acceptance: ['A07'], stages: ['R05', 'R07', 'R21'],
    r01: 'LATER_STAGE', pins: 'The design fixes no payload or error contract for surface changes beyond the quantity request lifecycle (D17/D18); R07c owns the atomic batch.', r01Tests: [], protectedTests: [] },
  { id: 'D21', title: 'A finish change never rewrites the source Work or its facts', tdSections: '§9; A21–A22', acceptance: ['A21', 'A22'], stages: ['R09', 'R17', 'R18', 'R21'],
    r01: 'CONTRACT_PARTIAL', pins: 'The external-outcome record is append-only: its only transition is a correction that supersedes it (with a reason); there is no edit / delete command, and no generic PATCH of a Work\'s quantity, fact or suitability exists.',
    r01Tests: [LIFE('FINISH_CHANGE_RECORD: the allowed transitions'), LIFE('K03/D22/D23'), CON('§11.2 closing note'), CDOM('R01-B03: finish-change.record-correction requires a reason'), CHTTP('R01-B03 (HTTP): finish-change.record-correction requires a reason')], protectedTests: [] },
  { id: 'D22', title: 'Suitability is separate from RP / SC and recorded by the РП', tdSections: '§9; A21, A23', acceptance: ['A21', 'A23'], stages: ['R08', 'R09', 'R17', 'R18', 'R21'],
    r01: 'CONTRACT_PINNED', pins: 'Only the РП holds the record grant; no lifecycle, command, route or permission speaks of approving suitability; the deputy and ADMIN cannot record. Persistence of outcomes is R09.',
    r01Tests: [LIFE('K03/D22/D23'), CON('§11.2 closing note'), CON('A19 (register)'), HTTP('A19 (HTTP): the whole role matrix'), OAPI('D01/D08/D16/K03 in the document')], protectedTests: [ZERO_ACCEPT] },
  { id: 'D23', title: 'ResultUse: source ids, scope, quantity, basis; no copy, no double count', tdSections: '§5, §9; A21–A22', acceptance: ['A21', 'A22'], stages: ['R09', 'R17', 'R18', 'R21'],
    r01: 'CONTRACT_PARTIAL', pins: 'ResultUse lifecycle REGISTERED → SUPERSEDED | RETRACTED, each with a reason, with no APPROVED / REJECTED state and no command that could create one. Links, slices and conservation guards are R09b.',
    r01Tests: [LIFE('RESULT_USE: the allowed transitions'), LIFE('RESULT_USE: every other'), LIFE('K03/D22/D23')], protectedTests: [PG_ATTACHMENT] },
  { id: 'D24', title: 'Reuse is shown as references in the expansion, never as a duplicate row', tdSections: '§10; A21', acceptance: ['A21'], stages: ['R09', 'R17', 'R18', 'R21'],
    r01: 'LATER_STAGE', pins: 'A UI decision (R18). R01 contributes only that the register has no reuse-as-Work route.', r01Tests: [], protectedTests: [] },
  // ------------------------------------------------------------------------------------------------------------------------------------- K
  { id: 'K01', title: 'Batch estimate import → labor atoms → reviewed allocations → worker-labor KPI', tdSections: '§7; A20, A26, A28', acceptance: ['A20', 'A26', 'A27', 'A28'], stages: ['R15', 'R16', 'R17', 'R18', 'R21'],
    r01: 'CONTRACT_PARTIAL', pins: 'The general physical percent exists only for COMPLETE coverage with a positive worker denominator AND a known numerator (every other state: null, never 0 or 100; an unknown earned total is not 0 and not 100 %); a zero denominator is ZERO_WORKER_DENOMINATOR, never COMPLETE; nine coverage states; the commit carries the common approve/commit fence; N01 review capability is default-deny and object-scoped; estimate commit cannot bypass the review. Parsers and mappings are R16/R17.',
    r01Tests: [CON('K01/§7.6'), CPROJ('R01-B07 negative case 2'), CPROJ('R01-B07 negative case 3'), CPROJ('R01-B07: the labor percent is bounded'), CDOM('R01-B03: approve / commit without the common fence'), PERM('N01: ESTIMATE_MAPPING_REVIEW is default-deny'), PERM('N01: an assignment grants the capability only'), HTTP('N01 default-deny over HTTP'), ORD('N01: the capability is never implied')], protectedTests: [] },
  { id: 'K02', title: 'REBASELINE_REQUIRED withholds the verdict of the affected Work only', tdSections: '§6, §8; A18', acceptance: ['A18'], stages: ['R11', 'R13', 'R18', 'R21'],
    r01: 'CONTRACT_PARTIAL', pins: 'A REBASELINE_REQUIRED projection keeps the previous baseline dates and quantity visible and carries no verdict and no current lag. Invalidation events and clearing by a new approved revision are R13.',
    r01Tests: [CON('K02: REBASELINE_REQUIRED'), CPROJ('R01-B07 positives')], protectedTests: [] },
  { id: 'K03', title: 'The РП records an external suitability decision; no internal approval', tdSections: '§9, §11; A21–A23', acceptance: ['A21', 'A22', 'A23'], stages: ['R08', 'R09', 'R17', 'R18', 'R21'],
    r01: 'CONTRACT_PINNED', pins: 'As D22: no approve-suitability route, permission or state; record-external-outcome and record-correction are РП-only commands; a correction supersedes, it does not edit.',
    r01Tests: [LIFE('K03/D22/D23'), LIFE('FINISH_CHANGE_RECORD: every other'), CON('A19 (register)'), HTTP('A19 (HTTP): the whole role matrix'), OAPI('D01/D08/D16/K03 in the document')], protectedTests: [] },
  { id: 'K04', title: 'Uniform working days, object timezone, elapsed curing, frozen calendars', tdSections: '§8; A08–A10', acceptance: ['A08', 'A09', 'A10'], stages: ['R10', 'R14', 'R21'],
    r01: 'CONTRACT_PARTIAL', pins: 'A projection names its calendar version, the object timezone and the last fully completed local day; lag kinds separate working days from elapsed hours. The engine, DST and cut-off arithmetic are R10.',
    r01Tests: [CON('§8.4 priority order'), CON('D08: dependency types')], protectedTests: [] },
  // ------------------------------------------------------------------------------------------------------------------------------------- C
  { id: 'C01', title: 'Work-only schedule aggregate (no WEU-level items)', tdSections: 'R11, R20; A01, A25', acceptance: ['A01', 'A25'], stages: ['R11', 'R20'],
    r01: 'CONTRACT_PARTIAL', pins: 'The change-set entry has no execution-unit field and sending one is an error (the D01 contract); the schema, the uniqueness constraint and the Gantt are R11 / R18.', r01Tests: [CON('D01/C01: a GPR entry is one Work'), CDOM('R01-B01: calendar arithmetic')], protectedTests: [] },
  { id: 'C02', title: 'One active object finish registry; legacy mapping read-only', tdSections: 'R05, R19; A03, A25', acceptance: ['A03', 'A25'], stages: ['R05', 'R19'],
    r01: 'LATER_STAGE', pins: 'No R01 contract.', r01Tests: [], protectedTests: [] },
  { id: 'C03', title: 'Importer is not the BoQ parser; WorkType is not Admin-only', tdSections: 'R05, R15–R17; A02, A03, A26', acceptance: ['A02', 'A03', 'A26'], stages: ['R05', 'R15', 'R16', 'R17'],
    r01: 'CONTRACT_PARTIAL', pins: 'BoQ and estimate-labor are separate commands with their own stages and a shared РП import grant; WorkType object creation is the РП\'s, publication the Admin\'s.',
    r01Tests: [CON('A19 (register)'), LIFE('WORK_TYPE_PUBLICATION_REQUEST: the allowed transitions')], protectedTests: [] },
  { id: 'C04', title: 'Nullable early Work; one authoritative fact resolver', tdSections: 'R02, R04; A12', acceptance: ['A12'], stages: ['R02', 'R04'],
    r01: 'CONTRACT_PARTIAL', pins: 'NULL ≠ 0 in every decimal and projection contract. Resolver is R02, nullable columns R04.', r01Tests: [DEC('NULL is not zero'), CON('NULL vs 0 in the quantities')], protectedTests: [] },
  { id: 'C05', title: 'Original / current ledger with hierarchical caps', tdSections: 'R06–R07; A04, A06', acceptance: ['A04', 'A05', 'A06'], stages: ['R06', 'R07'],
    r01: 'CONTRACT_PARTIAL', pins: 'Original / current / baseline / fact are separate fields; an unproven original is UNKNOWN_LEGACY = null; decimals are exact strings; BELOW_PROTECTED_QUANTITY exists as a 422 code (the D04 contract). The ledger tables and caps are R06 / R07.', r01Tests: [CON('D04/C05: an unproven original'), DEC('D02/D04: a split'), VER('error contract: the status table')], protectedTests: [] },
  { id: 'C06', title: 'Shared surface change and local stage differences', tdSections: 'R05, R07; A07', acceptance: ['A07'], stages: ['R05', 'R07'],
    r01: 'LATER_STAGE', pins: 'Like D20: the design fixes no contract for surface changes beyond the quantity request lifecycle; R07c owns the atomic batch.', r01Tests: [], protectedTests: [] },
  { id: 'C07', title: 'Zone-scoped release and explicit SC policy', tdSections: 'R08; A11, A23', acceptance: ['A11', 'A23'], stages: ['R08'],
    r01: 'LATER_STAGE', pins: 'No R01 contract.', r01Tests: [], protectedTests: [ZERO_ACCEPT, PARTIAL_SC] },
  { id: 'C08', title: 'Baseline snapshot with quantity; quantity-only rebaseline', tdSections: 'R11–R13; A18', acceptance: ['A18'], stages: ['R11', 'R12', 'R13'],
    r01: 'CONTRACT_PARTIAL', pins: 'baselineQuantity is a separate projection field; REBASELINE_REQUIRED contract (K02); a quantity-only change is a change-set like any other.', r01Tests: [CON('K02: REBASELINE_REQUIRED'), CON('D04/D19, §6.3 case 1')], protectedTests: [] },
  { id: 'C09', title: 'One ScheduleProjection API for every consumer', tdSections: 'R13, R18, R21; A15, A16', acceptance: ['A15', 'A16'], stages: ['R13', 'R18', 'R21'],
    r01: 'CONTRACT_PARTIAL', pins: 'ScheduleProjection shape, the state priority order and the per-state nullability invariants (the D13 contract); the consumers switch in R13 / R18 / R21.', r01Tests: [CON('§8.4 priority order'), CON('D14: no approved GPR'), CON('D15: a Work outside the approved GPR')], protectedTests: [] },
  { id: 'C10', title: 'Explicit grants, separate submit / return / approve, fresh authorization', tdSections: 'R01, R11–R12; A13, A19', acceptance: ['A13', 'A19'], stages: ['R01', 'R11', 'R12'],
    r01: 'CONTRACT_PINNED', pins: 'Nine explicit GPR-2 permissions outside the Object.values(Permission) surface; ADMIN holds one (publication) and no business grant; separate commands for submit / return / approve; role re-read on every request; the pipeline order authenticate → permission → object scope → nested-resource ownership preflight (tenant-level requests included; default deny until a stage supplies a verified owner lookup) → envelope → replay → execute; legacy grants unchanged.',
    r01Tests: [...A19, ...NO_ADMIN, PERM('unchanged legacy grants'), PERM('every role has an explicit row'), HTTP('A19 changed-role replay'), HTTP('the order is permission → scope → envelope'), ORD('an unauthorised caller reaches NEITHER hook'), ORD('R01-B04 wiring'), HTTP('cross-tenant'), HTTP('the Idempotency-Key is not an access token'), CHTTP('R01-B04: a well-formed id that is MISSING'), CHTTP('R01-B04: tenant-level corporate publication'), CHTTP('R01-B04: the order'), CHTTP('R01-B04: with the PRODUCTION default hooks'), CHTTP('R01-B04: a resolver that throws'), CDOM('R01-B04: ownershipPermits is strict'), CDOM('R01-B04: every {id} in the register')],
    protectedTests: [HEAD_PARITY] },
  { id: 'C11', title: 'Omissions and the new-Work race: snapshot, reasons, scope token, recheck', tdSections: 'R11–R12; A17', acceptance: ['A17'], stages: ['R11', 'R12'],
    r01: 'CONTRACT_PARTIAL', pins: 'As D16 (reasons, scope token on submit / approve, SCOPE_VERSION_CHANGED). The recheck under the coordination lock is R12.', r01Tests: [CON('D16/C11: every Work is included or excluded'), CON('D16/C11/C16: exactly the scope-sensitive commands')], protectedTests: [] },
  { id: 'C12', title: 'Reuse without copying evidence', tdSections: 'R09; A21, A23', acceptance: ['A21', 'A22', 'A23'], stages: ['R09'],
    r01: 'CONTRACT_PARTIAL', pins: 'As D23: ResultUse states and the absence of any copy / approve command.', r01Tests: [LIFE('RESULT_USE: the allowed transitions'), LIFE('K03/D22/D23')], protectedTests: [PG_ATTACHMENT] },
  { id: 'C13', title: 'Persisted source mode; the first WEU must not turn 300 into 0', tdSections: 'R02, R04, R19; A05, A25', acceptance: ['A05', 'A25'], stages: ['R02', 'R04', 'R19'],
    r01: 'CONTRACT_PARTIAL', pins: 'FACT_SOURCE_MODE lifecycle: the only edge is a reconciliation that no role may perform by hand; creating a first execution unit is not a transition. The persisted column and the resolver are R02.',
    r01Tests: [LIFE('C13: creating a first execution unit is not a transition'), LIFE('FACT_SOURCE_MODE: the allowed transitions')], protectedTests: [PROD_EXEC('resolveActualQuantity: with execution units'), UNITS_BOUND] },
  { id: 'C14', title: 'Calendar engine, edge set, backplan, Gantt', tdSections: 'R10, R14, R18; A08, A10, A14', acceptance: ['A08', 'A09', 'A10', 'A14'], stages: ['R10', 'R14', 'R18'],
    r01: 'CONTRACT_PARTIAL', pins: 'Edge types and lag kinds as D07 / D08; one change-set command for typed dates and drag (D12).', r01Tests: [CON('D08: dependency types'), CON('A10: an apply names the exact preview')], protectedTests: [] },
  { id: 'C15', title: 'One RP / INTERNAL_SC resolver with deterministic ties; known-at vs effective-at', tdSections: 'R02; A24', acceptance: ['A24'], stages: ['R02'],
    r01: 'LATER_STAGE', pins: 'No R01 contract.', r01Tests: [], protectedTests: [FACT_FREEZE] },
  { id: 'C16', title: 'Consistent snapshots, optimistic versions and revalidation under lock', tdSections: 'R03, R07, R12; A06, A17, A30', acceptance: ['A06', 'A17', 'A30'], stages: ['R03', 'R07', 'R12'],
    r01: 'CONTRACT_PARTIAL', pins: 'Version tokens (aggregate / scope / revision sequence / source version) as distinct types and canonical strings; STALE_VERSION and SCOPE_VERSION_CHANGED are separate 409s; the command fingerprint (which includes the named source versions of an approve / commit); an open payload is plain JSON that the fingerprint can always canonicalise, so no client mistake is a 500. Snapshots and locks are R03.',
    r01Tests: [VER('version tokens: canonical decimal-integer strings only'), VER('the design has four different'), VER('C16/D16: stale aggregate version'), VER('A10/§12.4: the command fingerprint'), OAPI('the patterns in the document are the grammars the parsers enforce'), CDOM('R01-B03: an open payload is plain JSON'), CDOM('R01-B03: the nesting bound'), CDOM('R01-B03: whatever the open-value validator accepts'), CHTTP('R01-B03 (HTTP): an open payload that cannot be canonicalised'), CHTTP('R01-B03 (HTTP): 300 seeded random'), COAPI('R01-B05: the typed payloads'), COAPI('R01-B05: signed decimals'), COAPI('R01-B05-R1'), COAPI('R01-B05-R2'), CDOM('R01-B05-R1'), CDOM('R01-B05-R2')], protectedTests: [PG_IDEMPOTENT] },
  { id: 'C17', title: 'Unknown LIVE, version-only runner, migrations on boot', tdSections: 'R00, R03, R19–R22; A25, A29', acceptance: ['A25', 'A29'], stages: ['R00', 'R03', 'R19', 'R20', 'R21', 'R22'],
    r01: 'CONTRACT_PARTIAL', pins: 'R01 adds no migration file and no boot-time behaviour: the /v2 surface is off by default, and a native test still asserts that the numbered chain ends at 025. All LIVE inventory/migration work is R00b/R03/R19+.',
    r01Tests: [OFF('flag absent'), OFF('flag "enabled"')], protectedTests: [GPR1_PG('A1 fresh native chain')] },
  { id: 'C18', title: 'Decision-to-test matrix; replace only cancelled expectations; keep protected suites', tdSections: 'Каждый этап; A01–A30', acceptance: ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A09', 'A10', 'A11', 'A12', 'A13', 'A14', 'A15', 'A16', 'A17', 'A18', 'A19', 'A20', 'A21', 'A22', 'A23', 'A24', 'A25', 'A26', 'A27', 'A28', 'A29', 'A30'], stages: ['R00', 'R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R09', 'R10', 'R11', 'R12', 'R13', 'R14', 'R15', 'R16', 'R17', 'R18', 'R19', 'R20', 'R21', 'R22'],
    r01: 'CONTRACT_PARTIAL', pins: 'R01 builds the index and verifies it: every D / K / C id appears once with real tests; acceptance and stage columns equal the normative documents (every range expanded); the register of cancelled old expectations is complete, cites real tests and TD decisions, and every registered or protected suite is byte-identical to the base commit (R01 changed none). C18 itself is accepted by A01–A30 across EVERY stage — each stage extends the matrix and replaces only its own cancelled expectations — so R01 can never complete it.',
    r01Tests: [TRACE('every decision'), TRACE('register of cancelled expectations'), TRACE('protected and registered suites'), TRACE('the committed matrix document'), NORM('the index equals the normative documents'), NORM('the ten discrepancies'), NORM('the check can fail')], protectedTests: [] }
];

// ------------------------------------------------------------------------------------------------------------------------------------------
// The old expectations the design cancels (Roadmap §5.2). R01 changes NONE of these tests — each is changed by the stage named, with the decision cited.
// ------------------------------------------------------------------------------------------------------------------------------------------
export interface CancelledExpectation {
  n: number; oldExpectation: string; newExpectation: string; decisions: string[]; changedInStage: string;
  tests: TestRef[]; productionAnchors: { file: string; fragment: string }[]; note?: string;
}
const GPR1_DOM = f('gpr-1-schedule-domain'), GPR1_HTTP = f('gpr-1-schedule-http'), UX_D01 = f('gpr-ux-d01-viewmodel'), VMS = f('view-models');
export const CANCELLED_EXPECTATIONS: CancelledExpectation[] = [
  { n: 1, oldExpectation: 'A schedule line is a WEU; a whole Work is refused when it has execution units', newExpectation: 'One line per Work regardless of WEUs', decisions: ['D01', 'C01'], changedInStage: 'R11 (R20 for archive)',
    tests: [GPR1_DOM('approval rules: the first approval needs entries')], productionAnchors: [{ file: 'packages/domain/schedule.ts', fragment: 'WORK_SCHEDULED_AS_WHOLE_MESSAGE' }, { file: 'packages/domain/schedule.ts', fragment: 'worksScheduledAtBothLevels' }] },
  { n: 2, oldExpectation: 'A baseline carries no quantity snapshot', newExpectation: 'Immutable quantity / unit / quantity-version snapshot; a quantity-only diff is a change', decisions: ['D17', 'K02', 'C08'], changedInStage: 'R11',
    tests: [GPR1_PG('A2 exact schema'), GPR1_DOM('revision diff: added / removed / changed with the exact fields')], productionAnchors: [{ file: 'infra/025_production_schedule.sql', fragment: 'schedule_revision_entries' }] },
  { n: 3, oldExpectation: 'The deputy edits and approves', newExpectation: 'РП edit / submit; deputy approve / return', decisions: ['D11', 'C10'], changedInStage: 'R12 (legacy contour retired in R21)',
    tests: [GPR1_DOM('who may do what: view / prepare / approve / explain a delay'), GPR1_HTTP('A. authorization: everyone internal may read')], productionAnchors: [{ file: 'packages/domain/index.ts', fragment: 'scheduleManage' }],
    note: 'The GPR-1 grants stay untouched in R01 on purpose: the GPR-1 contour is operative until the cutover, and the new /v2 grants live in packages/domain/gpr2.' },
  { n: 4, oldExpectation: 'Dates, plan and risk are read from Work columns', newExpectation: 'Only the approved GPR projection; no baseline → null', decisions: ['D13', 'D14', 'D15', 'C09'], changedInStage: 'R13 / R18 (guard extended to dates, metrics and worker per Roadmap §5.2)',
    tests: [UX_D01('guard: O01 / W01 view-models and screens never read the legacy work.scheduleStatus'), VMS('O01 schedule carries only plan and fact')], productionAnchors: [{ file: 'apps/backend/src/read-service.ts', fragment: 'scheduleStatus' }] },
  { n: 5, oldExpectation: 'Calendar-day interpolation of the plan', newExpectation: 'Uniform working days on the frozen object calendar', decisions: ['K04', 'C14'], changedInStage: 'R10 / R13',
    tests: [GPR1_DOM('planned progress is the accepted linear plan'), GPR1_DOM('Есть отставание: not started a day after the start date; delay counts whole calendar days'), GPR1_DOM('delay arithmetic is exact')], productionAnchors: [{ file: 'packages/domain/schedule.ts', fragment: 'plannedProgressOn' }] },
  { n: 6, oldExpectation: 'Adding a WEU automatically changes the source of the actual quantity', newExpectation: 'A persisted source mode and a safe transition gate', decisions: ['C13'], changedInStage: 'R02',
    tests: [PROD_EXEC('resolveActualQuantity: with execution units sharing the work'), PROD_EXEC('resolveActualQuantity: execution units exist but none share')], productionAnchors: [{ file: 'packages/domain/index.ts', fragment: 'resolveActualQuantity' }],
    note: 'tests/production-execution.test.ts lines 241–258 are ALSO in the protected list (Roadmap §5.1). R02 must keep the PORTION-mode semantics of these assertions and replace only the implicit LEGACY→PORTION switch (the lifecycle contract in R01 already forbids that switch).' },
  { n: 7, oldExpectation: 'Monetary weights in the general physical readiness', newExpectation: 'Normative worker labor; incomplete coverage → null', decisions: ['K01'], changedInStage: 'R17 / R18',
    tests: [], productionAnchors: [{ file: 'apps/backend/src/read-service.ts', fragment: "weighted('actualProgress')" }],
    note: 'No existing test asserts the cost weighting (static search of tests/*.test.ts found none): the behaviour lives only in read-service.ts. R17 must ADD the replacing test; there is no old expectation to delete.' }
];

// Suites that are either registered above or protected by Roadmap §5.1, with the sha256 (line endings normalised) of their content at the BASE commit.
// R01 edits none of them; a stage that must change one has to change this table deliberately, with the decision cited.
export const PINNED_SUITES: Record<string, string> = {
  'tests/gpr-1-schedule-domain.test.ts': '6aba942c222ff1b7f24765db7878b8213608204a60d26fedcdb5677252a53acc',
  'tests/gpr-1-schedule-http.test.ts': '5f3c60edd1f3ccf20a04f940dad289bae94cd595b9acbeb8602606fca266a013',
  'tests/gpr-1-schedule-postgres.test.ts': 'f26798bd810d9d886f2bb826d5512fb5a1de560e4db30f365930a33cb7cf4614',
  'tests/gpr-ux-d01-viewmodel.test.ts': '476206b3c18f63b3b57ad1160a5c8d5dc9d623bb64a0eff11c00514037e65536',
  'tests/view-models.test.ts': 'ac13da352da657458a045b1b4888f972a1c18fffdf49bfbc63ad0c65b4713d5d',
  'tests/production-execution.test.ts': 'af3e6afcd186602199a882fccb0075efaf57e91c663fb647c12e18802dd6f7d8',
  'tests/execution-units.test.ts': '18cc635d9ce7c555db36f4b4175f2803265b355d508a96231c8bd6bc6ad694e6',
  'tests/f12.1-customer-sc-zero-accept.test.ts': 'd7c8a6d9e822dad83f88666777b55cb1c8622dfd1b1d6715f7b1e6a92a5ddb2c',
  'tests/f12.1-fact-freeze-customer-sc.test.ts': 'af55e9896b3041949ad2999e6d8cd786d3ccef089d388c3db26d3b7d433cafce',
  'tests/f12-final-r06-auth-safe-idempotency.test.ts': '56065e90945822a7a5cf6ec8041c38ece4cfec5dabddb8ecd9aa74616d94a759',
  'tests/f12-final-corrective-postgres-concurrency.test.ts': 'd0bf94967385972566275a4b3551721769d2ec737fc01b45087c1fbba42b4dc4',
  'tests/f8.1-final-corrective-patch.test.ts': '5526a6cdb8f5c54e99735e5fbd884aa57809144486658061bf52b1433eba831a',
  'tests/pbx2-department-head-roles.test.ts': '80946ef666f92c85f0d583c4cbb7a9673b810e08860fea035c83b72584e4542f'
};
