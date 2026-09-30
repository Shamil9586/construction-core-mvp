import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roles, hasPermission, Permission } from '../packages/domain';
import { canRedistributeTeams, canViewTeamsOverview, canViewMyPtoTeam, canViewObjectPtoTeam } from '../apps/frontend/src/auth/internalRoles';
import { buildRedistributeCommand, canSubmitRedistribution, describeOp, type RedistributeOp } from '../apps/frontend/src/view-models/teams';

test('PBX-3A frontend role predicates agree with backend permissions for every role', () => {
  for (const role of roles) {
    assert.equal(canRedistributeTeams(role), hasPermission(role, Permission.FUNCTION_TEAM_MANAGE) && hasPermission(role, Permission.OBJECT_FUNCTION_LEAD_ASSIGN), role);
    assert.equal(canViewMyPtoTeam(role), role === 'PTO' || role === 'PTO_HEAD', role);
    // every role the UI offers the read-only overview to holds PTO_TEAM_READ on the backend
    if (canViewTeamsOverview(role) || canViewMyPtoTeam(role)) assert.equal(hasPermission(role, Permission.PTO_TEAM_READ), true, role);
    assert.equal(canViewObjectPtoTeam(role), canViewTeamsOverview(role) || canViewMyPtoTeam(role));
  }
  // General Director: read-only oversight, no controls; Deputy holds no ordinary PTO operational permission.
  assert.equal(canViewTeamsOverview('GENERAL_DIRECTOR'), true);
  assert.equal(canRedistributeTeams('GENERAL_DIRECTOR'), false);
  assert.equal(hasPermission('DEPUTY_DIRECTOR', Permission.PTO_EDIT), false);
  assert.equal(hasPermission('DEPUTY_DIRECTOR', Permission.DOCUMENTATION_MANAGE), false);
  assert.equal(hasPermission('PTO', Permission.PTO_OBJECT_TEAM_MANAGE), false);
  assert.equal(hasPermission('PTO_HEAD', Permission.PTO_OBJECT_TEAM_MANAGE), true);
});

test('PBX-3A: the Deputy\'s queued steps become ONE atomic command (Akhmetov/Orlov swap)', () => {
  const ops: RedistributeOp[] = [
    { kind: 'orgTransfer', memberUserId: 'akh', toManagerUserId: 'iva' },
    { kind: 'orgTransfer', memberUserId: 'orl', toManagerUserId: 'smi' },
    { kind: 'memberEnd', objectId: 'o3', memberUserId: 'akh' },
    { kind: 'memberAdd', objectId: 'o4', memberUserId: 'akh' },
    { kind: 'memberEnd', objectId: 'o4', memberUserId: 'orl' },
    { kind: 'memberAdd', objectId: 'o3', memberUserId: 'orl' },
    { kind: 'handover', objectId: 'o3', outgoingUserId: 'akh', incomingUserId: 'orl' },
    { kind: 'handover', objectId: 'o4', outgoingUserId: 'orl', incomingUserId: 'akh' },
  ];
  const cmd = buildRedistributeCommand('  Иванову нужен Ахметов ', ops);
  assert.equal(cmd.reason, 'Иванову нужен Ахметов');
  assert.equal(cmd.orgTransfers.length, 2); assert.equal(cmd.memberEnds.length, 2); assert.equal(cmd.memberAdds.length, 2); assert.equal(cmd.handovers.length, 2);
  assert.equal(cmd.leadChanges.length, 0); assert.equal(cmd.orgEnds.length, 0);
  assert.equal(canSubmitRedistribution('', ops), false, 'reason required');
  assert.equal(canSubmitRedistribution('r', []), false, 'at least one step');
  assert.equal(canSubmitRedistribution('r', ops), true);
  assert.equal(describeOp(ops[2], (id) => id, (id) => id), '«o3»: снять akh');
});
