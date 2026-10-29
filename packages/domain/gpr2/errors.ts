/**
 * GPR-2 R01 — error contract (Technical Design §11.1, decisions D11/C10, C16).
 *
 * One closed catalogue of rule codes and the HTTP status each one maps to. The status table is the whole contract:
 *   403 permission · 404 a scoped resource the caller cannot reach · 409 stale version / scope changed / idempotency mismatch ·
 *   422 a semantic violation, always with a rule code · 413 / 415 file limits (producers arrive with the import stages).
 * 501 COMMAND_NOT_ENABLED is the one addition: an authorised, in-scope call to a command whose stage is not implemented yet. It is how R01
 * keeps every later command closed behind a feature gate without ever answering "success" or leaking whether the target exists.
 *
 * SCOPE SAFETY. A message is chosen by code, never composed from caller data, and `details` is passed through an allowlist. So the answer
 * for "that object does not exist", "that object belongs to another tenant", "that object belongs to another project manager" and "that
 * id is not even a uuid" is the SAME body (see scopeSafeNotFound) — nothing in an error says which of the four it was. Permission is
 * decided before scope (a caller without the grant gets 403 whatever they ask for), so 403 never reveals an object either.
 */

export const GPR2_ERROR_STATUS = {
    PERMISSION_DENIED: 403,
    RESOURCE_NOT_FOUND: 404,
    STALE_VERSION: 409,
    SCOPE_VERSION_CHANGED: 409,
    IDEMPOTENCY_PAYLOAD_MISMATCH: 409,
    VALIDATION_FAILED: 422,
    INVALID_TRANSITION: 422,
    REASON_REQUIRED: 422,
    SEPARATION_OF_DUTIES: 422,
    BELOW_PROTECTED_QUANTITY: 422,
    UNSUPPORTED_DEPENDENCY_TYPE: 422,
    PAYLOAD_TOO_LARGE: 413,
    UNSUPPORTED_MEDIA_TYPE: 415,
    COMMAND_NOT_ENABLED: 501,
    // R05 (WorkType / finish / templates / Work generation). Like R01: 409 only when the world changed under the caller (a stale preview, a superseded
    // source version); every rule the input breaks as given — a second producer, a missing quantity, a wrong unit, a foreign reference — is 422.
    STALE_PREVIEW: 409,
    STALE_SOURCE_VERSION: 409,
    ONE_PRODUCER_CONFLICT: 422,
    MISSING_REQUIRED_DATA: 422,
    INVALID_MEASUREMENT: 422,
    CROSS_SCOPE_REFERENCE: 422,
    AREA_SCOPE_CONFLICT: 422,
    VERSION_IMMUTABLE: 422
} as const;
export type Gpr2ErrorCode = keyof typeof GPR2_ERROR_STATUS;
export const GPR2_ERROR_CODES = Object.keys(GPR2_ERROR_STATUS) as Gpr2ErrorCode[];

/** The stage that first produces each code. R01 only defines it; a code with a later producer is still part of the contract now. */
export const GPR2_ERROR_PRODUCER: Record<Gpr2ErrorCode, string> = {
    PERMISSION_DENIED: 'R01', RESOURCE_NOT_FOUND: 'R01', VALIDATION_FAILED: 'R01', INVALID_TRANSITION: 'R01', REASON_REQUIRED: 'R01',
    SEPARATION_OF_DUTIES: 'R01', COMMAND_NOT_ENABLED: 'R01', UNSUPPORTED_DEPENDENCY_TYPE: 'R01',
    STALE_VERSION: 'R03', SCOPE_VERSION_CHANGED: 'R03', IDEMPOTENCY_PAYLOAD_MISMATCH: 'R03',
    BELOW_PROTECTED_QUANTITY: 'R07', PAYLOAD_TOO_LARGE: 'R15', UNSUPPORTED_MEDIA_TYPE: 'R15',
    STALE_PREVIEW: 'R05', STALE_SOURCE_VERSION: 'R05', ONE_PRODUCER_CONFLICT: 'R05', MISSING_REQUIRED_DATA: 'R05', INVALID_MEASUREMENT: 'R05',
    CROSS_SCOPE_REFERENCE: 'R05', AREA_SCOPE_CONFLICT: 'R05', VERSION_IMMUTABLE: 'R05'
};

const MESSAGES: Record<Gpr2ErrorCode, string> = {
    PERMISSION_DENIED: 'Недостаточно прав для этого действия',
    // Deliberately the same wording the existing scoped() lookup uses for a missing record.
    RESOURCE_NOT_FOUND: 'Запись не найдена',
    STALE_VERSION: 'Данные изменены другим пользователем. Обновите страницу.',
    SCOPE_VERSION_CHANGED: 'Состав работ объекта изменился. Обновите данные и повторите действие.',
    IDEMPOTENCY_PAYLOAD_MISMATCH: 'Idempotency-Key уже использован с другими данными',
    VALIDATION_FAILED: 'Запрос не соответствует контракту',
    INVALID_TRANSITION: 'Это действие недопустимо в текущем состоянии',
    REASON_REQUIRED: 'Необходимо указать причину',
    SEPARATION_OF_DUTIES: 'Автор или инициатор не может утвердить собственное представление',
    BELOW_PROTECTED_QUANTITY: 'Объём ниже защищённого уже подтверждёнными данными',
    UNSUPPORTED_DEPENDENCY_TYPE: 'Этот тип зависимости не поддерживается',
    PAYLOAD_TOO_LARGE: 'Файл превышает допустимый размер',
    UNSUPPORTED_MEDIA_TYPE: 'Этот формат файла не поддерживается',
    COMMAND_NOT_ENABLED: 'Команда пока не включена',
    STALE_PREVIEW: 'Предпросмотр устарел. Повторите предпросмотр и подтвердите заново.',
    STALE_SOURCE_VERSION: 'Версия источника изменилась. Повторите предпросмотр.',
    ONE_PRODUCER_CONFLICT: 'Для этого производственного обязательства уже есть исполняющая работа',
    MISSING_REQUIRED_DATA: 'Недостаточно обязательных данных для создания работы',
    INVALID_MEASUREMENT: 'Единица или правило измерения не соответствуют виду работ',
    CROSS_SCOPE_REFERENCE: 'Ссылка указывает на запись вне доступной области',
    AREA_SCOPE_CONFLICT: 'Участки пересекаются или нарушают иерархию',
    VERSION_IMMUTABLE: 'Опубликованная версия неизменна'
};

