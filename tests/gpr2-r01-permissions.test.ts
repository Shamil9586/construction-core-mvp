import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Permission, roles, hasPermission, type Role } from '../packages/domain';
import {
  Gpr2Permission, GPR2_PERMISSIONS, GPR2_GRANTS, hasGpr2Permission, gpr2RoleMatrix, ESTIMATE_MAPPING_REVIEW, hasEstimateMappingReviewCapability, isAuthorized,
  NO_CAPABILITY_ASSIGNMENTS, type CapabilityAssignment
} from '../packages/domain/gpr2';

/**
 * GPR-2 R01 — explicit grants of the new functions, A19 at the DOMAIN level (TD §11.3, §14; D05/D11/D18, C10).
 *
 * The expectation table below is written out by hand from the §11.3 role matrix — it is NOT derived from GPR2_GRANTS — so the test compares
 * the implementation with the design, not with itself. The legacy snapshot is the permission set of the base commit 48f3ce7.
 */
const P = Gpr2Permission;
const ALL_ROLES = [...roles] as Role[];

// TD §11.3, one row per permission → the ONLY roles that hold it by default.
const MATRIX: Record<Gpr2Permission, Role[]> = {
  [P.SCHEDULE_AUTHOR]: ['PROJECT_MANAGER'],              // GPR draft / edit / submit: РП yes; deputy "no by default"; Admin "no by default"
  [P.SCHEDULE_REVIEW]: ['DEPUTY_DIRECTOR'],              // GPR approve / return: deputy only
  [P.QUANTITY_AUTHOR]: ['PROJECT_MANAGER'],              // quantity propose / submit: РП yes; deputy "no editor grant by default"
  [P.QUANTITY_REVIEW]: ['DEPUTY_DIRECTOR'],              // quantity approve / return: deputy only
  [P.QUANTITY_REVIEW_NOTE]: [],                          // "PTO by an explicit review grant" — nobody by default
  [P.EXTERNAL_OUTCOME_RECORD]: ['PROJECT_MANAGER'],      // record external suitability / ResultUse: РП yes; deputy reads only; Admin no
  [P.OBJECT_CATALOG_MANAGE]: ['PROJECT_MANAGER'],        // object WorkType / template adaptation: РП yes; deputy reads only
  [P.CORPORATE_PUBLICATION]: ['ADMIN'],                  // corporate WorkType / template publication: Admin (explicit dictionary grant); РП proposes only
  [P.IMPORT_MANAGE]: ['PROJECT_MANAGER']                 // BoQ / estimate import: РП
};

