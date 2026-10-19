/**
 * GPR-2 R01 — version tokens and the command fingerprint (Technical Design §5.4, §8.1, §11.1, §12.2, §12.4; decisions D16/D17, C11/C16).
 *
 * Four different things are all called "a version" in the design and mixing any two is a bug class of its own, so each is its own type:
 *
 *   AggregateVersion  the optimistic token of ONE row (a draft revision, a quantity request, a Work) — `expectedVersion`
 *   ScopeVersion      the object's scope token — `expectedScopeVersion`; changes when relevant scope changes (Work creation, quantity
 *                     approval, baseline publication), so an approval can notice that a Work appeared after a submission was made
 *   RevisionSequence  the BUSINESS number of a GPR revision (1, 2, 3 …). TD §5.4: "revision number is not an optimistic version"
 *   SourceVersionId   the uuid of an immutable version row (a quantity version, a calendar version) a projection was built from
 *
 * The two tokens travel as canonical decimal-integer STRINGS (like every decimal in the contract — a JSON number is refused): no sign, no
 * leading zeros, at most 18 digits so a PostgreSQL bigint always fits. They are compared as BigInt, never as float.
 *
 * The fingerprint is the "immutable input fingerprint" of approve/commit (§11.1) and the payload identity of an idempotent command (§12.4):
 * sha256 over a canonical JSON of the semantic input — key order and whitespace cannot change it, a changed payload, expected version or
 * source version always does. The Idempotency-Key itself, the actor and the tenant are NOT part of it: they scope the key, the fingerprint
 * says whether a repeat is the SAME command.
 */
import { createHash } from 'node:crypto';
import { Gpr2Error, Gpr2ValidationRule } from './errors';

declare const aggregateBrand: unique symbol, scopeBrand: unique symbol, sequenceBrand: unique symbol, sourceBrand: unique symbol, fingerprintBrand: unique symbol;
export type AggregateVersion = string & { readonly [aggregateBrand]: true };
export type ScopeVersion = string & { readonly [scopeBrand]: true };
export type RevisionSequence = number & { readonly [sequenceBrand]: true };
export type SourceVersionId = string & { readonly [sourceBrand]: true };
export type InputFingerprint = string & { readonly [fingerprintBrand]: true };

const TOKEN = /^(0|[1-9][0-9]{0,17})$/;
export type TokenParse<T> = { ok: true; value: T } | { ok: false; rule: Gpr2ValidationRule };

function parseToken(input: unknown): TokenParse<string> {
    if (typeof input !== 'string')
        return { ok: false, rule: 'VERSION_TOKEN_NOT_A_STRING' };
    return TOKEN.test(input) ? { ok: true, value: input } : { ok: false, rule: 'VERSION_TOKEN_MALFORMED' };
}
export const parseAggregateVersion = (input: unknown) => parseToken(input) as TokenParse<AggregateVersion>;
export const parseScopeVersion = (input: unknown) => parseToken(input) as TokenParse<ScopeVersion>;

export function parseRevisionSequence(input: unknown): TokenParse<RevisionSequence> {
    return typeof input === 'number' && Number.isSafeInteger(input) && input >= 1
        ? { ok: true, value: input as RevisionSequence }
        : { ok: false, rule: 'OUT_OF_RANGE' };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function parseSourceVersionId(input: unknown): TokenParse<SourceVersionId> {
    if (typeof input !== 'string')
        return { ok: false, rule: 'FIELD_TYPE' };
    const v = input.toLowerCase();
    return UUID.test(v) ? { ok: true, value: v as SourceVersionId } : { ok: false, rule: 'ID_MALFORMED' };
}

/** The value PostgreSQL returns for a version column (int4 → number, int8 → string) as a BigInt. */
const asBig = (v: string | number | bigint) => BigInt(v);
export const formatVersion = (v: string | number | bigint): string => asBig(v).toString();
export const nextVersion = <T extends string>(v: T): T => (asBig(v) + 1n).toString() as T;

/** Optimistic check of one aggregate row. Stale → 409 STALE_VERSION (the caller re-reads; no automatic rebase). */
export function assertAggregateVersion(expected: AggregateVersion, actual: string | number | bigint): void {
    if (asBig(expected) !== asBig(actual))
        throw new Gpr2Error('STALE_VERSION', { token: 'expectedVersion' });
}
/** Scope fence. Changed → 409 SCOPE_VERSION_CHANGED (a Work appeared, a quantity was approved … since the submission was prepared). */
export function assertScopeVersion(expected: ScopeVersion, actual: string | number | bigint): void {
    if (asBig(expected) !== asBig(actual))
        throw new Gpr2Error('SCOPE_VERSION_CHANGED', { token: 'expectedScopeVersion' });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Canonical JSON and the command fingerprint
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Deterministic serialisation: object keys sorted, no whitespace. It refuses what has no stable text form — undefined, functions, symbols,
 * bigint, non-finite or non-integer numbers (a decimal must already be a string) and anything that is not plain data.
 */
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value === 'boolean' || typeof value === 'string')
        return JSON.stringify(value);
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value))
            throw new TypeError('canonicalJson: only safe integers may be numbers; decimals are strings');
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
        return '[' + value.map(canonicalJson).join(',') + ']';
    if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
        return '{' + Object.keys(value as object).sort().map(k => JSON.stringify(k) + ':' + canonicalJson((value as any)[k])).join(',') + '}';
    throw new TypeError('canonicalJson: unsupported value of type ' + typeof value);
}

export interface CommandIdentity {
    /** Stable command id from the endpoint register, e.g. "schedule.revision.approve". */
    commandKind: string;
    /** The payload AFTER schema parsing, so decimals are already canonical strings. */
    payload: unknown;
    expectedVersion: AggregateVersion | null;
    expectedScopeVersion: ScopeVersion | null;
    /** "expected source versions" of an approve / commit (§11.1): named immutable version ids. */
    sourceVersions: Readonly<Record<string, SourceVersionId>>;
}
export function commandFingerprint(identity: CommandIdentity): InputFingerprint {
    const text = canonicalJson({
        commandKind: identity.commandKind,
        payload: identity.payload,
        expectedVersion: identity.expectedVersion,
        expectedScopeVersion: identity.expectedScopeVersion,
        sourceVersions: identity.sourceVersions
    });
    return createHash('sha256').update(text, 'utf8').digest('hex') as InputFingerprint;
}
export const isInputFingerprint = (v: unknown): v is InputFingerprint => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
