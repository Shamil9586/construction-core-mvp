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
 // Only the SECURITY DEFINER owner sees financial tables; the LOGIN sees
 // neither finance books nor director-protected projections through SQL.
 await owner.query('GRANT SELECT ON TABLE public.objects,public.contractors,public.fin_subjects,public.fin_party_scopes,public.fin_contract_scopes,public.fin_quarter_plan_books,public.fin_quarter_book_revisions,public.fin_quarter_plan_lines,public.fin_quarter_plan_line_revisions TO fin_sdo_definer_test');
 await owner.query('GRANT SELECT,INSERT ON TABLE public.fin_subjects,public.fin_party_scopes,public.fin_contract_scopes,public.fin_plan_edit_sessions,public.fin_plan_edit_session_lines TO fin_sdo_definer_test');
 await owner.query('GRANT UPDATE,DELETE ON TABLE public.fin_plan_edit_sessions,public.fin_plan_edit_session_lines TO fin_sdo_definer_test');
 await owner.query('GRANT INSERT ON TABLE public.fin_quarter_plan_books,public.fin_quarter_book_revisions,public.fin_quarter_plan_lines,public.fin_quarter_plan_line_revisions TO fin_sdo_definer_test');
 await owner.query('GRANT UPDATE ON TABLE public.fin_quarter_plan_books TO fin_sdo_definer_test');
 await owner.query('ALTER FUNCTION public.fin_sdo_session_principal(text,text) OWNER TO fin_sdo_definer_test');
 await owner.query('ALTER FUNCTION public.fin_sdo_create_historical_subject(text,text,text,text,text) OWNER TO fin_sdo_definer_test');
 await owner.query('ALTER FUNCTION public.fin_sdo_create_historical_party(text,text,text) OWNER TO fin_sdo_definer_test');
 await owner.query('ALTER FUNCTION public.fin_sdo_read_directory(text) OWNER TO fin_sdo_definer_test');
 await owner.query('ALTER FUNCTION public.fin_sdo_read_quarter(text,integer,integer,timestamptz) OWNER TO fin_sdo_definer_test');
 await owner.query('ALTER FUNCTION public.fin_sdo_create_edit_buffer(text,integer,integer,integer,jsonb) OWNER TO fin_sdo_definer_test');
 await owner.query('ALTER FUNCTION public.fin_sdo_list_edit_buffers(text,integer,integer) OWNER TO fin_sdo_definer_test');
 await owner.query('ALTER FUNCTION public.fin_sdo_read_edit_buffer(text,uuid) OWNER TO fin_sdo_definer_test');
 await owner.query('ALTER FUNCTION public.fin_sdo_update_edit_buffer(text,uuid,integer,integer,integer,integer,jsonb) OWNER TO fin_sdo_definer_test');
 await owner.query('ALTER FUNCTION public.fin_sdo_commit_edit_buffer(text,integer,integer,uuid,integer,date,text,text) OWNER TO fin_sdo_definer_test');
 await owner.query('ALTER FUNCTION public.fin_assert_quarter_book() OWNER TO fin_sdo_definer_test');
 await owner.query('ALTER FUNCTION public.fin_assert_history_links() OWNER TO fin_sdo_definer_test');
 await owner.query('GRANT EXECUTE ON FUNCTION public.fin_sdo_session_principal(text,text) TO fin_sdo_isolated_login');
 await owner.query('GRANT EXECUTE ON FUNCTION public.fin_sdo_create_historical_subject(text,text,text,text,text) TO fin_sdo_isolated_login');
 await owner.query('GRANT EXECUTE ON FUNCTION public.fin_sdo_create_historical_party(text,text,text) TO fin_sdo_isolated_login');
 await owner.query('GRANT EXECUTE ON FUNCTION public.fin_sdo_read_directory(text) TO fin_sdo_isolated_login');
 await owner.query('GRANT EXECUTE ON FUNCTION public.fin_sdo_read_quarter(text,integer,integer,timestamptz) TO fin_sdo_isolated_login');
 await owner.query('GRANT EXECUTE ON FUNCTION public.fin_sdo_create_edit_buffer(text,integer,integer,integer,jsonb) TO fin_sdo_isolated_login');
 await owner.query('GRANT EXECUTE ON FUNCTION public.fin_sdo_list_edit_buffers(text,integer,integer) TO fin_sdo_isolated_login');
 await owner.query('GRANT EXECUTE ON FUNCTION public.fin_sdo_read_edit_buffer(text,uuid) TO fin_sdo_isolated_login');
 await owner.query('GRANT EXECUTE ON FUNCTION public.fin_sdo_update_edit_buffer(text,uuid,integer,integer,integer,integer,jsonb) TO fin_sdo_isolated_login');
 await owner.query('GRANT EXECUTE ON FUNCTION public.fin_sdo_commit_edit_buffer(text,integer,integer,uuid,integer,date,text,text) TO fin_sdo_isolated_login');

 const pgRoles=await owner.query("SELECT rolname,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname IN ($1,$2)",[roleName,'fin_sdo_definer_test']);
 assert.equal(pgRoles.rows.length,2);
 for (const r of pgRoles.rows) {
   assert.equal(r.rolsuper,false);assert.equal(r.rolbypassrls,false);
   assert.equal(r.rolcreaterole,false);assert.equal(r.rolcreatedb,false);
 }
 const fnOwners=await owner.query("SELECT p.proname,r.rolname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='public' AND p.proname IN ('fin_sdo_session_principal','fin_sdo_create_historical_subject','fin_sdo_create_historical_party','fin_sdo_read_directory','fin_sdo_read_quarter','fin_sdo_create_edit_buffer','fin_sdo_list_edit_buffers','fin_sdo_read_edit_buffer','fin_sdo_update_edit_buffer','fin_sdo_commit_edit_buffer','fin_assert_quarter_book','fin_assert_history_links')");
 assert.equal(fnOwners.rows.length,12);
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
 const director=await actor('fin1-isolated.example.test','GENERAL_DIRECTOR');
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
   "SELECT has_table_privilege('fin_sdo_definer_test','public.objects','UPDATE') AS production_update, has_table_privilege('fin_sdo_definer_test','public.fin_quarter_plan_books','UPDATE') AS finance_book_update, has_table_privilege('fin_sdo_isolated_login','public.fin_quarter_plan_books','UPDATE') AS runtime_book_update");
 assert.equal(ownerPrivilege.rows[0].production_update,false);
 assert.equal(ownerPrivilege.rows[0].finance_book_update,true);
 assert.equal(ownerPrivilege.rows[0].runtime_book_update,false);
 console.log('PASS S-01 DEFINER can CAS book head, runtime LOGIN cannot directly update book or production');


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
   // Prove the FIN restricted connection is the only query path, including
   // read-only GD access and cross-tenant isolation.
   const directory=await api('subjects',a.token);
   assert.equal(directory.status,200);
   assert.ok(directory.body.historical.some((v:any)=>v.id===httpId));
   assert.ok(directory.body.historicalParties.some((v:any)=>v.id===httpParty.body.id));
   assert.ok(directory.body.core.some((v:any)=>v.name==='FIN CORE ACTIVE'));
   console.log('PASS S-01 FIN restricted READ directory includes tenant CORE and HISTORICAL');

   const plan=await api('quarter?year=2027&quarter=1',a.token);
   assert.equal(plan.status,200);
   assert.equal(plan.body.status,'ACTIVE');
   assert.equal(plan.body.original,'10000000.00');
   assert.equal(plan.body.current,'11000000.00');
   assert.ok(plan.body.history.length>=3);
   assert.equal(plan.body.lines.length,2);
   console.log('PASS S-01 FIN protected quarter original/current/history and multi-line book');

   // Snapshot knownAt must expose neither the later amount nor the future
   // mutable head *version*. Construct a native-PG microsecond midpoint so
   // node Date rounding cannot make this test flaky.
   const point=await owner.query(
      "SELECT to_char((r1.recorded_at+(r2.recorded_at-r1.recorded_at)/2) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS known_at FROM fin_quarter_book_revisions r1 JOIN fin_quarter_book_revisions r2 ON r2.tenant_id=r1.tenant_id AND r2.book_id=r1.book_id AND r2.revision_no=2 JOIN fin_quarter_plan_books b ON b.id=r1.book_id AND b.tenant_id=r1.tenant_id WHERE r1.revision_no=1 AND r1.tenant_id=$1 AND b.plan_year=2027 AND b.plan_quarter=1",
      [a.tenant]
   );
   assert.equal(point.rows.length,1);
   const retrospective=await api('quarter?year=2027&quarter=1&knownAt='+encodeURIComponent(point.rows[0].known_at),a.token);
   assert.equal(retrospective.status,200);
   assert.equal(retrospective.body.status,'ACTIVE');
   assert.equal(retrospective.body.current,'10000000.00');
   assert.equal(retrospective.body.revisionNo,1);
   assert.equal(retrospective.body.bookVersion,1);
   assert.equal(retrospective.body.history.length,1);
   console.log('PASS S-01 FIN as-of view never leaks future head-version, amount, or revision count');

   const asOf=await api('quarter?year=2027&quarter=1&knownAt=2020-01-01T00%3A00%3A00%2B03%3A00',a.token);
   assert.equal(asOf.status,200);assert.equal(asOf.body.status,'NO_PLAN_AT_KNOWN_AT');
   console.log('PASS S-01 FIN read as-of excludes revisions recorded after cutoff');
   const noPlan=await api('quarter?year=2030&quarter=4',a.token);
   assert.equal(noPlan.status,200);assert.equal(noPlan.body.status,'NO_PLAN');
   console.log('PASS S-01 empty quarter does not become implicit zero');

   const gdPlan=await api('quarter?year=2027&quarter=1',director.token);
   assert.equal(gdPlan.status,200);assert.equal(gdPlan.body.current,plan.body.current);
   const gdSubjects=await api('subjects',director.token);
   assert.equal(gdSubjects.status,200);
   assert.ok(gdSubjects.body.historical.some((x:any)=>x.id===httpId));
   const gdWrite=await api('historical-parties',director.token,'POST',{name:'Forbidden GD',idempotencyKey:randomUUID()});
   assert.equal(gdWrite.status,403);
   console.log('PASS S-01 director may read protected plans and subjects but not write');
   const ptoRead=await api('quarter?year=2027&quarter=1',pto.token);
   assert.equal(ptoRead.status,403);
   assert.ok(!JSON.stringify(ptoRead.body).includes('11000000.00'));
   console.log('PASS S-01 PTO protected quarter API denied without disclosure');
   const foreignPlan=await api('quarter?year=2027&quarter=1',b.token);
   assert.equal(foreignPlan.status,200);assert.equal(foreignPlan.body.status,'NO_PLAN');
   const foreignDir=await api('subjects',b.token);
   assert.equal(foreignDir.status,200);
   assert.ok(!foreignDir.body.historical.some((v:any)=>v.id===httpId));
   console.log('PASS S-01 different-tenant bearer has no cross-tenant plan, subject or record count');
   await expectSqlState(()=>runFinSdoCommandTx(async tx=>{
     await tx.c.query('SELECT * FROM public.fin_quarter_plan_books LIMIT 1');
   }),'42501','FIN runtime login forbidden direct financial book SELECT');
   // Protected technical input (create only): 6.00 remains draft, and 6+4.00
   // remains an actor-scoped draft, never an original/effective quarter book.
   const bSix=await api('buffers',a.token,'POST',{
     year:2030,quarter:1,expectedBookVersion:0,lines:[
       {historicalSubjectId:httpId,partyKind:'UNALLOCATED',contractKind:'NOT_SPECIFIED',amountMln:'6.00'}
     ]
   });
   assert.equal(bSix.status,200);assert.equal(bSix.body.totalRub,'6000000.00');
   assert.equal(bSix.body.uncommitted,true);
   assert.equal(bSix.body.version,1);
   const bTen=await api('buffers',a.token,'POST',{
     year:2030,quarter:1,expectedBookVersion:0,lines:[
       {historicalSubjectId:httpId,partyKind:'UNALLOCATED',contractKind:'NOT_SPECIFIED',amountMln:'6.00'},
       {coreObjectId:directory.body.core[0].id,partyKind:'HISTORICAL_PARTY',
        partyId:httpParty.body.id,contractKind:'KNOWN',contractNumber:'FIN-C-2029',amountMln:'4.00'}
     ]
   });
   assert.equal(bTen.status,200);assert.equal(bTen.body.totalRub,'10000000.00');
   assert.notEqual(bSix.body.bufferId,bTen.body.bufferId);
   const firstPrivate=await api('buffers/'+bSix.body.bufferId,a.token);
   assert.equal(firstPrivate.status,200);
   assert.equal(firstPrivate.body.buffer.version,1);
   assert.equal(firstPrivate.body.lines.length,1);
   const listPrivate=await api('buffers?year=2030&quarter=1',a.token);
   assert.equal(listPrivate.status,200);
   assert.ok(listPrivate.body.some((v:any)=>v.id===bSix.body.bufferId));
   assert.ok(listPrivate.body.some((v:any)=>v.id===bTen.body.bufferId));
   const deniedDirector=await api('buffers?year=2030&quarter=1',director.token);
   assert.equal(deniedDirector.status,403);
   const deniedDirectorById=await api('buffers/'+bSix.body.bufferId,director.token);
   assert.equal(deniedDirectorById.status,403);
   const deniedForeignById=await api('buffers/'+bSix.body.bufferId,b.token);
   assert.equal(deniedForeignById.status,403);
   const deniedPtoById=await api('buffers/'+bSix.body.bufferId,pto.token);
   assert.equal(deniedPtoById.status,403);
   console.log('PASS S-01 actor-only technical buffer list/read, director and cross-tenant denied');

   const patchPayload={year:2030,quarter:1,expectedBookVersion:0,expectedBufferVersion:1,lines:[
     {historicalSubjectId:httpId,partyKind:'UNALLOCATED',contractKind:'NOT_SPECIFIED',amountMln:'6.00'},
     {coreObjectId:directory.body.core[0].id,partyKind:'HISTORICAL_PARTY',
      partyId:httpParty.body.id,contractKind:'KNOWN',contractNumber:'FIN-C-2029',amountMln:'4.00'}
   ]};
   const patched=await api('buffers/'+bSix.body.bufferId,a.token,'PATCH',patchPayload);
   assert.equal(patched.status,200);assert.equal(patched.body.version,2);
   assert.equal(patched.body.bufferId,bSix.body.bufferId);
   assert.equal(patched.body.totalRub,'10000000.00');
   const afterPatch=await api('buffers/'+bSix.body.bufferId,a.token);
   assert.equal(afterPatch.status,200);assert.equal(afterPatch.body.buffer.version,2);
   assert.equal(afterPatch.body.lines.length,2);
   const stalePatch=await api('buffers/'+bSix.body.bufferId,a.token,'PATCH',patchPayload);
   assert.equal(stalePatch.status,409);
   const unchanged=await api('buffers/'+bSix.body.bufferId,a.token);
   assert.equal(unchanged.body.lines.length,2);assert.equal(unchanged.body.buffer.version,2);
   const foreignPatch=await api('buffers/'+bSix.body.bufferId,b.token,'PATCH',patchPayload);
   assert.equal(foreignPatch.status,403);
   const directorPatch=await api('buffers/'+bSix.body.bufferId,director.token,'PATCH',patchPayload);
   assert.equal(directorPatch.status,403);
   const duplicatePatch=await api('buffers/'+bSix.body.bufferId,a.token,'PATCH',{
     ...patchPayload,expectedBufferVersion:2,lines:[
       {historicalSubjectId:httpId,partyKind:'UNALLOCATED',contractKind:'NOT_SPECIFIED',amountMln:'6.00'},
       {historicalSubjectId:httpId,partyKind:'UNALLOCATED',contractKind:'NOT_SPECIFIED',amountMln:'4.00'}
     ]
   });
   assert.equal(duplicatePatch.status,409);
   assert.equal((await api('buffers/'+bSix.body.bufferId,a.token)).body.buffer.version,2);
   assert.equal((await api('buffers/'+bSix.body.bufferId,a.token)).body.lines.length,2);
   console.log('PASS S-01 6.00 to 10.00 protected PATCH via CAS with stale/foreign/duplicate rollback');

   const stillNoPlan=await api('quarter?year=2030&quarter=1',a.token);
   assert.equal(stillNoPlan.status,200);assert.equal(stillNoPlan.body.status,'NO_PLAN');
   console.log('PASS S-01 restricted DB technical buffer 6 then 6+4 without creating original');
   const invalidForeign=await api('buffers',a.token,'POST',{
     year:2030,quarter:1,expectedBookVersion:0,lines:[
       {historicalSubjectId:b.uid,partyKind:'UNALLOCATED',contractKind:'NOT_SPECIFIED',amountMln:'12.00'}
     ]
   });
   assert.equal(invalidForeign.status,403);
   const ptoBuffer=await api('buffers',pto.token,'POST',{
     year:2030,quarter:1,expectedBookVersion:0,lines:[
       {historicalSubjectId:httpId,partyKind:'UNALLOCATED',contractKind:'NOT_SPECIFIED',amountMln:'12.00'}
     ]
   });
   assert.equal(ptoBuffer.status,403);
   console.log('PASS S-01 protected buffers reject foreign subject and PTO bearer');
   const duplicate=await api('buffers',a.token,'POST',{
     year:2030,quarter:1,expectedBookVersion:0,lines:[
       {historicalSubjectId:httpId,partyKind:'UNALLOCATED',contractKind:'NOT_SPECIFIED',amountMln:'6.00'},
       {historicalSubjectId:httpId,partyKind:'UNALLOCATED',contractKind:'NOT_SPECIFIED',amountMln:'4.00'}
     ]
   });
   assert.equal(duplicate.status,409);
   const bookSessions=await owner.query("SELECT count(*)::int n FROM fin_plan_edit_sessions WHERE tenant_id=$1 AND plan_year=2030 AND plan_quarter=1",[a.tenant]);
   assert.equal(bookSessions.rows[0].n,2);
   console.log('PASS S-01 rejected duplicate canonical row rolls back entire buffer (no partial session)');
   await expectSqlState(()=>runFinSdoCommandTx(async tx=>{
      await tx.c.query("INSERT INTO fin_plan_edit_sessions(tenant_id,actor_id,plan_year,plan_quarter) VALUES($1,$2,2030,2)",[a.tenant,a.uid]);
   }),'42501','limited FIN login cannot directly create edit buffer without definer');
   // One genuine restricted-connection FIN quarter book commit. The
   // 6→(6+4) private draft is not a plan until this atomic operation succeeds.
   const originalCommand={year:2030,quarter:1,bufferId:bSix.body.bufferId,
     expectedBookVersion:0,effectiveOn:'2030-01-10',idempotencyKey:randomUUID()};
   const original=await api('commit',a.token,'POST',originalCommand);
   assert.equal(original.status,200,JSON.stringify(original.body));
   assert.equal(original.body.totalRub,'10000000.00');
   assert.equal(original.body.bookVersion,1);
   const firstOfficial=await api('quarter?year=2030&quarter=1',a.token);
   assert.equal(firstOfficial.status,200);
   assert.equal(firstOfficial.body.original,'10000000.00');
   assert.equal(firstOfficial.body.current,'10000000.00');
   assert.equal(firstOfficial.body.history.length,1);
   assert.equal(firstOfficial.body.lines.length,2);
   const replay=await api('commit',a.token,'POST',originalCommand);
   assert.equal(replay.status,200);
   assert.deepEqual(replay.body,original.body);
   const conflictingReplay=await api('commit',a.token,'POST',
     {...originalCommand,effectiveOn:'2030-01-11'});
   assert.equal(conflictingReplay.status,409);
   const staleOriginal=await api('commit',a.token,'POST',{
     ...originalCommand,bufferId:bTen.body.bufferId,
     idempotencyKey:randomUUID()
   });
   assert.equal(staleOriginal.status,409);
   console.log('PASS S-01 protected first quarter plan at 10.00m, immutable original, CAS and replay');

   const correctionBuffer=await api('buffers',a.token,'POST',{
     year:2030,quarter:1,expectedBookVersion:1,lines:[
       {historicalSubjectId:httpId,partyKind:'UNALLOCATED',
        contractKind:'NOT_SPECIFIED',amountMln:'6.50'},
       {coreObjectId:directory.body.core[0].id,partyKind:'HISTORICAL_PARTY',
        partyId:httpParty.body.id,contractKind:'KNOWN',
        contractNumber:'FIN-C-2029',amountMln:'4.00'}
     ]
   });
   assert.equal(correctionBuffer.status,200,JSON.stringify(correctionBuffer.body));
   const correction=await api('commit',a.token,'POST',{
     year:2030,quarter:1,bufferId:correctionBuffer.body.bufferId,
     expectedBookVersion:1,effectiveOn:'2030-02-10',
     reason:'Техническая корректировка',idempotencyKey:randomUUID()
   });
   assert.equal(correction.status,200,JSON.stringify(correction.body));
   assert.equal(correction.body.bookVersion,2);
   assert.equal(correction.body.totalRub,'10500000.00');
   const revised=await api('quarter?year=2030&quarter=1',director.token);
   assert.equal(revised.status,200);
   assert.equal(revised.body.original,'10000000.00');
   assert.equal(revised.body.current,'10500000.00');
   assert.equal(revised.body.history.length,2);
   assert.equal(revised.body.lines.length,2);
   console.log('PASS S-01 FIN protected correction and director-only immutable history');

   // Invalid correction must leave current book/head/history identical.
   const lowDraft=await api('buffers',a.token,'POST',{
      year:2030,quarter:1,expectedBookVersion:2,lines:[
       {historicalSubjectId:httpId,partyKind:'UNALLOCATED',
        contractKind:'NOT_SPECIFIED',amountMln:'5.99'},
       {coreObjectId:directory.body.core[0].id,partyKind:'HISTORICAL_PARTY',
        partyId:httpParty.body.id,contractKind:'KNOWN',contractNumber:'FIN-C-2029',amountMln:'4.00'}
      ]
   });
   assert.equal(lowDraft.status,200);
   const lowReject=await api('commit',a.token,'POST',{
      year:2030,quarter:1,bufferId:lowDraft.body.bufferId,
      expectedBookVersion:2,effectiveOn:'2030-03-03',
      reason:'Below threshold',idempotencyKey:randomUUID()
   });
   assert.equal(lowReject.status,422,JSON.stringify(lowReject.body));
   const unchangedBook=await api('quarter?year=2030&quarter=1',a.token);
   assert.equal(unchangedBook.body.current,'10500000.00');
   assert.equal(unchangedBook.body.original,'10000000.00');
   assert.equal(unchangedBook.body.bookVersion,2);
   assert.equal(unchangedBook.body.history.length,2);
   console.log('PASS S-01 9.99m protected correction atomically rejected without head/history change');

   const ptoCommit=await api('commit',pto.token,'POST',{...originalCommand,idempotencyKey:randomUUID()});
   assert.equal(ptoCommit.status,403);
   const directorCommit=await api('commit',director.token,'POST',{...originalCommand,idempotencyKey:randomUUID()});
   assert.equal(directorCommit.status,403);
   const foreignCommit=await api('commit',b.token,'POST',{...originalCommand,idempotencyKey:randomUUID()});
   assert.equal(foreignCommit.status,403);
   await expectSqlState(()=>runFinSdoCommandTx(async tx=>{
     await tx.c.query('UPDATE public.fin_quarter_plan_books SET head_revision_no=50,version=50 WHERE id=$1',
       [original.body.bookId]);
   }),'42501','actual restricted FIN login denied direct book head mutation');
   await expectSqlState(()=>runFinSdoCommandTx(async tx=>{
     await tx.c.query('DELETE FROM public.fin_quarter_book_revisions WHERE id=$1',
       [firstOfficial.body.history[0].id]);
   }),'42501','actual restricted FIN login denied immutable book history DELETE');
   await expectSqlState(()=>runFinSdoCommandTx(async tx=>{
     await tx.c.query('UPDATE public.fin_command_ledger SET result=$1::jsonb WHERE id=$2',
       ['{}',randomUUID()]);
   }),'42501','actual restricted FIN login denied finance command-ledger rewrite');
   console.log('PASS S-01 protected FIN book tenant/role negative API and direct SQL integrity denials');

   // Two initially valid drafts race: at most one original in one quarter.
   const draftRace=await Promise.all(['10.00','12.00'].map(amount=>
     api('buffers',a.token,'POST',{
       year:2031,quarter:1,expectedBookVersion:0,lines:[
         {historicalSubjectId:httpId,partyKind:'UNALLOCATED',
          contractKind:'NOT_SPECIFIED',amountMln:amount}
       ]
     })
   ));
   assert.ok(draftRace.every(x=>x.status===200));
   const initialRace=await Promise.all(draftRace.map(x=>
     api('commit',a.token,'POST',{
       year:2031,quarter:1,bufferId:x.body.bufferId,
       expectedBookVersion:0,effectiveOn:'2031-01-10',idempotencyKey:randomUUID()
     })
   ));
   assert.deepEqual(initialRace.map(x=>x.status).sort((x,y)=>x-y),[200,409]);
   const single=await api('quarter?year=2031&quarter=1',a.token);
   assert.equal(single.status,200);
   assert.equal(single.body.bookVersion,1);
   assert.equal(single.body.history.length,1);
   console.log('PASS S-01 native two-connection protected initial commit race: one original, loser 409');


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
 console.log('S-01 protected book original/revision, draft CAS and restricted PostgreSQL tested; SEC-01 OPEN until full matrix and independent review.');
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{
  // Ephemeral CI database gets destroyed after job. Never drop a role in production.
  await restrictedFinConnectionPool().end().catch(()=>{});
  await owner.end();
});
