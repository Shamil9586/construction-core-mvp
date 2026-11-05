import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { mapFinProtectedFailure, FIN_PUBLIC_DB_ERRORS } from '../apps/backend/src/fin-sdo-1-errors';

// SEC-01-F01: whatever reaches the protected FIN boundary leaves it as a FIN HttpException, never raw.
// The native script scripts/fin-sdo-1-isolated-sec01-f01-verify.ts proves the same on the real HTTP path.
function pgError(code: unknown, message: string) {
  return Object.assign(new Error(message), {
    code, severity: 'ERROR', detail: 'LEAK-DETAIL Key (tenant_id)=(00000000-0000-4000-8000-00000000000b)',
    hint: 'LEAK-HINT', schema: 'public', table: 'fin_plan_edit_sessions', routine: 'LEAK-routine',
    where: 'PL/pgSQL function public.fin_sdo_create_edit_buffer(text,integer,integer,integer,jsonb) line 9',
  });
}
function outcome(e: unknown) {
  const original = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try { mapFinProtectedFailure(e, 'unit'); }
  catch (thrown) {
    assert.ok(thrown instanceof HttpException, 'raw error escaped the FIN boundary: ' + String(thrown));
    assert.notEqual(thrown, e);
    const response = JSON.stringify(thrown.getResponse());
    for (const leak of ['LEAK', 'fin_plan_edit_sessions', 'public.', 'PL/pgSQL', 'invalid input', 'does not exist'])
      assert.ok(!response.includes(leak) && !logged.join('\n').includes(leak), 'leaked ' + leak + ' in ' + response + ' / ' + logged);
    return { status: thrown.getStatus(), message: thrown.message, logged };
  }
  finally { console.error = original; }
  assert.fail('mapper returned instead of throwing');
}

test('unexpected SQLSTATEs and non-database failures are 500 FIN_INTERNAL_ERROR, never rethrown', () => {
  const cases: unknown[] = [
    pgError('22P02', 'invalid input syntax for type uuid: "x"'), pgError('22007', 'invalid input syntax for type date'),
    pgError('22008', 'date/time field value out of range'), pgError('23503', 'insert or update violates foreign key constraint'),
    pgError('42P01', 'relation "public.fin_plan_edit_session_lines" does not exist'), pgError('XX000', 'internal'),
    pgError('40001', 'could not serialize access'), pgError('08006', 'connection failure'), pgError(undefined, 'LEAK no code'),
    pgError(42501, 'LEAK numeric code'), new Error('FIN_SDO_RESTRICTED_CONNECTION_NOT_CONFIGURED'), 'LEAK string', null, undefined, { code: '22P02' },
  ];
  for (const e of cases) {
    const r = outcome(e);
    assert.deepEqual({ status: r.status, message: r.message }, { status: 500, message: 'FIN_INTERNAL_ERROR' }, String((e as any)?.code));
    assert.equal(r.logged.length, 1);
    assert.match(r.logged[0], /"event":"FIN_PROTECTED_UNEXPECTED_FAILURE"/);
  }
});

test('documented §7.2 codes pass only with the SQLSTATE the definer raises them with', () => {
  for (const [code, { sqlstate, status }] of Object.entries(FIN_PUBLIC_DB_ERRORS)) {
    assert.deepEqual(outcome(pgError(sqlstate, code)), { status, message: code, logged: [] });
    for (const wrong of ['XX000', '22P02', '23503', sqlstate === '23505' ? '23514' : '23505']) {
      const r = outcome(pgError(wrong, code));
      assert.notEqual(r.message, code, code + ' must not be trusted under ' + wrong);
    }
  }
  assert.deepEqual(outcome(pgError('23505', 'FIN_QUARTER_TOTAL_BELOW_MIN')), { status: 409, message: 'FIN_COMMAND_CONFLICT', logged: [] });
});

test('expected classes keep their safe generic codes; prototype keys are not codes', () => {
  assert.deepEqual(outcome(pgError('42501', 'FIN_BUFFER_NOT_FOUND_OR_DENIED')), { status: 403, message: 'FIN_ACCESS_DENIED', logged: [] });
  assert.deepEqual(outcome(pgError('23505', 'duplicate key value violates unique constraint "fin_x"')), { status: 409, message: 'FIN_COMMAND_CONFLICT', logged: [] });
  assert.deepEqual(outcome(pgError('23514', 'FIN_LINE_INVALID')), { status: 422, message: 'FIN_COMMAND_INVALID', logged: [] });
  assert.deepEqual(outcome(pgError('22001', 'value too long for type character varying(250)')), { status: 422, message: 'FIN_COMMAND_INVALID', logged: [] });
  assert.deepEqual(outcome(pgError('23514', 'constructor')), { status: 422, message: 'FIN_COMMAND_INVALID', logged: [] });
  assert.deepEqual(outcome(pgError('23505', '__proto__')), { status: 409, message: 'FIN_COMMAND_CONFLICT', logged: [] });
});
