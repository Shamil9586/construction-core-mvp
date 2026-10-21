# Construction Core — F13.1 Design/UX Recovery & Reconciliation

**Status: REVIEW CANDIDATE — NOT PRODUCT ACCEPTANCE.** Documentation-only inventory, 21 October 2026.

| Source | Exact SHA |
|---|---|
| Current canonical main | `92fcf6d047fd22453349260432dbc65590386a17` |
| Historical F13.1 branch `feature/design-f13-1-ui-validation` | `a0b5a159e72e48a4acc4b8e28a9efee13b47350a` |
| Common ancestor | `14ba13bc11b7e6a82771f4371262db3e7e4534c7` |

The historical branch has **2 unmerged commits** (`14778617812706199011ac8b4401baa317415faa`, `a0b5a159e72e48a4acc4b8e28a9efee13b47350a`) and **12 documentation files absent from main**. GitHub compare main...F13.1 reports 2 ahead, 90 behind, 12 files. This is not a product-code diff. The two commits must NOT be cherry-picked wholesale: documents describe an earlier backend/product baseline and contain proposals now superseded by accepted changes.

## File-by-file reconciliation (12 files)

| Historical source file | Proposed disposition | What survives / what needs updating |
|---|---|---|
| `design-system/README.md` | **REWRITE** | Preserve object-first navigation, independent control contours, fact ≠ confirmation; replace dated statements about role cleanup and API gaps with current approved contracts. |
| `design-system/accessibility-rules.md` | **KEEP AS PROPOSED CHECKLIST** | Keyboard, accessible labels, focus, reflow, contrast and error/empty states are useful. Validate against F11/tests and real UI before treating every WCAG rule as proven. |
| `design-system/ai-tooling-policy.md` | **KEEP AS OPTIONAL POLICY** | Human-approved tooling and PR-based audits. DESIGN.MD, Impeccable and 21st.dev are NOT authorised implementations or required dependencies. |
| `design-system/component-rules.md` | **RECONCILE WITH CURRENT DESIGN SYSTEM** | ProgressBar, StatusBadge, PlanFact, unknown ≠ zero, no mixed readiness. Current shipped implementation and `apps/frontend/src/design-system/README.md` take precedence. |
| `design-system/forbidden-patterns.md` | **KEEP PRINCIPLES / REVIEW EXCEPTIONS** | F1–F18 include durable protections (tenant/object separation, immutable history, independent fact/SC, status not inferred from colour). Old absolute prohibitions must be checked against accepted navigation and visibility decisions. |
| `design-system/frontend-handoff.md` | **REWRITE** | Map C01/O01/W01 to current GPR-1/F8/PBX3A implementation. Old G1–G4/T1–T2 are historical proposals, not a valid list of all missing product features. |
| `design-system/specs/C01-company-control-center.md` | **PARTIALLY IMPLEMENTED / UPDATE** | Portfolio, physical SMR, attention and insufficient-data semantics exist. Per-object schedule-status column still uses `NO_SCHEDULE_STATUS`; must not invent verdict from healthStatus. |
| `design-system/specs/O01-object-overview.md` | **PARTIALLY SUPERSEDED / UPDATE** | Physical readiness and independent blockers remain. GPR-UX-D01 adds an approved-GPR-derived schedule conclusion via `ScheduleConclusion`; do not restore legacy health/works status aggregation. Read-only PTO team and navigation-only registry link also exist under later approved decisions. |
| `design-system/specs/W01-work-card.md` | **PRESERVE AS DESIGN INTENT / OPEN DECISIONS** | Type/finish/pie/conditions/zone (G2) are not fully represented on Work; RP fact/Internal SC quantities are represented via F8.1, while CUSTOMER_SC display is intentionally excluded by accepted F8.1 rules. Historic three-column UI is NOT authorised to override this decision. Immutable work/confirmation history needs scoped frontend read-model verification (G4). |
| `design-system/specs/object-team-ux.md` | **PTO IMPLEMENTED IN PART / EXTEND LATER** | Core invariant manager change must not remove object team is present in PBX-3A; O01 has current PTO team plus assignment history, and `/teams` supports explicit redistributions and handovers. Construction Control/SDO/Project Management write flows remain outside PBX-3A. |
| `design-system/visual-consistency-rules.md` | **RECONCILE WITH DESIGN SYSTEM** | Tokens, 16 type classes, density, responsive, status and separate contours are principally established; visual/accessibility claims require current test evidence per component and breakpoint. |
| `docs/design/Construction-Core-Parallel-Design-Context.md` | **ARCHIVE AS HISTORICAL CONTEXT** | Captures former parallel-session restrictions and product vision, but “current backend task: ROLE-CLEANUP” and other phase-state statements are stale. Do not promote it to current source of truth. |

