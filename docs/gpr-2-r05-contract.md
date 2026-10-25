# GPR-2 R05 contract — WorkType scopes, object finish systems, AreaScopes, templates, Work generation

Owner-authorised offline implementation of Roadmap **R05a–d** on 24.10.2026, base `0417083ae69842caf40349ccd042ff0401911283`. Normative sources (verified
SHA-256 before work began): Technical Design `b80ba7315509b9a011b87a45957f7e9a3eaf802624c1ca241f7072fab8879368`, Roadmap
`a4c27d19a731b0d32a70c75a14af4f04c289ff93007d4ed78fe308a6ab434f76`. Decisions D01, D03, D05, D06, D09, D20, C02/C03/C06; scenarios A01, A03, A07 (partial —
see limits), A12, A19, A30. No LIVE change, no R06+ behaviour. Status: **IMPLEMENTED — PENDING INDEPENDENT REVIEW**.

Corrective (same day): the first independent review (GPT, `GPT_REVIEW_20261024`, findings R05-GPT-B01…B05) is answered by the additive migration
`033_gpr2_r05_corrective.sql` and a preview rule (B04); migrations 029–032 are unchanged.

Independent-acceptance corrective (24.10.2026): the native-PostgreSQL acceptance (`INDEPENDENT_ACCEPTANCE_REPORT`, findings R05-IND-NEW-01…05) is
answered by the additive migration `034_gpr2_r05_independent_corrective.sql` (NEW-01…04) and a preview rule (NEW-05); 029–033 are unchanged.
Status: **IMPLEMENTED — PENDING GPT REVIEW**.

Third corrective (25.10.2026): the GPT review of that candidate (`GPT_REVIEW_20261025_R05_INDEPENDENT_CORRECTIVE`, R05-GPT-R3-B01 and the LOCAL-quantity
case) is answered by the additive migration `035_gpr2_r05_operation_semantics.sql` and a preview rule; 029–034 are unchanged. Status: **PENDING GPT RE-REVIEW**.

Preview corrective (25.10.2026): the independent native acceptance of `7a838ca` (`2026-10-25-7a838ca-findings.md`, R05-IND3-01 and R05-IND3-02) is
answered in the pure preview and the payload schemas only (`packages/domain/gpr2/r05.ts`); no SQL changed, 029–035 are unchanged, no migration added.
Status: **CORRECTIVE IMPLEMENTED — PENDING NARROW INDEPENDENT RE-ACCEPTANCE**.

## Surface

All commands go through the R01 guard (`runGpr2Command`: permission → object scope → nested resource → envelope → replay → execute) and are mounted only
with `GPR2_CONTRACT_ROUTES=enabled`. Every other `/v2` command still answers 501. Payloads are stage-owned and validated strictly in
`packages/domain/gpr2/r05.ts`.

| Command | Route (`/api/v2` …) | Who | Effect |
|---|---|---|---|
| `work-type.create` | `POST /objects/{objectId}/work-types` | РП, own object | OBJECT-scope WorkType; unit from the R05 catalogue; same name → warning, own id |
| `work-type.publication.request` | `POST /objects/{objectId}/work-types/{id}/publication-requests` | РП | PENDING request, metadata snapshot |
| `work-type.publication.approve` | `POST /work-type-publication-requests/{id}/approve` | Admin (`CORPORATE_PUBLICATION`) | PROMOTED (same id becomes corporate) or ALIASED (object type keeps its id, names a corporate type of the same unit) |
| `work-type.publication.reject` | `POST /work-type-publication-requests/{id}/reject` | Admin, reason | Request REJECTED; the WorkType row is not written |
| `area-scope.create` *(proposed route)* | `POST /objects/{objectId}/area-scopes` | РП | AreaScope in a flexible tree |
| `finish-template.draft` *(proposed)* | `POST /finish-templates` | Admin | Template + DRAFT version with stages |
| `finish-template.publish` *(proposed)* | `POST /finish-templates/{id}/publish` | Admin | DRAFT → PUBLISHED (immutable) |
| `finish-system.upsert` | `POST /objects/{objectId}/finish-systems` | РП | Object finish type (if new) + one new PUBLISHED system version |
| `finish-system.preview` | `POST /objects/{objectId}/finish-systems/{id}/preview` | РП | Read-only projection + fingerprint |
| `finish-system.confirm` | `POST /objects/{objectId}/finish-systems/{id}/confirm` | РП (+ legacy `WORK_CREATE`) | Real Works + producer bindings, atomically |

