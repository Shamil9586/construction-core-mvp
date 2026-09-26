import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * F8.3 SDO / Closing — pure domain logic, no database, no server. Same style
 * tests/f8.2.1-domain.test.ts already uses for F8.2.1's own domain-level
 * decisions.
 */

test('F8.3: canAccessSdoWorkspace — SDO and ADMIN only', async () => {
  const { canAccessSdoWorkspace } = await import('../packages/domain');
  assert.equal(canAccessSdoWorkspace('SDO'), true);
  assert.equal(canAccessSdoWorkspace('ADMIN'), true);
  for (const role of ['GENERAL_DIRECTOR', 'TECHNICAL_DIRECTOR', 'PROJECT_MANAGER', 'CONSTRUCTION_CONTROL', 'PTO', 'DEPARTMENT_HEAD', 'CONTRACTOR_VIEWER'] as const) {
    assert.equal(canAccessSdoWorkspace(role), false, role);
  }
});

/* --------------------------------------------------------------------- *
 * SDO status workflow                                                    *
 * --------------------------------------------------------------------- */

test('F8.3: isSdoClosingStatusTransitionAllowed — exactly the six listed edges are allowed', async () => {
  const { isSdoClosingStatusTransitionAllowed } = await import('../packages/domain');
  assert.equal(isSdoClosingStatusTransitionAllowed('ON_RECONCILIATION', 'VERIFICATION_PASSED'), true);
  assert.equal(isSdoClosingStatusTransitionAllowed('ON_RECONCILIATION', 'ON_CORRECTION'), true);
  assert.equal(isSdoClosingStatusTransitionAllowed('ON_CORRECTION', 'ON_RECONCILIATION'), true);
  assert.equal(isSdoClosingStatusTransitionAllowed('VERIFICATION_PASSED', 'CLOSED'), true);
  assert.equal(isSdoClosingStatusTransitionAllowed('VERIFICATION_PASSED', 'ON_CORRECTION'), true);
  assert.equal(isSdoClosingStatusTransitionAllowed('CLOSED', 'ON_CORRECTION'), true);
});

test('F8.3: isSdoClosingStatusTransitionAllowed — representative forbidden transitions', async () => {
  const { isSdoClosingStatusTransitionAllowed } = await import('../packages/domain');
  assert.equal(isSdoClosingStatusTransitionAllowed('ON_RECONCILIATION', 'CLOSED'), false, 'skip-ahead');
  assert.equal(isSdoClosingStatusTransitionAllowed('CLOSED', 'VERIFICATION_PASSED'), false, 'CLOSED must go through ON_CORRECTION first');
  assert.equal(isSdoClosingStatusTransitionAllowed('CLOSED', 'ON_RECONCILIATION'), false);
  assert.equal(isSdoClosingStatusTransitionAllowed('ON_CORRECTION', 'VERIFICATION_PASSED'), false, 'ON_CORRECTION only leads back to ON_RECONCILIATION');
  assert.equal(isSdoClosingStatusTransitionAllowed('ON_CORRECTION', 'CLOSED'), false);
  assert.equal(isSdoClosingStatusTransitionAllowed('VERIFICATION_PASSED', 'ON_RECONCILIATION'), false, 'backward, not a listed edge');
  for (const s of ['ON_RECONCILIATION', 'VERIFICATION_PASSED', 'ON_CORRECTION', 'CLOSED']) {
    assert.equal(isSdoClosingStatusTransitionAllowed(s, s), false, `${s}: no same-status no-op`);
  }
});

/* --------------------------------------------------------------------- *
 * Readiness (decision 7)                                                 *
 * --------------------------------------------------------------------- */

