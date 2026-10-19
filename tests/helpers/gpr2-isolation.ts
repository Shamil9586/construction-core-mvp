/**
 * GPR-2 R01 test isolation. IMPORT THIS FIRST in any test that loads backend code.
 *
 * apps/backend/src/db.ts decides at the moment it is first imported whether to use in-memory PGlite (DB_MODE=pglite and no DATABASE_URL) or a real
 * node-postgres pool, which reads DATABASE_URL and the standard PG* variables. A test that imports the backend before the environment is set would
 * therefore open a connection to whatever those variables name. This module runs before any backend import (imports are evaluated in order) and
 * removes every way for the pool to point anywhere but the process's own memory. Nothing here can be undone by a later import.
 */
for (const name of Object.keys(process.env))
  if (/^(DATABASE_URL|E2E_.*DATABASE.*|E2E_POSTGRES.*|PG[A-Z_]*|POSTGRES_.*)$/.test(name)) delete process.env[name];
process.env.DB_MODE = 'pglite';
process.env.PGLITE_DIR = 'memory://';
process.env.AUTH_MODE = 'mock';

/** Proof for a test report: the pool the backend is using is the in-memory PGlite one, never a node-postgres Pool. */
export async function assertInMemoryPool() {
  const { pool } = await import('../../apps/backend/src/db');
  if ('options' in pool || process.env.DATABASE_URL || process.env.DB_MODE !== 'pglite')
    throw new Error('GPR-2 R01 isolation violated: the backend pool is not the in-memory PGlite pool');
  return true;
}
