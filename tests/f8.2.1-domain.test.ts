import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * F8.2.1 PTO Operations Layer — pure domain logic, no database, no server.
 * Same style tests/production-execution.test.ts already uses for F8.1's
 * pure `packages/domain` classes/functions.
 *
 * Decision 5 (status transition rules) and Decision 4 (PTO Attention Queue)
 * are both domain-level decisions per the Decision Lock's own "Step 2 —
 * Domain" split, kept out of service.ts/read-service.ts so the rule has
 * exactly one definition regardless of which layer calls it.
 */
test('F8.2.1: isDocumentationStatusTransitionAllowed — exactly the six listed edges are allowed', async () => {
  const { isDocumentationStatusTransitionAllowed } = await import('../packages/domain');
  assert.equal(isDocumentationStatusTransitionAllowed('DRAFT', 'PREPARING'), true);
  assert.equal(isDocumentationStatusTransitionAllowed('PREPARING', 'READY_FOR_PRESENTATION'), true);
  assert.equal(isDocumentationStatusTransitionAllowed('READY_FOR_PRESENTATION', 'PRESENTED'), true);
  assert.equal(isDocumentationStatusTransitionAllowed('PRESENTED', 'RETURNED'), true);
  // F8.2.1 Corrective Patch (F8.2.1-01) — the correction loop: a returned
  // package can be worked on, and once corrected, presented again.
  assert.equal(isDocumentationStatusTransitionAllowed('RETURNED', 'CORRECTING'), true);
  assert.equal(isDocumentationStatusTransitionAllowed('CORRECTING', 'PRESENTED'), true);
});

test('F8.2.1: isDocumentationStatusTransitionAllowed — DRAFT to PRESENTED and DRAFT to ACCEPTED_BY_CUSTOMER are refused, the Decision Lock\'s own named examples', async () => {
  const { isDocumentationStatusTransitionAllowed } = await import('../packages/domain');
  assert.equal(isDocumentationStatusTransitionAllowed('DRAFT', 'PRESENTED'), false);
  assert.equal(isDocumentationStatusTransitionAllowed('DRAFT', 'ACCEPTED_BY_CUSTOMER'), false);
});

test('F8.2.1: isDocumentationStatusTransitionAllowed — no backward transition, no skip-ahead, no same-status no-op', async () => {
  const { isDocumentationStatusTransitionAllowed } = await import('../packages/domain');
  assert.equal(isDocumentationStatusTransitionAllowed('PREPARING', 'DRAFT'), false, 'backward');
  assert.equal(isDocumentationStatusTransitionAllowed('READY_FOR_PRESENTATION', 'PREPARING'), false, 'backward');
  assert.equal(isDocumentationStatusTransitionAllowed('DRAFT', 'READY_FOR_PRESENTATION'), false, 'skip-ahead');
  assert.equal(isDocumentationStatusTransitionAllowed('PREPARING', 'PRESENTED'), false, 'skip-ahead');
  assert.equal(isDocumentationStatusTransitionAllowed('DRAFT', 'DRAFT'), false, 'same-status is not a listed edge');
  assert.equal(isDocumentationStatusTransitionAllowed('PREPARING', 'PREPARING'), false);
});

