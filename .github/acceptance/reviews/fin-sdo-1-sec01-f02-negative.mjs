// FIN-SDO-1 SEC-01-F02 independent negative probes; review required, NOT EXECUTED.
// CI-only harness in reviewed PR, separate from the immutable product candidate.
// MUST be reviewed and tested in isolated GitHub Actions. Never run against LIVE.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dsn = process.env.DATABASE_URL;
if (process.env.FIN_SDO_ISOLATED_CONFIRM !== 'YES' || !dsn) throw Error('isolated test confirmation required');
const parsed = new URL(dsn);
if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.pathname !== '/fin_sdo_test')
  throw Error('refuse non-ephemeral FIN database');
const core = path.join(process.env.GITHUB_WORKSPACE || process.cwd(), 'core');
const requireCore = createRequire(path.join(core, 'package.json'));
const { Pool } = requireCore('pg');
const admin = new Pool({ connectionString: dsn, connectionTimeoutMillis: 5000 });
const tests = [];
let app = null;
let restricted = null;
function success(id, expected, actual) {
  tests.push({ id, result: 'PASS', expected, actual });
  console.log('PASS SEC01-F02 ' + id);
}
async function denySQL(client, statement, id, expected='42501') {
  try {
    await client.query(statement);
    throw Error(id + ': forbidden SQL succeeded');
  } catch (err) {
    assert.equal(err?.code, expected, id + ': unexpected SQLSTATE');
    success(id, expected, String(err.code));
  }
}
async function main() {
  const pg = await admin.query('SHOW server_version');
  assert.match(pg.rows[0].server_version, /^16\./);
  success('N0-postgresql16', '16.x', pg.rows[0].server_version.split(' ')[0]);

  const role = await admin.query(
    "SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname IN ('fin_sdo_isolated_login','fin_sdo_definer_test') ORDER BY rolname");
  assert.equal(role.rows.length, 2);
  for (const r of role.rows) {
    assert.equal(r.rolsuper, false, 'no FIN superuser');
    assert.equal(r.rolbypassrls, false, 'no bypassrls');
  }
  assert.equal(role.rows.find(r=>r.rolname==='fin_sdo_isolated_login').rolcanlogin, true);
  assert.equal(role.rows.find(r=>r.rolname==='fin_sdo_definer_test').rolcanlogin, false);
  success('N1-native-role-flags', 'restricted LOGIN and NOLOGIN definer; no SUPERUSER/BYPASSRLS', 'matched');

  const fn = await admin.query(`
    SELECT p.proname, p.prosecdef, p.proconfig,
      EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
              WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_exec
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'fin_sdo_%'
  `);
  assert.ok(fn.rows.length >= 9, 'FIN functions not all present');
  for (const f of fn.rows) {
    assert.equal(f.prosecdef, true, 'not SECURITY DEFINER: ' + f.proname);
    assert.equal(f.public_exec, false, 'PUBLIC EXECUTE: ' + f.proname);
    assert.ok((f.proconfig ?? []).some(x=>x.replace(/\s/g,'')==='search_path=pg_catalog,pg_temp'),
      'unfixed search_path: ' + f.proname);
  }
  success('N2-security-definer-boundary', 'no PUBLIC EXECUTE, pinned pg_catalog/pg_temp', String(fn.rows.length) + ' functions');

  // Fresh disposable login password, never printed or included in evidence.
  const password = randomBytes(36).toString('hex');
  await admin.query("ALTER ROLE fin_sdo_isolated_login PASSWORD '" + password + "'");
  const limitedUrl = new URL(dsn);
  limitedUrl.username='fin_sdo_isolated_login';
  limitedUrl.password=password;
  restricted = new Pool({ connectionString: limitedUrl.toString(), connectionTimeoutMillis: 5000 });
  await denySQL(restricted, 'SELECT * FROM public.sessions LIMIT 1','N3-deny-credentials-table');
  await denySQL(restricted, 'SELECT * FROM public.fin_quarter_plan_books LIMIT 1','N4-deny-direct-plan-read');
  const before = Number((await admin.query('SELECT count(*)::int AS n FROM public.fin_quarter_plan_books')).rows[0].n);
  await denySQL(restricted, 'INSERT INTO public.fin_quarter_plan_books DEFAULT VALUES','N5-deny-direct-plan-write');
  const after = Number((await admin.query('SELECT count(*)::int AS n FROM public.fin_quarter_plan_books')).rows[0].n);
  assert.equal(after,before,'forbidden write modified protected book');
  success('N5b-no-partial-write','same book count','matched');
  await denySQL(restricted, 'SET ROLE fin_sdo_definer_test','N6-deny-role-escalation');

  // Independently created synthetic users and sessions; no real employee data.
  const t1=(await admin.query("SELECT id FROM tenants WHERE portal='fin1-isolated.example.test'")).rows[0]?.id;
  const t2=(await admin.query("SELECT id FROM tenants WHERE portal='fin2-isolated.example.test'")).rows[0]?.id;
  assert.ok(t1&&t2&&t1!==t2,'expected isolated fixtures not present');
  async function actor(tenant,role) {
    const uid=(await admin.query('INSERT INTO users(tenant_id,bitrix_user_id,name,role) VALUES($1,$2,$3,$4) RETURNING id',
      [tenant,'f02-review-'+randomUUID(),'F02 '+role,role])).rows[0].id;
    const token=randomBytes(32).toString('base64url');
    await admin.query("INSERT INTO sessions(tenant_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [tenant,uid,createHash('sha256').update(token).digest('hex')]);
    return {uid,tenant,token};
  }
  const a=await actor(t1,'SDO'), b=await actor(t2,'SDO'), pto=await actor(t1,'PTO');
  process.env.FIN_SDO_DATABASE_URL=limitedUrl.toString();
  process.env.FIN_SDO_1_ROUTES='enabled';
  process.env.FIN_SDO_PROTECTED_IDENTITY_COMMANDS='enabled';
  process.env.AUTH_MODE='mock';
  process.env.MOCK_LOGIN_KEY='test-only-key-never-LIVE';
  process.env.APP_ORIGIN='http://127.0.0.1';
  const { createApp }=await import(pathToFileURL(path.join(core,'apps/backend/src/main.ts')).href);
  app=await createApp();
  await app.listen(0,'127.0.0.1');
  const addr=app.getHttpServer().address();
  assert.ok(addr&&typeof addr !== 'string');
  const base='http://127.0.0.1:'+addr.port+'/fin-sdo-1/';
  async function http(endpoint, token, options={}) {
    const h={...options.headers};
    if(token)h.Authorization='Bearer '+token;
    if(options.body !== undefined)h['Content-Type']='application/json';
    const r=await fetch(base+endpoint,{method:options.method||'GET',headers:h,
      ...(options.body===undefined?{}:{body:JSON.stringify(options.body)})});
    const body=await r.text();
    const cc=r.headers.get('cache-control')||'';
    assert.match(cc,/no-store/,'missing no-store');
    assert.notEqual(r.status,304,'conditional 304 not allowed');
    assert.equal(r.headers.get('etag'),null,'etag not allowed');
    assert.match(r.headers.get('vary')||'',/Authorization/i,'Vary: Authorization missing');
    return {status:r.status,body};
  }
  const unauth=await http('subjects',null);
  assert.equal(unauth.status,401);success('N7-unauthenticated-http','401 + no-store',String(unauth.status));
  const forbidden=await http('subjects',pto.token);
  assert.equal(forbidden.status,403);success('N8-forbidden-fin-role','403 + no-store',String(forbidden.status));
  const invalid=await http('buffers/not-a-uuid',a.token);
  assert.equal(invalid.status,400);success('N9-malformed-uuid','400 + no-store',String(invalid.status));
  const valid=await http('subjects',a.token,{headers:{'If-None-Match':'*'}});
  assert.equal(valid.status,200);success('N10-conditional-cache','200 not 304 + no-store',String(valid.status));

  const uniqueName='F02 synthetic '+randomUUID();
  const created=await http('historical-subjects',a.token,{
    method:'POST',body:{name:uniqueName,idempotencyKey:randomUUID()}
  });
  assert.equal(created.status,200, 'own tenant subject creation');
  const other=await http('subjects',b.token);
  assert.equal(other.status,200);
  assert.ok(!other.body.includes(uniqueName),'cross-tenant subject disclosed');
  success('N11-cross-tenant-discovery','tenant B cannot observe A new subject','not disclosed');


  // Reviewer-owned negative N13: fail-closed on an injected *unexpected* PostgreSQL error.
  // Only mutate this disposable database, and remove every injected object in finally.
  const f02tag=randomUUID().replace(/-/g,'');
  const f02fn='fin_f02_negative_'+f02tag;
  const f02tr='fin_f02_trigger_'+f02tag;
  await admin.query(`CREATE FUNCTION public.${f02fn}() RETURNS trigger LANGUAGE plpgsql AS
    $fin_f02$ BEGIN RAISE EXCEPTION 'F02-PRIVATE-DB-DETAIL-DO-NOT-EXPOSE' USING ERRCODE = 'XX000'; END $fin_f02// FIN-SDO-1 SEC-01-F02 independent negative probes; review required, NOT EXECUTED.
// CI-only harness in reviewed PR, separate from the immutable product candidate.
// MUST be reviewed and tested in isolated GitHub Actions. Never run against LIVE.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dsn = process.env.DATABASE_URL;
if (process.env.FIN_SDO_ISOLATED_CONFIRM !== 'YES' || !dsn) throw Error('isolated test confirmation required');
const parsed = new URL(dsn);
if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.pathname !== '/fin_sdo_test')
  throw Error('refuse non-ephemeral FIN database');
const core = path.join(process.env.GITHUB_WORKSPACE || process.cwd(), 'core');
const requireCore = createRequire(path.join(core, 'package.json'));
const { Pool } = requireCore('pg');
const admin = new Pool({ connectionString: dsn, connectionTimeoutMillis: 5000 });
const tests = [];
let app = null;
let restricted = null;
function success(id, expected, actual) {
  tests.push({ id, result: 'PASS', expected, actual });
  console.log('PASS SEC01-F02 ' + id);
}
async function denySQL(client, statement, id, expected='42501') {
  try {
    await client.query(statement);
    throw Error(id + ': forbidden SQL succeeded');
  } catch (err) {
    assert.equal(err?.code, expected, id + ': unexpected SQLSTATE');
    success(id, expected, String(err.code));
  }
}
async function main() {
  const pg = await admin.query('SHOW server_version');
  assert.match(pg.rows[0].server_version, /^16\./);
  success('N0-postgresql16', '16.x', pg.rows[0].server_version.split(' ')[0]);

  const role = await admin.query(
    "SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname IN ('fin_sdo_isolated_login','fin_sdo_definer_test') ORDER BY rolname");
  assert.equal(role.rows.length, 2);
  for (const r of role.rows) {
    assert.equal(r.rolsuper, false, 'no FIN superuser');
    assert.equal(r.rolbypassrls, false, 'no bypassrls');
  }
  assert.equal(role.rows.find(r=>r.rolname==='fin_sdo_isolated_login').rolcanlogin, true);
  assert.equal(role.rows.find(r=>r.rolname==='fin_sdo_definer_test').rolcanlogin, false);
  success('N1-native-role-flags', 'restricted LOGIN and NOLOGIN definer; no SUPERUSER/BYPASSRLS', 'matched');

  const fn = await admin.query(`
    SELECT p.proname, p.prosecdef, p.proconfig,
      EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
              WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_exec
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'fin_sdo_%'
  `);
  assert.ok(fn.rows.length >= 9, 'FIN functions not all present');
  for (const f of fn.rows) {
    assert.equal(f.prosecdef, true, 'not SECURITY DEFINER: ' + f.proname);
    assert.equal(f.public_exec, false, 'PUBLIC EXECUTE: ' + f.proname);
    assert.ok((f.proconfig ?? []).some(x=>x.replace(/\s/g,'')==='search_path=pg_catalog,pg_temp'),
      'unfixed search_path: ' + f.proname);
  }
  success('N2-security-definer-boundary', 'no PUBLIC EXECUTE, pinned pg_catalog/pg_temp', String(fn.rows.length) + ' functions');

  // Fresh disposable login password, never printed or included in evidence.
  const password = randomBytes(36).toString('hex');
  await admin.query("ALTER ROLE fin_sdo_isolated_login PASSWORD '" + password + "'");
  const limitedUrl = new URL(dsn);
  limitedUrl.username='fin_sdo_isolated_login';
  limitedUrl.password=password;
  restricted = new Pool({ connectionString: limitedUrl.toString(), connectionTimeoutMillis: 5000 });
  await denySQL(restricted, 'SELECT * FROM public.sessions LIMIT 1','N3-deny-credentials-table');
  await denySQL(restricted, 'SELECT * FROM public.fin_quarter_plan_books LIMIT 1','N4-deny-direct-plan-read');
  const before = Number((await admin.query('SELECT count(*)::int AS n FROM public.fin_quarter_plan_books')).rows[0].n);
  await denySQL(restricted, 'INSERT INTO public.fin_quarter_plan_books DEFAULT VALUES','N5-deny-direct-plan-write');
  const after = Number((await admin.query('SELECT count(*)::int AS n FROM public.fin_quarter_plan_books')).rows[0].n);
  assert.equal(after,before,'forbidden write modified protected book');
  success('N5b-no-partial-write','same book count','matched');
  await denySQL(restricted, 'SET ROLE fin_sdo_definer_test','N6-deny-role-escalation');

  // Independently created synthetic users and sessions; no real employee data.
  const t1=(await admin.query("SELECT id FROM tenants WHERE portal='fin1-isolated.example.test'")).rows[0]?.id;
  const t2=(await admin.query("SELECT id FROM tenants WHERE portal='fin2-isolated.example.test'")).rows[0]?.id;
  assert.ok(t1&&t2&&t1!==t2,'expected isolated fixtures not present');
  async function actor(tenant,role) {
    const uid=(await admin.query('INSERT INTO users(tenant_id,bitrix_user_id,name,role) VALUES($1,$2,$3,$4) RETURNING id',
      [tenant,'f02-review-'+randomUUID(),'F02 '+role,role])).rows[0].id;
    const token=randomBytes(32).toString('base64url');
    await admin.query("INSERT INTO sessions(tenant_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [tenant,uid,createHash('sha256').update(token).digest('hex')]);
    return {uid,tenant,token};
  }
  const a=await actor(t1,'SDO'), b=await actor(t2,'SDO'), pto=await actor(t1,'PTO');
  process.env.FIN_SDO_DATABASE_URL=limitedUrl.toString();
  process.env.FIN_SDO_1_ROUTES='enabled';
  process.env.FIN_SDO_PROTECTED_IDENTITY_COMMANDS='enabled';
  process.env.AUTH_MODE='mock';
  process.env.MOCK_LOGIN_KEY='test-only-key-never-LIVE';
  process.env.APP_ORIGIN='http://127.0.0.1';
  const { createApp }=await import(pathToFileURL(path.join(core,'apps/backend/src/main.ts')).href);
  app=await createApp();
  await app.listen(0,'127.0.0.1');
  const addr=app.getHttpServer().address();
  assert.ok(addr&&typeof addr !== 'string');
  const base='http://127.0.0.1:'+addr.port+'/fin-sdo-1/';
  async function http(endpoint, token, options={}) {
    const h={...options.headers};
    if(token)h.Authorization='Bearer '+token;
    if(options.body !== undefined)h['Content-Type']='application/json';
    const r=await fetch(base+endpoint,{method:options.method||'GET',headers:h,
      ...(options.body===undefined?{}:{body:JSON.stringify(options.body)})});
    const body=await r.text();
    const cc=r.headers.get('cache-control')||'';
    assert.match(cc,/no-store/,'missing no-store');
    assert.notEqual(r.status,304,'conditional 304 not allowed');
    assert.equal(r.headers.get('etag'),null,'etag not allowed');
    assert.match(r.headers.get('vary')||'',/Authorization/i,'Vary: Authorization missing');
    return {status:r.status,body};
  }
  const unauth=await http('subjects',null);
  assert.equal(unauth.status,401);success('N7-unauthenticated-http','401 + no-store',String(unauth.status));
  const forbidden=await http('subjects',pto.token);
  assert.equal(forbidden.status,403);success('N8-forbidden-fin-role','403 + no-store',String(forbidden.status));
  const invalid=await http('buffers/not-a-uuid',a.token);
  assert.equal(invalid.status,400);success('N9-malformed-uuid','400 + no-store',String(invalid.status));
  const valid=await http('subjects',a.token,{headers:{'If-None-Match':'*'}});
  assert.equal(valid.status,200);success('N10-conditional-cache','200 not 304 + no-store',String(valid.status));

  const uniqueName='F02 synthetic '+randomUUID();
  const created=await http('historical-subjects',a.token,{
    method:'POST',body:{name:uniqueName,idempotencyKey:randomUUID()}
  });
  assert.equal(created.status,200, 'own tenant subject creation');
  const other=await http('subjects',b.token);
  assert.equal(other.status,200);
  assert.ok(!other.body.includes(uniqueName),'cross-tenant subject disclosed');
  success('N11-cross-tenant-discovery','tenant B cannot observe A new subject','not disclosed');


  // Reviewer-owned negative N13: fail-closed on an injected *unexpected* PostgreSQL error.
  // Only mutate this disposable database, and remove every injected object in finally.
  const f02tag=randomUUID().replace(/-/g,'');
  const f02fn='fin_f02_negative_'+f02tag;
  const f02tr='fin_f02_trigger_'+f02tag;
  await admin.query(`CREATE FUNCTION public.${f02fn}() RETURNS trigger LANGUAGE plpgsql AS
);
  try {
    await admin.query(`CREATE TRIGGER ${f02tr} BEFORE INSERT ON public.fin_historical_subjects
      FOR EACH ROW EXECUTE FUNCTION public.${f02fn}()`);
    try {
      const baseline=await admin.query(
        'SELECT (SELECT count(*)::int FROM public.fin_historical_subjects WHERE tenant_id=$1) AS subjects, '+
        '(SELECT count(*)::int FROM public.fin_command_ledger WHERE tenant_id=$1) AS ledger',[t1]);
      const failed=await http('historical-subjects',a.token,{
        method:'POST',body:{name:'F02 should rollback '+randomUUID(),idempotencyKey:randomUUID()}
      });
      assert.equal(failed.status,500,'unexpected native SQLSTATE must map to generic 500');
      assert.match(failed.body,/FIN_INTERNAL_ERROR/);
      assert.doesNotMatch(failed.body,/F02-PRIVATE|XX000|sqlstate|relation|stack|hint|detail/i);
      const afterFailed=await admin.query(
        'SELECT (SELECT count(*)::int FROM public.fin_historical_subjects WHERE tenant_id=$1) AS subjects, '+
        '(SELECT count(*)::int FROM public.fin_command_ledger WHERE tenant_id=$1) AS ledger',[t1]);
      assert.deepEqual(afterFailed.rows[0],baseline.rows[0],'failed command wrote partial records');
      success('N13-unexpected-db-error','generic HTTP 500, no SQL text, full rollback','matched');
    } finally {
      await admin.query(`DROP TRIGGER IF EXISTS ${f02tr} ON public.fin_historical_subjects`);
    }
  } finally {
    await admin.query(`DROP FUNCTION IF EXISTS public.${f02fn}()`);
  }

  const expired=await actor(t1,'SDO');
  await admin.query("UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE user_id=$1",[expired.uid]);
  const expiredReply=await http('subjects',expired.token);
  assert.ok([401,403].includes(expiredReply.status),'expired bearer must be denied');
  success('N14-expired-session','401 or 403 with no-store',String(expiredReply.status));

  await admin.query("UPDATE users SET role='PTO' WHERE id=$1 AND tenant_id=$2",[a.uid,t1]);
  const revoked=await http('subjects',a.token);
  assert.equal(revoked.status,403);
  success('N12-revoked-role','403 + no-store',String(revoked.status));

  console.log('SEC01-F02 reviewer-owned independent negative checks: '+tests.length+' PASS');
}
main().catch(e=>{console.error('SEC01-F02 negative test failed:',e.message);process.exitCode=1})
  .finally(async()=>{
    if(app)await app.close().catch(()=>{});
    if(restricted)await restricted.end().catch(()=>{});
    await admin.end().catch(()=>{});
  });
