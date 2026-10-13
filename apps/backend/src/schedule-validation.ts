import { z } from 'zod';
import { uuid, text, date, version } from './validation';
import { DELAY_CATEGORY_CODE_PATTERN, SCHEDULE_DATE_RANGE_MESSAGE, isScheduleDate } from '../../../packages/domain/schedule';

/**
 * GPR-1 request shapes. Kept beside (not inside) validation.ts so the schedule slice adds no lines to a file every slice edits.
 * Every shape is .strict(): an unknown field — a quantity, a contractor, a status — is rejected rather than silently ignored, because the
 * schedule must not become a second place those facts can be entered.
 */
const sequence = z.number().int().min(1).max(100000);
const longText = z.string().trim().min(1).max(2000);

/** A planning date: a valid civil date within the years a schedule plans in (a two-digit year typed into a date field is `0026-…`, not 2026). */
const scheduleDate = date.refine(isScheduleDate, SCHEDULE_DATE_RANGE_MESSAGE);

/** `?asOf=YYYY-MM-DD` — compute plan versus fact on that day instead of today (read-only; the fact is always the latest). */
export const scheduleAsOf = scheduleDate;

export const scheduleEntryCreateDto = z.object({
    objectWorkId: uuid,
    executionUnitId: uuid.nullable().optional(),
    plannedStart: scheduleDate,
    plannedFinish: scheduleDate,
    sequence: sequence.optional(),
    predecessorItemId: uuid.nullable().optional(),
}).strict();

export const scheduleEntryEditDto = z.object({
    version,
    plannedStart: scheduleDate.optional(),
    plannedFinish: scheduleDate.optional(),
    sequence: sequence.optional(),
    predecessorItemId: uuid.nullable().optional(),
}).strict().refine(d => Object.keys(d).length > 1, 'Нужно изменить хотя бы одно поле');

export const scheduleVersionOnlyDto = z.object({ version }).strict();

export const scheduleApproveDto = z.object({ version, comment: text.optional(), correctionReason: longText.optional() }).strict();

export const scheduleDelayReasonDto = z.object({
    itemId: uuid,
    categoryCode: z.string().regex(DELAY_CATEGORY_CODE_PATTERN, 'Некорректный код причины'),
    comment: longText,
    responsibleUserId: uuid.optional(),
    responsibleContractorId: uuid.optional(),
}).strict().refine(d => !(d.responsibleUserId && d.responsibleContractorId), 'Укажите ответственного человека или подрядчика, но не обоих');

export const scheduleDelayResolveDto = z.object({ version, comment: longText.optional() }).strict();

export const scheduleDelayCategoryDto = z.object({
    code: z.string().regex(DELAY_CATEGORY_CODE_PATTERN, 'Код: латинские заглавные буквы, цифры и «_», 2–40 символов'),
    name: text,
    sortOrder: z.number().int().min(0).max(100000).optional(),
    isActive: z.boolean().optional(),
}).strict();