/** Closed set of rule identifiers a `VALIDATION_FAILED` violation may carry — the "rule code" of TD §11.1. */
export const GPR2_VALIDATION_RULES = [
    'DECIMAL_NOT_A_STRING', 'DECIMAL_MALFORMED', 'DECIMAL_SCALE_EXCEEDED', 'DECIMAL_OUT_OF_RANGE', 'DECIMAL_NEGATIVE_NOT_ALLOWED', 'DECIMAL_NEGATIVE_ZERO',
    'VERSION_TOKEN_NOT_A_STRING', 'VERSION_TOKEN_MALFORMED', 'VERSION_TOKEN_REQUIRED',
    'IDEMPOTENCY_KEY_REQUIRED', 'IDEMPOTENCY_KEY_MALFORMED',
    'ID_MALFORMED', 'DATE_MALFORMED', 'FIELD_REQUIRED', 'FIELD_NOT_ALLOWED', 'FIELD_TYPE', 'OUT_OF_RANGE', 'ENUM_VALUE', 'REASON_REQUIRED',
    // R05: why a generation input cannot be applied (structured blockers; never the offending value).
    'QUANTITY_MISSING', 'UNIT_MISSING', 'UNIT_UNKNOWN', 'UNIT_MISMATCH', 'REFERENCE_NOT_IN_SCOPE', 'AREA_OVERLAP', 'PRODUCER_EXISTS', 'DUPLICATE_VALUE',
    'NOTHING_TO_GENERATE', 'AREA_COVERAGE_INCOMPLETE', 'PRODUCER_INCOMPATIBLE', 'PRODUCER_QUANTITY_CHANGED'
] as const;
export type Gpr2ValidationRule = typeof GPR2_VALIDATION_RULES[number];
export interface Gpr2Violation { path: string; rule: Gpr2ValidationRule }

/** The only keys an error body may carry besides code/message; everything else is dropped by sanitizeDetails(). */
export interface Gpr2ErrorDetails {
    violations?: Gpr2Violation[];
    /** INVALID_TRANSITION: which lifecycle, from which state, which command. State names are never evidence. */
    machine?: string;
    from?: string;
    command?: string;
    /** STALE_VERSION / SCOPE_VERSION_CHANGED: which of the two tokens was stale — never the values. */
    token?: 'expectedVersion' | 'expectedScopeVersion';
}

const MAX_VIOLATIONS = 50;
// A path names a field, never a value: dotted identifiers only. Whatever else a caller managed to put in a key becomes "*".
const SAFE_PATH = /^[A-Za-z0-9_.*-]{0,200}$/;
export function sanitizeDetails(details: unknown): Gpr2ErrorDetails | undefined {
    if (!details || typeof details !== 'object')
        return undefined;
    const d = details as Record<string, unknown>, out: Gpr2ErrorDetails = {};
    if (Array.isArray(d.violations))
        out.violations = d.violations.slice(0, MAX_VIOLATIONS)
            .filter((v: any) => v && typeof v.path === 'string' && (GPR2_VALIDATION_RULES as readonly string[]).includes(v.rule))
            .map((v: any) => ({ path: SAFE_PATH.test(v.path) ? v.path : '*', rule: v.rule }));
    for (const k of ['machine', 'from', 'command'] as const)
        if (typeof d[k] === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(d[k] as string))
            out[k] = d[k] as string;
    if (d.token === 'expectedVersion' || d.token === 'expectedScopeVersion')
        out.token = d.token;
    return Object.keys(out).length ? out : undefined;
}

export class Gpr2Error extends Error {
    readonly code: Gpr2ErrorCode;
    readonly status: number;
    readonly details?: Gpr2ErrorDetails;
    constructor(code: Gpr2ErrorCode, details?: unknown) {
        super(MESSAGES[code]);
        this.name = 'Gpr2Error';
        this.code = code;
        this.status = GPR2_ERROR_STATUS[code];
        this.details = sanitizeDetails(details);
    }
    /** The wire body, minus the request id the HTTP layer adds. */
    toBody(): { statusCode: number; code: Gpr2ErrorCode; message: string; details?: Gpr2ErrorDetails } {
        return { statusCode: this.status, code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
    }
}

export const validationFailed = (violations: Gpr2Violation[]) => new Gpr2Error('VALIDATION_FAILED', { violations });
/** The one answer for every kind of "you cannot see that": missing, other tenant, other object, malformed id. */
export const scopeSafeNotFound = () => new Gpr2Error('RESOURCE_NOT_FOUND');
export const permissionDenied = () => new Gpr2Error('PERMISSION_DENIED');
