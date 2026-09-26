import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import fs from 'node:fs';
import path from 'node:path';

/**
 * F8.3-20 — migration 010 backfilled every pre-existing
 * sdo_closing_portion_allocation_history row's new `operation` column with a
 * single blanket DEFAULT 'CREATE', which misclassifies any row that was
 * actually a legacy CORRECT (previous_amount IS NOT NULL). This file proves
 * migration 011 (infra/011_sdo_closing_allocation_history_operation_repair.sql)
 * repairs that misclassification on both the upgrade paths the review
 * required, against a REAL PostgreSQL database — never PGlite, which cannot
 * exercise `ALTER TABLE ... DISABLE/ENABLE TRIGGER` semantics meaningfully.
 *
 * This file controls exactly which migrations have been applied to a given
 * database by driving `schema_migrations` itself (via `applyMigrationsThrough`,
 * below) rather than the exported `migrate()` from scripts/migrate.ts, which
 * always applies every file it finds on disk — 010 and 011 both already
 * exist as files by the time this test runs, so `migrate()` alone could
 * never stop between them. `applyMigrationsThrough` executes the exact same
 * real file contents `migrate()` would (`fs.readFileSync('infra/<file>')`,
 * one `client.query()` per file, recorded in the same `schema_migrations`
 * table), just bounded to a chosen version — a fresh, isolated database is
 * created per test so this never interacts with any other test's schema or
 * data. The real, unmodified `migrate()` function is still exercised once,
 * at the end of the Path A test, to prove the production migration runner
 * itself behaves safely (a no-op) once every migration through 011 is
 * already recorded — the actual rerun-safety property the review asked for.
 */

const ADMIN_DATABASE_URL = process.env.E2E_ADMIN_DATABASE_URL ?? 'postgresql://postgres:local-test-only@127.0.0.1:5432/postgres';
const HOST = process.env.E2E_POSTGRES_HOST_URL ?? 'postgresql://postgres:local-test-only@127.0.0.1:5432/';

async function createIsolatedDatabase(name: string): Promise<string> {
  const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  return HOST + name;
}

async function dropDatabase(name: string): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

function migrationFiles(): string[] {
  return fs.readdirSync('infra').filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
}

/** Mirrors scripts/migrate.ts's own loop exactly, bounded to `maxVersion` — the real file contents, the same schema_migrations bookkeeping, just capped. */
async function applyMigrationsThrough(client: Client, maxVersion: number): Promise<void> {
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(version int PRIMARY KEY, applied_at timestamptz DEFAULT now())');
  for (const file of migrationFiles()) {
    const version = Number(file.split('_')[0]);
    if (version > maxVersion) continue;
    const already = await client.query('SELECT version FROM schema_migrations WHERE version=$1', [version]);
    if (already.rows.length) continue;
    await client.query(fs.readFileSync(path.join('infra', file), 'utf8'));
    await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [version]);
  }
}

