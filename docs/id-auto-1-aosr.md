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
