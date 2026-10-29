import './gpr2-isolation'; // FIRST: pins in-memory PGlite before any backend module loads
/**
 * Child-process probe for gpr2-r01-flag-off.test.ts. Boots the application ONCE with GPR2_CONTRACT_ROUTES set to argv[2] ("<unset>" leaves it unset),
 * sends unauthenticated requests (they are refused before any database access, so nothing is migrated or seeded) and prints what it saw as JSON.
 * The flag is read when main.ts is first imported, which is why each value needs its own process.
 */
(async () => {
  const value = process.argv[2];
  if (value !== '<unset>') process.env.GPR2_CONTRACT_ROUTES = value;
  process.env.MOCK_LOGIN_KEY = 'probe';
  process.env.RATE_LIMIT_MAX = '100000';
  const { createApp } = await import('../../apps/backend/src/main');
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  const send = async (method: string, path: string) => { const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' }); return { status: r.status, keys: Object.keys(await r.json().catch(() => ({}))).sort() }; };
  const id = '11111111-1111-4111-8111-111111111111';
  // R01-B05: everything in the served API document that is NOT part of the GPR-2 contract, fingerprinted — it must be identical with the flag on and off
  const { buildGpr2OpenApi } = await import('../../packages/domain/gpr2');
  const { createHash } = await import('node:crypto');
  const contractSchemas = new Set(Object.keys((buildGpr2OpenApi() as any).components.schemas));
  const served = await (await fetch(base + '/api-docs-json')).json();
  const rest = JSON.parse(JSON.stringify(served));
  for (const p of Object.keys(rest.paths)) if (p.startsWith('/v2/')) delete rest.paths[p];
  for (const n of Object.keys(rest.components?.schemas ?? {})) if (contractSchemas.has(n)) delete rest.components.schemas[n];
  delete rest.components?.securitySchemes?.bearerAuth; delete rest['x-error-status'];
  const legacyDigest = createHash('sha256').update(JSON.stringify(rest)).digest('hex');
  const out = {
    v2Command: await send('POST', `/v2/objects/${id}/schedule/revisions`),
    v2Corporate: await send('POST', `/v2/work-type-publication-requests/${id}/approve`),
    v2Reads: await Promise.all([`/v2/objects/${id}/work-types`, `/v2/objects/${id}/area-scopes`, `/v2/objects/${id}/finish-systems`, '/v2/finish-templates', `/v2/objects/${id}/work-type-publication-requests?state=PENDING`].map(p => send('GET', p))),
    legacyGpr1: await send('POST', `/objects/${id}/schedule/draft`),
    health: await send('GET', '/health'),
    swaggerHasV2: Object.keys(served.paths).some(p => p.startsWith('/v2/')),
    v2PathCount: Object.keys(served.paths).filter(p => p.startsWith('/v2/')).length,
    legacyPathCount: Object.keys(rest.paths).length,
    legacyDigest
  };
  console.log('PROBE ' + JSON.stringify(out));
  await app.close();
  process.exit(0);
})().catch(e => { console.error('PROBE_ERROR ' + (e?.stack ?? e)); process.exit(1); });
