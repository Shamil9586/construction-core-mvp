import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roles } from '../packages/domain';
import {
  LIFECYCLES, GPR_REVISION, QUANTITY_CHANGE_REQUEST, WORK_TYPE_PUBLICATION_REQUEST, RESULT_USE, FINISH_CHANGE_RECORD, FACT_SOURCE_MODE, IMPORT_BATCH_STATES,
  findTransition, commandsFrom, applyTransition, assertSeparationOfDuties, authorizeTransition, endpointById, GPR2_ENDPOINTS, Gpr2Permission, hasGpr2Permission,
  Gpr2Error, type Lifecycle
} from '../packages/domain/gpr2';

/**
 * GPR-2 R01 — lifecycles and transitions, positive AND negative (TD §5.2–5.5, §8.1, §9.3, §11.2, §12.1; D05/D11/D18/D21–D23, C10/C12/C13).
 * Roadmap acceptance: "all transitions have positive/negative tests". For each lifecycle the allowed rows are listed here by hand (the design's
 * sentences), and EVERY other (state × command) pair — over every command word any lifecycle knows — must be refused with INVALID_TRANSITION.
 */
const P = Gpr2Permission;
const ALL_COMMANDS = ['submit', 'discard', 'approve', 'return', 'supersede', 'revise', 'reject', 'retract', 'record-correction', 'reconcile-to-portion',
  'create-weu', 'create-first-weu', 'edit', 'delete', 'withdraw', 'reopen', 'approve-suitability', 'reject-suitability', 'register', 'publish', 'unlock'];

// [from, command, to, permission] — hand-written from the design text, one array per lifecycle.
const EXPECTED: Record<string, [string, string, string, Gpr2Permission | null][]> = {
  GPR_REVISION: [
    ['DRAFT', 'submit', 'SUBMITTED', P.SCHEDULE_AUTHOR],          // §8.1 DRAFT → SUBMITTED, РП
    ['DRAFT', 'discard', 'DISCARDED', P.SCHEDULE_AUTHOR],         // §8.1 the РП may discard their own unfinished draft
    ['SUBMITTED', 'approve', 'APPROVED', P.SCHEDULE_REVIEW],      // §8.1 SUBMITTED → APPROVED, deputy
    ['SUBMITTED', 'return', 'RETURNED', P.SCHEDULE_REVIEW],       // §8.1 SUBMITTED → RETURNED, deputy, with a reason
    ['APPROVED', 'supersede', 'SUPERSEDED', null]                 // §8.1 "superseded_by" — by a later approval, never by a role
  ],
  QUANTITY_CHANGE_REQUEST: [
    ['DRAFT', 'submit', 'SUBMITTED', P.QUANTITY_AUTHOR],          // §5.3 DRAFT → SUBMITTED
    ['SUBMITTED', 'approve', 'APPROVED', P.QUANTITY_REVIEW],      // §5.3 → APPROVED / RETURNED, deputy
    ['SUBMITTED', 'return', 'RETURNED', P.QUANTITY_REVIEW],
    ['RETURNED', 'revise', 'DRAFT', P.QUANTITY_AUTHOR]            // §5.3 "correction creates a new submission version"
  ],
  WORK_TYPE_PUBLICATION_REQUEST: [
    ['PENDING', 'approve', 'APPROVED', P.CORPORATE_PUBLICATION],  // §5.2 "Admin approve/reject"
    ['PENDING', 'reject', 'REJECTED', P.CORPORATE_PUBLICATION]
  ],
  RESULT_USE: [
    ['REGISTERED', 'supersede', 'SUPERSEDED', P.EXTERNAL_OUTCOME_RECORD],   // §5.5 REGISTERED / SUPERSEDED / RETRACTED, by the РП
    ['REGISTERED', 'retract', 'RETRACTED', P.EXTERNAL_OUTCOME_RECORD]
  ],
  FINISH_CHANGE_RECORD: [
    ['EFFECTIVE', 'record-correction', 'SUPERSEDED', P.EXTERNAL_OUTCOME_RECORD]  // §5.5 "a new record corrects the previous one, it does not edit it"
  ],
  FACT_SOURCE_MODE: [
    ['LEGACY_WORK', 'reconcile-to-portion', 'PORTION', null]      // §12.1 only a proven reconciliation switches the source — nobody by hand
  ]
};
const REASON_REQUIRED = new Set(['GPR_REVISION:return', 'QUANTITY_CHANGE_REQUEST:return', 'WORK_TYPE_PUBLICATION_REQUEST:reject', 'RESULT_USE:supersede', 'RESULT_USE:retract', 'FINISH_CHANGE_RECORD:record-correction']);
const SEPARATED = new Set(['GPR_REVISION:approve', 'QUANTITY_CHANGE_REQUEST:approve']);

