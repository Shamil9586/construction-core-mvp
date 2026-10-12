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
* The customer-accepted quantity is entered only after real customer acceptance (package PRESENTED + the forward gate above); document generation never triggers it.
* DOCX / scheme downloads: authenticated binary; `Content-Disposition` carries both an ASCII `filename` and `filename*`; `Cache-Control:
  private, no-store`. The UI fetches the DOCX when the card opens and renders a real `<a href=blob: download>` (native user click).

## Package scope, duplicate prevention and card clarity (migration 022)

A Documentation Package states **which production scope it documents**: its Work plus at least one Quantity Portion of that Work
(`documentation_package_portions`). Nothing is inferred and nothing is faked — no synthetic Work, execution unit or portion.

* **Explicit scope.** `POST /documentation-packages` requires `quantityPortionIds` (≥ 1) and an `idempotencyKey`. A single eligible portion may be
  preselected by the UI but is still sent and persisted. Authorization/404 checks run first; the scope check follows (`service.ts`).
* **No overlap.** A portion may belong to at most ONE ACTIVE package; a Work may have several packages as long as their portions differ. The PTO
  lifecycle has no cancelled status: every package is active until it is soft-archived (see below), and only then does it stop reserving its
  portions (`isPackageActive`, `packages/domain/package-scope.ts`, restated in the trigger's `EXISTS` by migration 023). Refusal text: «Этот участок уже включён в активный пакет исполнительной документации.»
  Three layers: the service check (`overlappingClaims`), a `FOR UPDATE` lock on the Work row that serialises create/link, and the
  `documentation_package_portions_no_overlap` trigger (per-portion advisory lock) as the database backstop for writers that bypass the service.
  The trigger fires on INSERT only — historical rows that already overlap are neither rewritten nor invalidated.
  Reusing one portion across several AOSRs *inside* one package (`aosr_portion_links`) is a different relation and stays allowed.
* **Idempotency.** `DOC_PACKAGE_CREATE` is claimed per `(user, idempotencyKey)` with the sorted portion ids as payload: a double click / retry returns the
  same package; the same key with a different scope is refused; six parallel creations of one portion create exactly one package.
* **Historical unscoped packages** stay readable and are shown as «Участок не выбран». They cannot move to PREPARING / READY_FOR_PRESENTATION / PRESENTED,
  register customer acceptance or record the customer quantity (`forwardGateViolation` starts with the scope check) until a portion is linked. Completed
  history (ACCEPTED_BY_CUSTOMER) is not touched; the way back (RETURNED → CORRECTING) and the link endpoint remain available.
* **Card.** The snapshot's `documentationPackages` rows carry a backend-derived identity: `workName`, `createdByName`, `aosrMethod` (null = «Способ подготовки
  АОСР не выбран», never read as external) and `scope` (zone summary + the CURRENT quantity following the existing provenance: customer-accepted → Internal SC →
  RP fact; no history is rendered). Absent creator → «Создатель не зафиксирован».
* **Create form.** Offers only portions no package claims; with none left: «Все доступные участки уже включены в активные пакеты ИД.»

### Read-only inspection of a Work's packages

`DATABASE_URL=… npx tsx scripts/inspect-work-packages.ts --work-id <uuid>` (or `--object-code … --work-name …`, `--empty-documents`) opens one
`BEGIN READ ONLY` transaction and classifies packages: A main, B external verification, C unscoped DRAFT leftover (nothing built on it), D unexpected,
plus document shells without title and version. It decides nothing and changes nothing.

## Soft archive of obsolete / test packages (migration 023)

An obsolete or test package must be able to leave the working list **without** being deleted and **without** a new business status.

* **Orthogonal metadata, not a status.** `documentation_packages.archived_at / archived_by / archive_reason` (all three together, a non-blank reason,
  enforced by a CHECK). `status` keeps its PTO meaning (DRAFT … ACCEPTED_BY_CUSTOMER); an archived DRAFT is still a DRAFT that is archived.
* **Retained and immutable.** The row, its documents, versions, method, scope and history stay. A trigger makes an archived row unchangeable (no
  un-archive, no forward status change) and undeletable. There is no delete API.
* **Safe archive rule** (`packages/domain/package-archive.ts`, enforced by `POST /documentation-packages/:id/archive`): status DRAFT or PREPARING, and
  no customer acceptance, no accepted-quantity history, no SDO case, never presented, no GENERATED Core AOSR (official number consumed / DOCX
  document created). A declared AOSR method, a file-backed scheme, external references and draft (unnumbered) AOSR records do **not** block —
  a disposable test package legitimately carries them and archiving keeps all of it. Anything else fails closed with a business message.
  The same rule is exposed to the UI per package as `archiveBlocker` (null = may be archived now) — the client never guesses.
* **Who.** The package-mutation gate every package action uses (PTO engineer: the effective assignee; PTO_HEAD: the object's lead; ADMIN), and an
  ordinary PTO engineer only for a package they are responsible for / created. A reason is mandatory; the version is checked.
* **Active-scope semantics.** An archived package reserves nothing: the service overlap check, the eligible-portion query (create form), the
  database trigger and the PTO-handoff package count all look at `archived_at IS NULL`. Concurrency is unchanged (works-row lock + per-portion
  advisory lock): archiving can only make a portion MORE available, so no interleaving yields two active claims.
* **Forward mutations are blocked** on an archived package everywhere (`ensurePackageNotArchived`: status, correction, scope link, documents,
  versions, edit, acceptance, handoff, and — through the AOSR write context — AOSR/scheme/method/quantity actions).
* **Read model / UI.** `snapshot.documentationPackages` is the WORKING SET (archived excluded, so lists, queues and readiness follow);
  archived packages travel in `snapshot.archivedDocumentationPackages` with who/when/why. W01 shows them only behind «Показать архивные»; the
  archived package detail is read-only and says «Архивирован».
* **Bare document shells.** AOSR and EXECUTIVE_SCHEME have dedicated flows (a generated Core AOSR; a scheme uploaded WITH its file), so the generic
  `POST /documentation-packages/:id/documents` refuses them (business message) and the generic form offers only ACT_CERTIFICATE. Historical
  shells already in a database stay readable; nothing deletes them.
