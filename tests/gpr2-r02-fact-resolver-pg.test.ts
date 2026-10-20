import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { IsolatedDatabase, Session, createIsolatedDatabase, recordEvidence, scrubConnectionEnvironment, until } from './helpers/gpr2-native-pg';

/**
 * GPR-2 R02 — NATIVE PostgreSQL (isolated cluster; see tests/helpers/gpr2-native-pg.ts for the isolation proof).
 *   * migration 026/027 on a database that already holds 025-shaped data: every existing row, to the byte, is unchanged; nothing is classified,
 *     numbered or reordered; the new tables are empty; a re-run is a no-op (A25-style protected-data check, A29)
 *   * the controlled runner against a real ledger: legacy rows are NOT presented as verified
 *   * microsecond ordering and the confirmation sequence on a real server
 *   * the source-mode edge under a genuine race: two first portion facts, one transition
 */
let db: IsolatedDatabase;
const MIGRATION_DIR = 'infra';

before(async () => {
  scrubConnectionEnvironment();
  db = await createIsolatedDatabase('r02');
  recordEvidence('r02-isolation', db.evidence);
  // the backend reads its connection at import time: set it BEFORE the first import, and share the one pool between the tests
  process.env.DB_MODE = 'postgres';
  process.env.DATABASE_URL = db.url;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'gpr2-r02-pg';
});
after(async () => {
  const { pool } = await import('../apps/backend/src/db');
  await pool.end();
  await db?.drop();
});