// The permission set of every role at the base commit, for the unchanged-legacy proof.
const LEGACY_PERMISSIONS = ['OBJECT_VIEW', 'OBJECT_CREATE', 'OBJECT_EDIT', 'OBJECT_MANAGE_CONTRACTORS', 'WORK_VIEW', 'WORK_CREATE', 'WORK_UPDATE_PROGRESS', 'INSPECTION_REQUEST', 'INSPECTION_ACCEPT', 'INSPECTION_REJECT', 'ISSUE_CREATE', 'ISSUE_RESOLVE', 'ISSUE_VERIFY', 'PTO_VIEW', 'PTO_EDIT', 'PTO_TRANSFER_SDO', 'SDO_VIEW', 'SDO_EDIT', 'SDO_CLOSE', 'FINANCE_VIEW', 'FINANCE_EDIT', 'ADMIN_USERS', 'ADMIN_DICTIONARIES', 'EXECUTION_UNIT_MANAGE', 'DOCUMENTATION_MANAGE', 'SDO_CASE_MANAGE', 'FUNCTION_TEAM_MANAGE', 'OBJECT_FUNCTION_LEAD_ASSIGN', 'PTO_OBJECT_TEAM_MANAGE', 'PTO_TEAM_READ', 'ORG_STRUCTURE_READ', 'SCHEDULE_VIEW', 'SCHEDULE_EDIT', 'SCHEDULE_APPROVE', 'SCHEDULE_DELAY_REASON'];
const SCHED_VIEW = ['SCHEDULE_VIEW'];
const LEGACY_GRANTS: Record<string, string[]> = {
  GENERAL_DIRECTOR: ['OBJECT_VIEW', 'WORK_VIEW', 'PTO_VIEW', 'SDO_VIEW', 'FINANCE_VIEW', 'PTO_TEAM_READ', 'ORG_STRUCTURE_READ', 'SCHEDULE_VIEW'],
  DEPUTY_DIRECTOR: ['OBJECT_VIEW', 'OBJECT_CREATE', 'OBJECT_EDIT', 'OBJECT_MANAGE_CONTRACTORS', 'WORK_VIEW', 'WORK_CREATE', 'PTO_VIEW', 'SDO_VIEW', 'FINANCE_VIEW', 'EXECUTION_UNIT_MANAGE', 'FUNCTION_TEAM_MANAGE', 'OBJECT_FUNCTION_LEAD_ASSIGN', 'PTO_TEAM_READ', 'ORG_STRUCTURE_READ', 'SCHEDULE_VIEW', 'SCHEDULE_EDIT', 'SCHEDULE_APPROVE', 'SCHEDULE_DELAY_REASON'],
  PROJECT_MANAGER: ['OBJECT_VIEW', 'OBJECT_EDIT', 'OBJECT_MANAGE_CONTRACTORS', 'WORK_VIEW', 'WORK_CREATE', 'WORK_UPDATE_PROGRESS', 'INSPECTION_REQUEST', 'ISSUE_RESOLVE', 'PTO_VIEW', 'SDO_VIEW', 'FINANCE_VIEW', 'EXECUTION_UNIT_MANAGE', 'SCHEDULE_VIEW', 'SCHEDULE_EDIT', 'SCHEDULE_DELAY_REASON'],
  CONSTRUCTION_CONTROL: ['OBJECT_VIEW', 'WORK_VIEW', 'INSPECTION_ACCEPT', 'INSPECTION_REJECT', 'ISSUE_CREATE', 'ISSUE_VERIFY', 'PTO_VIEW', 'SDO_VIEW', 'FINANCE_VIEW', ...SCHED_VIEW],
  CONSTRUCTION_CONTROL_HEAD: ['OBJECT_VIEW', 'WORK_VIEW', 'INSPECTION_ACCEPT', 'INSPECTION_REJECT', 'ISSUE_CREATE', 'ISSUE_VERIFY', 'PTO_VIEW', 'SDO_VIEW', 'FINANCE_VIEW', ...SCHED_VIEW],
  PTO: ['OBJECT_VIEW', 'WORK_VIEW', 'PTO_VIEW', 'PTO_EDIT', 'PTO_TRANSFER_SDO', 'SDO_VIEW', 'FINANCE_VIEW', 'DOCUMENTATION_MANAGE', 'PTO_TEAM_READ', ...SCHED_VIEW],
  PTO_HEAD: ['OBJECT_VIEW', 'WORK_VIEW', 'PTO_VIEW', 'PTO_EDIT', 'PTO_TRANSFER_SDO', 'SDO_VIEW', 'FINANCE_VIEW', 'DOCUMENTATION_MANAGE', 'PTO_OBJECT_TEAM_MANAGE', 'PTO_TEAM_READ', ...SCHED_VIEW],
  SDO: ['OBJECT_VIEW', 'WORK_VIEW', 'PTO_VIEW', 'SDO_VIEW', 'SDO_EDIT', 'SDO_CLOSE', 'FINANCE_VIEW', 'FINANCE_EDIT', 'SDO_CASE_MANAGE', ...SCHED_VIEW],
  SDO_HEAD: ['OBJECT_VIEW', 'WORK_VIEW', 'PTO_VIEW', 'SDO_VIEW', 'SDO_EDIT', 'SDO_CLOSE', 'FINANCE_VIEW', 'FINANCE_EDIT', 'SDO_CASE_MANAGE', ...SCHED_VIEW],
  CONTRACTOR_VIEWER: ['OBJECT_VIEW', 'WORK_VIEW']
};

test('A19 (domain): the §11.3 role matrix — every role × every GPR-2 permission matches the hand-written table', () => {
  assert.deepEqual([...GPR2_PERMISSIONS].sort(), Object.keys(MATRIX).sort(), 'the table covers exactly the permissions that exist');
  for (const permission of GPR2_PERMISSIONS)
    for (const role of ALL_ROLES)
      assert.equal(hasGpr2Permission(role, permission), MATRIX[permission].includes(role), `${role} × ${permission}`);
});

