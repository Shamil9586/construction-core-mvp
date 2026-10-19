/**
 * GPR-2 R01 — the safe shape of a payload the design leaves open (Technical Design §11.1; finding R01-B03).
 *
 * Several commands have a payload whose FIELDS belong to the stage that implements them (R05, R07, R09, R15–R17). R01 may not invent those fields, but
 * it may not let "open" mean "anything": the payload is canonicalised into the command fingerprint (versions.ts), and canonicalJson throws on what has
 * no stable text form, which used to surface as HTTP 500 (`quantity.request.create` with `newQuantity: 1.5`).
 *
 * So an open payload is accepted exactly when it is PLAIN JSON that canonicalJson can serialise — null, boolean, string, a safe integer, an array
 * or an object of those — and nothing else:
 *
 *   a number with a fraction        DECIMAL_NOT_A_STRING   "decimals are strings" (§11.1); a stage that has a decimal field types it
 *   a number that is not a safe     OUT_OF_RANGE           integer (1e21, Infinity from `1e999`): no stable text form
 *   undefined / function / symbol / bigint / Date / Map / class instance    FIELD_TYPE
 *   the key `__proto__`             FIELD_NOT_ALLOWED      never a legitimate field name, always a prototype-pollution probe
 *   nesting deeper than MAX_OPEN_DEPTH    OUT_OF_RANGE     a bound for the recursion itself (a hostile body of 100 000 `[` must not exhaust the stack)
 *
 * The guarantee the tests hold this file to: whatever validateOpenValue() accepts, canonicalJson() serialises without throwing. R01 cannot tell
 * an integer count from an integer quantity by its value, so the stage that owns a decimal field declares it in its own typed schema (a
 * deferred extension, listed in docs/gpr-2-r01-contracts.md); until then an integer in an open payload is just an integer.
 *
 * Violations carry a path and a rule only — never the offending value (errors.ts).
 */
import type { Gpr2ValidationRule, Gpr2Violation } from './errors';

export const MAX_OPEN_DEPTH = 32;
/** Enough to tell a caller what is wrong; sanitizeDetails() keeps 50 anyway, so a hostile body cannot make the validator build a huge list. */
const COLLECT_LIMIT = 50;
const SAFE_KEY = /^[A-Za-z0-9_-]{1,64}$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && Object.getPrototypeOf(v) === Object.prototype;

/** Violations of one value found at `path`; the caller decides the prefix. Never throws, whatever the input. */
export function openValueViolations(value: unknown, path: readonly string[] = [], depth = 0): Gpr2Violation[] {
    const out: Gpr2Violation[] = [];
    const at = (rule: Gpr2ValidationRule) => out.push({ path: path.join('.'), rule });
    if (value === null || typeof value === 'boolean' || typeof value === 'string')
        return out;
    if (typeof value === 'number') {
        if (Number.isSafeInteger(value))
            return out;
        at(Number.isFinite(value) && !Number.isInteger(value) ? 'DECIMAL_NOT_A_STRING' : 'OUT_OF_RANGE');
        return out;
    }
    if (depth >= MAX_OPEN_DEPTH) {
        at('OUT_OF_RANGE');
        return out;
    }
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length && out.length < COLLECT_LIMIT; index++)
            out.push(...openValueViolations(value[index], [...path, String(index)], depth + 1));
        return out;
    }
    if (isPlainObject(value)) {
        for (const key of Object.keys(value)) {
            if (out.length >= COLLECT_LIMIT)
                break;
            if (key === '__proto__') {
                out.push({ path: [...path, '*'].join('.'), rule: 'FIELD_NOT_ALLOWED' });
                continue;
            }
            out.push(...openValueViolations(value[key], [...path, SAFE_KEY.test(key) ? key : '*'], depth + 1));
        }
        return out;
    }
    at('FIELD_TYPE');
    return out;
}

/** The top level of an open payload must itself be an object (`{}` is the empty command). */
export function openObjectViolations(value: unknown, path: readonly string[] = []): Gpr2Violation[] {
    if (value === undefined)
        return [{ path: path.join('.'), rule: 'FIELD_REQUIRED' }];
    if (!isPlainObject(value))
        return [{ path: path.join('.'), rule: 'FIELD_TYPE' }];
    return openValueViolations(value, path, 0);
}