## Decision and gap matrix — no automatic product changes

| ID | Present assessment relative to current main | Evidence / next gate |
|---|---|---|
| **G1: object-level schedule conclusion** | **PARTIAL / SCOPE-SPLIT** | O01 has approved-GPR conclusion (`view-models/schedule.ts`, `screens/O01/ScheduleConclusion.tsx`). C01 `view-models/c01.ts` still explicitly lacks confirmed per-object summary and exposes `NO_SCHEDULE_STATUS`. Separate design/domain approval needed for C01, not reintroduction of `healthStatus`. |
| **G2: full Work definition** | **OPEN CAPABILITY GAP** | `view-models/w01.ts` documents no full Work fields for finish type, layer/pie, execution conditions, zone. Work Execution Units/layers are not automatically equivalent to approved Work-definition semantics. Requires domain/API design, outside this docs-only task. |
| **G3: independent RP / Internal SC / Customer SC** | **DOMAIN PARTIAL + EXPLICIT UI RESTRICTION** | Portion fact and INTERNAL_SC accepted quantity exist; CUSTOMER_SC domain exists but W01 excludes customer workflow/display under F8.1 accepted scope. Historic “always three UI columns” conflicts with current approved UI restriction. OWNER/ARCHITECTURE DECISION REQUIRED before UI changes. |
| **G4: append-only history display** | **PARTIAL / REQUIRES FOCUSED EVIDENCE** | Fact/confirmation histories and audit concerns exist in backend, but exact W01 user-facing unified chronological history and correction UX were not established by this inventory. Verify source/API and acceptance tests before declaring closed or reopening. |
| **T1: object team model** | **PTO DONE / OTHER FUNCTIONS DEFERRED** | `docs/pbx-3a-object-team-foundation.md` and `screens/O01/PtoTeamSection.tsx` demonstrate PTO lead/member current/history and member-independent lead changes. PBX-3A documents foundation codes for SC/SDO/PM but PTO-only writes. |
| **T2: visibility and assignment rights** | **PTO IMPLEMENTED / BROADER ROLES OPEN** | `packages/domain/index.ts`, `apps/frontend/src/auth/internalRoles.ts` implement scoped PTO and leadership rights. Extending team administration to other functions requires separate architecture/permission acceptance. |
| **X1: context file** | **HISTORICAL FILE EXISTS ONLY IN OLD BRANCH** | If retained, place in explicit archive and label as superseded, not authoritative. |

### Cross-cutting retained rules

- Select an object before operational actions; C01 is a portfolio selector, not a mixed multi-object work screen.
- Physical SMR completion is not combined with quality control, ID, SDO or financial closing.
- RP fact, Internal SC and Customer SC are independent data/decisions; no implicit mirroring of quantities.
- Unknown/no data is not zero or success; statuses must be sourced from the correct authoritative subsystem.
- Audit and historical assignment data are not silently edited or deleted; changing a manager must not clear their team.
- Design components consume display data and tokens, never decide business authorization.
- The role model in main is DEPUTY_DIRECTOR plus PTO_HEAD/SC_HEAD/SDO_HEAD; do not restore legacy TECHNICAL_DIRECTOR or DEPARTMENT_HEAD as assignable roles.

## Proposed controlled recovery procedure

1. Preserve original F13.1 branch and its exact commits pending acceptance of a reconciled UX specification.
2. In a separate *future* docs-only candidate, carry forward revised rules and screen specs, explicitly noting historical origin and superseded decisions.
3. For G2, G3 Customer UI, G4, C01 G1, T1/T2 extensions: require explicit product/architecture gate; **do not silently implement**.
4. Independent reviewer maps each recovered document to current implementation and accepted F8, GPR-1, PBX-3A, F11 constraints. Check current screenshot/browser evidence separately.
5. Only after documentation acceptance consider retiring the F13.1 branch, retaining an immutable archival ref.

**Out of scope in this PR:** implementing UX, changing backend/frontend/migrations, changing roles, updating Render, changing LIVE, merging PR #4, or deleting branches.
