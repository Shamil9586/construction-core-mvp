import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { harness, closeHarness, setUp, generatedAosr, uploadScheme, presentPackage } from './helpers/aosr-harness';

/**
 * Integration overlap: ID-AUTO-2 documentary readiness (registry + forward gate) x Bitrix Disk provider-neutral file evidence (migration 024).
 * A scheme whose attachment is a verified BITRIX_DISK reference (no bytes in Core) is file-backed exactly like a LOCAL one; an incomplete
 * reference is not. Registry and forward gate give the same verdict for both providers, for both AOSR methods.
 */
after(closeHarness);

const registry = async (objectId: string) => {
  const { raw } = await harness();
  const r = await raw(`objects/${objectId}/documentation-registry`);
  assert.equal(r.status, 200);
  return (await r.json()) as any;
};
const rowOf = (view: any, id: string) => view.rows.find((r: any) => r.packageId === id);
async function asDisk(schemeDocId: string, patch: { ext?: string | null; size?: number } = {}) {
  const { pool } = await import('../apps/backend/src/db');
  const att = (await pool.query(`SELECT a.id FROM documentation_document_versions v JOIN attachments a ON a.id::text=v.storage_reference WHERE v.documentation_document_id=$1 ORDER BY v.version_number DESC LIMIT 1`, [schemeDocId])).rows[0];
  const ext = patch.ext === undefined ? '4242' : patch.ext;
  if (ext === null) { // a Disk record without its external reference cannot exist (CHECK): model it as an emptied LOCAL blob instead
    await pool.query(`UPDATE attachments SET file_provider='LOCAL', external_file_id=NULL, external_folder_id=NULL, size_bytes=NULL, checksum_sha256=NULL, content='\\x'::bytea WHERE id=$1`, [att.id]);
  } else {
    await pool.query(`UPDATE attachments SET file_provider='BITRIX_DISK', external_file_id=$2, content=NULL, size_bytes=$3, checksum_sha256=$4, external_folder_id='1' WHERE id=$1`, [att.id, ext, patch.size ?? 10, 'a'.repeat(64)]);
  }
}

test('EXTERNAL and CORE packages: a Disk-backed scheme counts as file evidence in the registry and the forward gate; an emptied LOCAL blob does not', async () => {
  const { req } = await harness();
  const ext = await setUp({ labels: ['1 этаж', '2 этаж'], location: null, method: 'EXTERNAL' });
  const sch = await uploadScheme(req, ext.pkg.id, 'ES-DISK');
  const docId = sch.id ?? sch.documentId ?? sch.schemeId;
  assert.ok(docId, JSON.stringify(sch));
  let row = rowOf(await registry(ext.object.id), ext.pkg.id);
  assert.equal(row.schemeFileBackedCount, 1, 'LOCAL file-backed');
  await asDisk(docId);
  row = rowOf(await registry(ext.object.id), ext.pkg.id);
  assert.equal(row.schemeFileBackedCount, 1, 'BITRIX_DISK reference is file-backed');
  assert.equal(row.readiness.ready, true);
  await asDisk(docId, { ext: null });
  row = rowOf(await registry(ext.object.id), ext.pkg.id);
  assert.equal(row.schemeFileBackedCount, 0, 'an empty blob is metadata only');
  assert.equal(row.readiness.ready, false);

  const core = await setUp({ labels: ['1 этаж', '2 этаж'], location: null });
  const g = await generatedAosr(req, core);
  assert.equal(rowOf(await registry(core.object.id), core.pkg.id).readiness.ready, true, 'LOCAL: registry ready');
  const { pool } = await import('../apps/backend/src/db');
  const schemeDoc = (await pool.query('SELECT scheme_document_id AS id FROM aosr_scheme_links WHERE aosr_id=$1 LIMIT 1', [g.aosr.id])).rows[0].id;
  await asDisk(schemeDoc);
  row = rowOf(await registry(core.object.id), core.pkg.id);
  assert.equal(row.readiness.ready, true, 'BITRIX_DISK: registry ready');
  assert.equal(row.aosrs[0].schemeCoverage.covered, true);
  assert.equal((await presentPackage(req, core.pkg.id)).status, 'PRESENTED', 'forward gate lets the Disk-backed package through');
});
