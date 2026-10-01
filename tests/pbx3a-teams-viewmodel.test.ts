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

test('PBX3A-R02 (UI): replacement without handover coverage is blocked before submit; add-only / handover-only pass', async () => {
  const { replacementHandoverGaps } = await import('../apps/frontend/src/view-models/teams');
  const swap: RedistributeOp[] = [{ kind: 'memberEnd', objectId: 'o', memberUserId: 'a' }, { kind: 'memberAdd', objectId: 'o', memberUserId: 'b' }];
  assert.deepEqual(replacementHandoverGaps(swap), ['o']);
  assert.equal(canSubmitRedistribution('r', swap), false);
  const covered: RedistributeOp[] = [...swap, { kind: 'handover', objectId: 'o', outgoingUserId: 'a', incomingUserId: 'b' }];
  assert.equal(canSubmitRedistribution('r', covered), true);
  assert.equal(canSubmitRedistribution('r', [swap[1]]), true, 'addition-only');
  assert.equal(canSubmitRedistribution('r', [swap[0]]), true, 'removal-only');
  assert.equal(canSubmitRedistribution('r', [covered[2]]), true, 'handover-only');
});

/* PBX3A-LIVE-UI-01 — object-scoped engineer pickers */
import { objectMemberOptions } from '../apps/frontend/src/view-models/teams';

const eng = (userId: string, name: string, isActive = true) => ({ userId, name, isActive, orgManagerUserId: null });
const member = (userId: string, name: string, isActive = true) => ({ userId, name, isActive, assignmentId: 'a-' + userId, startedAt: '2026-01-01', version: 1, orgManagerUserId: null, orgManagerName: null, inherited: false });
const overview = {
  engineers: [eng('A', 'Ахматов'), eng('B', 'Бардакова'), eng('C', 'Сидоров'), eng('X', 'Неактивный', false)],
  objects: [
    { objectId: 'o1', name: 'Объект 1', lead: null, members: [member('A', 'Ахматов'), member('X', 'Неактивный', false)] },
    { objectId: 'o2', name: 'Объект 2', lead: null, members: [member('B', 'Бардакова')] },
  ],
};
const values = (o: { value: string }[]) => o.map((x) => x.value).sort();

test('PBX3A-LIVE-UI-01 A: memberEnd offers only current members of the selected object', () => {
  const opts = objectMemberOptions(overview, 'memberEnd', 'o1');
  assert.ok(values(opts).includes('A'));
  assert.ok(!values(opts).includes('B'));
  assert.ok(!values(opts).includes('C'));
});

test('PBX3A-LIVE-UI-01 B/C: memberAdd offers active non-members only; an engineer on another object stays eligible', () => {
  const opts = objectMemberOptions(overview, 'memberAdd', 'o1');
  assert.ok(!values(opts).includes('A'), 'already a member');
  assert.ok(values(opts).includes('B'), 'B works on o2 but is not on o1');
  assert.ok(values(opts).includes('C'));
  assert.ok(!values(opts).includes('X'), 'inactive engineers cannot be added');
});

test('PBX3A-LIVE-UI-01 D: no object selected (or unknown object) → empty, never the tenant list', () => {
  for (const kind of ['memberEnd', 'memberAdd'] as const) {
    assert.deepEqual(objectMemberOptions(overview, kind, ''), []);
    assert.deepEqual(objectMemberOptions(overview, kind, 'nope'), []);
  }
});

test('PBX3A-LIVE-UI-01 E: an inactive current member stays selectable for memberEnd, labelled «(недоступен)»', () => {
  const x = objectMemberOptions(overview, 'memberEnd', 'o1').find((o) => o.value === 'X');
  assert.equal(x?.label, 'Неактивный (недоступен)');
});

test('PBX3A-LIVE-UI-01: queued steps for the same object adjust the effective picker; other objects are unaffected', () => {
  const ended: RedistributeOp[] = [{ kind: 'memberEnd', objectId: 'o1', memberUserId: 'A' }];
  assert.ok(!values(objectMemberOptions(overview, 'memberEnd', 'o1', ended)).includes('A'), 'already queued for removal');
  assert.ok(!values(objectMemberOptions(overview, 'memberAdd', 'o1', ended)).includes('A'), 'no remove+add of the same person in one command');
  const added: RedistributeOp[] = [{ kind: 'memberAdd', objectId: 'o1', memberUserId: 'C' }];
  assert.ok(!values(objectMemberOptions(overview, 'memberAdd', 'o1', added)).includes('C'), 'already queued for addition');
  assert.ok(values(objectMemberOptions(overview, 'memberEnd', 'o1', added)).includes('C'));
  assert.ok(values(objectMemberOptions(overview, 'memberAdd', 'o2', added)).includes('C'), 'queued step on o1 does not affect o2');
  assert.ok(values(objectMemberOptions(overview, 'memberEnd', 'o2', ended)).includes('B'));
});