test('F8.3: resolvePackageSdoReadiness — ready when a customer documentation acceptance record exists and every covered portion has a Customer SC confirmation', async () => {
  const { resolvePackageSdoReadiness } = await import('../packages/domain');
  const result = resolvePackageSdoReadiness({
    hasCustomerAcceptance: true,
    coveredPortionIds: ['p1', 'p2'],
    customerScConfirmedPortionIds: ['p1', 'p2'],
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.missingReasons, []);
});

test('F8.3: resolvePackageSdoReadiness — false when the customer documentation acceptance record is missing', async () => {
  const { resolvePackageSdoReadiness } = await import('../packages/domain');
  const result = resolvePackageSdoReadiness({
    hasCustomerAcceptance: false,
    coveredPortionIds: ['p1'],
    customerScConfirmedPortionIds: ['p1'],
  });
  assert.equal(result.ready, false);
  assert.ok(result.missingReasons.some((r) => /заказчика/.test(r)));
});

test('F8.3: resolvePackageSdoReadiness — false when a Customer SC quantity confirmation is missing for a covered portion', async () => {
  const { resolvePackageSdoReadiness } = await import('../packages/domain');
  const result = resolvePackageSdoReadiness({
    hasCustomerAcceptance: true,
    coveredPortionIds: ['p1', 'p2'],
    customerScConfirmedPortionIds: ['p1'],
  });
  assert.equal(result.ready, false);
  assert.ok(result.missingReasons.some((r) => /СК заказчика/.test(r)));
});

test('F8.3: resolvePackageSdoReadiness — false when the package covers zero Quantity Portions, even with a customer acceptance record', async () => {
  const { resolvePackageSdoReadiness } = await import('../packages/domain');
  const result = resolvePackageSdoReadiness({
    hasCustomerAcceptance: true,
    coveredPortionIds: [],
    customerScConfirmedPortionIds: [],
  });
  assert.equal(result.ready, false);
});

test('F8.3: resolvePackageSdoReadiness — this function never takes a document/package status at all; only the audited acceptance fact and Customer SC coverage decide readiness', async () => {
  const { resolvePackageSdoReadiness } = await import('../packages/domain');
  // A caller cannot satisfy readiness by passing a status string of any
  // kind — the type itself has no such field, so "status ==
  // ACCEPTED_BY_CUSTOMER" cannot be smuggled in as a readiness input even
  // by accident. The only way to make `ready` true is `hasCustomerAcceptance:
  // true`, which the caller (service.ts/read-service.ts) computes from the
  // dedicated documentation_customer_acceptances record's own existence.
  const result = resolvePackageSdoReadiness({
    hasCustomerAcceptance: false,
    coveredPortionIds: ['p1'],
    customerScConfirmedPortionIds: ['p1'],
  });
  assert.equal(result.ready, false, 'no status field exists to fake readiness with — only the acceptance fact can');
});

/* --------------------------------------------------------------------- *
 * Closing amount / allocation rule                                       *
 * --------------------------------------------------------------------- */

test('F8.3: SdoClosingAllocationService.canClose — no total amount blocks CLOSED', async () => {
  const { SdoClosingAllocationService } = await import('../packages/domain');
  const result = new SdoClosingAllocationService().canClose(null, []);
  assert.equal(result.allowed, false);
});

test('F8.3: SdoClosingAllocationService.canClose — no allocations at all allows CLOSED using the total amount', async () => {
  const { SdoClosingAllocationService } = await import('../packages/domain');
  const result = new SdoClosingAllocationService().canClose('1840000.00', []);
  assert.equal(result.allowed, true);
});

test('F8.3: SdoClosingAllocationService.canClose — partial allocation sum blocks CLOSED', async () => {
  const { SdoClosingAllocationService } = await import('../packages/domain');
  const result = new SdoClosingAllocationService().canClose('1840000.00', [{ amount: '1000000.00' }]);
  assert.equal(result.allowed, false);
});

test('F8.3: SdoClosingAllocationService.canClose — exact allocation sum allows CLOSED', async () => {
  const { SdoClosingAllocationService } = await import('../packages/domain');
  const result = new SdoClosingAllocationService().canClose('1840000.00', [{ amount: '1000000.00' }, { amount: '840000.00' }]);
  assert.equal(result.allowed, true);
});

test('F8.3: SdoClosingAllocationService.canClose — an over-allocation sum also blocks CLOSED, not only a shortfall', async () => {
  const { SdoClosingAllocationService } = await import('../packages/domain');
  const result = new SdoClosingAllocationService().canClose('1000000.00', [{ amount: '600000.00' }, { amount: '600000.00' }]);
  assert.equal(result.allowed, false);
});

/* --------------------------------------------------------------------- *
 * F8.3-R02 corrective: acceptance snapshot currency                     *
 * --------------------------------------------------------------------- */

test('F8.3-R02: isCustomerAcceptanceSnapshotCurrent — current when the accepted set exactly matches the current set (order-independent)', async () => {
  const { isCustomerAcceptanceSnapshotCurrent } = await import('../packages/domain');
  assert.equal(isCustomerAcceptanceSnapshotCurrent({ acceptedVersionIds: ['v1', 'v2'], currentDocumentCount: 2, currentVersionIds: ['v2', 'v1'] }), true);
});

test('F8.3-R02b: isCustomerAcceptanceSnapshotCurrent — a Package with zero Documentation Documents is never current (nothing to accept)', async () => {
  const { isCustomerAcceptanceSnapshotCurrent } = await import('../packages/domain');
  assert.equal(isCustomerAcceptanceSnapshotCurrent({ acceptedVersionIds: [], currentDocumentCount: 0, currentVersionIds: [] }), false);
});

test('F8.3-R02: isCustomerAcceptanceSnapshotCurrent — not current once a document gets a new version (the current id is no longer the accepted one)', async () => {
  const { isCustomerAcceptanceSnapshotCurrent } = await import('../packages/domain');
  // Same document, accepted at v1's id, but v2 now exists and is current.
  assert.equal(isCustomerAcceptanceSnapshotCurrent({ acceptedVersionIds: ['v1-id'], currentDocumentCount: 1, currentVersionIds: ['v2-id'] }), false);
});

test('F8.3-R02: isCustomerAcceptanceSnapshotCurrent — not current when a new, already-versioned document was added to the package after acceptance', async () => {
  const { isCustomerAcceptanceSnapshotCurrent } = await import('../packages/domain');
  assert.equal(isCustomerAcceptanceSnapshotCurrent({ acceptedVersionIds: ['v1'], currentDocumentCount: 2, currentVersionIds: ['v1', 'v2-new-doc'] }), false);
});

test('F8.3-R02: isCustomerAcceptanceSnapshotCurrent — not current when the accepted snapshot covers more than the package currently has', async () => {
  const { isCustomerAcceptanceSnapshotCurrent } = await import('../packages/domain');
  assert.equal(isCustomerAcceptanceSnapshotCurrent({ acceptedVersionIds: ['v1', 'v2'], currentDocumentCount: 1, currentVersionIds: ['v1'] }), false);
});

/* --------------------------------------------------------------------- *
 * F8.3-R02b corrective: every current document must have a version      *
 * --------------------------------------------------------------------- */

test('F8.3-R02b: isCustomerAcceptanceSnapshotCurrent — not current when a document has no version at all, even if the accepted set matches every version that DOES exist', async () => {
  const { isCustomerAcceptanceSnapshotCurrent } = await import('../packages/domain');
  // Document A has v1 (accepted); Document B exists but has no version yet.
  // acceptedVersionIds and currentVersionIds are both ['a-v1'] — equal sets —
  // but currentDocumentCount (2) does not match currentVersionIds.length (1).
  assert.equal(isCustomerAcceptanceSnapshotCurrent({ acceptedVersionIds: ['a-v1'], currentDocumentCount: 2, currentVersionIds: ['a-v1'] }), false);
});

test('F8.3-R02b: isCustomerAcceptanceSnapshotCurrent — a versionless document added after acceptance immediately breaks currency, even though both id arrays are unchanged', async () => {
  const { isCustomerAcceptanceSnapshotCurrent } = await import('../packages/domain');
  // Before: one document, one version, accepted — current.
  assert.equal(isCustomerAcceptanceSnapshotCurrent({ acceptedVersionIds: ['a-v1'], currentDocumentCount: 1, currentVersionIds: ['a-v1'] }), true);
  // After a second, versionless document is added: currentDocumentCount
  // rises to 2 but currentVersionIds is still just ['a-v1'] — no longer current.
  assert.equal(isCustomerAcceptanceSnapshotCurrent({ acceptedVersionIds: ['a-v1'], currentDocumentCount: 2, currentVersionIds: ['a-v1'] }), false);
});

/* --------------------------------------------------------------------- *
 * F8.3-17: canMutateDocumentationPackageContent — the one shared content-  *
 * freeze gate every content mutation route calls                         *
 * --------------------------------------------------------------------- */

test('F8.3-17: canMutateDocumentationPackageContent — allowed in every content-editable status with no SDO Case', async () => {
  const { canMutateDocumentationPackageContent } = await import('../packages/domain');
  for (const packageStatus of ['DRAFT', 'PREPARING', 'READY_FOR_PRESENTATION', 'CORRECTING']) {
    const result = canMutateDocumentationPackageContent({ packageStatus, sdoCaseExists: false, sdoCasePackageLocked: false });
    assert.equal(result.allowed, true, packageStatus);
    assert.equal(result.reason, null, packageStatus);
  }
});

test('F8.3-17: canMutateDocumentationPackageContent — rejected in every content-frozen status, even with no SDO Case', async () => {
  const { canMutateDocumentationPackageContent } = await import('../packages/domain');
  for (const packageStatus of ['PRESENTED', 'ACCEPTED_BY_CUSTOMER', 'RETURNED']) {
    const result = canMutateDocumentationPackageContent({ packageStatus, sdoCaseExists: false, sdoCasePackageLocked: false });
    assert.equal(result.allowed, false, packageStatus);
    assert.equal(typeof result.reason, 'string', packageStatus);
  }
});

test('F8.3-17: canMutateDocumentationPackageContent — a locked SDO Case freezes content even while the Package status itself reads CORRECTING', async () => {
  const { canMutateDocumentationPackageContent } = await import('../packages/domain');
  // Belt-and-suspenders: package_locked=true must never be second-guessed by
  // packageStatus, since the two are expected to never actually disagree in
  // practice, but the gate must not rely on that.
  const result = canMutateDocumentationPackageContent({ packageStatus: 'CORRECTING', sdoCaseExists: true, sdoCasePackageLocked: true });
  assert.equal(result.allowed, false);
  assert.equal(typeof result.reason, 'string');
});

test('F8.3-17: canMutateDocumentationPackageContent — an SDO Case that exists but is unlocked (returned to PTO) does not itself block content-editable statuses', async () => {
  const { canMutateDocumentationPackageContent } = await import('../packages/domain');
  const result = canMutateDocumentationPackageContent({ packageStatus: 'CORRECTING', sdoCaseExists: true, sdoCasePackageLocked: false });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, null);
});

test('F8.3-17: canMutateDocumentationPackageContent — a locked SDO Case is irrelevant once the Package status itself already rejects (no double-reason ambiguity)', async () => {
  const { canMutateDocumentationPackageContent } = await import('../packages/domain');
  // PRESENTED already rejects on status alone — this pins that the status
  // check fires first, matching the function's own read order.
  const result = canMutateDocumentationPackageContent({ packageStatus: 'PRESENTED', sdoCaseExists: true, sdoCasePackageLocked: true });
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? '', /PRESENTED/);
});