test('C10/D11: the РП edits and submits; the deputy approves and returns and does NOT edit; neither role holds the other\'s grant', () => {
  assert.ok(hasGpr2Permission('PROJECT_MANAGER', P.SCHEDULE_AUTHOR) && hasGpr2Permission('PROJECT_MANAGER', P.QUANTITY_AUTHOR));
  assert.ok(!hasGpr2Permission('PROJECT_MANAGER', P.SCHEDULE_REVIEW) && !hasGpr2Permission('PROJECT_MANAGER', P.QUANTITY_REVIEW), 'a РП never reviews');
  assert.ok(hasGpr2Permission('DEPUTY_DIRECTOR', P.SCHEDULE_REVIEW) && hasGpr2Permission('DEPUTY_DIRECTOR', P.QUANTITY_REVIEW));
  assert.ok(!hasGpr2Permission('DEPUTY_DIRECTOR', P.SCHEDULE_AUTHOR) && !hasGpr2Permission('DEPUTY_DIRECTOR', P.QUANTITY_AUTHOR), 'the deputy has no editor grant by default');
  assert.ok(!hasGpr2Permission('DEPUTY_DIRECTOR', P.EXTERNAL_OUTCOME_RECORD) && !hasGpr2Permission('DEPUTY_DIRECTOR', P.OBJECT_CATALOG_MANAGE), 'the deputy reads suitability / templates, does not record them');
});

test('"no new Admin business grants": ADMIN holds exactly one GPR-2 permission — corporate publication — and none of the business ones', () => {
  assert.deepEqual(GPR2_GRANTS.ADMIN, [P.CORPORATE_PUBLICATION]);
  for (const permission of GPR2_PERMISSIONS.filter(p => p !== P.CORPORATE_PUBLICATION)) assert.equal(hasGpr2Permission('ADMIN', permission), false, 'ADMIN × ' + permission);
  // the publication grant is the Admin side of D05 only; a РП can propose but never decide
  assert.equal(hasGpr2Permission('PROJECT_MANAGER', P.CORPORATE_PUBLICATION), false);
  assert.equal(hasGpr2Permission('DEPUTY_DIRECTOR', P.CORPORATE_PUBLICATION), false);
});

test('no automatic new-grants-from-enum: the GPR-2 permissions are outside `Permission`, so `Object.values(Permission)` (ADMIN\'s grant) cannot contain them', () => {
  const legacyValues = Object.values(Permission) as string[];
  assert.deepEqual([...legacyValues].sort(), [...LEGACY_PERMISSIONS].sort(), 'the legacy enum is exactly what it was at the base commit');
  for (const p of GPR2_PERMISSIONS) {
    assert.equal(legacyValues.includes(p), false, p + ' must not be a member of the legacy Permission enum');
    assert.match(p, /^GPR2_/);
    assert.equal(hasPermission('ADMIN', p as any), false, 'the legacy matrix never grants a GPR-2 permission, not even to ADMIN');
    for (const role of ALL_ROLES) assert.equal(hasPermission(role, p as any), false, role);
  }
  assert.deepEqual(new Set(GPR2_PERMISSIONS).size, GPR2_PERMISSIONS.length, 'no duplicate values');
});

test('unchanged legacy grants: every role holds exactly the legacy permissions it held at the base commit (R01 widens nothing)', () => {
  for (const role of ALL_ROLES) {
    const held = (Object.values(Permission) as Permission[]).filter(p => hasPermission(role, p)).sort();
    const expected = role === 'ADMIN' ? [...LEGACY_PERMISSIONS].sort() : [...LEGACY_GRANTS[role]].sort();
    assert.deepEqual(held, expected, role);
  }
});

test('every role has an explicit row in the GPR-2 table (a role added later must be decided, not defaulted); unknown or removed roles hold nothing', () => {
  assert.deepEqual(Object.keys(GPR2_GRANTS).sort(), [...roles].sort());
  for (const removed of ['TECHNICAL_DIRECTOR', 'DEPARTMENT_HEAD', 'CONSTRUCTION_DIRECTOR', 'DoC', '', 'admin', 'constructor', '__proto__', 'toString'])
    for (const p of GPR2_PERMISSIONS) assert.equal(hasGpr2Permission(removed, p), false, JSON.stringify(removed));
  for (const none of [null, undefined]) assert.equal(hasGpr2Permission(none as any, P.SCHEDULE_AUTHOR), false);
  assert.ok(Object.isFrozen(GPR2_GRANTS) && Object.isFrozen(GPR2_GRANTS.ADMIN), 'the table cannot be mutated at run time');
  const matrix = gpr2RoleMatrix();
  matrix.ADMIN.push(P.SCHEDULE_AUTHOR);
  assert.equal(hasGpr2Permission('ADMIN', P.SCHEDULE_AUTHOR), false, 'the exported matrix is a copy');
});

