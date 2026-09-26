import { z } from 'zod';
export const uuid = z.string().uuid(), text = z.string().trim().min(1).max(500), date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v, 'Некорректная дата');
export const money = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/), qty = z.union([z.number().finite().nonnegative(), z.string().regex(/^\d{1,14}(\.\d{1,4})?$/)]), version = z.number().int().positive();
export const objectDto = z.object({ externalCode: text, name: text, address: text, organizationName: text, customerName: text.optional(), projectManagerId: uuid, startDate: date, plannedFinishDate: date, contractValue: money, contractorIds: z.array(uuid).min(1) }).strict();
export const objectContractorDto = z.object({ contractorId: uuid }).strict();
// F1 corrective: remove must address the specific relation instance, not just
// (objectId,contractorId) — those are stable across a remove+reassign cycle
// but the relation `id` (and its version) are not. See removeContractor() in
// service.ts.
export const removeContractorDto = z.object({ relationId: uuid, version }).strict();
// Core 2.1 restricted Object Edit whitelist (docs/core-2.1-architecture-plan.md,
// F6 corrective — startDate was part of the originally approved whitelist and had
// been incompletely carried into baseline docs/an earlier pass; restored here, not
// new scope): name/address/customerName/startDate/plannedFinishDate/
// projectManagerId only. contractValue, status and contractor assignments are
// deliberately absent — .strict() rejects them. Partial: every field but version
// is optional — an omitted field is left unchanged by editObject(), not cleared.
// At least one editable field besides version is required (a version-only body is
// a no-op edit, rejected rather than silently accepted). projectManagerId's mere
// presence (any value, changed or not) requires TECHNICAL_DIRECTOR/ADMIN; see
// editObject() in service.ts.
export const objectEditDto = z.object({ name: text.optional(), address: text.optional(), customerName: text.optional(), startDate: date.optional(), plannedFinishDate: date.optional(), projectManagerId: uuid.optional(), version }).strict().refine(d => Object.keys(d).length > 1, 'Нужно изменить хотя бы одно поле');
export const workDto = z.object({ objectId: uuid, workTypeId: uuid, contractorId: uuid, responsibleUserId: uuid, name: text, unit: text, plannedQuantity: qty.refine(v => Number(v) > 0), plannedStartDate: date, plannedFinishDate: date, estimatedCost: money }).strict();
export const progressDto = z.object({ totalQuantity: qty, version, comment: text }).strict();
export const issueDto = z.object({ title: text, description: text.optional(), severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']), responsibleUserId: uuid, dueDate: date, version }).strict();
export const closeDto = z.object({ sdoCaseId: uuid, amount: money.refine(v => Number(v) > 0), period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), closingDate: date, version, idempotencyKey: uuid }).strict();
// F8.1 Production Execution + Construction Control Foundation.
export const executionUnitDto = z.object({ objectWorkId: uuid, workTypeId: uuid, finishTypeId: uuid.optional(), executionConditions: text.optional(), location: text.optional(), contractorId: uuid, unit: text, plannedQuantity: qty.refine(v => Number(v) > 0) }).strict();
export const executionUnitLayerDto = z.object({ sortOrder: z.number().int().nonnegative(), name: text }).strict();
export const quantityPortionDto = z.object({ label: text, plannedQuantity: qty.refine(v => Number(v) > 0) }).strict();
export const portionFactDto = z.object({ quantity: qty, version, comment: text.optional() }).strict();
export const portionInspectionRequestDto = z.object({ inspectionType: z.enum(['INTERNAL_SC', 'CUSTOMER_SC']), version }).strict();
// F8.1-01 corrective, second pass (Independent Re-Review, Patch 2): `quantity`
// is the inspector's own confirmed figure — optional here (a whole-work
// inspection has none to confirm) but required by inspectionAction() itself
// the moment the inspection is portion-scoped; never defaulted from RP_FACT.
export const inspectionAcceptDto = z.object({ version, comment: text, quantity: qty.optional() }).strict();
// F8.2 PTO / Executive Documentation Foundation.
export const documentationPackageDto = z.object({ objectWorkId: uuid, responsibleUserId: uuid }).strict();
export const documentationPackageEditDto = z.object({ responsibleUserId: uuid, version }).strict();
export const documentationPackagePortionDto = z.object({ quantityPortionId: uuid }).strict();
// GENERAL_WORK_LOG is deliberately absent — F8.2 Document Types MVP allows
// exactly AOSR/ACT_CERTIFICATE/EXECUTIVE_SCHEME, the same set the DB's own
// CHECK constraint enforces (infra/007_documentation_foundation.sql).
export const documentationDocumentDto = z.object({ type: z.enum(['AOSR', 'ACT_CERTIFICATE', 'EXECUTIVE_SCHEME']) }).strict();
// BITRIX_DISK is deliberately absent — future compatibility only, not
// implemented here (no file upload, no archive, no PDF viewer). A
// storageReference is required exactly when storageProvider is
// EXTERNAL_REFERENCE, mirroring the DB's own pairing CHECK.
export const documentationVersionDto = z.object({ storageProvider: z.enum(['NONE', 'EXTERNAL_REFERENCE']), storageReference: text.optional(), comment: text.optional() }).strict().refine(d => (d.storageProvider === 'EXTERNAL_REFERENCE') === (d.storageReference !== undefined), 'Ссылка на документ обязательна только для EXTERNAL_REFERENCE');
export const documentationPackageStatusDto = z.object({ status: z.enum(['DRAFT', 'PREPARING', 'READY_FOR_PRESENTATION', 'PRESENTED', 'RETURNED', 'CORRECTING', 'ACCEPTED_BY_CUSTOMER']), version, comment: text.optional() }).strict();
// F8.3 SDO / Closing.
// Dedicated, audited external-result registration (F8.3 decisions 9-10) —
// never a bare status flip. acceptedDate is the external fact (when the
// customer actually signed); reference is an optional customer-side
// document/act number.
export const sdoCustomerAcceptanceDto = z.object({ version, acceptedDate: date, reference: text.optional(), comment: text.optional() }).strict();
export const sdoHandoffDto = z.object({ version, comment: text.optional() }).strict();
export const sdoReturnToPtoDto = z.object({ version, comment: text.optional() }).strict();
export const sdoResponsibleDto = z.object({ version, responsibleUserId: uuid }).strict();
export const sdoClosingStatusDto = z.object({ version, status: z.enum(['ON_RECONCILIATION', 'VERIFICATION_PASSED', 'ON_CORRECTION', 'CLOSED']), reason: text.optional() }).strict();
export const sdoClosingAmountDto = z.object({ version, amount: money }).strict();
export const sdoClosingAllocationDto = z.object({ quantityPortionId: uuid, amount: money.refine(v => Number(v) > 0) }).strict();
