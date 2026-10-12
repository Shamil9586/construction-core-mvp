import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DocumentationPackage } from '../apps/frontend/src/types/api';
import { buildPackageIdentity } from '../apps/frontend/src/view-models/packageIdentity';
import { buildW01ViewModel } from '../apps/frontend/src/view-models/w01';
import { buildPackageDetailViewModel } from '../apps/frontend/src/view-models/documentationPackage';
import { validateSnapshot } from '../apps/frontend/src/data/validateSnapshot';

/** Soft archive in the read models: archive is not a status, archived packages are separate, and eligibility is never guessed client-side. */
function pkg(over: Partial<DocumentationPackage> = {}): DocumentationPackage {
  return {
    id: 'package-1', tenantId: 't', createdAt: '2026-10-03T11:05:00Z', updatedAt: '2026-10-03T11:05:00Z', version: 1,
    objectId: 'object-1', objectWorkId: 'work-1', status: 'PREPARING', responsibleUserId: 'u1', responsible: 'Шамиль', createdBy: 'u1',
    workName: 'Штукатурка стен', createdByName: 'Шамиль', aosrMethod: 'EXTERNAL',
    scope: { hasScope: true, portions: [{ id: 'p1', label: '1 этаж', zone: '1 этаж', unit: 'м²', plannedQuantity: '500.0000', currentQuantity: '498.0000', quantitySource: 'INTERNAL_SC' }], zoneSummary: '1 этаж', currentQuantity: { quantity: '498.0000', unit: 'м²', source: 'INTERNAL_SC' } },
    ...over,
  } as DocumentationPackage;
}
const archivedPkg = (over: Partial<DocumentationPackage> = {}) =>
  pkg({ archivedAt: '2026-10-12T09:30:00Z', archivedBy: 'u9', archivedByName: 'Начальник ПТО', archiveReason: 'Тестовый пакет EXTERNAL-маршрута', ...over });

test('identity: an active package has no archive facts; an archived one says Архивирован with who / when / why', () => {
  assert.equal(buildPackageIdentity(pkg()).archive, null);
  const a = buildPackageIdentity(archivedPkg()).archive!;
  assert.equal(a.badgeText, 'Архивирован');
  assert.match(a.byText, /^Архивировал: Начальник ПТО, 12\.10\.2026/);
  assert.equal(a.reasonText, 'Причина: Тестовый пакет EXTERNAL-маршрута');
  // an archiver we cannot name is not invented
  assert.match(buildPackageIdentity(archivedPkg({ archivedByName: null })).archive!.byText, /^Архивировал: не зафиксировано, 12\.10\.2026/);
});

test('identity: the archive action is offered ONLY when the server says null («may be archived now») — a reason, an absent flag or an archived package never offers it', () => {
  assert.equal(buildPackageIdentity(pkg({ archiveBlocker: null })).canArchive, true);
  assert.equal(buildPackageIdentity(pkg({ archiveBlocker: 'Пакет предъявлялся заказчику — архивирование недоступно.' })).canArchive, false);
  assert.equal(buildPackageIdentity(pkg()).canArchive, false, 'older payload without the flag: never guessed');
  assert.equal(buildPackageIdentity(archivedPkg({ archiveBlocker: null })).canArchive, false);
});

test('W01: archived packages are a separate, per-work list — never mixed into the working packages', () => {
  const object: any = { id: 'object-1', name: 'Школа', externalCode: 'X', address: 'a', responsible: 'r', customerName: null, organizationName: 'o' };
  const work: any = { id: 'work-1', objectId: 'object-1', name: 'Штукатурка стен', unit: 'м²', plannedQuantity: '1', actualQuantity: '0', blockers: [], customerScAccepted: false, lastReportedAt: null, plannedStartDate: '2026-01-01', plannedFinishDate: '2026-02-01', actualStartDate: null, actualFinishDate: null, contractor: 'c', responsible: 'r', status: 'ACTIVE', scheduleStatus: 'GREEN', plannedProgress: 0, actualProgress: 0, variance: null, delayDays: 0, accepted: false, stale: false };
  const vm = buildW01ViewModel(work, object, [], [], [], [pkg({ id: 'active' })], [], [], [archivedPkg({ id: 'old' }), archivedPkg({ id: 'other-work', objectWorkId: 'work-2' })]);
  assert.deepEqual(vm.documentationPackages.map((p) => p.id), ['active']);
  assert.deepEqual(vm.archivedPackages.map((p) => p.id), ['old']);
  assert.equal(vm.archivedPackages[0]!.identity.archive?.badgeText, 'Архивирован');
  assert.equal(vm.archivedPackages[0]!.status.label, 'В подготовке', 'the status it had stays as history');
});

test('package detail: an archived package builds a read-only model that keeps its scope; the archive facts are on the identity', () => {
  const archived = archivedPkg();
  const vm = buildPackageDetailViewModel(
    archived, undefined, undefined, [],
    archived.scope.portions.map((p) => ({ documentationPackageId: archived.id, quantityPortionId: p.id })) as any,
    [], [], [], [], [], [],
  );
  assert.equal(vm.identity.archive?.badgeText, 'Архивирован');
  assert.equal(vm.identity.canArchive, false);
  assert.equal(vm.identity.scopeText, '1 этаж');
  assert.equal(vm.identity.methodText, 'Формируются вне Core');
});

test('validateSnapshot: an archived package must say when and why; an ACTIVE package can never claim to be archived', () => {
  const base = (): any => ({ objects: [], works: [], contractors: [], dependencies: [], inspections: [] });
  const ok = { ...base(), documentationPackages: [pkg({ archiveBlocker: null })], archivedDocumentationPackages: [archivedPkg()] };
  assert.doesNotThrow(() => validateSnapshot(ok));
  assert.throws(() => validateSnapshot({ ...base(), archivedDocumentationPackages: [archivedPkg({ archiveReason: undefined })] }));
  assert.throws(() => validateSnapshot({ ...base(), archivedDocumentationPackages: [archivedPkg({ archivedAt: undefined })] }));
  assert.throws(() => validateSnapshot({ ...base(), documentationPackages: [archivedPkg()] }), undefined, 'an archived package inside the working set is a contract violation');
  assert.throws(() => validateSnapshot({ ...base(), documentationPackages: [pkg({ archiveBlocker: 5 as any })] }));
});