test('F8.2.1 Corrective (F8.2.1-01): ACCEPTED_BY_CUSTOMER remains unreachable, and CORRECTING is reachable only from RETURNED and only leads to PRESENTED — not a general re-entry point', async () => {
  // ACCEPTED_BY_CUSTOMER "relates to the next stage" (Decision 5) — still not
  // a PTO user action, unaffected by this corrective patch. CORRECTING is now
  // reachable, but strictly through the one new edge (RETURNED -> CORRECTING
  // -> PRESENTED) — not from DRAFT/PREPARING/READY_FOR_PRESENTATION, and it
  // does not skip back to READY_FOR_PRESENTATION or loop back to RETURNED.
  const { isDocumentationStatusTransitionAllowed } = await import('../packages/domain');
  assert.equal(isDocumentationStatusTransitionAllowed('PRESENTED', 'ACCEPTED_BY_CUSTOMER'), false);
  assert.equal(isDocumentationStatusTransitionAllowed('RETURNED', 'ACCEPTED_BY_CUSTOMER'), false);
  assert.equal(isDocumentationStatusTransitionAllowed('CORRECTING', 'ACCEPTED_BY_CUSTOMER'), false);

  assert.equal(isDocumentationStatusTransitionAllowed('DRAFT', 'CORRECTING'), false, 'only RETURNED leads into CORRECTING');
  assert.equal(isDocumentationStatusTransitionAllowed('PREPARING', 'CORRECTING'), false);
  assert.equal(isDocumentationStatusTransitionAllowed('READY_FOR_PRESENTATION', 'CORRECTING'), false);
  assert.equal(isDocumentationStatusTransitionAllowed('PRESENTED', 'CORRECTING'), false, 'PRESENTED must go through RETURNED first, not straight to CORRECTING');

  assert.equal(isDocumentationStatusTransitionAllowed('CORRECTING', 'READY_FOR_PRESENTATION'), false, 'CORRECTING only leads to PRESENTED, not back to READY_FOR_PRESENTATION');
  assert.equal(isDocumentationStatusTransitionAllowed('CORRECTING', 'DRAFT'), false, 'no backward move out of CORRECTING');
  assert.equal(isDocumentationStatusTransitionAllowed('CORRECTING', 'RETURNED'), false, 'CORRECTING does not loop back to RETURNED');
  assert.equal(isDocumentationStatusTransitionAllowed('CORRECTING', 'CORRECTING'), false, 'no same-status no-op');

  assert.equal(isDocumentationStatusTransitionAllowed('RETURNED', 'PREPARING'), false, 'RETURNED only leads to CORRECTING now, not back to PREPARING');
  assert.equal(isDocumentationStatusTransitionAllowed('RETURNED', 'RETURNED'), false);
});

/* --------------------------------------------------------------------- *
 * Decision 4 — PTO Attention Queue                                       *
 * --------------------------------------------------------------------- */

test('F8.2.1: resolveDocumentationAttention — a work with no package at all reads RED, "Нет пакета ИД"', async () => {
  const { resolveDocumentationAttention } = await import('../packages/domain');
  const result = resolveDocumentationAttention([]);
  assert.equal(result.level, 'RED');
  assert.equal(result.reason, 'Нет пакета ИД');
});

test('F8.2.1: resolveDocumentationAttention — DRAFT or PREPARING reads YELLOW, "Документы формируются"', async () => {
  const { resolveDocumentationAttention } = await import('../packages/domain');
  assert.equal(resolveDocumentationAttention(['DRAFT']).level, 'YELLOW');
  assert.equal(resolveDocumentationAttention(['PREPARING']).level, 'YELLOW');
  assert.equal(resolveDocumentationAttention(['PREPARING']).reason, 'Документы формируются');
});

test('F8.2.1: resolveDocumentationAttention — READY_FOR_PRESENTATION clears the queue (NONE)', async () => {
  const { resolveDocumentationAttention } = await import('../packages/domain');
  const result = resolveDocumentationAttention(['READY_FOR_PRESENTATION']);
  assert.equal(result.level, 'NONE');
  assert.equal(result.reason, null);
});

test('F8.2.1: resolveDocumentationAttention — PRESENTED and ACCEPTED_BY_CUSTOMER also clear the queue: nothing left for PTO to do right now', async () => {
  const { resolveDocumentationAttention } = await import('../packages/domain');
  assert.equal(resolveDocumentationAttention(['PRESENTED']).level, 'NONE');
  assert.equal(resolveDocumentationAttention(['ACCEPTED_BY_CUSTOMER']).level, 'NONE');
});

test('F8.2.1: resolveDocumentationAttention — RETURNED reads RED again, same urgency as no package at all', async () => {
  const { resolveDocumentationAttention } = await import('../packages/domain');
  const result = resolveDocumentationAttention(['RETURNED']);
  assert.equal(result.level, 'RED');
  assert.ok(result.reason);
});

test('F8.2.1: resolveDocumentationAttention — multiple packages on one work: the worst level wins, RED over YELLOW over NONE', async () => {
  const { resolveDocumentationAttention } = await import('../packages/domain');
  assert.equal(resolveDocumentationAttention(['READY_FOR_PRESENTATION', 'DRAFT']).level, 'YELLOW', 'one still-preparing package keeps the work in the queue');
  assert.equal(resolveDocumentationAttention(['RETURNED', 'PRESENTED']).level, 'RED', 'one returned package outranks a presented sibling');
  assert.equal(resolveDocumentationAttention(['PRESENTED', 'READY_FOR_PRESENTATION']).level, 'NONE', 'both clear, no attention needed');
});
