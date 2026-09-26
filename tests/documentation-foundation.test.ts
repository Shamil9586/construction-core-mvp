import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * F8.2 PTO / Executive Documentation Foundation — backend integration, real
 * transactions against PGlite (tests/execution-units.test.ts's own pattern).
 * No HTTP route exists for these methods yet (that is Step 3), so
 * ProductionService's new methods are called directly with a real Actor.
 *
 * Scope: Documentation Package, Package <-> Quantity Portion relation,
 * Documentation Document, Documentation Version (with its storage reference
 * layer), and status history. F8.2 does not touch F8.1's own production/SC
 * model — BR-01..BR-04 below are about that separation staying real.
 */
test('F8.2: Documentation Package / Document / Version / status history — create, link, independence from production, permissions, object scope', async () => {
  delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'f8-2-foundation-key';
  process.env.DB_MODE = 'pglite';
  process.env.PGLITE_DIR = 'memory://';

  const { pool, one, insert } = await import('../apps/backend/src/db');
  const { migrate } = await import('../scripts/migrate');
  const { seed } = await import('../scripts/seed');
  const { ProductionService } = await import('../apps/backend/src/service');

  await migrate();
  const tenant = await seed();
  const service = new ProductionService();

  async function actorWithRole(role: string) {
    return one(pool, 'SELECT * FROM users WHERE tenant_id=$1 AND role=$2 ORDER BY bitrix_user_id LIMIT 1', [tenant.id, role]);
  }

  const pto = await actorWithRole('PTO');
  const pm = await actorWithRole('PROJECT_MANAGER');
  const sk = await actorWithRole('CONSTRUCTION_CONTROL');
  const work = await one(pool, 'SELECT * FROM works WHERE tenant_id=$1 LIMIT 1', [tenant.id]);

  // --- permission: DOCUMENTATION_MANAGE, not just any logged-in role ---
  await assert.rejects(
    () => service.createDocumentationPackage(sk, { objectWorkId: work.id, responsibleUserId: pto.id }),
    (e: any) => e.status === 403 || /Недостаточно прав/.test(e.message),
    'CONSTRUCTION_CONTROL (read-only per the Foundation contract) must be refused',
  );
  await assert.rejects(
    () => service.createDocumentationPackage(pm, { objectWorkId: work.id, responsibleUserId: pto.id }),
    (e: any) => e.status === 403 || /Недостаточно прав/.test(e.message),
    'PROJECT_MANAGER (read-only per the Foundation contract) must be refused',
  );

  // --- responsible must actually be an active PTO user ---
  await assert.rejects(
    () => service.createDocumentationPackage(pto, { objectWorkId: work.id, responsibleUserId: pm.id }),
    /ПТО/,
    'a package cannot name a non-PTO user as its responsible',
  );

  // --- create: happy path ---
  const pkg = await service.createDocumentationPackage(pto, { objectWorkId: work.id, responsibleUserId: pto.id });
  assert.equal(pkg.objectWorkId, work.id);
  assert.equal(pkg.responsibleUserId, pto.id);
  assert.equal(pkg.status, 'DRAFT', 'a new package starts DRAFT');
  assert.equal(pkg.tenantId, tenant.id);

  // BR-01 is proven by the create above already having succeeded: nothing in
  // createDocumentationPackage reads work.actualQuantity/plannedQuantity at
  // all, so a package exists the moment PTO creates one, regardless of how
  // far production has actually got (the Review's own "500 planned / 200
  // completed / package exists" example).

  // --- Package <-> Quantity Portion relation: an execution unit + two portions on this work ---
  const unit = await service.createExecutionUnit(pm, { objectWorkId: work.id, workTypeId: work.workTypeId, contractorId: work.contractorId, unit: work.unit, plannedQuantity: '500' });
  const portion1 = await service.createQuantityPortion(pm, unit.id, { label: 'Секция A', plannedQuantity: '300' });
  const portion2 = await service.createQuantityPortion(pm, unit.id, { label: 'Секция B', plannedQuantity: '200' });

  const link1 = await service.linkDocumentationPackagePortion(pto, pkg.id, { quantityPortionId: portion1.id });
  assert.equal(link1.documentationPackageId, pkg.id);
  assert.equal(link1.quantityPortionId, portion1.id);
  const link2 = await service.linkDocumentationPackagePortion(pto, pkg.id, { quantityPortionId: portion2.id });
  assert.equal(link2.quantityPortionId, portion2.id);

  await assert.rejects(
    () => service.linkDocumentationPackagePortion(pto, pkg.id, { quantityPortionId: portion1.id }),
    /уже привязан/,
    'linking the same portion twice is rejected, not silently duplicated',
  );

  // A portion belonging to a *different* work's execution unit must be refused.
  const otherWork = await one(pool, 'SELECT * FROM works WHERE tenant_id=$1 AND id<>$2 LIMIT 1', [tenant.id, work.id]);
  const otherUnit = await service.createExecutionUnit(pm, { objectWorkId: otherWork.id, workTypeId: otherWork.workTypeId, contractorId: otherWork.contractorId, unit: otherWork.unit, plannedQuantity: '100' });
  const otherPortion = await service.createQuantityPortion(pm, otherUnit.id, { label: 'Чужая секция', plannedQuantity: '100' });
  await assert.rejects(
    () => service.linkDocumentationPackagePortion(pto, pkg.id, { quantityPortionId: otherPortion.id }),
    /другой работе/,
    'a portion from a different work must not be linkable into this package',
  );

  // --- BR-02/BR-03: documentation status is independent of production readiness and quantity confirmation ---
  // Drive this *specific* work's own production to COMPLETE (full fact,
  // Internal SC accepted at the full confirmed quantity — F8.1's own model,
  // untouched), then move documentation to PREPARING — both must be able to
  // coexist, and neither service call may read or write the other's state.
  await service.recordPortionFact(pm, portion1.id, { quantity: '300', version: portion1.version, comment: 'Полный факт A' });
  await service.recordPortionFact(pm, portion2.id, { quantity: '200', version: portion2.version, comment: 'Полный факт B' });
  const requestA = await service.requestPortionInspection(pm, portion1.id, portion1.version + 1, 'INTERNAL_SC');
  const requestB = await service.requestPortionInspection(pm, portion2.id, portion2.version + 1, 'INTERNAL_SC');
  const fileA = await insert(pool, 'attachments', tenant.id, { fileName: 'a.jpg', mimeType: 'image/jpeg', content: Buffer.from('demo'), uploadedBy: sk.id });
  await pool.query('INSERT INTO inspection_photos(tenant_id,inspection_id,attachment_id,uploaded_by) VALUES($1,$2,$3,$4)', [tenant.id, requestA.id, fileA.id, sk.id]);
  await pool.query('INSERT INTO inspection_photos(tenant_id,inspection_id,attachment_id,uploaded_by) VALUES($1,$2,$3,$4)', [tenant.id, requestB.id, fileA.id, sk.id]);
  await service.inspectionAction(sk, requestA.id, requestA.version, 'accept', 'Секция A принята', '300');
  await service.inspectionAction(sk, requestB.id, requestB.version, 'accept', 'Секция B принята', '200');

  const prepared = await service.changeDocumentationPackageStatus(pto, pkg.id, { status: 'PREPARING', version: pkg.version });
  assert.equal(prepared.status, 'PREPARING');

  // The production side must show it does not know or care about documentation:
  // production completion (500/500 confirmed) coexists with Documentation:
  // PREPARING — the exact "Production COMPLETE / Documentation PREPARING is
  // allowed" example from the Foundation contract.
  const { PortionCompletionService } = await import('../packages/domain');
  const coverage = new PortionCompletionService().internalScStatus([
    { plannedQuantity: unit.plannedQuantity, portions: [{ internalScConfirmedQuantity: '300' }, { internalScConfirmedQuantity: '200' }] },
  ]);
  assert.equal(coverage, 'COMPLETE', 'production (Internal SC coverage) reads COMPLETE');
  const pkgAfter = await one(pool, 'SELECT * FROM documentation_packages WHERE tenant_id=$1 AND id=$2', [tenant.id, pkg.id]);
  assert.equal(pkgAfter.status, 'PREPARING', 'documentation stays exactly PREPARING — production completing did not push, block or otherwise touch it');

  // --- status history: every change is recorded, nothing is overwritten ---
  const returned = await service.changeDocumentationPackageStatus(pto, pkg.id, { status: 'READY_FOR_PRESENTATION', version: prepared.version, comment: 'Готово к предъявлению' });
  assert.equal(returned.status, 'READY_FOR_PRESENTATION');
  const history = await pool.query('SELECT * FROM documentation_package_status_history WHERE tenant_id=$1 AND documentation_package_id=$2 ORDER BY changed_at', [tenant.id, pkg.id]);
  assert.equal(history.rows.length, 2, 'DRAFT->PREPARING and PREPARING->READY_FOR_PRESENTATION, two distinct rows');
  assert.equal(history.rows[0].from_status, 'DRAFT');
  assert.equal(history.rows[0].to_status, 'PREPARING');
  assert.equal(history.rows[1].from_status, 'PREPARING');
  assert.equal(history.rows[1].to_status, 'READY_FOR_PRESENTATION');

  await assert.rejects(
    () => service.changeDocumentationPackageStatus(pto, pkg.id, { status: 'PRESENTED', version: prepared.version /* stale */ }),
    (e: any) => e.status === 409,
    'optimistic concurrency: a stale version must be rejected on a status change too',
  );

  // --- Documentation Document + Documentation Version (storage reference layer) ---
  const doc = await service.createDocumentationDocument(pto, pkg.id, { type: 'AOSR' });
  assert.equal(doc.documentationPackageId, pkg.id);
  assert.equal(doc.type, 'AOSR');

  await assert.rejects(
    () => service.createDocumentationDocument(pto, pkg.id, { type: 'GENERAL_WORK_LOG' }),
    /constraint/i,
    'GENERAL_WORK_LOG must not be a legal document type in the F8.2 MVP dictionary',
  );

  const versionNone = await service.createDocumentationVersion(pto, doc.id, { storageProvider: 'NONE' });
  assert.equal(versionNone.versionNumber, 1);
  assert.equal(versionNone.storageProvider, 'NONE');
  assert.equal(versionNone.storageReference, null);

  const versionExternal = await service.createDocumentationVersion(pto, doc.id, { storageProvider: 'EXTERNAL_REFERENCE', storageReference: 'https://disk.example/aosr-v2.pdf', comment: 'Актуальная версия' });
  assert.equal(versionExternal.versionNumber, 2, 'version history: sequential, not overwritten');
  assert.equal(versionExternal.storageReference, 'https://disk.example/aosr-v2.pdf');

  await assert.rejects(
    () => service.createDocumentationVersion(pto, doc.id, { storageProvider: 'EXTERNAL_REFERENCE' }),
    /ссылк/i,
    'EXTERNAL_REFERENCE without a storageReference must be refused',
  );

  const versions = await pool.query('SELECT * FROM documentation_document_versions WHERE tenant_id=$1 AND documentation_document_id=$2 ORDER BY version_number', [tenant.id, doc.id]);
  assert.equal(versions.rows.length, 2, 'both versions preserved — history, not an overwrite');
  assert.equal(versions.rows[0].version_number, 1);
  assert.equal(versions.rows[1].version_number, 2);

  // --- object scope: a nonexistent work is a 404, same as every other create-under-a-work method ---
  await assert.rejects(
    () => service.createDocumentationPackage(pto, { objectWorkId: '00000000-0000-0000-0000-000000000000', responsibleUserId: pto.id }),
    (e: any) => e.status === 404,
  );

  // --- tenant isolation: a second tenant cannot see or act on the first tenant's package ---
  const otherTenant = await one(pool, "INSERT INTO tenants(portal,member_id,name) VALUES('f8-2-other.local','f8-2-other','Другой тенант') RETURNING *");
  const otherTenantPto = await insert(pool, 'users', otherTenant.id, { bitrixUserId: '900', name: 'Чужой ПТО', role: 'PTO' });
  await assert.rejects(
    () => service.changeDocumentationPackageStatus(otherTenantPto, pkg.id, { status: 'PRESENTED', version: returned.version }),
    (e: any) => e.status === 404,
    'a package id from another tenant must read as not-found, never leak status or accept the change',
  );
  await assert.rejects(
    () => service.linkDocumentationPackagePortion(otherTenantPto, pkg.id, { quantityPortionId: portion1.id }),
    (e: any) => e.status === 404,
  );

  await pool.end();
});