const by = (name: string): Lifecycle => LIFECYCLES.find(l => l.name === name)!;
const thrown = (fn: () => unknown): Gpr2Error | undefined => { try { fn(); } catch (e: any) { return e; } };

test('the lifecycle catalogue is exactly the six the design fixes, each with a coherent state set', () => {
  assert.deepEqual(LIFECYCLES.map(l => l.name).sort(), Object.keys(EXPECTED).sort());
  for (const l of LIFECYCLES) {
    assert.ok(l.states.includes(l.initial), l.name + ' initial is a state');
    for (const s of l.terminal) assert.ok(l.states.includes(s), l.name + ' terminal ' + s);
    for (const tr of l.transitions) { assert.ok(l.states.includes(tr.from) && l.states.includes(tr.to), `${l.name}: ${tr.from}→${tr.to}`); assert.ok(!l.terminal.includes(tr.from), `${l.name}: a terminal state ${tr.from} has no way out`); }
    assert.ok(Object.isFrozen(l) && Object.isFrozen(l.transitions), l.name + ' is immutable');
  }
  assert.deepEqual([...GPR_REVISION.states], ['DRAFT', 'SUBMITTED', 'APPROVED', 'RETURNED', 'DISCARDED', 'SUPERSEDED']);
  assert.deepEqual([...IMPORT_BATCH_STATES], ['UPLOADED', 'PARSING', 'REVIEW_REQUIRED', 'READY', 'COMMITTED', 'FAILED', 'SUPERSEDED'], 'TD §7.3 states; edges deliberately left to the import stages');
});

// Titles are written out (not templated) so the decision index can find each lifecycle's tests by name.
const TITLE: Record<string, { positive: string; negative: string }> = {
  GPR_REVISION: { positive: 'GPR_REVISION: the allowed transitions are exactly the designed ones (positive), with the designed permission', negative: 'GPR_REVISION: every other (state × command) pair is refused with INVALID_TRANSITION (negative, exhaustive)' },
  QUANTITY_CHANGE_REQUEST: { positive: 'QUANTITY_CHANGE_REQUEST: the allowed transitions are exactly the designed ones (positive), with the designed permission', negative: 'QUANTITY_CHANGE_REQUEST: every other (state × command) pair is refused with INVALID_TRANSITION (negative, exhaustive)' },
  WORK_TYPE_PUBLICATION_REQUEST: { positive: 'WORK_TYPE_PUBLICATION_REQUEST: the allowed transitions are exactly the designed ones (positive), with the designed permission', negative: 'WORK_TYPE_PUBLICATION_REQUEST: every other (state × command) pair is refused with INVALID_TRANSITION (negative, exhaustive)' },
  RESULT_USE: { positive: 'RESULT_USE: the allowed transitions are exactly the designed ones (positive), with the designed permission', negative: 'RESULT_USE: every other (state × command) pair is refused with INVALID_TRANSITION (negative, exhaustive)' },
  FINISH_CHANGE_RECORD: { positive: 'FINISH_CHANGE_RECORD: the allowed transitions are exactly the designed ones (positive), with the designed permission', negative: 'FINISH_CHANGE_RECORD: every other (state × command) pair is refused with INVALID_TRANSITION (negative, exhaustive)' },
  FACT_SOURCE_MODE: { positive: 'FACT_SOURCE_MODE: the allowed transitions are exactly the designed ones (positive), with the designed permission', negative: 'FACT_SOURCE_MODE: every other (state × command) pair is refused with INVALID_TRANSITION (negative, exhaustive)' }
};

for (const l of LIFECYCLES) {
  test(TITLE[l.name].positive, () => {
    const expected = EXPECTED[l.name];
    assert.equal(l.transitions.length, expected.length, 'no undesigned transition exists');
    for (const [from, command, to, permission] of expected) {
      const row = findTransition(l, from, command);
      assert.ok(row, `${from} --${command}--> exists`);
      assert.equal(row!.to, to, `${from} --${command}--> ${to}`);
      assert.equal(row!.permission, permission, `${from} --${command}-- permission`);
      assert.equal(row!.reasonRequired, REASON_REQUIRED.has(`${l.name}:${command}`), `${from} --${command}-- reason`);
      assert.equal(row!.separationOfDuties, SEPARATED.has(`${l.name}:${command}`), `${from} --${command}-- separation`);
      assert.equal(applyTransition(l, from, command, { reason: 'причина', actorId: 'approver', authorId: 'author', submitterId: 'submitter' }).to, to);
    }
  });

  test(TITLE[l.name].negative, () => {
    const allowed = new Set(EXPECTED[l.name].map(([f, c]) => `${f}|${c}`));
    let refused = 0;
    for (const from of l.states)
      for (const command of new Set([...ALL_COMMANDS, ...l.transitions.map(t => t.command)])) {
        if (allowed.has(`${from}|${command}`)) continue;
        const e = thrown(() => applyTransition(l, from, command, { reason: 'r', actorId: 'a', authorId: 'b', submitterId: 'c' }));
        assert.ok(e instanceof Gpr2Error && e.code === 'INVALID_TRANSITION' && e.status === 422, `${l.name}: ${from} --${command}--> must be refused`);
        assert.deepEqual(e!.details, { machine: l.name, from, command });
        refused++;
      }
    assert.ok(refused > l.states.length * 10, 'a meaningful number of negative cases ran: ' + refused);
  });
}