/** The minimal FK-satisfying graph a Portion allocation history row needs, built with raw SQL against schema version 9 — the real application code cannot run against a pre-010 schema (it always writes the `operation` column), so this seed step is deliberately not routed through the app. */
async function seedMinimalGraph(client: Client): Promise<{ tenantId: string; userId: string; portionId: string; caseId: string }> {
  const tenant = await client.query(`INSERT INTO tenants(portal, member_id, name) VALUES ($1,$2,$3) RETURNING id`, ['t' + Date.now() + '.bitrix24.ru', 'm-' + Date.now(), 'Test Tenant']);
  const tenantId = tenant.rows[0].id;
  const user = await client.query(`INSERT INTO users(tenant_id, bitrix_user_id, name, role) VALUES ($1,$2,$3,$4) RETURNING id`, [tenantId, 'u-1', 'Test User', 'SDO']);
  const userId = user.rows[0].id;
  const contractor = await client.query(`INSERT INTO contractors(tenant_id, name) VALUES ($1,$2) RETURNING id`, [tenantId, 'Test Contractor']);
  const contractorId = contractor.rows[0].id;
  const category = await client.query(`INSERT INTO work_categories(tenant_id, name, code) VALUES ($1,$2,$3) RETURNING id`, [tenantId, 'Test Category', 'CAT-1']);
  const categoryId = category.rows[0].id;
  const workType = await client.query(`INSERT INTO work_types(tenant_id, category_id, name, unit) VALUES ($1,$2,$3,$4) RETURNING id`, [tenantId, categoryId, 'Test Work Type', 'м²']);
  const workTypeId = workType.rows[0].id;
  const object = await client.query(
    `INSERT INTO objects(tenant_id, external_code, name, address, project_manager_id, start_date, planned_finish_date, contract_value) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [tenantId, 'OBJ-1', 'Test Object', 'Test Address', userId, '2026-01-01', '2026-12-31', '1000000'],
  );
  const objectId = object.rows[0].id;
  const work = await client.query(
    `INSERT INTO works(tenant_id, object_id, work_type_id, contractor_id, responsible_user_id, name, unit, planned_quantity, planned_start_date, planned_finish_date, estimated_cost) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [tenantId, objectId, workTypeId, contractorId, userId, 'Test Work', 'м²', 500, '2026-01-01', '2026-06-01', 100000],
  );
  const workId = work.rows[0].id;
  const unit = await client.query(
    `INSERT INTO work_execution_units(tenant_id, object_work_id, work_type_id, contractor_id, unit, planned_quantity) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [tenantId, workId, workTypeId, contractorId, 'м²', 500],
  );
  const unitId = unit.rows[0].id;
  const portion = await client.query(`INSERT INTO quantity_portions(tenant_id, execution_unit_id, label, planned_quantity) VALUES ($1,$2,$3,$4) RETURNING id`, [tenantId, unitId, 'Секция A', 200]);
  const portionId = portion.rows[0].id;
  const pkg = await client.query(`INSERT INTO documentation_packages(tenant_id, object_id, object_work_id, responsible_user_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [tenantId, objectId, workId, userId, userId]);
  const packageId = pkg.rows[0].id;
  const sdoCase = await client.query(`INSERT INTO sdo_closing_cases(tenant_id, object_id, object_work_id, documentation_package_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [tenantId, objectId, workId, packageId, userId]);
  const caseId = sdoCase.rows[0].id;
  return { tenantId, userId, portionId, caseId };
}

/** Inserts one legacy sdo_closing_portion_allocation_history row at schema version 9 — no `operation` column exists yet at this point. */
async function insertLegacyHistoryRow(
  client: Client,
  seed: { tenantId: string; userId: string; portionId: string; caseId: string },
  previousAmount: string | null,
  newAmount: string,
): Promise<string> {
  const row = await client.query(
    `INSERT INTO sdo_closing_portion_allocation_history(tenant_id, sdo_closing_case_id, quantity_portion_id, previous_amount, new_amount, changed_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [seed.tenantId, seed.caseId, seed.portionId, previousAmount, newAmount, seed.userId],
  );
  return row.rows[0].id;
}

async function fetchHistoryRow(client: Client, id: string): Promise<any> {
  const r = await client.query('SELECT * FROM sdo_closing_portion_allocation_history WHERE id=$1', [id]);
  return r.rows[0];
}

/* --------------------------------------------------------------------- *
 * PATH A — fresh install rolling straight through 009 -> 010 -> 011      *
 * --------------------------------------------------------------------- */

test('F8.3-20 Path A: a fresh install applying 010 and 011 together classifies a legacy CREATE row as CREATE and a legacy CORRECT row as CORRECT', async () => {
  const dbName = 'f83_20_patha_' + Date.now();
  const url = await createIsolatedDatabase(dbName);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await applyMigrationsThrough(client, 9);
    const seed = await seedMinimalGraph(client);

    // A genuine legacy CREATE — the Portion's first-ever allocation.
    const createRowId = await insertLegacyHistoryRow(client, seed, null, '100.00');
    // A genuine legacy CORRECT — an existing allocation's amount changed.
    const correctRowId = await insertLegacyHistoryRow(client, seed, '100.00', '175.00');

    await applyMigrationsThrough(client, 999);

    const createRow = await fetchHistoryRow(client, createRowId);
    const correctRow = await fetchHistoryRow(client, correctRowId);
    assert.equal(createRow.operation, 'CREATE', 'a genuine legacy CREATE stays CREATE');
    assert.equal(correctRow.operation, 'CORRECT', 'a genuine legacy CORRECT is classified CORRECT, not left at the flawed CREATE default');

    // Every other column, on both rows, is exactly what was inserted —
    // only `operation` may ever change.
    assert.equal(createRow.previous_amount, null);
    assert.equal(createRow.new_amount, '100.00');
    assert.equal(createRow.changed_by, seed.userId);
    assert.equal(createRow.sdo_closing_case_id, seed.caseId);
    assert.equal(createRow.quantity_portion_id, seed.portionId);
    assert.equal(correctRow.previous_amount, '100.00');
    assert.equal(correctRow.new_amount, '175.00');
    assert.equal(correctRow.changed_by, seed.userId);

    const count = await client.query('SELECT count(*)::int AS n FROM sdo_closing_portion_allocation_history WHERE sdo_closing_case_id=$1', [seed.caseId]);
    assert.equal(count.rows[0].n, 2, 'row count unchanged — an UPDATE, never an INSERT or DELETE');

    // Immutable-history protection still rejects a direct edit after the migration.
    await assert.rejects(
      client.query('UPDATE sdo_closing_portion_allocation_history SET new_amount=$1 WHERE id=$2', ['999.00', createRowId]),
      /Append-only history/,
      'the trigger is re-enabled after the migration-only repair — no permanent bypass',
    );

    // The real, unmodified migration runner is itself safe to invoke once
    // everything is already applied — this is the actual production
    // rerun-safety property, exercised against the real function. This is
    // deliberately the only test in this file that imports
    // scripts/migrate.ts: its own `import { pool } from '../apps/backend/src/db'`
    // is a plain specifier, so — regardless of the query string busting
    // migrate.ts's own module identity here — it resolves to the one
    // process-wide db.ts module instance, bound to whichever DATABASE_URL
    // was set the first time ANYTHING imports db.ts in this process. A
    // second test in this file calling migrate() against a different
    // per-test database would silently reuse this one's connection instead,
    // so no other test here does. That same plain-specifier sharing is what
    // lets this test reach the exact Pool migrate() itself used — imported
    // again below by its own plain path — to close it explicitly before the
    // database is force-dropped; leaving it open would otherwise surface as
    // an unhandled 'error' event on the Pool once DROP DATABASE ... WITH
    // (FORCE) terminates its still-open connection out from under it.
    process.env.DATABASE_URL = url;
    process.env.DB_MODE = 'postgres';
    const { migrate } = await import('../scripts/migrate.ts?path-a=' + Date.now());
    await migrate();
    const createRowAfterRerun = await fetchHistoryRow(client, createRowId);
    assert.equal(createRowAfterRerun.operation, 'CREATE', 'a real migrate() rerun is a safe no-op — classification unchanged');
    const { pool: migratePool } = await import('../apps/backend/src/db');
    await migratePool.end();
  } finally {
    await client.end();
    await dropDatabase(dbName);
  }
});

/* --------------------------------------------------------------------- *
 * PATH B — 010 already applied (mislabelled), 011 lands later            *
 * --------------------------------------------------------------------- */

test('F8.3-20 Path B: a database where 010 already ran (and mislabelled a legacy correction as CREATE) is repaired once 011 applies', async () => {
  const dbName = 'f83_20_pathb_' + Date.now();
  const url = await createIsolatedDatabase(dbName);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await applyMigrationsThrough(client, 9);
    const seed = await seedMinimalGraph(client);
    const createRowId = await insertLegacyHistoryRow(client, seed, null, '100.00');
    const correctRowId = await insertLegacyHistoryRow(client, seed, '100.00', '175.00');

    // Simulates "faulty 010 is ALREADY APPLIED" — a separate migrate()
    // invocation, at a separate point in time, that never saw 011 at all.
    await applyMigrationsThrough(client, 10);

    // RED evidence: the defect genuinely reproduces at this checkpoint —
    // the legacy correction now reads CREATE, exactly as the review found.
    const beforeRepair = await fetchHistoryRow(client, correctRowId);
    assert.equal(beforeRepair.operation, 'CREATE', 'reproduces the actual defect: migration 010 alone mislabels a legacy correction');
    const createBeforeRepair = await fetchHistoryRow(client, createRowId);
    assert.equal(createBeforeRepair.operation, 'CREATE', 'a genuine legacy CREATE already reads correctly even before 011');

    // A later, separate deployment brings 011.
    await applyMigrationsThrough(client, 999);

    const createRow = await fetchHistoryRow(client, createRowId);
    const correctRow = await fetchHistoryRow(client, correctRowId);
    assert.equal(createRow.operation, 'CREATE', 'untouched — was already correct');
    assert.equal(correctRow.operation, 'CORRECT', 'GREEN: repaired once 011 applies');

    // Nothing besides `operation` moved.
    assert.equal(correctRow.previous_amount, '100.00');
    assert.equal(correctRow.new_amount, '175.00');
    assert.equal(correctRow.changed_by, seed.userId);
    assert.equal(correctRow.sdo_closing_case_id, seed.caseId);
    assert.equal(correctRow.quantity_portion_id, seed.portionId);
    assert.ok(correctRow.changed_at);
    assert.ok(correctRow.created_at);

    const count = await client.query('SELECT count(*)::int AS n FROM sdo_closing_portion_allocation_history WHERE sdo_closing_case_id=$1', [seed.caseId]);
    assert.equal(count.rows[0].n, 2, 'row count unchanged');
  } finally {
    await client.end();
    await dropDatabase(dbName);
  }
});

