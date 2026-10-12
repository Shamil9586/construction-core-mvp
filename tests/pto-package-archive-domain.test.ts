import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveViolation, ARCHIVABLE_STATUSES, DEDICATED_FLOW_DOCUMENT_TYPES, BARE_DOCUMENT_REFUSED_MESSAGE, PACKAGE_ALREADY_ARCHIVED_MESSAGE, type PackageArchiveFacts } from '../packages/domain/package-archive';

/** Soft archive is for UNUSED / test packages; it must never hide a documentary process that is actually running (fail closed). */
const facts = (over: Partial<PackageArchiveFacts> = {}): PackageArchiveFacts => ({
  status: 'DRAFT', archivedAt: null, everPresented: false, customerAcceptances: 0, customerAcceptedQuantities: 0, hasSdoCase: false, generatedAosrs: 0, ...over,
});

test('archive: only DRAFT and PREPARING are archivable — every later lifecycle status is refused with a clear business error', () => {
  assert.deepEqual([...ARCHIVABLE_STATUSES], ['DRAFT', 'PREPARING']);
  assert.equal(archiveViolation(facts({ status: 'DRAFT' })), null);
  assert.equal(archiveViolation(facts({ status: 'PREPARING' })), null);
  for (const status of ['READY_FOR_PRESENTATION', 'PRESENTED', 'RETURNED', 'CORRECTING', 'ACCEPTED_BY_CUSTOMER']) {
    assert.match(archiveViolation(facts({ status })) ?? '', /Архивировать можно только пакет в статусе «Черновик» или «Подготовка»/, status);
  }
});

test('archive: each irreversible downstream fact blocks on its own, even when the status still says DRAFT/PREPARING (defence in depth)', () => {
  assert.match(archiveViolation(facts({ hasSdoCase: true })) ?? '', /передан в СДО/);
  assert.match(archiveViolation(facts({ customerAcceptances: 1 })) ?? '', /согласие заказчика/);
  assert.match(archiveViolation(facts({ customerAcceptedQuantities: 2 })) ?? '', /принятый заказчиком объём/);
  assert.match(archiveViolation(facts({ everPresented: true })) ?? '', /предъявлялся заказчику/);
  assert.match(archiveViolation(facts({ generatedAosrs: 1, status: 'PREPARING' })) ?? '', /сформированы АОСР/);
});

test('archive: a method declaration, a draft (unnumbered) AOSR record, a file-backed scheme and external references are NOT blockers — a disposable test package carries them', () => {
  // None of those exist as a fact in the rule: the only AOSR fact is a GENERATED one (number consumed / document created).
  assert.equal(archiveViolation(facts({ status: 'PREPARING', generatedAosrs: 0 })), null);
});

test('archive: an already archived package is refused first, with its own message', () => {
  assert.equal(archiveViolation(facts({ archivedAt: new Date() })), PACKAGE_ALREADY_ARCHIVED_MESSAGE);
});

test('bare document shells: AOSR and the executive scheme have dedicated flows and each has its own refusal text', () => {
  assert.deepEqual([...DEDICATED_FLOW_DOCUMENT_TYPES], ['AOSR', 'EXECUTIVE_SCHEME']);
  assert.match(BARE_DOCUMENT_REFUSED_MESSAGE.AOSR, /Пустой документ АОСР не создаётся/);
  assert.match(BARE_DOCUMENT_REFUSED_MESSAGE.EXECUTIVE_SCHEME, /Пустая исполнительная схема не создаётся/);
});
