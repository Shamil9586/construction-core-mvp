/**
 * SEC-01-F01 / TECH-F01..F03 native verification: real HTTP through the FIN protected slice and the
 * restricted FIN LOGIN on a DISPOSABLE PostgreSQL. Never intercepted, never LIVE.
 *
 * Prerequisite: run AFTER scripts/fin-sdo-1-isolated-protected-verify.ts in the same disposable database
 * (it creates the restricted FIN LOGIN, the NOLOGIN definer owner and their grants). This script only
 * resets that disposable LOGIN's password, creates its own users/sessions and, for the forced-fault
 * scenarios, installs temporary triggers / renames that are always removed again.
 *
 * Every check is reported as PASS or FAIL and the script exits non-zero if any FAIL, so a baseline run
 * records every defect instead of stopping at the first one.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { connect } from 'node:net';
import { Pool } from 'pg';
import { restrictedFinConnectionPool } from '../apps/backend/src/fin-sdo-1-db';

const url=process.env.DATABASE_URL;
if(process.env.FIN_SDO_ISOLATED_CONFIRM!=='YES'||!url)throw Error('Requires isolated confirmation');
const dbUrl=new URL(url);
if(!['localhost','127.0.0.1','::1'].includes(dbUrl.hostname)||!dbUrl.pathname.endsWith('_test'))throw Error('Refuse non-test DB');

const owner=new Pool({connectionString:url,connectionTimeoutMillis:5000});
const roleName='fin_sdo_isolated_login';
const failures:string[]=[];
async function check(label:string,fn:()=>Promise<void>|void){
 try{await fn();console.log('PASS SEC01-F01 '+label);}
 catch(e:any){failures.push(label);console.log('FAIL SEC01-F01 '+label+' :: '+String(e?.message??e).split('\n').slice(0,6).join(' | '));}
}
/** Strings that must never reach an HTTP body, header or application log line. */
const LEAK=[/SQLSTATE/i,/\b22P02\b/,/\b22007\b/,/\b22008\b/,/\b42P01\b/,/\bXX000\b/,/\b23503\b/,/invalid input syntax/i,/out of range/i,
  /does not exist/i,/violates/i,/relation "/i,/public\.fin_/,/\bfin_[a-z_]{3,}\b/,/node_modules/,/\.ts:\d+/,/\bat [A-Za-z_.]+ \(/,/<html/i,/<pre>/i,/LEAK-/];
const leaks=(text:string)=>LEAK.filter(r=>r.test(text)).map(String);
/** Operator logs may carry a SQLSTATE for diagnosis, never the database message, detail, hint, relation names or tenant data. */
const LOG_LEAK=[/invalid input syntax/i,/out of range/i,/does not exist/i,/violates/i,/relation "/i,/public\.fin_/,/LEAK-/,/node_modules/,/\bat [A-Za-z_.]+ \(/];
const logLeaks=(text:string)=>LOG_LEAK.filter(r=>r.test(text)).map(String);

async function main(){
 const prereq=await owner.query("SELECT (SELECT count(*)::int FROM pg_roles WHERE rolname=$1) login,(SELECT count(*)::int FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.proname='fin_sdo_commit_edit_buffer' AND r.rolname='fin_sdo_definer_test') definer",[roleName]);
 assert.deepEqual(prereq.rows[0],{login:1,definer:1},'run fin-sdo-1-isolated-protected-verify.ts first in this disposable DB');
 const password=randomBytes(38).toString('base64url'); // never printed or persisted
 await owner.query("ALTER ROLE fin_sdo_isolated_login PASSWORD '"+password+"'");
 const finUrl=new URL(url);finUrl.username=roleName;finUrl.password=password;
 process.env.FIN_SDO_DATABASE_URL=finUrl.toString();

 async function actor(portal:string,role:string){
   const tenant=(await owner.query('SELECT id FROM tenants WHERE portal=$1',[portal])).rows[0].id as string;
   const uid=(await owner.query('INSERT INTO users(tenant_id,bitrix_user_id,name,role) VALUES($1,$2,$3,$4) RETURNING id',[tenant,'fin-F01-'+randomUUID(),'F01 '+role,role])).rows[0].id as string;
   const token=randomBytes(32).toString('base64url');
   await owner.query("INSERT INTO sessions(tenant_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tenant,uid,createHash('sha256').update(token).digest('hex')]);
   return {tenant,uid,token};
 }
 const a=await actor('fin1-isolated.example.test','SDO');
 const b=await actor('fin2-isolated.example.test','SDO');
 const gd=await actor('fin1-isolated.example.test','GENERAL_DIRECTOR');
 const pto=await actor('fin1-isolated.example.test','PTO');
 const revoked=await actor('fin1-isolated.example.test','SDO');
 const expired=await actor('fin1-isolated.example.test','SDO');
 await owner.query("UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE user_id=$1",[expired.uid]);

 // Capture every application log line produced while serving the requests below.
 const logLines:string[]=[];
 const original={log:console.log,error:console.error,warn:console.warn};
 for(const k of ['log','error','warn'] as const)(console as any)[k]=(...args:any[])=>{logLines.push(args.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' '));(original as any)[k](...args);};

 process.env.FIN_SDO_1_ROUTES='enabled';
 process.env.FIN_SDO_PROTECTED_IDENTITY_COMMANDS='enabled';
 process.env.AUTH_MODE='mock';
 process.env.MOCK_LOGIN_KEY='test-only-key-never-LIVE';
 process.env.APP_ORIGIN='http://127.0.0.1';
 const {createApp}=await import('../apps/backend/src/main');
 const app=await createApp();
 try{
  await app.listen(0,'127.0.0.1');
  const address=app.getHttpServer().address();
  assert.ok(address&&typeof address!=='string');
  const host='http://127.0.0.1:'+address.port;
  type Res={status:number;headers:Headers;text:string;body:any};
  async function call(path:string,opts:{token?:string;method?:string;json?:unknown;raw?:string;contentType?:string;headers?:Record<string,string>}={}):Promise<Res>{
    const headers:Record<string,string>={...(opts.token?{Authorization:'Bearer '+opts.token}:{}),...(opts.headers??{})};
    let body:string|undefined;
    if(opts.raw!==undefined){body=opts.raw;headers['Content-Type']=opts.contentType??'application/json';}
    else if(opts.json!==undefined){body=JSON.stringify(opts.json);headers['Content-Type']='application/json';}
    const r=await fetch(host+'/fin-sdo-1/'+path,{method:opts.method??'GET',headers,body});
    const text=await r.text();let parsed:any=null;try{parsed=JSON.parse(text)}catch{}
    return {status:r.status,headers:r.headers,text,body:parsed};
  }
  const headerText=(r:Res)=>[...r.headers.entries()].map(([k,v])=>k+': '+v).join('\n');
  /** A safe FIN error: exact status, JSON with the exact FIN message (when given), nothing internal anywhere. */
  function safeError(r:Res,status:number,message?:string|RegExp){
    assert.equal(r.status,status,'status '+r.status+' body '+r.text.slice(0,200));
    assert.ok(r.body&&typeof r.body==='object','JSON error body, got: '+r.text.slice(0,120));
    if(typeof message==='string')assert.equal(r.body.message,message);
    else if(message)assert.match(String(r.body.message),message);
    assert.deepEqual(Object.keys(r.body).filter(k=>!['statusCode','message','requestId'].includes(k)),[],'no extra error fields (detail/hint/query/stack/code)');
    assert.deepEqual(leaks(r.text),[],'body leak');
    assert.deepEqual(leaks(headerText(r)),[],'header leak');
  }
  const counts=async(tenant:string)=>(await owner.query(
    'SELECT (SELECT count(*)::int FROM fin_plan_edit_sessions WHERE tenant_id=$1) sessions,(SELECT count(*)::int FROM fin_plan_edit_session_lines WHERE tenant_id=$1) lines,(SELECT count(*)::int FROM fin_command_ledger WHERE tenant_id=$1) ledger,(SELECT count(*)::int FROM fin_quarter_plan_books WHERE tenant_id=$1) books,(SELECT count(*)::int FROM fin_quarter_book_revisions WHERE tenant_id=$1) revisions,(SELECT count(*)::int FROM fin_historical_subjects WHERE tenant_id=$1) subjects',[tenant])).rows[0];

  // Own fixtures for tenant A.
  const hist=await call('historical-subjects',{token:a.token,method:'POST',json:{name:'F01 historical',idempotencyKey:randomUUID()}});
  assert.equal(hist.status,200,hist.text);
  const party=await call('historical-parties',{token:a.token,method:'POST',json:{name:'F01 party',idempotencyKey:randomUUID()}});
  assert.equal(party.status,200,party.text);
  const line=(over:Record<string,unknown>={})=>({historicalSubjectId:hist.body.id,partyKind:'UNALLOCATED',contractKind:'NOT_SPECIFIED',amountMln:'10.00',...over});
  const draft=await call('buffers',{token:a.token,method:'POST',json:{year:2040,quarter:1,expectedBookVersion:0,lines:[line()]}});
  assert.equal(draft.status,200,draft.text);
  const commitBody=(over:Record<string,unknown>={})=>({year:2040,quarter:1,bufferId:draft.body.bufferId,expectedBufferVersion:1,expectedBookVersion:0,effectiveOn:'2040-01-10',idempotencyKey:randomUUID(),...over});

  // ---- 1. Malformed input is rejected at the trusted boundary: 400, safe body, no partial write ----
  const before=await counts(a.tenant);
  const malformed:Array<[string,string,Parameters<typeof call>[1]]>=[
    ['CORE subject UUID','buffers',{method:'POST',json:{year:2040,quarter:2,expectedBookVersion:0,lines:[{...line(),historicalSubjectId:undefined,coreObjectId:'not-a-uuid'}]}}],
    ['HISTORICAL subject UUID','buffers',{method:'POST',json:{year:2040,quarter:2,expectedBookVersion:0,lines:[line({historicalSubjectId:"x'::uuid; --"})]}}],
    ['FIN party UUID','buffers',{method:'POST',json:{year:2040,quarter:2,expectedBookVersion:0,lines:[line({partyKind:'HISTORICAL_PARTY',partyId:'123'})]}}],
    ['party kind','buffers',{method:'POST',json:{year:2040,quarter:2,expectedBookVersion:0,lines:[line({partyKind:'CUSTOMER'})]}}],
    ['contract scope kind','buffers',{method:'POST',json:{year:2040,quarter:2,expectedBookVersion:0,lines:[line({contractKind:'NO_CONTRACT'})]}}],
    ['contract number too long','buffers',{method:'POST',json:{year:2040,quarter:2,expectedBookVersion:0,lines:[line({contractKind:'KNOWN',contractNumber:'Д'.repeat(151)})]}}],
    ['client-supplied tenantId','buffers',{method:'POST',json:{year:2040,quarter:2,expectedBookVersion:0,tenantId:b.tenant,lines:[line()]}}],
    ['buffer id in GET','buffers/not-a-uuid',{}],
    ['buffer id in PATCH','buffers/12345',{method:'PATCH',json:{year:2040,quarter:1,expectedBookVersion:0,expectedBufferVersion:1,lines:[line()]}}],
    ['buffer id in commit','commit',{method:'POST',json:commitBody({bufferId:'zzz'})}],
    ['effectiveOn year 0000','commit',{method:'POST',json:commitBody({effectiveOn:'0000-01-01'})}],
    ['effectiveOn 30 February','commit',{method:'POST',json:commitBody({effectiveOn:'2040-02-30'})}],
    ['effectiveOn text','commit',{method:'POST',json:commitBody({effectiveOn:'tomorrow'})}],
    ['knownAt year 0000','quarter?year=2040&quarter=1&knownAt='+encodeURIComponent('0000-01-01T00:00:00Z'),{}],
    ['knownAt text','quarter?year=2040&quarter=1&knownAt=yesterday',{}],
    ['quarter year text','quarter?year=abc&quarter=1',{}],
    ['quarter year overflow','quarter?year=99999999999&quarter=1',{}],
    ['buffers list quarter 5','buffers?year=2040&quarter=5',{}],
    ['malformed JSON buffers','buffers',{method:'POST',raw:'{"year":2040,'}],
    ['malformed JSON commit','commit',{method:'POST',raw:'{bad json'}],
    ['malformed JSON historical','historical-subjects',{method:'POST',raw:'[1,2'}],
    ['JSON array body','buffers',{method:'POST',json:[1,2,3]}],
  ];
  for(const [label,path,opts] of malformed)
    await check('malformed '+label+' -> 400 safe FIN error',async()=>safeError(await call(path,{token:a.token,...opts}),400));
  await check('malformed input wrote nothing (sessions/lines/ledger/books/revisions)',async()=>assert.deepEqual(await counts(a.tenant),before));

  // ---- 2. Unexpected SQLSTATE on the real protected HTTP path never escapes raw ----
  async function forced(label:string,install:string[],uninstall:string[],request:()=>Promise<Res>){
    const start=logLines.length,baseline=await counts(a.tenant);
    for(const sql of install)await owner.query(sql);
    let r:Res;
    try{r=await request();}finally{for(const sql of uninstall)await owner.query(sql);}
    await check('forced '+label+' -> 500 FIN_INTERNAL_ERROR, no leak',async()=>safeError(r,500,'FIN_INTERNAL_ERROR'));
    await check('forced '+label+' -> no partial write',async()=>assert.deepEqual(await counts(a.tenant),baseline));
    await check('forced '+label+' -> no internal detail in application logs',async()=>assert.deepEqual(logLines.slice(start).flatMap(logLeaks),[]));
  }
  const raiser=(name:string,state:string,message:string)=>
    `CREATE OR REPLACE FUNCTION public.f01_${name}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION '${message}' USING ERRCODE='${state}', DETAIL='LEAK-DETAIL tenant ${b.tenant}', HINT='LEAK-HINT public.fin_secret'; END$$`;
  const newBuffer=()=>call('buffers',{token:a.token,method:'POST',json:{year:2040,quarter:3,expectedBookVersion:0,lines:[line()]}});
  await forced('22P02 invalid_text_representation (buffer create)',
    [raiser('p22p02','22P02','invalid input syntax for type uuid: "LEAK-22P02"'),'CREATE TRIGGER f01_t22p02 BEFORE INSERT ON public.fin_plan_edit_sessions FOR EACH ROW EXECUTE FUNCTION public.f01_p22p02()'],
    ['DROP TRIGGER f01_t22p02 ON public.fin_plan_edit_sessions','DROP FUNCTION public.f01_p22p02()'],newBuffer);
  await forced('23503 foreign_key_violation (buffer create)',
    [raiser('p23503','23503','insert or update on table "fin_plan_edit_sessions" violates foreign key LEAK-23503'),'CREATE TRIGGER f01_t23503 BEFORE INSERT ON public.fin_plan_edit_sessions FOR EACH ROW EXECUTE FUNCTION public.f01_p23503()'],
    ['DROP TRIGGER f01_t23503 ON public.fin_plan_edit_sessions','DROP FUNCTION public.f01_p23503()'],newBuffer);
  await forced('42P01 undefined_table (renamed relation)',
    ['ALTER TABLE public.fin_plan_edit_session_lines RENAME TO fin_plan_edit_session_lines_f01'],
    ['ALTER TABLE public.fin_plan_edit_session_lines_f01 RENAME TO fin_plan_edit_session_lines'],newBuffer);
  await forced('XX000 internal_error (original commit)',
    [raiser('pxx000','XX000','LEAK-XX000 internal'),'CREATE TRIGGER f01_txx000 BEFORE INSERT ON public.fin_quarter_plan_books FOR EACH ROW EXECUTE FUNCTION public.f01_pxx000()'],
    ['DROP TRIGGER f01_txx000 ON public.fin_quarter_plan_books','DROP FUNCTION public.f01_pxx000()'],
    ()=>call('commit',{token:a.token,method:'POST',json:commitBody()}));
  await forced('allow-listed FIN code under a foreign SQLSTATE is not trusted',
    [raiser('pfake','XX000','FIN_QUARTER_TOTAL_BELOW_MIN'),'CREATE TRIGGER f01_tfake BEFORE INSERT ON public.fin_quarter_plan_books FOR EACH ROW EXECUTE FUNCTION public.f01_pfake()'],
    ['DROP TRIGGER f01_tfake ON public.fin_quarter_plan_books','DROP FUNCTION public.f01_pfake()'],
    ()=>call('commit',{token:a.token,method:'POST',json:commitBody()}));
  await forced('22008 datetime_field_overflow (historical subject create)',
    [raiser('p22008','22008','date/time field value out of range: "LEAK-22008"'),'CREATE TRIGGER f01_t22008 BEFORE INSERT ON public.fin_historical_subjects FOR EACH ROW EXECUTE FUNCTION public.f01_p22008()'],
    ['DROP TRIGGER f01_t22008 ON public.fin_historical_subjects','DROP FUNCTION public.f01_p22008()'],
    ()=>call('historical-subjects',{token:a.token,method:'POST',json:{name:'F01 forced',idempotencyKey:randomUUID()}}));

  // The documented contract still works after the faults were removed.
  const committed=await call('commit',{token:a.token,method:'POST',json:commitBody()});
  await check('documented path intact: original commit 200 after forced faults removed',async()=>{assert.equal(committed.status,200,committed.text);assert.equal(committed.body.totalRub,'10000000.00');});
  await check('documented FIN codes still pass with their SQLSTATE: stale book 409 FIN_QUARTER_BOOK_VERSION_CONFLICT',async()=>
    safeError(await call('buffers',{token:a.token,method:'POST',json:{year:2040,quarter:1,expectedBookVersion:0,lines:[line()]}}),409,'FIN_QUARTER_BOOK_VERSION_CONFLICT'));

  // ---- 3. Authentication / authorisation regression ----
  const foreignBuffer=await call('buffers',{token:b.token,method:'POST',json:{year:2040,quarter:1,expectedBookVersion:0,lines:[{coreObjectId:undefined,historicalSubjectId:(await call('historical-subjects',{token:b.token,method:'POST',json:{name:'F01 tenant B secret',idempotencyKey:randomUUID()}})).body.id,partyKind:'UNALLOCATED',contractKind:'NOT_SPECIFIED',amountMln:'33.33'}]}});
  assert.equal(foreignBuffer.status,200,foreignBuffer.text);
  const secret=[b.tenant,foreignBuffer.body.bufferId,'F01 tenant B secret','33330000.00'];
  const noSecret=(r:Res)=>{for(const s of secret){assert.ok(!r.text.includes(s),'body leaked '+s);assert.ok(!headerText(r).includes(s),'header leaked '+s);}};
  await check('no bearer -> 401 safe',async()=>safeError(await call('quarter?year=2040&quarter=1'),401));
  await check('unknown bearer -> 401 safe',async()=>safeError(await call('quarter?year=2040&quarter=1',{token:randomBytes(32).toString('base64url')}),401));
  await check('expired session -> 401 safe',async()=>safeError(await call('subjects',{token:expired.token}),401));
  await check('PTO -> 403 FIN_ACCESS_DENIED on read and write',async()=>{
    safeError(await call('quarter?year=2040&quarter=1',{token:pto.token}),403,'FIN_ACCESS_DENIED');
    safeError(await call('buffers',{token:pto.token,method:'POST',json:{year:2040,quarter:2,expectedBookVersion:0,lines:[line()]}}),403,'FIN_ACCESS_DENIED');});
  await check('GENERAL_DIRECTOR write -> 403',async()=>safeError(await call('commit',{token:gd.token,method:'POST',json:commitBody()}),403,'FIN_ACCESS_DENIED'));
  await check('tenant A: foreign buffer and nonexistent buffer are indistinguishable (GET/PATCH/commit)',async()=>{
    const strip=(r:Res)=>({s:r.status,m:r.body?.message,keys:Object.keys(r.body??{}).sort()});
    for(const [path,opts] of [['buffers/','GET'],['buffers/','PATCH'],['commit','POST']] as const){
      const req=(id:string)=>path==='commit'
        ?call('commit',{token:a.token,method:'POST',json:commitBody({bufferId:id,year:2040,quarter:1})})
        :call(path+id,{token:a.token,method:opts,...(opts==='PATCH'?{json:{year:2040,quarter:1,expectedBookVersion:0,expectedBufferVersion:1,lines:[line()]}}:{})});
      const foreign=await req(foreignBuffer.body.bufferId),missing=await req(randomUUID());
      assert.deepEqual(strip(foreign),strip(missing),path+' '+opts);
      assert.equal(foreign.status,403);noSecret(foreign);safeError(foreign,403,'FIN_ACCESS_DENIED');
    }});
  await check('tenant A quarter/known_at/buffers/directory carry no tenant-B data',async()=>{
    for(const p of ['quarter?year=2040&quarter=1','quarter?year=2040&quarter=1&knownAt='+encodeURIComponent(new Date().toISOString()),'buffers?year=2040&quarter=1','subjects'])noSecret(await call(p,{token:a.token}));});
  // Revocation: a valid completed command replayed after the role is revoked must not return the stored success.
  const revDraft=await call('buffers',{token:revoked.token,method:'POST',json:{year:2041,quarter:1,expectedBookVersion:0,lines:[line({historicalSubjectId:hist.body.id})]}});
  assert.equal(revDraft.status,200,revDraft.text);
  const revCommand={year:2041,quarter:1,bufferId:revDraft.body.bufferId,expectedBufferVersion:1,expectedBookVersion:0,effectiveOn:'2041-01-10',idempotencyKey:randomUUID()};
  const revFirst=await call('commit',{token:revoked.token,method:'POST',json:revCommand});
  assert.equal(revFirst.status,200,revFirst.text);
  await owner.query("UPDATE users SET role='PTO' WHERE id=$1",[revoked.uid]);
  await check('revoked writer: same-key replay -> 403, no stored success or amount',async()=>{
    const r=await call('commit',{token:revoked.token,method:'POST',json:revCommand});
    safeError(r,403,'FIN_ACCESS_DENIED');assert.ok(!r.text.includes('10000000.00'));});
  await owner.query("UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE user_id=$1",[revoked.uid]);
  await check('revoked session: replay -> 401, no stored success',async()=>safeError(await call('commit',{token:revoked.token,method:'POST',json:revCommand}),401));

  // ---- 4. TECH-F03 / FIN1-18 cache headers on every FIN response class (real API) ----
  const noStore=(r:Res,label:string)=>{
    const cc=r.headers.get('cache-control')??'';
    assert.match(cc,/\bno-store\b/,label+' Cache-Control: '+cc);
    assert.match(cc,/\bprivate\b/,label+' Cache-Control: '+cc);
    assert.equal(r.headers.get('pragma'),'no-cache',label+' Pragma');
    assert.equal(r.headers.get('etag'),null,label+' must not carry an ETag validator');
    assert.equal(r.headers.get('last-modified'),null,label+' must not carry Last-Modified');
  };
  const own=await call('buffers',{token:a.token,method:'POST',json:{year:2040,quarter:4,expectedBookVersion:0,lines:[line()]}});
  const low=await call('buffers',{token:a.token,method:'POST',json:{year:2044,quarter:1,expectedBookVersion:0,lines:[line({amountMln:'9.99'})]}});
  assert.equal(own.status,200,own.text);assert.equal(low.status,200,low.text);
  const headerCases:Array<[string,()=>Promise<Res>,number]>=[
    ['GET subjects 200',()=>call('subjects',{token:a.token}),200],
    ['GET quarter 200',()=>call('quarter?year=2040&quarter=1',{token:a.token}),200],
    ['GET quarter knownAt 200',()=>call('quarter?year=2040&quarter=1&knownAt='+encodeURIComponent(new Date().toISOString()),{token:gd.token}),200],
    ['GET buffers 200',()=>call('buffers?year=2040&quarter=4',{token:a.token}),200],
    ['GET buffers/:id 200',()=>call('buffers/'+own.body.bufferId,{token:a.token}),200],
    ['POST buffers 200',()=>call('buffers',{token:a.token,method:'POST',json:{year:2042,quarter:1,expectedBookVersion:0,lines:[line()]}}),200],
    ['PATCH buffers/:id 200',()=>call('buffers/'+own.body.bufferId,{token:a.token,method:'PATCH',json:{year:2040,quarter:4,expectedBookVersion:0,expectedBufferVersion:1,lines:[line({amountMln:'11.00'})]}}),200],
    ['POST historical-subjects 200',()=>call('historical-subjects',{token:a.token,method:'POST',json:{name:'F01 header',idempotencyKey:randomUUID()}}),200],
    ['POST commit 200',()=>call('commit',{token:a.token,method:'POST',json:{year:2040,quarter:4,bufferId:own.body.bufferId,expectedBufferVersion:2,expectedBookVersion:0,effectiveOn:'2040-10-10',idempotencyKey:randomUUID()}}),200],
    ['401',()=>call('subjects'),401],
    ['403',()=>call('subjects',{token:pto.token}),403],
    ['400',()=>call('buffers/not-a-uuid',{token:a.token}),400],
    ['400 malformed JSON',()=>call('commit',{token:a.token,method:'POST',raw:'{x'}),400],
    ['409',()=>call('commit',{token:a.token,method:'POST',json:commitBody()}),409],
    ['409 buffer CAS',()=>call('commit',{token:a.token,method:'POST',json:{year:2040,quarter:4,bufferId:own.body.bufferId,expectedBufferVersion:9,expectedBookVersion:0,effectiveOn:'2040-10-11',idempotencyKey:randomUUID()}}),409],
    ['422 below minimum',()=>call('commit',{token:a.token,method:'POST',json:{year:2044,quarter:1,bufferId:low.body.bufferId,expectedBufferVersion:1,expectedBookVersion:0,effectiveOn:'2044-01-10',idempotencyKey:randomUUID()}}),422],
  ];
  for(const [label,req,status] of headerCases)
    await check('cache headers '+label,async()=>{const r=await req();assert.equal(r.status,status,r.text.slice(0,160));noStore(r,label);});
  await check('cache headers 500 (forced fault)',async()=>{
    await owner.query(raiser('phdr','XX000','LEAK-HDR'));
    await owner.query('CREATE TRIGGER f01_thdr BEFORE INSERT ON public.fin_plan_edit_sessions FOR EACH ROW EXECUTE FUNCTION public.f01_phdr()');
    try{const r=await newBuffer();assert.equal(r.status,500);noStore(r,'500');}
    finally{await owner.query('DROP TRIGGER f01_thdr ON public.fin_plan_edit_sessions');await owner.query('DROP FUNCTION public.f01_phdr()');}});
  await check('conditional GET never revalidates to 304 (If-None-Match / If-Modified-Since)',async()=>{
    const first=await call('quarter?year=2040&quarter=1',{token:a.token});
    for(const h of [{'If-None-Match':'*'},{'If-None-Match':first.headers.get('etag')??'W/"x"'},{'If-Modified-Since':new Date(Date.now()+86400000).toUTCString()}]){
      const r=await call('quarter?year=2040&quarter=1',{token:a.token,headers:h});
      assert.equal(r.status,200,JSON.stringify(h));assert.equal(r.text,first.text);}});
  await check('responses for two actors are not shared: Vary includes Authorization',async()=>{
    const r=await call('subjects',{token:a.token});assert.match(r.headers.get('vary')??'',/Authorization/i);});

  // ---- 5. TECH-F01 observation: lost response on protected buffer create ----
  {
    const payload=JSON.stringify({year:2043,quarter:1,expectedBookVersion:0,lines:[line()]});
    const before5=await counts(a.tenant);
    await new Promise<void>((resolve,reject)=>{
      const s=connect(Number(new URL(host).port),'127.0.0.1',()=>{
        s.write('POST /fin-sdo-1/buffers HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer '+a.token+'\r\nContent-Type: application/json\r\nContent-Length: '+Buffer.byteLength(payload)+'\r\nConnection: close\r\n\r\n'+payload,()=>{s.destroy();resolve();});
      });
      s.on('error',reject);
    });
    let n=before5.sessions;
    for(let i=0;i<50&&n===before5.sessions;i++){n=(await counts(a.tenant)).sessions;if(n===before5.sessions)await new Promise(r=>setTimeout(r,100));}
    const retry=await call('buffers',{token:a.token,method:'POST',raw:payload});
    const after5=await counts(a.tenant);
    console.log('OBSERVATION TECH-F01 lost POST /buffers response then retry: technical sessions +'+(after5.sessions-before5.sessions)+' (retry status '+retry.status+'), quarter books +'+(after5.books-before5.books)+', ledger +'+(after5.ledger-before5.ledger));
    await check('TECH-F01 duplicate technical buffer never becomes a plan: 2043Q1 stays NO_PLAN, buffers private to author',async()=>{
      assert.equal((await call('quarter?year=2043&quarter=1',{token:gd.token})).body.status,'NO_PLAN');
      assert.equal(after5.books,before5.books);
      safeError(await call('buffers?year=2043&quarter=1',{token:gd.token}),403,'FIN_ACCESS_DENIED');});
  }

  // ---- 6. TECH-F02 observation: duplicate canonical line in a protected buffer ----
  {
    const before6=await counts(a.tenant);
    const dup=await call('buffers',{token:a.token,method:'POST',json:{year:2043,quarter:2,expectedBookVersion:0,lines:[line({amountMln:'6.00'}),line({amountMln:'4.00'})]}});
    console.log('OBSERVATION TECH-F02 duplicate canonical line in protected buffer: HTTP '+dup.status+' '+JSON.stringify(dup.body?.message));
    await check('TECH-F02 duplicate canonical line -> 409 safe conflict and full rollback',async()=>{
      safeError(dup,409);assert.deepEqual(await counts(a.tenant),before6);});
  }
 } finally {
  await app.close();
  Object.assign(console,original);
 }
 if(failures.length){console.log('SEC01-F01 FAILURES: '+failures.length+'\n - '+failures.join('\n - '));process.exitCode=1;}
 else console.log('SEC01-F01 all checks PASS (executor evidence; SEC-01 remains OPEN until independent re-review)');
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{
  await restrictedFinConnectionPool().end().catch(()=>{});
  await owner.end();
});
