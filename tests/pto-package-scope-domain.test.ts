import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPackageScope, zoneName, isPackageActive } from '../packages/domain/package-scope';

const portion = (id: string, label: string, over: any = {}) => ({ id, label, location: null, unit: 'м²', rpFact: '500', internalSc: '498', customerAccepted: null, ...over });

test('zone name: the location and the portion label are combined without repeating one inside the other', () => {
  assert.equal(zoneName('1 этаж', null), '1 этаж');
  assert.equal(zoneName('', '1 этаж'), '1 этаж');
  assert.equal(zoneName('Секция A', 'санузлы'), 'санузлы · Секция A');
  assert.equal(zoneName('1 этаж', '1 этаж'), '1 этаж');
  assert.equal(zoneName('1 этаж, секция А', '1 этаж'), '1 этаж, секция А');
});

test('scope summary: names for up to two zones (human order), a count otherwise; empty scope has none', () => {
  assert.equal(buildPackageScope([]).hasScope, false);
  assert.equal(buildPackageScope([]).zoneSummary, null);
  assert.equal(buildPackageScope([portion('b', '2 этаж'), portion('a', '1 этаж')]).zoneSummary, '1 этаж, 2 этаж');
  assert.equal(buildPackageScope([portion('a', '1 этаж'), portion('b', '2 этаж'), portion('c', '3 этаж')]).zoneSummary, '3 участка');
  assert.equal(buildPackageScope(Array.from({ length: 5 }, (_, i) => portion('p' + i, `Зона ${i}`))).zoneSummary, '5 участков');
  assert.equal(buildPackageScope(Array.from({ length: 21 }, (_, i) => portion('p' + i, `Зона ${i}`))).zoneSummary, '21 участок');
  assert.equal(buildPackageScope([portion('a', '10 этаж'), portion('b', '2 этаж')]).portions.map(p => p.zone).join(','), '2 этаж,10 этаж', 'numeric-aware order');
});

test('current quantity of the scope follows the accepted provenance: customer-accepted, else Internal SC, else RP fact — summed per portion', () => {
  assert.deepEqual(buildPackageScope([portion('a', '1 этаж')]).currentQuantity, { quantity: '498.0000', unit: 'м²', source: 'INTERNAL_SC' });
  assert.deepEqual(buildPackageScope([portion('a', '1 этаж', { customerAccepted: '496' })]).currentQuantity, { quantity: '496.0000', unit: 'м²', source: 'CUSTOMER_ACCEPTED' });
  assert.deepEqual(buildPackageScope([portion('a', '1 этаж', { internalSc: null })]).currentQuantity, { quantity: '500.0000', unit: 'м²', source: 'RP_FACT' });
  // two portions: the weakest source labels the total
  const two = buildPackageScope([portion('a', '1 этаж', { customerAccepted: '496' }), portion('b', '2 этаж')]);
  assert.equal(two.currentQuantity?.quantity, '994.0000');
  assert.equal(two.currentQuantity?.source, 'INTERNAL_SC');
  assert.equal(buildPackageScope([portion('a', 'x', { rpFact: null, internalSc: null })]).currentQuantity, null);
});

test('a package is active until it is soft-archived — the PTO lifecycle status never decides it', () => {
  assert.equal(isPackageActive({ archivedAt: null }), true);
  assert.equal(isPackageActive({}), true);
  assert.equal(isPackageActive({ archivedAt: new Date('2026-10-12T10:00:00Z') }), false);
});