Service entries without a route (real legacy decisions are R19): `registerObjectFinishType`, `recordLegacyFinishMapping`, `recordLegacyWorkClassification`,
read-only `resolveLegacyFinish`, `legacyWorkFinishEvidence` (`apps/backend/src/gpr2-r05-legacy.ts`, `gpr2-r05-catalog.ts`).

New error codes (`errors.ts`): 409 `STALE_PREVIEW`, `STALE_SOURCE_VERSION`; 422 `ONE_PRODUCER_CONFLICT`, `MISSING_REQUIRED_DATA`, `INVALID_MEASUREMENT`,
`CROSS_SCOPE_REFERENCE`, `AREA_SCOPE_CONFLICT`, `VERSION_IMMUTABLE`. 409 stays reserved for "the world changed" (R01 rule).

## Schema (all additive; `-- migration-class: additive`; no destructive statement)

| Migration | Adds |
|---|---|
| `029_gpr2_r05a_work_type_scope.sql` | `work_types.scope/object_id/origin_object_id/alias_of_work_type_id/created_by`, `work_type_publication_requests`, scope/alias/unit/use/origin guards, and ONE partial index on the existing `work_types`: `work_types_object_idx (tenant_id, object_id) WHERE object_id IS NOT NULL` (non-unique; `object_id` is a column 029 itself adds, so no pre-R05 query references it and no existing plan can use the index — the full regression of the previous candidate ran with it). The 029 header sentence "no index is added to work_types" is inaccurate (R05-GPT-B05); 029 is not edited, its checksum stands. No index was added to `works`. |
| `030_gpr2_r05b_finish_area_legacy.sql` | `object_finish_types`, `object_area_scopes`, `legacy_finish_mappings`, `legacy_work_classifications` |
| `031_gpr2_r05c_templates.sql` | `finish_templates`, `finish_template_versions`, `finish_template_stages`, `object_finish_system_versions`, `finish_stage_occurrences`, `finish_stage_exclusions` |
| `032_gpr2_r05d_work_generation.sql` | `work_scope_state` (scope version, trigger-maintained), `work_scope_bindings` (one active producer per obligation) |
| `035_gpr2_r05_operation_semantics.sql` | trigger `gpr2_binding_operation_semantics`: every ACTIVE producer binding of one Work names an occurrence of the same WorkType, unit and measure scope (R3-B01); a precondition check that fails the run over data already violating it |
| `034_gpr2_r05_independent_corrective.sql` | three empty tables — `object_area_scope_child_revisions` (per parent), `work_scope_operations` (one row per producing Work, PK (tenant, work)), `work_type_reference_state` (per WorkType) — and the triggers of the four write-conflict protocols below; a precondition check that fails the run over data already violating NEW-01…04 (nothing is repaired or invented) |
| `033_gpr2_r05_corrective.sql` | CHECK `work_types_object_origin_required` (NOT VALID, then VALIDATE — fails and rolls back if any OBJECT type lacks an origin; no value is invented) and six triggers: bound-Work identity, binding / classification Work lock, template-version identity + DRAFT-only insert, system-version identity, publication provenance. No table, column, index or row. |

Existing rows: no Work, WEU, portion, confirmation, progress, legacy finish or legacy WorkType column is written. Existing WorkTypes read `CORPORATE`
(constant default — the fact they already are: tenant-wide dictionary rows without an object).

## Rules enforced by PostgreSQL (not only by the API)

- WorkType scope moves only OBJECT → CORPORATE with an APPROVED/PROMOTED request; alias only via APPROVED/ALIASED, once, to a corporate type of the same unit;
  an object type is usable only by Works / WEUs of its object; the unit of a referenced WorkType is frozen; decided requests immutable; nothing deleted.
- Object finish registry: stable code unique per object for ever; identity immutable; ACTIVE → RETIRED only.
- AreaScope: same-object parent (composite FK), parent / code / measure immutable (no cycle can form), children of a measured parent never exceed it in the
  same unit (row lock on the parent), never deleted, no retirement with active children or an active producer.
- Legacy mappings / classifications: append-only chains; only RESOLVED names a target; never inferred by name.
- Templates and object systems: DRAFT → PUBLISHED once, then immutable with all stages / occurrences / exclusions; corporate templates use corporate types;
  object versions corporate or same-object types; measure unit = WorkType unit; provenance (INHERITED exact copy / OVERRIDDEN with reason / ADDED_LOCAL)
  checked; every source-template stage used or excluded exactly once at publication; holds stored only as `PROPOSAL`.
- One producer: unique (tenant, object, finish type, occurrence key, AreaScope); ancestor/descendant overlap refused under a row lock on the finish type;
  the Work must be a new Work of the same object with the occurrence's WorkType and unit; one operation per Work; bindings append-only.
