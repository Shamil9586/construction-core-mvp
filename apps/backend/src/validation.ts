import { z } from 'zod';
export const uuid = z.string().uuid(), text = z.string().trim().min(1).max(500), date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v, 'Некорректная дата');
export const money = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/), qty = z.union([z.number().finite().nonnegative(), z.string().regex(/^\d{1,14}(\.\d{1,4})?$/)]), version = z.number().int().positive();
export const objectDto = z.object({ externalCode: text, name: text, address: text, organizationName: text, customerName: text.optional(), projectManagerId: uuid, startDate: date, plannedFinishDate: date, contractValue: money, contractorIds: z.array(uuid).max(200).default([]) }).strict();
export const objectContractorDto = z.object({ contractorId: uuid }).strict();
// Core 2.1 restricted Object Edit whitelist (docs/core-2.1-architecture-plan.md,
// F6 corrective — startDate was part of the originally approved whitelist and had
// been incompletely carried into baseline docs/an earlier pass; restored here, not
// new scope): name/address/customerName/startDate/plannedFinishDate/
// projectManagerId only. contractValue, status and contractor assignments are
// deliberately absent — .strict() rejects them. Partial: every field but version
// is optional — an omitted field is left unchanged by editObject(), not cleared.
// At least one editable field besides version is required (a version-only body is
// a no-op edit, rejected rather than silently accepted). projectManagerId's mere
// presence (any value, changed or not) requires DEPUTY_DIRECTOR/ADMIN; see
// editObject() in service.ts.
export const objectEditDto = z.object({ name: text.optional(), address: text.optional(), customerName: text.optional(), startDate: date.optional(), plannedFinishDate: date.optional(), projectManagerId: uuid.optional(), version }).strict().refine(d => Object.keys(d).length > 1, 'Нужно изменить хотя бы одно поле');
export const workDto = z.object({ objectId: uuid, workTypeId: uuid, contractorId: uuid, responsibleUserId: uuid, name: text, unit: text, plannedQuantity: qty.refine(v => Number(v) > 0), plannedStartDate: date, plannedFinishDate: date, estimatedCost: money }).strict();
export const progressDto = z.object({ totalQuantity: qty, version, comment: text }).strict();
export const issueDto = z.object({ title: text, description: text.optional(), severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']), responsibleUserId: uuid, dueDate: date, version }).strict();
export const closeDto = z.object({ sdoCaseId: uuid, amount: money.refine(v => Number(v) > 0), period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), closingDate: date, version, idempotencyKey: uuid }).strict();
// F8.1 Production Execution + Construction Control Foundation.
// F12.3 (LOCKED DECISION 2): idempotencyKey is optional, not required like
// closeDto's own field — see infra/013_retry_idempotency.sql for why. A
// caller that supplies one gets true create-retry safety; a caller that
// omits it (every call site accepted before this pass) is completely
// unaffected.
export const executionUnitDto = z.object({ objectWorkId: uuid, workTypeId: uuid, finishTypeId: uuid.optional(), executionConditions: text.optional(), location: text.optional(), contractorId: uuid, unit: text, plannedQuantity: qty.refine(v => Number(v) > 0), idempotencyKey: uuid.optional() }).strict();
export const executionUnitLayerDto = z.object({ sortOrder: z.number().int().nonnegative(), name: text }).strict();
export const quantityPortionDto = z.object({ label: text, plannedQuantity: qty.refine(v => Number(v) > 0), idempotencyKey: uuid.optional() }).strict();
// F12.3 FINAL-R02: idempotencyKey optional, same as executionUnitDto/
// quantityPortionDto above — a caller that omits it keeps the exact
// pre-existing (version-gated only) behaviour.
export const portionFactDto = z.object({ quantity: qty, version, comment: text.optional(), idempotencyKey: uuid.optional() }).strict();
export const portionInspectionRequestDto = z.object({ inspectionType: z.enum(['INTERNAL_SC', 'CUSTOMER_SC']), version, idempotencyKey: uuid.optional() }).strict();
// F8.1-01 corrective, second pass (Independent Re-Review, Patch 2): `quantity`
// is the inspector's own confirmed figure — optional here (a whole-work
// inspection has none to confirm) but required by inspectionAction() itself
// the moment the inspection is portion-scoped; never defaulted from RP_FACT.
export const inspectionAcceptDto = z.object({ version, comment: text, quantity: qty.optional() }).strict();
// F8.2 PTO / Executive Documentation Foundation.
// PILOT-W01 UI03: responsibleUserId is optional — the responsible engineer is derived server-side from the persisted PTO work assignment; a client-sent value must match it exactly.
export const documentationPackageDto = z.object({ objectWorkId: uuid, responsibleUserId: uuid.optional() }).strict();
export const ptoWorkAssignmentDto = z.object({ assigneeUserId: uuid }).strict();
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
// F12.3 FINAL-R02: idempotencyKey optional on the three corrected F8.3 paths.
export const sdoHandoffDto = z.object({ version, comment: text.optional(), idempotencyKey: uuid.optional() }).strict();
export const sdoReturnToPtoDto = z.object({ version, comment: text.optional(), idempotencyKey: uuid.optional() }).strict();
export const sdoResponsibleDto = z.object({ version, responsibleUserId: uuid }).strict();
export const sdoClosingStatusDto = z.object({ version, status: z.enum(['ON_RECONCILIATION', 'VERIFICATION_PASSED', 'ON_CORRECTION', 'CLOSED']), reason: text.optional(), idempotencyKey: uuid.optional() }).strict();
export const sdoClosingAmountDto = z.object({ version, amount: money }).strict();
// F8.3-R05 corrective: version is optional — required (and checked) only when
// correcting an existing allocation; the first allocation for a Portion has
// no prior row to conflict with. See setSdoClosingPortionAllocation(), service.ts.
export const sdoClosingAllocationDto = z.object({ quantityPortionId: uuid, amount: money.refine(v => Number(v) > 0), version: version.optional() }).strict();
// F8.3-19: cancelling an allocation always targets an existing row, so
// version is required (unlike sdoClosingAllocationDto's own optional one).
export const sdoClosingAllocationCancelDto = z.object({ version }).strict();
// F8.3-17.2: PTO-only pre-handoff correction — same shape as sdoReturnToPtoDto
// (SDO's own post-handoff "Вернуть в ПТО"), a separate dedicated operation.
export const documentationPackageCorrectionDto = z.object({ version, comment: text.optional() }).strict();
// ID-AUTO-1 AOSR.
const longText = z.string().trim().min(1).max(4000);
const nullableLongText = z.union([longText, z.null()]);
const nullableDate = z.union([date, z.null()]);
export const aosrCreateDto = z.object({ title: text.optional(), workDescription: longText.optional(), suggestionCode: text.optional(), quantityPortionIds: z.array(uuid).max(50).optional() }).strict().refine(d => !!d.title || !!d.suggestionCode, 'Укажите наименование АОСР или типовую позицию');
export const aosrSuggestionDismissDto = z.object({ suggestionCode: text }).strict();
export const aosrEditDto = z.object({ title: text.optional(), workDescription: nullableLongText.optional(), startDate: nullableDate.optional(), endDate: nullableDate.optional(), actDate: nullableDate.optional(), projectDocumentation: nullableLongText.optional(), normativeReferences: nullableLongText.optional(), subsequentWork: nullableLongText.optional(), additionalInfo: nullableLongText.optional(), copiesCount: z.union([z.number().int().positive().max(99), z.null()]).optional(), version }).strict();
export const aosrLinksDto = z.object({ quantityPortionIds: z.array(uuid).max(50).optional(), materialRecordIds: z.array(uuid).max(100).optional(), schemeDocumentIds: z.array(uuid).max(100).optional(), version }).strict();
export const aosrGenerateDto = z.object({ version }).strict();
export const aosrSchemeDto = z.object({ title: text }).strict();
const optText = longText.optional();
export const aosrPartyDto = z.object({ partyRole: z.enum(['DEVELOPER', 'CONSTRUCTION_ENTITY', 'DESIGNER', 'WORK_EXECUTOR', 'DEVELOPER_SC_REP', 'CONSTRUCTION_REP', 'INTERNAL_SC', 'DESIGNER_REP', 'EXECUTOR_REP']), organizationName: optText, organizationDetails: optText, personName: optText, position: optText, registryNumber: optText, authorityDocument: optText, version: version.optional() }).strict();
const qualityDoc = z.object({ docType: z.enum(['PASSPORT', 'CERTIFICATE', 'DECLARATION', 'OTHER']), number: text, docDate: date.optional(), issuer: text.optional() }).strict();
export const aosrMaterialDto = z.object({ name: text, materialId: uuid.optional(), qualityDocuments: z.array(qualityDoc).max(20).optional() }).strict();
export const aosrQualityDocumentDto = qualityDoc;
export const customerAcceptedQuantityDto = z.object({ items: z.array(z.object({ quantityPortionId: uuid, quantity: qty }).strict()).min(1).max(50), reference: text.optional(), comment: text.optional(), idempotencyKey: uuid.optional() }).strict();
