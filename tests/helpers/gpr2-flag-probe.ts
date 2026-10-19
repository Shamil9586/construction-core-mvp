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
  const out = {
    v2Command: await send('POST', `/v2/objects/${id}/schedule/revisions`),
    v2Corporate: await send('POST', `/v2/work-type-publication-requests/${id}/approve`),
    legacyGpr1: await send('POST', `/objects/${id}/schedule/draft`),
    health: await send('GET', '/health'),
    swaggerHasV2: Object.keys((await (await fetch(base + '/api-docs-json')).json()).paths).some(p => p.startsWith('/v2/'))
  };
  console.log('PROBE ' + JSON.stringify(out));
  await app.close();
  process.exit(0);
})().catch(e => { console.error('PROBE_ERROR ' + (e?.stack ?? e)); process.exit(1); });