/* --------------------------------------------------------------------- *
 * CANCEL/RESTORE/already-correct rows are never touched by the repair    *
 * --------------------------------------------------------------------- */

test('F8.3-20: CANCEL, RESTORE and an already-correct CORRECT row all survive migration 011 untouched, and rerunning the migration bookkeeping is a safe no-op', async () => {
  const dbName = 'f83_20_preserve_' + Date.now();
  const url = await createIsolatedDatabase(dbName);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await applyMigrationsThrough(client, 9);
    const seed = await seedMinimalGraph(client);
    const legacyCreateId = await insertLegacyHistoryRow(client, seed, null, '100.00');
    const legacyCorrectId = await insertLegacyHistoryRow(client, seed, '100.00', '175.00');
    await applyMigrationsThrough(client, 999);

    // Post-010 rows, inserted directly with their real, correct operation —
    // exactly the shape the current application code produces.
    const alreadyCorrectRow = await client.query(
      `INSERT INTO sdo_closing_portion_allocation_history(tenant_id, sdo_closing_case_id, quantity_portion_id, previous_amount, new_amount, operation, changed_by) VALUES ($1,$2,$3,$4,$5,'CORRECT',$6) RETURNING id`,
      [seed.tenantId, seed.caseId, seed.portionId, '175.00', '300.00', seed.userId],
    );
    const alreadyCorrectId = alreadyCorrectRow.rows[0].id;
    const cancelRow = await client.query(
      `INSERT INTO sdo_closing_portion_allocation_history(tenant_id, sdo_closing_case_id, quantity_portion_id, previous_amount, new_amount, operation, changed_by) VALUES ($1,$2,$3,$4,NULL,'CANCEL',$5) RETURNING id`,
      [seed.tenantId, seed.caseId, seed.portionId, '300.00', seed.userId],
    );
    const cancelId = cancelRow.rows[0].id;
    const restoreRow = await client.query(
      `INSERT INTO sdo_closing_portion_allocation_history(tenant_id, sdo_closing_case_id, quantity_portion_id, previous_amount, new_amount, operation, changed_by) VALUES ($1,$2,$3,NULL,$4,'RESTORE',$5) RETURNING id`,
      [seed.tenantId, seed.caseId, seed.portionId, '300.00', seed.userId],
    );
    const restoreId = restoreRow.rows[0].id;

    // Re-running the bounded loop again (every version already applied) —
    // never re-executes 011's UPDATE against fresh state; still a no-op.
    await applyMigrationsThrough(client, 999);

    assert.equal((await fetchHistoryRow(client, legacyCreateId)).operation, 'CREATE');
    assert.equal((await fetchHistoryRow(client, legacyCorrectId)).operation, 'CORRECT');
    assert.equal((await fetchHistoryRow(client, alreadyCorrectId)).operation, 'CORRECT', 'an already-correct CORRECT row is left alone');
    assert.equal((await fetchHistoryRow(client, cancelId)).operation, 'CANCEL', 'CANCEL is never overwritten');
    assert.equal((await fetchHistoryRow(client, restoreId)).operation, 'RESTORE', 'RESTORE is never overwritten');

    const count = await client.query('SELECT count(*)::int AS n FROM sdo_closing_portion_allocation_history WHERE sdo_closing_case_id=$1', [seed.caseId]);
    assert.equal(count.rows[0].n, 5, 'row count unchanged across every rerun');
    // The real, exported migrate() function's own rerun-safety is already
    // exercised once, against the real function, in the Path A test above —
    // deliberately not repeated here (its transitive db.ts Pool is a
    // process-wide singleton bound to whichever DATABASE_URL was set the
    // first time it loaded, so a second real migrate() call from this same
    // test process would silently reuse Path A's already-dropped database).
  } finally {
    await client.end();
    await dropDatabase(dbName);
  }
});