- Scope version: bumped by triggers on every Work insert and every binding, whatever the path; since 033 also by every Work identity change (object,
  WorkType, unit, tenant) and every legacy classification.
- (033, B01) A Work with an active producer binding keeps tenant, object, WorkType and unit; a classified Work keeps tenant and object. The binding /
  classification insert locks the Work row `FOR SHARE` and re-checks it; a Work identity change first writes the scope-state row(s) the binding /
  classification also writes. READ COMMITTED: the later session waits, then is refused; REPEATABLE READ: 40001 serialization failure. R04 planning
  completion, start, progress and inspection write none of these columns.
- (033, B02) A template version is inserted only as DRAFT and keeps its `template_id`; an object version keeps `object_id`, `finish_type_id` and
  `source_template_version_id` (DRAFT included). At publication every occurrence / exclusion names the version's own source, every INHERITED
  occurrence is still an exact copy (`PROVENANCE_MISMATCH` otherwise).
- (033, B03) An OBJECT WorkType has a non-NULL `origin_object_id = object_id` (029's CHECK let NULL through as UNKNOWN). Promotion keeps the origin.

## Concurrency protocols (034, R05-IND-NEW-01…04)

Each guard of 030–033 that read committed rows under a lock of an UNMODIFIED row is completed by a real write to a shared row, so that under READ
COMMITTED the later transaction waits and its guard (a new statement) sees the committed row, and under REPEATABLE READ it gets 40001 instead of passing
on an old snapshot (a retry gets the business answer):

| Invariant | Shared row both sides write | Re-check |
|---|---|---|
| NEW-01: active same-unit children ≤ a measured parent | `object_area_scope_child_revisions(parent)` — every child insert, before 030's sum | 030's sum |
| NEW-02: one Work = one operation (finish type, occurrence key); several disjoint AreaScopes of the SAME operation stay allowed | `work_scope_operations(work)` — every producer binding claims it (`ON CONFLICT DO NOTHING`) | claim row and older bindings compared |
| NEW-03: no RETIRED AreaScope with an ACTIVE producer | `work_scope_state(object)` — every binding (032) and every ACTIVE → RETIRED | the binding locks its AreaScope `FOR SHARE` and re-checks lifecycle; 032's producer guard on retirement |
| NEW-04: the unit of a referenced WorkType never changes, a stage / occurrence measures in its WorkType's unit | `work_type_reference_state(type)` — the FIRST Work / WEU / stage / occurrence of the type, and every unit change | references lock the WorkType `FOR SHARE`; stages / occurrences re-check their unit on the locked row |

A Work or WEU created after a committed unit change references the type with the unit it states itself (legacy Works carry their own unit; nothing is
converted). Lock order: AreaScope → finish type → operation claim → Work → WorkType → scope state (binding); child revision → parent (child); AreaScope →
scope state (retirement); WorkType → reference state (unit change).

## One operation per Work, in PostgreSQL (034 + 035)

A Work's one operation is its finish type and occurrence key (034 claim) **and** the WorkType, unit and measure scope of the occurrences it produces
(035). A binding under another version of the same key with another measure scope (MAIN vs LOCAL) is refused (SQLSTATE 23514,
`GPR2_R05:ONE_PRODUCER_CONFLICT`); bindings of one compatible operation over several disjoint AreaScopes, under one version or several, stay allowed. The
rule is exactly `producerCompatible` (below), so PostgreSQL and the preview agree.

## Producer semantics across versions (R05-IND-NEW-05)

An occurrence key names an obligation, not an operation. An existing producer (bound under any version) satisfies the obligation of the version being
generated only when it performs the same operation: its Work's WorkType and its occurrence's WorkType equal the new occurrence's, and so do the unit and the
measure scope (`producerCompatible`). Otherwise the item is BLOCKED with `ONE_PRODUCER_CONFLICT` / `PRODUCER_INCOMPATIBLE`: the old Work is not offered as
EXISTING, is not rewritten, no second producer of the obligation is created, and confirm is refused (422, nothing written). Resolving the change is a finish
change (R09). A compatible producer from another version stays EXISTING (warning `EXISTING_FROM_OTHER_VERSION`).

LOCAL quantity (third corrective): a LOCAL producer was generated for the local quantity stated then (its binding's `basis_quantity`). When the same
obligation is restated with another quantity, it is not satisfied by the old producer and is not silently replaced: blocker `ONE_PRODUCER_CONFLICT` /
`PRODUCER_QUANTITY_CHANGED` (a quantity change is R06 / R07). Restating the same quantity, or stating none, shows the producer as EXISTING. (Whether
"stating none" keeps that meaning is an open owner decision; the code does not settle it.)

## One statement per obligation (R05-IND3-01)

`localQuantities` names an obligation `(occurrenceKey, areaScopeId)` at most once per request — even with the same value. Both payload schemas
(`generationPreviewPayload`, `generationConfirmPayload`) refuse a repeat with 422 `VALIDATION_FAILED`, rule `DUPLICATE_VALUE`, path
`localQuantities.<index of the repeat>` (every repeat is named), before anything is computed — so a repeated confirm writes nothing and a stored result
is never reached. Neither the first nor the last statement is chosen. The pure `computeGenerationPreview` refuses the same input for a caller that did
not parse it: blocker `VALIDATION_FAILED` / `DUPLICATE_VALUE`, the obligation's item is BLOCKED and takes no value, `canConfirm=false`.

## EXISTING per binding (R05-IND3-02)

An EXISTING item and an `existingWorks` row are ONE producer binding: their `quantity` is that binding's `basisQuantity` on its AreaScope (the leaf's
measure for MAIN, the stated local quantity for LOCAL) — the same meaning as a PROPOSED item's quantity. The Work's whole planned quantity is the separate
`existingWorks[].workPlannedQuantity`, repeated on each row of that Work: a property of the Work, not an amount to add up. One Work 1000 over A 600 + B 400
is shown as 600 and 400 (A alone: 600); its rows add up to 1000. Both values are part of the preview fingerprint; no stored row changes.

## Parent AreaScope coverage (R05-GPT-B04)

A measured AreaScope with children is represented only by its leaves. For every MAIN occurrence, every node with children inside a selected subtree whose
own measure is in the stage unit must be covered by its children (a child's own measure, or for an unmeasured child the effective measure of its
children): less → blocker `MISSING_REQUIRED_DATA` / rule `AREA_COVERAGE_INCOMPLETE` naming that node, with `missingInputs` entry
`{ kind: 'AREA_COVERAGE', areaScopeId, quantity: <uncovered>, unit }`; more → `AREA_SCOPE_CONFLICT` / `AREA_OVERLAP` (PostgreSQL already refuses such a
child in the same unit). No remainder AreaScope is invented and no quantity is dropped: the РП models the remainder or selects leaves. A child without a
measure is already `QUANTITY_MISSING`; a node without a measure in the stage unit declares nothing to cover; LOCAL stages are not concerned. The blocker is
part of the preview fingerprint, and confirm recomputes it (refusal 422, nothing written).

## Confirm order (R03)

`coordinate EXCLUSIVE` (first statement) → ledger `authorize` (current user row, GPR-2 grant, legacy `WORK_CREATE`, object scope, owner) → claim / compare /
replay → finish-system row lock + `expectedVersion` → inputs (CROSS_SCOPE) → current published source version (STALE_SOURCE_VERSION) → `expectedScopeVersion`
(SCOPE_VERSION_CHANGED) → preview re-computed, fingerprint (STALE_PREVIEW) → blockers → Works (contractor / responsible / cost / dates NULL) + bindings →
ledger result → COMMIT. Any failure rolls everything back, the ledger claim included.

## Interpretations to confirm at review

1. The unit catalogue for NEW units (`м, м², м³, т, кг, шт, компл` + Latin spellings) is a proposal; legacy units are not re-validated.
2. A production obligation is `(finish type, occurrence key, leaf AreaScope)`. Different finish types on the same area are different obligations (warned, not
   blocked). A new system version re-uses existing producers of the same occurrence key (shown as EXISTING).
3. Generated Work name: `<WorkType> — <finish type> [<occurrence key>]` (+ area code per area) — derived, not invented data.
4. A historical Work of the same WorkType in the object is shown as a warning (`LEGACY_WORK_SAME_WORK_TYPE`); overlap can be neither proved nor excluded
   before I-LIVE / R19.
5. `area-scope.create`, `finish-template.draft`, `finish-template.publish` routes are proposals (`routeFixedByTd: false`); the R01 contract tests were updated
   for the three new register rows with R05 traceability.
6. The preview answers its projection (`{ preview, appliedVersions, resultIds: [], warnings }`), not a `CommandResult`; the derived OpenAPI still describes the
   generic 200 envelope and open R05 payloads (stage-owned).

## Not in R05

Surface change / quantity versions (R06/R07; A07 surface delta and protected-effect abort are therefore not claimed), reuse / finish change (R09), real legacy
mapping and classification of LIVE data (R19 after I-LIVE), schedule inclusion (R11+), UI.
