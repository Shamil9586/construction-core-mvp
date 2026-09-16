import { test } from 'node:test';
import assert from 'node:assert/strict';
test('OAuth tokens encrypted with authenticated AES-256-GCM', async () => {
  delete process.env.DATABASE_URL; process.env.DB_MODE='pglite'; process.env.PGLITE_DIR='memory://';
  const {encrypt,decrypt}=await import('../apps/backend/src/security');
  const {pool}=await import('../apps/backend/src/db');
  try {
    process.env.TOKEN_ENCRYPTION_KEY='1'.repeat(64);
    const value=encrypt('sensitive-test-token');
    assert.ok(!value.includes('sensitive-test-token'));
    assert.equal(decrypt(value),'sensitive-test-token');
    const parts=value.split('.');parts[1]='0'.repeat(32);
    assert.throws(()=>decrypt(parts.join('.')));
  } finally { await pool.end(); }
});
