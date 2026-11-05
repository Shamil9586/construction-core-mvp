import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Permission, roles, type Role } from '../packages/domain';
import { canReadFinPlan, canWriteFinPlan } from '../packages/domain/fin-sdo-1';

/**
 * FIN1-19 (domain level). The table is written by hand from DEC-01 — it is NOT derived from canReadFinPlan / canWriteFinPlan.
 *   SDO / SDO_HEAD write; GENERAL_DIRECTOR / DEPUTY_DIRECTOR read only; ADMIN within the tenant;
 *   РП / ПТО / СК / СК-руководитель / CONTRACTOR_VIEWER — no FIN access.
 */
const READ: Role[] = ['SDO', 'SDO_HEAD', 'GENERAL_DIRECTOR', 'DEPUTY_DIRECTOR', 'ADMIN'];
const WRITE: Role[] = ['SDO', 'SDO_HEAD', 'ADMIN'];

test('FIN1-19: every real role × FIN read/write matches the DEC-01 table; unknown roles are denied', () => {
  for (const role of roles) {
    assert.equal(canReadFinPlan(role), READ.includes(role), `${role} read`);
    assert.equal(canWriteFinPlan(role), WRITE.includes(role), `${role} write`);
  }
  for (const unknown of ['', 'admin', 'Sdo', 'ROOT', 'SDO ', 'PTO_HEAD ']) {
    assert.equal(canReadFinPlan(unknown), false, `unknown "${unknown}" read`);
    assert.equal(canWriteFinPlan(unknown), false, `unknown "${unknown}" write`);
  }
});

test('FIN1-19: the read-only roles never hold write', () => {
  for (const role of ['GENERAL_DIRECTOR', 'DEPUTY_DIRECTOR'] as Role[]) assert.ok(canReadFinPlan(role) && !canWriteFinPlan(role), role);
});

test('FIN1-27: FIN access is not inherited from broad legacy SDO_VIEW / FINANCE_VIEW, and adds nothing to the legacy Permission enum', () => {
  assert.ok(!Object.values(Permission).some(p => /^FIN_SDO/.test(p)), 'no FIN_SDO_* member in the legacy enum (it would widen ADMIN and the R01 legacy pin)');
  // roles that hold SDO_VIEW / FINANCE_VIEW in the legacy matrix but have no FIN access:
  for (const role of ['PROJECT_MANAGER', 'CONSTRUCTION_CONTROL', 'CONSTRUCTION_CONTROL_HEAD', 'PTO', 'PTO_HEAD'] as Role[])
    assert.ok(!canReadFinPlan(role), `${role} must not read FIN`);
});

test('FIN access role lists in TypeScript and in the SQL authorisation function are identical', () => {
  const sql = readFileSync(new URL('../design/fin-sdo-1/schema-UNNUMBERED.sql', import.meta.url), 'utf8');
  const list = (op: string) => {
    const m = new RegExp(`p_operation='${op}' AND u\\.role IN \\(([^)]*)\\)`).exec(sql);
    assert.ok(m, `SQL ${op} role list found`);
    return m![1].split(',').map(s => s.trim().replace(/'/g, '')).sort();
  };
  assert.deepEqual(list('READ'), [...READ].sort());
  assert.deepEqual(list('WRITE'), [...WRITE].sort());
});
