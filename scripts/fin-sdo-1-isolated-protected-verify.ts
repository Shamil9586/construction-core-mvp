/**
 * S-01 isolated native PostgreSQL proof: actual FIN-specific LOGIN principal
 * (different from legacy app DB role), no direct FIN DML, privileged historical
 * subject command via session bearer. Not a complete FIN-SDO protected writer.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { runFinSdoCommandTx, restrictedFinConnectionPool } from '../apps/backend/src/fin-sdo-1-db';

const url=process.env.DATABASE_URL;
if(process.env.FIN_SDO_ISOLATED_CONFIRM!=='YES'||!url)throw Error('Requires isolated confirmation');
const dbUrl=new URL(url);
if(!['localhost','127.0.0.1','::1'].includes(dbUrl.hostname)||!dbUrl.pathname.endsWith('_test'))throw Error('Refuse non-test DB');

const owner=new Pool({connectionString:url,connectionTimeoutMillis:5000});
const roleName='fin_sdo_isolated_login';
const password=randomBytes(38).toString('base64url'); // never printed or persisted
const finUrl=new URL(url);
finUrl.username=roleName;finUrl.password=password;
process.env.FIN_SDO_DATABASE_URL=finUrl.toString();

async function expectSqlState(fn:()=>Promise<unknown>,sqlstate:string,label:string){
 try{await fn();throw new Error('Expected '+sqlstate+' for '+label);}
 catch(e:any){assert.equal(e?.code,sqlstate,'Wrong SQLSTATE for '+label+': '+String(e?.message));console.log('PASS S-01 '+label+' ['+sqlstate+']');}
}

async function main(){
 await owner.query("CREATE ROLE fin_sdo_isolated_login LOGIN PASSWORD '"+password+"'");
 // A separate NOLOGIN, NO-BYPASSRLS, non-superuser owner executes strictly
 // the privilege-whitelisted FIN SECURITY DEFINER commands. This models
 // S-01 least privilege, unlike a function owned by the migration superuser.
 await owner.query('CREATE ROLE fin_sdo_definer_test NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE');
 await owner.query('GRANT USAGE ON SCHEMA public TO fin_sdo_definer_test,fin_sdo_isolated_login');
 await owner.query('GRANT SELECT ON TABLE public.sessions,public.users,public.fin_command_ledger TO fin_sdo_definer_test');
 await owner.query('GRANT SELECT,INSERT ON TABLE public.fin_historical_subjects,public.fin_historical_parties TO fin_sdo_definer_test');
 await owner.query('GRANT INSERT ON TABLE public.fin_command_ledger TO fin_sdo_definer_test');
 await owner.query('ALTER FUNCTION public.fin_sdo_session_principal(text,text) OWNER TO fin_sdo_definer_test');
 await owner.query('ALTER FUNCTION public.fin_sdo_create_historical_subject(text,text,text,text,text) OWNER TO fin_sdo_definer_test');
 await owner.query('ALTER FUNCTION public.fin_sdo_create_historical_party(text,text,text) OWNER TO fin_sdo_definer_test');
 await owner.query('GRANT EXECUTE ON FUNCTION public.fin_sdo_session_principal(text,text) TO fin_sdo_isolated_login');
 await owner.query('GRANT EXECUTE ON FUNCTION public.fin_sdo_create_historical_subject(text,text,text,text,text) TO fin_sdo_isolated_login');
 await owner.query('GRANT EXECUTE ON FUNCTION public.fin_sdo_create_historical_party(text,text,text) TO fin_sdo_isolated_login');

 const pgRoles=await owner.query("SELECT rolname,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname IN ($1,$2)",[roleName,'fin_sdo_definer_test']);
 assert.equal(pgRoles.rows.length,2);
 for (const r of pgRoles.rows) {
   assert.equal(r.rolsuper,false);assert.equal(r.rolbypassrls,false);
   assert.equal(r.rolcreaterole,false);assert.equal(r.rolcreatedb,false);
 }
 const fnOwners=await owner.query("SELECT p.proname,r.rolname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='public' AND p.proname IN ('fin_sdo_session_principal','fin_sdo_create_historical_subject','fin_sdo_create_historical_party')");
 assert.equal(fnOwners.rows.length,3);
 for (const row of fnOwners.rows) assert.equal(row.rolname,'fin_sdo_definer_test');
 console.log('PASS S-01 all tested SECURITY DEFINER functions owned by minimal NOLOGIN/NOBYPASSRLS role');


 async function actor(tenantPortal:string,role:string){
   const tenant=(await owner.query('SELECT id FROM tenants WHERE portal=$1',[tenantPortal])).rows[0].id as string;
   const uid=(await owner.query('INSERT INTO users(tenant_id,bitrix_user_id,name,role) VALUES($1,$2,$3,$4) RETURNING id',[tenant,'fin-S01-'+randomUUID(),'S-01 isolated test',role])).rows[0].id;
   const token=randomBytes(32).toString('base64url');
   const digest=createHash('sha256').update(token).digest('hex');
   await owner.query("INSERT INTO sessions(tenant_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tenant,uid,digest]);
   return {tenant,uid,token};
 }
 const a=await actor('fin1-isolated.example.test','SDO');
 const b=await actor('fin2-isolated.example.test','SDO');
 const pto=await actor('fin1-isolated.example.test','PTO');
 const key=randomUUID();

 // Must use FIN-only connector and one tx.c, not the main product connection.
 const result=await runFinSdoCommandTx(async tx=>{
   const identity=await tx.c.query('SELECT current_user AS role');
   assert.equal(identity.rows[0].role,roleName);
   const r=await tx.c.query(
     'SELECT public.fin_sdo_create_historical_subject($1,$2,$3,$4,$5) AS result',
     [a.token,'Protected SDO historical object','Street 1','Client',key]);
   return r.rows[0].result;
 });
 assert.equal(result.origin,'HISTORICAL');
 const actual=await owner.query('SELECT tenant_id,created_by,name FROM fin_historical_subjects WHERE id=$1',[result.id]);
 assert.equal(actual.rows.length,1);assert.equal(actual.rows[0].tenant_id,a.tenant);assert.equal(actual.rows[0].created_by,a.uid);
 console.log('PASS S-01 restricted FIN LOGIN successfully commits authenticated privileged subject create');

 const again=await runFinSdoCommandTx(async tx=>(await tx.c.query(
   'SELECT public.fin_sdo_create_historical_subject($1,$2,$3,$4,$5) AS result',
   [a.token,'Protected SDO historical object','Street 1','Client',key])).rows[0].result);
 assert.deepEqual(again,result);
 assert.equal((await owner.query('SELECT count(*)::int n FROM fin_command_ledger WHERE tenant_id=$1 AND idempotency_key=$2',[a.tenant,key])).rows[0].n,1);
 console.log('PASS S-01 idempotency replay under restricted role has one financial ledger entry');

 await expectSqlState(()=>runFinSdoCommandTx(async tx=>{
   await tx.c.query('SELECT public.fin_sdo_create_historical_subject($1,$2,$3,$4,$5)',
   [a.token,'Different payload','Street 1','Client',key]);
 }),'23505','privileged command refuses conflicting replay');

 await expectSqlState(()=>runFinSdoCommandTx(async tx=>{
   await tx.c.query('UPDATE fin_historical_subjects SET name=$1 WHERE id=$2',['Forged',result.id]);
 }),'42501','same FIN restricted role rejects direct historical UPDATE');

 await expectSqlState(()=>runFinSdoCommandTx(async tx=>{
   await tx.c.query('INSERT INTO fin_command_ledger(tenant_id,actor_id,kind,scope_id,idempotency_key,fingerprint,result) VALUES($1,$2,$3,$4,$5,$6,$7)',
     [a.tenant,a.uid,'spoof',a.tenant,randomUUID(),'fake','{}']);
 }),'42501','same FIN restricted role rejects direct ledger INSERT');

 await expectSqlState(()=>runFinSdoCommandTx(async tx=>{
   await tx.c.query('SELECT token_hash FROM public.sessions LIMIT 1');
 }),'42501','same FIN restricted role rejects direct sessions SELECT');

 await expectSqlState(()=>runFinSdoCommandTx(async tx=>{
   await tx.c.query('SELECT public.fin_sdo_create_historical_subject($1,$2,$3,$4,$5)',
   [pto.token,'Forbidden','A','B',randomUUID()]);
 }),'42501','PTO bearer rejected inside PostgreSQL privileged function');

 await expectSqlState(()=>runFinSdoCommandTx(async tx=>{
   await tx.c.query('SELECT public.fin_sdo_create_historical_subject($1,$2,$3,$4,$5)',
   ['00000000-0000-0000-0000-000000000000','Spoof','A','B',randomUUID()]);
 }),'42501','spoofed actor identifier cannot substitute for bearer');


 const partyKey=randomUUID();
 const partyResult=await runFinSdoCommandTx(async tx=>(await tx.c.query(
   'SELECT public.fin_sdo_create_historical_party($1,$2,$3) AS result',
   [a.token,'Historical planning subcontractor',partyKey])).rows[0].result);
 const partyAgain=await runFinSdoCommandTx(async tx=>(await tx.c.query(
   'SELECT public.fin_sdo_create_historical_party($1,$2,$3) AS result',
   [a.token,'Historical planning subcontractor',partyKey])).rows[0].result);
 assert.deepEqual(partyAgain,partyResult);
 const partyRow=await owner.query('SELECT tenant_id,created_by,name FROM fin_historical_parties WHERE id=$1',[partyResult.id]);
 assert.equal(partyRow.rows.length,1);assert.equal(partyRow.rows[0].tenant_id,a.tenant);
 assert.equal(partyRow.rows[0].created_by,a.uid);
 assert.equal((await owner.query("SELECT count(*)::int n FROM fin_command_ledger WHERE tenant_id=$1 AND actor_id=$2 AND kind='historical-party-create' AND idempotency_key=$3",[a.tenant,a.uid,partyKey])).rows[0].n,1);
 console.log('PASS S-01 protected historical party created once under limited FIN role with actor/tenant from bearer');

 await expectSqlState(()=>runFinSdoCommandTx(async tx=>{
   await tx.c.query('SELECT public.fin_sdo_create_historical_party($1,$2,$3)',[a.token,'Conflicting payload',partyKey]);
 }),'23505','historical party mismatched idempotency fingerprint denied');

 await expectSqlState(()=>runFinSdoCommandTx(async tx=>{
   await tx.c.query('SELECT public.fin_sdo_create_historical_party($1,$2,$3)',[pto.token,'Forbidden party',randomUUID()]);
 }),'42501','PTO cannot call privileged historical-party creation');

 await expectSqlState(()=>runFinSdoCommandTx(async tx=>{
   await tx.c.query('INSERT INTO public.fin_historical_parties(tenant_id,name,created_by) VALUES($1,$2,$3)',[a.tenant,'Direct forged party',a.uid]);
 }),'42501','same FIN restricted role cannot insert historical party directly');

 const ownerPrivilege=await owner.query(
   "SELECT has_table_privilege('fin_sdo_definer_test','public.objects','UPDATE') AS production_update, has_table_privilege('fin_sdo_definer_test','public.fin_quarter_plan_books','UPDATE') AS finance_book_update");
 assert.equal(ownerPrivilege.rows[0].production_update,false);
 assert.equal(ownerPrivilege.rows[0].finance_book_update,false);
 console.log('PASS S-01 restricted DEFINER has no production/financial-book DML privileges');


 // First real HTTP vertical slice: Nest authenticates the supplied bearer
 // using existing sessions. The FIN service then uses the SAME token through
 // the separate restricted PostgreSQL pool (the DB independently checks role,
 // active user and tenant instead of trusting HTTP actor fields).
 process.env.FIN_SDO_1_ROUTES='enabled';
 process.env.FIN_SDO_PROTECTED_IDENTITY_COMMANDS='enabled';
 process.env.AUTH_MODE='mock';
 process.env.MOCK_LOGIN_KEY='test-only-key-never-LIVE';
 process.env.APP_ORIGIN='http://127.0.0.1';
 const {createApp}=await import('../apps/backend/src/main');
 const finApp=await createApp();
 try {
   await finApp.listen(0,'127.0.0.1');
   const endpoint=finApp.getHttpServer().address();
   assert.ok(endpoint && typeof endpoint!=='string');
   const host='http://127.0.0.1:'+endpoint.port;
   async function api(path:string,bearer:string,method='GET',payload?:unknown){
      const response=await fetch(host+'/fin-sdo-1/'+path,{
        method,headers:{Authorization:'Bearer '+bearer,...(payload===undefined?{}:{'Content-Type':'application/json'})},
        ...(payload===undefined?{}:{body:JSON.stringify(payload)})
      });
      const body=await response.json();
      return {status:response.status,body};
   }
   const httpKey=randomUUID();
   let http=await api('historical-subjects',a.token,'POST',{
     name:'HTTP protected identity',address:'Test street',customerName:'Test client',idempotencyKey:httpKey
   });
   assert.equal(http.status,200);
   const httpId=http.body.id;
   assert.ok(httpId);
   const httpReplay=await api('historical-subjects',a.token,'POST',{
     name:'HTTP protected identity',address:'Test street',customerName:'Test client',idempotencyKey:httpKey
   });
   assert.equal(httpReplay.status,200);assert.deepEqual(httpReplay.body,http.body);
   const actualHttp=(await owner.query('SELECT tenant_id,created_by FROM fin_historical_subjects WHERE id=$1',[httpId])).rows;
   assert.equal(actualHttp.length,1);assert.equal(actualHttp[0].tenant_id,a.tenant);
   assert.equal(actualHttp[0].created_by,a.uid);
   console.log('PASS S-01 direct HTTP protected historical subject and identical request replay');
   const httpParty=await api('historical-parties',a.token,'POST',{name:'HTTP historical subcontractor',idempotencyKey:randomUUID()});
   assert.equal(httpParty.status,200);
   assert.equal((await owner.query('SELECT tenant_id FROM fin_historical_parties WHERE id=$1',[httpParty.body.id])).rows[0].tenant_id,a.tenant);
   console.log('PASS S-01 direct HTTP historical party persisted from bearer-derived tenant');
   const forbidden=await api('historical-parties',pto.token,'POST',{name:'Not allowed',idempotencyKey:randomUUID()});
   assert.equal(forbidden.status,403);
   console.log('PASS S-01 direct HTTP PTO cannot call restricted write');
   const mismatch=await api('historical-subjects',a.token,'POST',{name:'DIFFERENT',idempotencyKey:httpKey});
   assert.equal(mismatch.status,409);
   assert.ok(!JSON.stringify(mismatch.body).includes('fin_command_ledger'));
   console.log('PASS S-01 HTTP conflicting idempotency replay is 409 without SQL leakage');
   // Fail CLOSED: unconverted book/buffer writers and FIN legacy projections are
   // *not* allowed to fall back to the main product pool in protected mode.
   for (const [path,method,payload] of [
     ['quarter?year=2028&quarter=1','GET',undefined],
     ['subjects','GET',undefined],
     ['buffers','POST',{year:2028,quarter:1,expectedBookVersion:0,lines:[]}],
     ['commit','POST',{year:2028,quarter:1,bufferId:randomUUID(),expectedBookVersion:0,effectiveOn:'2028-01-01',idempotencyKey:randomUUID()}]
   ] as const){
     const result=await api(path,a.token,method,payload);
     assert.equal(result.status,503,path+' must remain unavailable until SEC-01 fixed');
     assert.ok(!JSON.stringify(result.body).includes('Protected SDO historical'));
   }
   console.log('PASS S-01 protected mode refuses ALL unconverted FIN readers and book writers (503)');
 } finally {await finApp.close();}
 const foreign=await runFinSdoCommandTx(async tx=>(await tx.c.query(
   'SELECT public.fin_sdo_create_historical_subject($1,$2,$3,$4,$5) AS result',
   [b.token,'Other tenant protected','Street 2','Other client',randomUUID()])).rows[0].result);
 const foreignRow=await owner.query('SELECT tenant_id,created_by FROM fin_historical_subjects WHERE id=$1',[foreign.id]);
 assert.equal(foreignRow.rows[0].tenant_id,b.tenant);
 assert.notEqual(foreignRow.rows[0].tenant_id,a.tenant);
 console.log('PASS S-01 tenant of protected write is derived from bearer, not a passed tenant_id');

 await owner.query("UPDATE users SET role='PTO' WHERE id=$1 AND tenant_id=$2",[a.uid,a.tenant]);
 await expectSqlState(()=>runFinSdoCommandTx(async tx=>{
   await tx.c.query('SELECT public.fin_sdo_create_historical_subject($1,$2,$3,$4,$5)',
   [a.token,'Protected SDO historical object','Street 1','Client',key]);
 }),'42501','role revocation blocks idempotent replay at DB authorization boundary');
 await expectSqlState(()=>runFinSdoCommandTx(async tx=>{
   await tx.c.query('SELECT public.fin_sdo_create_historical_party($1,$2,$3)',[a.token,'Historical planning subcontractor',partyKey]);
 }),'42501','role revocation blocks historical party idempotent replay');

 assert.equal((await owner.query('SELECT name FROM fin_historical_subjects WHERE id=$1',[result.id])).rows[0].name,'Protected SDO historical object');
 console.log('S-01 vertical slice isolated proof COMPLETE. OTHER FIN WRITERS AND READERS REMAIN BLOCKED.');
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{
  // Ephemeral CI database gets destroyed after job. Never drop a role in production.
  await restrictedFinConnectionPool().end().catch(()=>{});
  await owner.end();
});
