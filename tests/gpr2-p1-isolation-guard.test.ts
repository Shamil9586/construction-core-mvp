import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ISOLATED_CLUSTER_NAME, ISOLATED_DB_PREFIX, IsolationRow, isolatedAdminUrl, validateIsolationRow } from './helpers/gpr2-native-pg';

/**
 * GPR-2 P1 — the harness that decides WHERE native tests may run is itself tested: it must refuse everything that is not the executor's own
 * loopback cluster. (Pure: no server is contacted. The positive case — the real cluster accepted — is the first thing every native test does.)
 */
const row = (over: Partial<IsolationRow> = {}): IsolationRow => ({ v: 'PostgreSQL 16', num: 160015, cluster: ISOLATED_CLUSTER_NAME, port: 54329, addr: '127.0.0.1/32', db: 'postgres', dd: '/var/tmp/x', ...over });

test('the marked loopback cluster is accepted (and the evidence says no production credential was used)', () => {
  const e = validateIsolationRow(row(), 'postgresql://u:p@127.0.0.1:54329/postgres');
  assert.equal(e.clusterName, ISOLATED_CLUSTER_NAME);
  assert.equal(e.productionCredentialsUsed, false);
  assert.equal(validateIsolationRow(row({ addr: null }), 'postgresql://u:p@127.0.0.1:54329/postgres').serverAddr, null, 'a unix socket reports no address');
  assert.equal(validateIsolationRow(row({ addr: '::1/128' }), 'postgresql://u:p@[::1]:54329/postgres').serverAddr, '::1/128');
});

test('any server without the marker is refused — an application database, a managed LIVE-like server, a default install', () => {
  for (const cluster of ['', 'main', 'production', 'render-pg', ISOLATED_CLUSTER_NAME + '-x', ISOLATED_CLUSTER_NAME.toUpperCase()])
    assert.throws(() => validateIsolationRow(row({ cluster }), 'postgresql://u:p@127.0.0.1/postgres'), /not the isolated cluster/, JSON.stringify(cluster));
});

test('a marked server that is not on loopback is refused (a copied configuration on a remote host)', () => {
  for (const addr of ['10.0.0.5/32', '172.17.0.2/32', '203.0.113.9/32', '127.0.0.2/32', '::2/128'])
    assert.throws(() => validateIsolationRow(row({ addr }), 'postgresql://u:p@db/postgres'), /not loopback/, addr);
});

test('the URL comes ONLY from GPR2_ISOLATED_PG_URL and only for a loopback host or a socket directory', () => {
  const saved = process.env.GPR2_ISOLATED_PG_URL;
  try {
    delete process.env.GPR2_ISOLATED_PG_URL;
    process.env.DATABASE_URL = 'postgresql://prod:secret@db.example.com/prod'; // present, and ignored
    assert.throws(() => isolatedAdminUrl(), /GPR2_ISOLATED_PG_URL is not set/);
    for (const bad of ['postgresql://u:p@db.example.com:5432/postgres', 'postgresql://u:p@10.1.2.3/postgres', 'postgresql://u:p@localhost.evil.example/postgres', 'postgresql://u:p@127.0.0.1.evil.example/postgres']) {
      process.env.GPR2_ISOLATED_PG_URL = bad;
      assert.throws(() => isolatedAdminUrl(), /loopback/, bad);
    }
    for (const ok of ['postgresql://u:p@127.0.0.1:54329/postgres', 'postgresql://u:p@localhost:54329/postgres', 'postgresql://u:p@[::1]:54329/postgres']) {
      process.env.GPR2_ISOLATED_PG_URL = ok;
      assert.equal(isolatedAdminUrl(), ok);
    }
  }
  finally {
    delete process.env.DATABASE_URL;
    if (saved === undefined) delete process.env.GPR2_ISOLATED_PG_URL; else process.env.GPR2_ISOLATED_PG_URL = saved;
  }
});

test('the only databases the native tests may drop carry the P1 prefix', () => {
  assert.equal(ISOLATED_DB_PREFIX, 'gpr2_p1_');
});
