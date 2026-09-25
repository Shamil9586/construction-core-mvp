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
test('F8.2.1: isDocumentationStatusTransitionAllowed — exactly the four listed edges are allowed', async () => {
  const { isDocumentationStatusTransitionAllowed } = await import('../packages/domain');
  assert.equal(isDocumentationStatusTransitionAllowed('DRAFT', 'PREPARING'), true);
  assert.equal(isDocumentationStatusTransitionAllowed('PREPARING', 'READY_FOR_PRESENTATION'), true);
  assert.equal(isDocumentationStatusTransitionAllowed('READY_FOR_PRESENTATION', 'PRESENTED'), true);
  assert.equal(isDocumentationStatusTransitionAllowed('PRESENTED', 'RETURNED'), true);
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

test('F8.2.1: isDocumentationStatusTransitionAllowed — CORRECTING and ACCEPTED_BY_CUSTOMER are unreachable in this phase, and RETURNED is a dead end', async () => {
  // ACCEPTED_BY_CUSTOMER "relates to the next stage" (Decision 5); CORRECTING
  // never appears in the Decision Lock's own allowed-edges list either — both
  // are deliberately not wired into this phase's transition graph, not an
  // omission. RETURNED has no outbound edge listed, so it is a dead end here
  // too — fixing a returned package is explicitly the next phase's concern.
  const { isDocumentationStatusTransitionAllowed } = await import('../packages/domain');
  assert.equal(isDocumentationStatusTransitionAllowed('PRESENTED', 'ACCEPTED_BY_CUSTOMER'), false);
  assert.equal(isDocumentationStatusTransitionAllowed('RETURNED', 'CORRECTING'), false);
  assert.equal(isDocumentationStatusTransitionAllowed('CORRECTING', 'READY_FOR_PRESENTATION'), false);
  assert.equal(isDocumentationStatusTransitionAllowed('RETURNED', 'PREPARING'), false);
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
