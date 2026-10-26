/**
 * FIN-SDO-1 protected HTTP boundary (SEC-01-F01): fail closed.
 *
 * Every failure of a protected FIN call leaves through `mapFinProtectedFailure` as an HttpException
 * whose message is a FIN code. Nothing from the database error — message, detail, hint, query,
 * schema, routine, stack — is ever forwarded, and nothing is ever rethrown raw.
 *
 *   42501 (definer denial, unknown or foreign UUID)  -> 403 FIN_ACCESS_DENIED
 *   documented §7.2 code raised by the protected SQL -> its status, but only with the SQLSTATE that
 *     the definer function raises it with (the code alone is not trusted)
 *   other 23505 unique violation                     -> 409 FIN_COMMAND_CONFLICT
 *   other 23514 check / 22001 too long               -> 422 FIN_COMMAND_INVALID
 *   anything else (22P02, 22007, 22008, 23503, 42P01, XX000, connection, non-database error ...)
 *                                                    -> 500 FIN_INTERNAL_ERROR, never a business code
 *
 * Malformed input is meant to stop earlier, at the controller DTO (400), before any PostgreSQL cast.
 * An unexpected database failure is therefore reported as an internal failure, not as validation.
 */
import { ConflictException, ForbiddenException, HttpException, InternalServerErrorException, UnprocessableEntityException } from '@nestjs/common';

/**
 * §7.2 codes raised by the SECURITY DEFINER commands in design/fin-sdo-1/schema-UNNUMBERED.sql. The SQL
 * raises each one only after fin_sdo_session_principal() has authenticated the bearer and the row was
 * resolved inside the actor's own tenant, so it describes the caller's own command only.
 */
export const FIN_PUBLIC_DB_ERRORS: Readonly<Record<string, { sqlstate: '23505' | '23514'; status: 409 | 422 }>> = {
  FIN_QUARTER_BOOK_VERSION_CONFLICT: { sqlstate: '23505', status: 409 },
  FIN_QUARTER_BOOK_ALREADY_EXISTS: { sqlstate: '23505', status: 409 },
  FIN_IDEMPOTENCY_PAYLOAD_MISMATCH: { sqlstate: '23505', status: 409 },
  FIN_BUFFER_CAS_CONFLICT: { sqlstate: '23505', status: 409 },
  FIN_BUFFER_VERSION_CONFLICT: { sqlstate: '23505', status: 409 },
  FIN_QUARTER_TOTAL_BELOW_MIN: { sqlstate: '23514', status: 422 },
  FIN_CORRECTION_REASON_REQUIRED: { sqlstate: '23514', status: 422 },
  FIN_EXISTING_LINE_OMITTED: { sqlstate: '23514', status: 422 },
  FIN_NO_CHANGES: { sqlstate: '23514', status: 422 },
  FIN_BUFFER_QUARTER_MISMATCH: { sqlstate: '23514', status: 422 },
  FIN_AMOUNT_INVALID: { sqlstate: '23514', status: 422 },
  FIN_AMOUNT_OUT_OF_RANGE: { sqlstate: '23514', status: 422 },
};

const SQLSTATE = /^[0-9A-Z]{5}$/;

export function mapFinProtectedFailure(e: unknown, operation: string): never {
  // Already an application-level FIN response (thrown by our own guards): its message is ours.
  if (e instanceof HttpException) throw e;
  const raw = (e ?? {}) as { code?: unknown; message?: unknown };
  const sqlstate = typeof raw.code === 'string' && SQLSTATE.test(raw.code) ? raw.code : null;
  const message = typeof raw.message === 'string' ? raw.message : '';
  if (sqlstate === '42501') throw new ForbiddenException('FIN_ACCESS_DENIED');
  const documented = Object.prototype.hasOwnProperty.call(FIN_PUBLIC_DB_ERRORS, message) ? FIN_PUBLIC_DB_ERRORS[message] : undefined;
  if (documented && documented.sqlstate === sqlstate)
    throw documented.status === 409 ? new ConflictException(message) : new UnprocessableEntityException(message);
  if (sqlstate === '23505') throw new ConflictException('FIN_COMMAND_CONFLICT');
  if (sqlstate === '23514' || sqlstate === '22001') throw new UnprocessableEntityException('FIN_COMMAND_INVALID');
  // Operator diagnosis only: the operation and the SQLSTATE, never the database text or caller data.
  console.error(JSON.stringify({ level: 'error', event: 'FIN_PROTECTED_UNEXPECTED_FAILURE', operation, sqlstate }));
  throw new InternalServerErrorException('FIN_INTERNAL_ERROR');
}

/** `.catch(finBoundary('commit'))` — the one exit for every protected FIN database call. */
export const finBoundary = (operation: string) => (e: unknown): never => mapFinProtectedFailure(e, operation);

/**
 * FIN responses are private to one actor in one tenant: never stored by a browser or an intermediary,
 * never revalidated. Registered before the body parser so even transport errors on /fin-sdo-1 carry it.
 */
export function finPrivateNoStore(_req: any, res: any, next: () => void) {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.vary('Authorization');
  // No ETag on this response: express derives it from `res.app.get('etag fn')`; shadow only that setting
  // for this one response (other routes keep the application default). Without a validator, a conditional
  // request can never be answered 304.
  const app = res.app;
  Object.defineProperty(res, 'app', {
    configurable: true,
    value: Object.create(app, { get: { value: (name: string, ...rest: unknown[]) => (rest.length === 0 && name === 'etag fn' ? undefined : app.get(name, ...rest)) } }),
  });
  next();
}