test('D11: a returned revision is final for that row, a submitted one cannot be discarded or edited, an approved one is only ever superseded', () => {
  for (const state of ['RETURNED', 'DISCARDED', 'SUPERSEDED'] as const) assert.deepEqual(commandsFrom(GPR_REVISION, state), [], state + ' is terminal');
  assert.deepEqual(commandsFrom(GPR_REVISION, 'SUBMITTED').sort(), ['approve', 'return']);
  assert.deepEqual(commandsFrom(GPR_REVISION, 'APPROVED'), ['supersede']);
  assert.equal(findTransition(GPR_REVISION, 'SUBMITTED', 'discard'), undefined, '"return is not discard"; a submission cannot be withdrawn');
  assert.equal(findTransition(GPR_REVISION, 'RETURNED', 'submit'), undefined, 'the РП continues in a NEW draft, not in the returned row');
  assert.equal(findTransition(GPR_REVISION, 'APPROVED', 'return'), undefined, 'an approved plan is never rewritten');
});

test('reasons: a return / reject / retract / correction without real text is REASON_REQUIRED (422), blank and over-long included', () => {
  for (const [l, from, command] of [[GPR_REVISION, 'SUBMITTED', 'return'], [QUANTITY_CHANGE_REQUEST, 'SUBMITTED', 'return'], [WORK_TYPE_PUBLICATION_REQUEST, 'PENDING', 'reject'],
    [RESULT_USE, 'REGISTERED', 'retract'], [FINISH_CHANGE_RECORD, 'EFFECTIVE', 'record-correction']] as [Lifecycle, string, string][])
    for (const reason of [undefined, null, '', '   ', '\n\t', 'x'.repeat(2001)]) {
      const e = thrown(() => applyTransition(l, from, command, { reason }));
      assert.ok(e && e.code === 'REASON_REQUIRED' && e.status === 422, `${l.name} ${command} reason=${JSON.stringify(reason)?.slice(0, 12)}`);
    }
  assert.doesNotThrow(() => applyTransition(GPR_REVISION, 'SUBMITTED', 'return', { reason: ' нужна доработка ' }));
  assert.doesNotThrow(() => applyTransition(GPR_REVISION, 'SUBMITTED', 'approve', { actorId: 'd', authorId: 'a', submitterId: 's' }), 'approve needs no reason');
});

test('A19 (separation): the approver is neither the author nor the submitter — and an unknown id fails CLOSED', () => {
  const ctx = { actorId: 'deputy', authorId: 'pm', submitterId: 'pm' };
  for (const [l, from] of [[GPR_REVISION, 'SUBMITTED'], [QUANTITY_CHANGE_REQUEST, 'SUBMITTED']] as [Lifecycle, string][]) {
    assert.doesNotThrow(() => applyTransition(l, from, 'approve', ctx));
    for (const bad of [{ ...ctx, actorId: 'pm' }, { ...ctx, actorId: 'author-x', authorId: 'author-x' }, { ...ctx, actorId: 's2', submitterId: 's2' },
      { ...ctx, actorId: undefined }, { ...ctx, authorId: undefined }, { ...ctx, submitterId: null }, { ...ctx, actorId: '' }, {}]) {
      const e = thrown(() => applyTransition(l, from, 'approve', bad as any));
      assert.ok(e && e.code === 'SEPARATION_OF_DUTIES' && e.status === 422, l.name + ' ' + JSON.stringify(bad));
    }
  }
  assert.ok(thrown(() => assertSeparationOfDuties({ actorId: 'u', authorId: 'u', submitterId: 'v' })));
  assert.equal(thrown(() => assertSeparationOfDuties({ actorId: 'u', authorId: 'a', submitterId: 'b' })), undefined);
  // a return is a review, not an approval of one's own work: the design states the rule for approval only
  assert.doesNotThrow(() => applyTransition(GPR_REVISION, 'SUBMITTED', 'return', { reason: 'r' }));
});