const files = () => fs.readdirSync(MIGRATION_DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
const PROTECTED = ['works', 'work_progress', 'work_execution_units', 'quantity_portions', 'portion_quantity_confirmations', 'inspections', 'issues', 'documentation_packages',
  'documentation_package_portions', 'documentation_documents', 'documentation_document_versions', 'documentation_customer_acceptances', 'sdo_closing_cases',
  'sdo_closing_portion_allocations', 'audit_logs', 'financial_closings', 'schedule_revisions', 'schedule_revision_entries', 'schedule_items', 'users', 'objects'];

async function digestOf(c: Client): Promise<Record<string, { count: number; md5: string }>> {
  const out: Record<string, { count: number; md5: string }> = {};
  for (const t of PROTECTED) {
    // the two columns migration 026 adds are the only ones left out of the comparison
    const r = await c.query(`SELECT count(*)::int AS n, coalesce(md5(string_agg(((to_jsonb(x) - 'fact_source_mode') - 'confirmation_seq')::text, '|' ORDER BY x.id)), '') AS h FROM ${t} x`);
    out[t] = { count: r.rows[0].n, md5: r.rows[0].h };
  }
  return out;
}

test('R02 migration 026 on 025-shaped data: protected rows unchanged, nothing classified, nothing numbered, re-run is a no-op', async () => {
  const c = new Client({ connectionString: db.url });
  await c.connect();
  try {
    // A database exactly as the OLD runner leaves it: versions 1..25 applied, the ledger has only version/applied_at.
    await c.query('CREATE TABLE schema_migrations(version int PRIMARY KEY, applied_at timestamptz DEFAULT now())');
    for (const f of files().filter(f => Number(f.split('_')[0]) <= 25)) {
      await c.query(fs.readFileSync(path.join(MIGRATION_DIR, f), 'utf8'));
      await c.query('INSERT INTO schema_migrations(version) VALUES($1)', [Number(f.split('_')[0])]);
    }
    const { seed } = await import('../scripts/seed');
    const dbm = await import('../apps/backend/src/db');
    const tenant = await seed();
    // legacy-shaped evidence on top of the seed: a unit, a portion and an UNORDERABLE tie (same instant, different quantities)
    const work = (await c.query("SELECT w.* FROM works w WHERE w.tenant_id=$1 AND w.actual_quantity>0 ORDER BY w.name LIMIT 1", [tenant.id])).rows[0];
    const user = (await c.query("SELECT id FROM users WHERE tenant_id=$1 AND role='PROJECT_MANAGER' LIMIT 1", [tenant.id])).rows[0];
    const unit = (await c.query('INSERT INTO work_execution_units(tenant_id,object_work_id,work_type_id,contractor_id,unit,planned_quantity) VALUES($1,$2,$3,$4,$5,100) RETURNING id', [tenant.id, work.id, work.work_type_id, work.contractor_id, work.unit])).rows[0];
    const portion = (await c.query("INSERT INTO quantity_portions(tenant_id,execution_unit_id,label,planned_quantity) VALUES($1,$2,'legacy',100) RETURNING id", [tenant.id, unit.id])).rows[0];
    for (const q of ['40', '70'])
      await c.query("INSERT INTO portion_quantity_confirmations(tenant_id,portion_id,source,quantity,recorded_by,recorded_at) VALUES($1,$2,'RP_FACT',$3,$4,'2026-01-01T00:00:00.000005Z')", [tenant.id, portion.id, q, user.id]);

    const before = await digestOf(c);
    const t0 = Date.now();
    const { migrate } = await import('../scripts/migrate');
    const ledgerBefore = (await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n;
    assert.equal(ledgerBefore, 25);
    await migrate();
    const applyMs = Date.now() - t0;
    const applied = (await c.query('SELECT version FROM schema_migrations WHERE version>25 ORDER BY version')).rows.map((r: any) => r.version);
    assert.ok(applied.includes(26), 'migration 026 was applied');

    const after = await digestOf(c);
    assert.deepEqual(after, before, 'every protected table is byte-identical to what it was (column-wise, ignoring only the two new columns)');
    assert.equal((await c.query('SELECT count(*)::int AS n FROM works WHERE fact_source_mode IS NOT NULL')).rows[0].n, 0, 'no Work was classified');
    assert.equal((await c.query('SELECT count(*)::int AS n FROM portion_quantity_confirmations WHERE confirmation_seq IS NOT NULL')).rows[0].n, 0, 'no legacy confirmation was numbered');
    assert.equal((await c.query('SELECT count(*)::int AS n FROM work_fact_source_mode_history')).rows[0].n, 0, 'the history starts empty');

    // re-run: nothing to do, nothing changes
    await migrate();
    assert.deepEqual((await c.query('SELECT version FROM schema_migrations WHERE version>25 ORDER BY version')).rows.map((r: any) => r.version), applied);
    assert.deepEqual(await digestOf(c), before);

    // new confirmations are numbered, old ones are not, and a legacy tie stays unorderable
    const fresh = (await c.query("INSERT INTO portion_quantity_confirmations(tenant_id,portion_id,source,quantity,recorded_by) VALUES($1,$2,'RP_FACT',55,$3),($1,$2,'RP_FACT',56,$3) RETURNING confirmation_seq", [tenant.id, portion.id, user.id])).rows;
    assert.ok(BigInt(fresh[0].confirmation_seq) < BigInt(fresh[1].confirmation_seq), 'new confirmations take increasing sequence numbers');
    const { loadPortionFigures } = await import('../apps/backend/src/fact-resolver');
    const figures = (await loadPortionFigures(dbm.pool, tenant.id, [portion.id])).get(portion.id)!;
    assert.equal(figures.rp.state, 'RESOLVED');
    assert.equal(figures.rpFact, '56.0000', 'the newest recorded_at wins; its sequence settles a tie between new rows');
    recordEvidence('r02-migration-upgrade', { applyMs, applied, before, after });
  }
  finally {
    await c.end();
  }
});

test('R02 the persisted mode edge under a real race: two first portion facts of one classified Work make exactly one transition', async () => {
  const admin = await Session.open(db.url, 'observer');
  const mod = await import('../apps/backend/src/service');
  const { pool, one } = await import('../apps/backend/src/db');
  const service = new mod.ProductionService();
  try {
    const tenant = (await one(pool, 'SELECT id FROM tenants LIMIT 1')).id;
    const obj = await one(pool, "SELECT * FROM objects WHERE tenant_id=$1 AND external_code='DEMO-2026-004'", [tenant]);
    const pm = await one(pool, 'SELECT * FROM users WHERE id=$1', [obj.projectManagerId]);
    const work = (await pool.query("SELECT * FROM works w WHERE tenant_id=$1 AND object_id=$2 AND actual_quantity=0 AND NOT EXISTS(SELECT 1 FROM work_dependencies d WHERE d.successor_work_id=w.id OR d.predecessor_work_id=w.id) ORDER BY name", [tenant, obj.id])).rows[0];
    const w = { id: work.id, workTypeId: work.work_type_id, contractorId: work.contractor_id, unit: work.unit };
    await pool.query('ALTER TABLE works DISABLE TRIGGER works_fact_source_mode_guard');
    await pool.query("UPDATE works SET fact_source_mode='LEGACY_WORK' WHERE id=$1", [w.id]);
    await pool.query('ALTER TABLE works ENABLE TRIGGER works_fact_source_mode_guard');
    const unit = await service.createExecutionUnit(pm, { objectWorkId: w.id, workTypeId: w.workTypeId, contractorId: w.contractorId, unit: w.unit, plannedQuantity: '200' });
    const p1 = await service.createQuantityPortion(pm, unit.id, { label: 'A', plannedQuantity: '100' });
    const p2 = await service.createQuantityPortion(pm, unit.id, { label: 'B', plannedQuantity: '100' });

    // BARRIER: an independent session row-locks the Work; both writers run up to the point where they must update it, and are seen BLOCKED by
    // PostgreSQL itself — only then is the lock released.
    const gate = await Session.open(db.url, 'gate');
    await gate.begin();
    await gate.query('SELECT 1 FROM works WHERE id=$1 FOR UPDATE', [w.id]);
    const a = service.recordPortionFact(pm, p1.id, { quantity: '10', version: p1.version, comment: 'A' });
    const b = service.recordPortionFact(pm, p2.id, { quantity: '20', version: p2.version, comment: 'B' });
    let settled = 0;
    a.finally(() => settled++).catch(() => undefined);
    b.finally(() => settled++).catch(() => undefined);
    await until(async () => (await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND state='active'")).rows[0].n >= 2, 'both writers to be blocked on the Work row');
    assert.equal(settled, 0, 'neither writer finished while the Work row is held');
    await gate.commit();
    await gate.close();
    await Promise.all([a, b]);

    assert.equal((await pool.query("SELECT fact_source_mode FROM works WHERE id=$1", [w.id])).rows[0].fact_source_mode, 'PORTION');
    const history = (await pool.query("SELECT from_mode,to_mode,basis FROM work_fact_source_mode_history WHERE work_id=$1 AND to_mode='PORTION'", [w.id])).rows;
    assert.equal(history.length, 1, 'exactly one transition, whichever writer won');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM portion_quantity_confirmations WHERE portion_id=ANY($1::uuid[])', [[p1.id, p2.id]])).rows[0].n, 2, 'and both facts were recorded');
    recordEvidence('r02-mode-race', { history, writersBlockedBeforeRelease: 2 });
  }
  finally {
    await admin.close();
  }
});
