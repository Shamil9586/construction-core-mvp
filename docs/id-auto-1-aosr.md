# ID-AUTO-1 — AOSR inside the Documentation Package

First vertical slice: existing Documentation Package → several AOSR → fill one → generate one editable DOCX from
the official form `АОСР_приказ_344(1).docx` (Приказ Минстроя № 344/пр, приложение № 3).

## Model (infra/020_aosr_foundation.sql)

| Concept | Table | Notes |
|---|---|---|
| AOSR identity / content | `aosr_documents` | per package/Work; any number; description (point 1), dates, project documentation, normative, subsequent work |
| Technical history | `aosr_revisions` (append-only) | one row per generation; official number never changes |
| Generated file | `documentation_documents(type=AOSR)` → `documentation_document_versions(storage_provider=CORE_FILE)` → `attachments` | existing documentation layer; no second storage |
| Numbering | `aosr_number_counters` | per object; consumed only on the first successful generation |
| Production provenance | `aosr_portion_links` | no uniqueness across AOSRs; a Quantity Portion is never consumed; no quantity on the AOSR |
| Materials | `aosr_material_records` → `aosr_quality_documents`, `aosr_material_links` | no batches / deliveries |
| Executive schemes | `documentation_documents(type=EXECUTIVE_SCHEME, title)` + `aosr_scheme_links` | many-to-many |
| Parties / signatories | `aosr_party_records` (+ immutable `aosr_party_record_history`) | object level; `INTERNAL_SC` = construction entity's own SC representative |
| Typical suggestions | `packages/domain/aosr.ts` (`AOSR_TYPICAL_GROUPS`) + `aosr_suggestion_dismissals` | suggestions only |
| Customer-accepted quantity | `documentation_customer_accepted_quantities` (append-only) + a `CUSTOMER_SC` row in `portion_quantity_confirmations` | RP_FACT / INTERNAL_SC untouched; SDO reads the latest customer figure |

## Rules enforced by the backend (`apps/backend/src/aosr-service.ts`)

* Same gate as every package mutation (`packageMutationAccess`: effective PTO assignment) and the same freeze
  (`canMutateDocumentationPackageContent`): no AOSR change/generation once the package is PRESENTED/RETURNED/
  ACCEPTED_BY_CUSTOMER or SDO-locked. Parties/materials are object-level master data (access rule only).
* Readiness (`resolveAosrReadiness`) blocks generation; quantity and scanned files are not required. Every AOSR needs at least one linked executive scheme (a quality document never substitutes), but one scheme may cover many AOSRs — no unique scheme per AOSR.
* Customer-accepted quantity: PTO only, only for a PRESENTED/ACCEPTED_BY_CUSTOMER package that is not SDO-locked;
  idempotent per `idempotencyKey`.

## DOCX (`apps/backend/src/id-auto/aosr-docx.ts`)

The template is stored unchanged at `apps/backend/assets/aosr/aosr-order-344-annex-3.docx` and pinned by SHA-256;
if the file is missing or altered, readiness reports `TEMPLATE_UNAVAILABLE`. Only the form's own blank paragraphs
(non-breaking-space runs) receive text; labels, numbering, table and signature blocks are not touched.


## Final corrective — the generator is optional (migration 021)

One PTO process, with an OPTIONAL document-generation tool:

```
                 ┌─ «АОСР формируются в Core» ───┐
PTO documentation                                 ├─→ file-backed executive scheme → presentation →
                 └─ «АОСР формируются вне Core» ─┘     customer-accepted quantity → SDO
```

* `documentation_package_aosr_methods` (append-only) records the explicit choice per package. Nothing is inferred; a package with no
  row has not declared one. Migration 021 writes a single `CORE` row for packages that already hold Core AOSRs.
* `CORE`: everything from ID-AUTO-1 (multiple AOSRs, suggestions, readiness, DOCX, numbering). Core AOSR operations (create, dismiss
  suggestion, generate) require this method.
* `EXTERNAL`: Core keeps **only the declaration** — no AOSR record, no `documentation_documents` placeholder, no number. Core -> external
  is refused while any Core AOSR exists (no silent data loss); external -> Core is always allowed.
* Executive scheme = `documentation_documents(type=EXECUTIVE_SCHEME)` **with a file**: a `CORE_FILE` version pointing at an `attachments`
  row with content (`documentation-evidence.ts`). Created together with its file (no empty shell); a metadata-only record can have its
  file attached later. A material quality document never replaces a scheme; one scheme still backs many AOSRs.
* Forward gate (`forwardGateViolation`, documentation-evidence.ts) for the two PTO actions that depend on the documentation route — moving a
  package to PRESENTED and recording the customer-accepted quantity:
  - no declared method -> refused with a business message asking the engineer to choose (never inferred from "no AOSR"); the package stays
    readable, historical packages are not retroactively invalidated;
  - `CORE` -> at least one Core AOSR AND every Core AOSR has a successfully generated CURRENT DOCX (a draft, or an act edited after its
    generation, blocks); the engineer who does not want the generator chooses «вне Core» instead of leaving unfinished Core AOSRs;
  - `EXTERNAL` -> zero Core AOSRs / DOCX / numbers are valid;
  - both -> at least one file-backed executive scheme (one scheme may cover all AOSRs).
  Core AOSR readiness additionally needs a file-backed scheme linked to that AOSR.
* Customer-accepted quantity depends on package state + evidence only — never on a Core AOSR existing, being ready or generated.
* DOCX / scheme downloads: authenticated binary; `Content-Disposition` carries both an ASCII `filename` and `filename*`; `Cache-Control:
  private, no-store`. The UI fetches the DOCX when the card opens and renders a real `<a href=blob: download>` (native user click).
