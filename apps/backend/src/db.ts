import { Pool, PoolClient, types } from 'pg';
// PostgreSQL DATE is a civil date, not a midnight in the host timezone.
types.setTypeParser(1082, value => value);
// PGlite is an explicit local verification mode. Deployments use node-postgres.
function localPool() { const { PGlite } = require('@electric-sql/pglite'); const db = new PGlite(process.env.PGLITE_DIR ?? '.local-pglite'); let tail = Promise.resolve(); async function acquire() { let release: any; const next = new Promise<void>(r => release = r); const prev = tail; tail = next; await prev; return release; } const query = async (sql: string, args: any[] = []) => { const r = (!args.length && sql.includes(';')) ? await db.exec(sql) : [await db.query(sql, args)]; const last = r[r.length - 1] ?? { rows: [] }; for(const field of last.fields??[])if(field.dataTypeID===1082)for(const row of last.rows??[])if(row[field.name] instanceof Date)row[field.name]=row[field.name].toISOString().slice(0,10); return { ...last, rowCount: last.command === 'SELECT' ? (last.rows?.length ?? 0) : (last.affectedRows ?? last.rows?.length ?? 0) }; }; return { query: async (sql: string, args: any[] = []) => { const release = await acquire(); try {
        return await query(sql, args);
    }
    finally {
        release();
    } }, connect: async () => { const release = await acquire(); return { query, release }; }, end: () => db.close() }; }
export const pool: any = process.env.DB_MODE === 'pglite' && !process.env.DATABASE_URL ? localPool() : new Pool({ connectionString: process.env.DATABASE_URL, max: 12, connectionTimeoutMillis: 5000, options: '-c timezone=UTC' });
export async function transaction<T>(fn: (c: PoolClient) => Promise<T>) { const c = await pool.connect(); try {
    await c.query('BEGIN');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
}
catch (e) {
    await c.query('ROLLBACK');
    throw e;
}
finally {
    c.release();
} }
export const camel = (row: any): any => row && Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, x) => x.toUpperCase()), v]));
export async function rows(c: any, sql: string, args: any[] = []) { return (await c.query(sql, args)).rows.map(camel); }
export async function one(c: any, sql: string, args: any[] = []) { return (await rows(c, sql, args))[0]; }
const tables = new Set(['users', 'contractors', 'objects', 'object_contractors', 'work_categories', 'work_types', 'work_templates', 'works', 'work_dependencies', 'work_progress', 'inspections', 'issues', 'attachments', 'inspection_photos', 'materials', 'material_batches', 'material_documents', 'work_materials', 'executive_documents', 'executive_packages', 'package_documents', 'pto_transfers', 'sdo_cases', 'financial_closings', 'monthly_plans', 'audit_logs', 'domain_events', 'notifications', 'dictionary_items', 'risk_settings', 'bitrix_installations', 'sessions', 'import_reports',
    // F8.1 Production Execution + Construction Control Foundation.
    'finish_types', 'work_execution_units', 'execution_unit_layers', 'quantity_portions', 'portion_quantity_confirmations',
    // F8.2 PTO / Executive Documentation Foundation.
    'documentation_packages', 'documentation_package_portions', 'documentation_documents', 'documentation_document_versions', 'documentation_package_status_history']);
export async function insert(c: any, table: string, tenantId: string, data: any) { if (!tables.has(table))
    throw Error('Invalid table'); const d = { tenant_id: tenantId, ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k.replace(/[A-Z]/g, x => '_' + x.toLowerCase()), v])) }; const keys = Object.keys(d); if (keys.some(k => !/^[a-z_]+$/.test(k)))
    throw Error('Invalid column'); return one(c, `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, Object.values(d)); }