test('system-driven rows (permission null) are authorised for NO role: supersede and the legacy→portion reconciliation can never be done by hand', () => {
  for (const [l, from, command] of [[GPR_REVISION, 'APPROVED', 'supersede'], [FACT_SOURCE_MODE, 'LEGACY_WORK', 'reconcile-to-portion']] as [Lifecycle, string, string][]) {
    const row = findTransition(l, from, command)!;
    assert.equal(row.permission, null);
    assert.equal(row.endpoint, null, 'no endpoint performs it');
    for (const role of roles) assert.equal(authorizeTransition(row, p => hasGpr2Permission(role, p)), false, `${role} × ${command}`);
  }
});

test('authorizeTransition follows the permission table: exactly the roles of the §11.3 matrix may perform each row', () => {
  const who = (l: Lifecycle, from: string, command: string) => roles.filter(r => authorizeTransition(findTransition(l, from, command)!, p => hasGpr2Permission(r, p)));
  assert.deepEqual(who(GPR_REVISION, 'DRAFT', 'submit'), ['PROJECT_MANAGER']);
  assert.deepEqual(who(GPR_REVISION, 'SUBMITTED', 'approve'), ['DEPUTY_DIRECTOR']);
  assert.deepEqual(who(GPR_REVISION, 'SUBMITTED', 'return'), ['DEPUTY_DIRECTOR']);
  assert.deepEqual(who(QUANTITY_CHANGE_REQUEST, 'DRAFT', 'submit'), ['PROJECT_MANAGER']);
  assert.deepEqual(who(QUANTITY_CHANGE_REQUEST, 'SUBMITTED', 'approve'), ['DEPUTY_DIRECTOR']);
  assert.deepEqual(who(WORK_TYPE_PUBLICATION_REQUEST, 'PENDING', 'approve'), ['ADMIN'], 'the one explicit Admin grant');
  assert.deepEqual(who(WORK_TYPE_PUBLICATION_REQUEST, 'PENDING', 'reject'), ['ADMIN']);
  assert.deepEqual(who(RESULT_USE, 'REGISTERED', 'retract'), ['PROJECT_MANAGER']);
});

test('C13: creating a first execution unit is not a transition — there is no command that flips LEGACY_WORK to PORTION, so 300 can never become 0 by that route', () => {
  for (const command of ['create-weu', 'create-first-weu', 'submit', 'approve', 'edit']) assert.equal(findTransition(FACT_SOURCE_MODE, 'LEGACY_WORK', command), undefined, command);
  assert.deepEqual(commandsFrom(FACT_SOURCE_MODE, 'LEGACY_WORK'), ['reconcile-to-portion']);
  assert.deepEqual(commandsFrom(FACT_SOURCE_MODE, 'PORTION'), [], 'no way back, no mixed mode in the first implementation');
  assert.equal(FACT_SOURCE_MODE.states.length, 2);
});

test('K03/D22/D23: no approval route for suitability exists — ResultUse has no APPROVED / REJECTED, and no lifecycle, command or endpoint speaks of one', () => {
  assert.deepEqual([...RESULT_USE.states], ['REGISTERED', 'SUPERSEDED', 'RETRACTED']);
  for (const l of LIFECYCLES) for (const tr of l.transitions) assert.doesNotMatch(tr.command + tr.endpoint, /suitab|пригод/i, `${l.name}:${tr.command}`);
  for (const e of GPR2_ENDPOINTS) assert.doesNotMatch(e.id + e.path, /suitab|approve-suitability/i, e.id);
  assert.equal(GPR2_ENDPOINTS.some(e => /finish-change/.test(e.id) && /approve|reject/.test(e.id)), false);
  // D21: the external-outcome record is append-only — no edit / delete command on it
  for (const command of ['edit', 'delete', 'update']) assert.equal(FINISH_CHANGE_RECORD.transitions.some(t => t.command === command), false);
});

test('every transition that names an endpoint names a real one, with the SAME permission — the table and the register cannot drift apart', () => {
  for (const l of LIFECYCLES)
    for (const tr of l.transitions) {
      if (tr.endpoint === null) { assert.equal(tr.permission, null, `${l.name}:${tr.command} has no endpoint, so it has no actor`); continue; }
      const e = endpointById(tr.endpoint);
      assert.ok(e, `${l.name}:${tr.command} → ${tr.endpoint}`);
      assert.deepEqual(e!.authorization, { type: 'PERMISSION', permission: tr.permission }, `${l.name}:${tr.command} permission`);
      assert.equal(e!.kind, 'COMMAND');
    }
  // and the reverse: every endpoint that claims a transition is claimed by a real row
  for (const e of GPR2_ENDPOINTS.filter(x => x.transition)) {
    const l = by(e.transition!.lifecycle);
    assert.ok(l, e.id + ' lifecycle exists');
    assert.ok(l.transitions.some(t => t.command === e.transition!.command && t.endpoint === e.id), `${e.id} ⇄ ${e.transition!.lifecycle}:${e.transition!.command}`);
  }
});
