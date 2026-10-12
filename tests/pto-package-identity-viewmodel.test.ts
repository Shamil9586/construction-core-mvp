import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DocumentationPackage } from '../apps/frontend/src/types/api';
import { buildPackageIdentity, AOSR_METHOD_UNSET_TEXT, CREATOR_UNKNOWN_TEXT, SCOPE_NOT_SELECTED_TEXT } from '../apps/frontend/src/view-models/packageIdentity';

/** The package card's text is formatted from the backend read model — never hardcoded, never inferred client-side. */
function pkg(overrides: Partial<DocumentationPackage> = {}): DocumentationPackage {
  return {
    id: 'package-1', tenantId: 't', createdAt: '2026-10-03T11:05:00Z', updatedAt: '2026-10-03T11:05:00Z', version: 1,
    objectId: 'object-1', objectWorkId: 'work-1', status: 'DRAFT', responsibleUserId: 'u1', responsible: 'Шамиль', createdBy: 'u1',
    workName: 'Штукатурка стен', createdByName: 'Шамиль', aosrMethod: 'CORE',
    scope: { hasScope: true, portions: [], zoneSummary: '1 этаж', currentQuantity: { quantity: '498.0000', unit: 'м²', source: 'INTERNAL_SC' } },
    ...overrides,
  };
}

test('the card answers: Work, scope, CURRENT quantity, AOSR method, responsible — for the PILOT-W01-shaped package', () => {
  const id = buildPackageIdentity(pkg());
  assert.equal(id.workName, 'Штукатурка стен');
  assert.equal(id.scopeText, '1 этаж');
  assert.equal(id.scopeMissing, false);
  assert.equal(id.quantityText.replace(/ /g, ' '), '498 м²', 'current quantity only — not 500 → 498 → 496');
  assert.equal(id.quantitySourceText, 'подтверждено строительным контролем');
  assert.equal(id.methodText, 'Формируются в Core');
  assert.equal(id.responsible, 'Шамиль');
  assert.match(id.createdText, /^Создан: Шамиль, 03\.10\.2026/);
});

test('the AOSR method is shown as persisted: Core, outside Core, and — explicitly — NOT chosen (never inferred as outside Core)', () => {
  assert.equal(buildPackageIdentity(pkg({ aosrMethod: 'EXTERNAL' })).methodText, 'Формируются вне Core');
  const unset = buildPackageIdentity(pkg({ aosrMethod: null }));
  assert.equal(unset.methodText, AOSR_METHOD_UNSET_TEXT);
  assert.equal(unset.methodText, 'Способ подготовки АОСР не выбран');
  assert.equal(unset.methodDeclared, false);
});

test('a package with no scope says «Участок не выбран»; several portions show a concise summary; customer-accepted source is named', () => {
  const none = buildPackageIdentity(pkg({ scope: { hasScope: false, portions: [], zoneSummary: null, currentQuantity: null } }));
  assert.equal(none.scopeText, SCOPE_NOT_SELECTED_TEXT);
  assert.equal(none.scopeMissing, true);
  assert.equal(none.quantityText, null);
  const many = buildPackageIdentity(pkg({ scope: { hasScope: true, portions: [], zoneSummary: '3 участка', currentQuantity: { quantity: '1240', unit: 'м²', source: 'CUSTOMER_ACCEPTED' } } }));
  assert.equal(many.scopeText, '3 участка');
  assert.equal(many.quantityText.replace(/ /g, ' '), '1 240 м²');
  assert.equal(many.quantitySourceText, 'принято заказчиком');
});

test('a historical package with no recorded creator does not fabricate one', () => {
  assert.equal(buildPackageIdentity(pkg({ createdByName: null })).createdText, CREATOR_UNKNOWN_TEXT);
  assert.equal(buildPackageIdentity(pkg({ workName: null }), 'Запасное имя').workName, 'Запасное имя');
});
