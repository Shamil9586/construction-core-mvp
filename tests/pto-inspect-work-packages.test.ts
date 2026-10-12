import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classify, recommendation, archiveBlocker } from '../scripts/inspect-work-packages';

const MAIN = 'bebcf645-40ae-4266-92d1-96f04c6f50f8';
const EXTERNAL = 'bd482e68-5e79-43c8-98eb-df012a7d4e4e';

const facts = (over: Record<string, unknown> = {}) => ({
  id: 'p-x', status: 'DRAFT', version: 1, createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'Шамиль', responsible: 'Шамиль',
  portions: [] as string[], aosrMethod: null as string | null, documents: 0, documentVersions: 0, aosrRecords: 0, statusChanges: 0,
  customerAcceptances: 0, customerAcceptedQuantities: 0, everPresented: false, generatedAosrs: 0, sdoCase: null as string | null,
  archivedAt: null as string | null, archiveReason: null as string | null, archivedBy: null as string | null, ...over,
});

test('inspection classification: main / external verification / unscoped draft / unexpected', () => {
  assert.equal(classify(facts({ id: MAIN, status: 'PRESENTED', portions: ['1 этаж'] }), MAIN, EXTERNAL), 'A_MAIN');
  assert.equal(classify(facts({ id: EXTERNAL, status: 'READY_FOR_PRESENTATION', aosrMethod: 'EXTERNAL', portions: ['1 этаж'] }), MAIN, EXTERNAL), 'B_EXTERNAL_VERIFICATION');
  assert.equal(classify(facts({ id: 'other', aosrMethod: 'EXTERNAL' }), MAIN, EXTERNAL), 'B_EXTERNAL_VERIFICATION', 'any recorded EXTERNAL method is an external verification package');
  assert.equal(classify(facts(), MAIN, EXTERNAL), 'C_UNSCOPED_DRAFT');
  // anything that ever carried work is NOT a click-through leftover — a person must look at it
  assert.equal(classify(facts({ documents: 1 }), MAIN, EXTERNAL), 'D_UNEXPECTED');
  assert.equal(classify(facts({ statusChanges: 2, status: 'RETURNED' }), MAIN, EXTERNAL), 'D_UNEXPECTED');
  assert.equal(classify(facts({ portions: ['2 этаж'] }), MAIN, EXTERNAL), 'D_UNEXPECTED', 'a scoped draft is not an unscoped leftover');
  assert.equal(classify(facts({ sdoCase: 'ON_RECONCILIATION' }), MAIN, EXTERNAL), 'D_UNEXPECTED');
});

test('inspection script is read-only by construction: one READ ONLY transaction, no write statement', () => {
  const source = fs.readFileSync('scripts/inspect-work-packages.ts', 'utf8');
  assert.match(source, /BEGIN READ ONLY/);
  assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\//g, ''), /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s|ALTER\s|TRUNCATE)\b/i);
});

test('inspection recommendation: the audited archive is proposed only where the backend rule would accept it, with the agreed reasons', () => {
  const external = facts({ id: EXTERNAL, status: 'PREPARING', aosrMethod: 'EXTERNAL', portions: ['1 этаж'], documents: 1, documentVersions: 1 });
  assert.equal(archiveBlocker(external), null, 'a declared method and a file-backed scheme do not block the archive');
  assert.deepEqual(recommendation(external, 'B_EXTERNAL_VERIFICATION'), { action: 'ARCHIVE', suggestedReason: 'Тестовый пакет EXTERNAL-маршрута', blocker: null });
  assert.deepEqual(recommendation(facts(), 'C_UNSCOPED_DRAFT'), { action: 'ARCHIVE', suggestedReason: 'Старый тестовый пакет', blocker: null });
  // the main package is always kept active, whatever the rule says
  assert.equal(recommendation(facts({ id: MAIN, status: 'DRAFT' }), 'A_MAIN').action, 'KEEP_ACTIVE');
  // anything past preparation / with downstream history is kept as history (fail closed), with the reason
  const presented = recommendation(facts({ status: 'PRESENTED', aosrMethod: 'EXTERNAL' }), 'B_EXTERNAL_VERIFICATION');
  assert.equal(presented.action, 'KEEP_AS_HISTORY');
  assert.match(presented.blocker ?? '', /уже в документообороте/);
  assert.equal(recommendation(facts({ aosrMethod: 'CORE', generatedAosrs: 2, status: 'PREPARING' }), 'D_UNEXPECTED').action, 'KEEP_AS_HISTORY');
  // an unexpected archivable package is for a person to review, never auto-proposed
  assert.equal(recommendation(facts({ portions: ['2 этаж'] }), 'D_UNEXPECTED').action, 'REVIEW_THEN_ARCHIVE');
  assert.equal(recommendation(facts({ archivedAt: '2026-10-12T09:30:00.000Z', archiveReason: 'x' }), 'B_EXTERNAL_VERIFICATION').action, 'ALREADY_ARCHIVED');
});
