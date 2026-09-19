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