test('N01: ESTIMATE_MAPPING_REVIEW is default-deny for every role, ADMIN included, and exists only as an object-scoped assignment', () => {
  assert.equal(ESTIMATE_MAPPING_REVIEW, 'ESTIMATE_MAPPING_REVIEW');
  const subject = (role: string) => ({ tenantId: 't1', userId: 'u1', role });
  for (const role of ALL_ROLES) {
    assert.equal(hasEstimateMappingReviewCapability({ tenantId: 't1', userId: 'u1' }, 'o1'), false, 'no assignments on record → no (role ' + role + ' is not an input at all)');
    assert.equal(isAuthorized(subject(role), { type: 'CAPABILITY', capability: ESTIMATE_MAPPING_REVIEW }, 'o1'), false, role + ' has no role path to the capability');
  }
  assert.equal(NO_CAPABILITY_ASSIGNMENTS.length, 0);
  assert.ok(Object.isFrozen(NO_CAPABILITY_ASSIGNMENTS));
  // not a member of any permission list either
  assert.equal((Object.values(Permission) as string[]).includes(ESTIMATE_MAPPING_REVIEW), false);
  assert.equal((GPR2_PERMISSIONS as readonly string[]).includes(ESTIMATE_MAPPING_REVIEW), false);
});

test('N01: an assignment grants the capability only to that user, on that object, in that tenant, while it is not revoked — and never anything else', () => {
  const a: CapabilityAssignment = { tenantId: 't1', objectId: 'o1', userId: 'u1', capability: ESTIMATE_MAPPING_REVIEW, assignedBy: 'owner', assignedAt: '2026-10-19T00:00:00Z', revokedAt: null };
  const has = (s: { tenantId: string; userId: string }, objectId: string | null, list = [a]) => hasEstimateMappingReviewCapability(s, objectId, list);
  assert.equal(has({ tenantId: 't1', userId: 'u1' }, 'o1'), true);
  assert.equal(has({ tenantId: 't1', userId: 'u2' }, 'o1'), false, 'another user');
  assert.equal(has({ tenantId: 't1', userId: 'u1' }, 'o2'), false, 'another object');
  assert.equal(has({ tenantId: 't2', userId: 'u1' }, 'o1'), false, 'another tenant');
  assert.equal(has({ tenantId: 't1', userId: 'u1' }, null), false, 'no object, no object-scoped capability');
  assert.equal(has({ tenantId: 't1', userId: 'u1' }, 'o1', [{ ...a, revokedAt: '2026-10-20T00:00:00Z' }]), false, 'revoked');
  assert.equal(has({ tenantId: 't1', userId: 'u1' }, 'o1', [{ ...a, capability: 'OTHER' as any }]), false, 'a different capability');
  // the capability does not smuggle in the import grant, and holding the grant does not give the review
  assert.equal(isAuthorized({ tenantId: 't1', userId: 'u1', role: 'PTO' }, { type: 'PERMISSION', permission: P.IMPORT_MANAGE }, 'o1', [a]), false);
  assert.equal(isAuthorized({ tenantId: 't1', userId: 'u1', role: 'PROJECT_MANAGER' }, { type: 'CAPABILITY', capability: ESTIMATE_MAPPING_REVIEW }, 'o1'), false, 'the РП import grant is not the review capability');
  // proposals: "PM / designated specialist" — either path
  const proposals = { type: 'PERMISSION_OR_CAPABILITY', permission: P.IMPORT_MANAGE, capability: ESTIMATE_MAPPING_REVIEW } as const;
  assert.equal(isAuthorized({ tenantId: 't1', userId: 'x', role: 'PROJECT_MANAGER' }, proposals, 'o1'), true, 'the РП');
  assert.equal(isAuthorized({ tenantId: 't1', userId: 'u1', role: 'PTO' }, proposals, 'o1', [a]), true, 'the designated specialist');
  assert.equal(isAuthorized({ tenantId: 't1', userId: 'u1', role: 'PTO' }, proposals, 'o1'), false, 'the same specialist before the assignment exists');
});
