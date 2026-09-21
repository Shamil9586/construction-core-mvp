import {test} from 'node:test';import assert from 'node:assert/strict';
test('Bitrix provider contracts and installation/refresh with simulated transport only',async(t)=>{
 delete process.env.DATABASE_URL; process.env.DB_MODE='pglite';process.env.PGLITE_DIR='memory://';process.env.AUTH_MODE='bitrix';process.env.BITRIX_PORTAL='acceptance.bitrix24.com';delete process.env.BITRIX_MEMBER_ID;process.env.BITRIX_ADMIN_USER_ID='7';process.env.BITRIX_CLIENT_ID='local.test';process.env.BITRIX_CLIENT_SECRET='test-client-secret';process.env.TOKEN_ENCRYPTION_KEY='2'.repeat(64);
 const {pool,one,rows,insert}=await import('../apps/backend/src/db');const {migrate}=await import('../scripts/migrate');await migrate();const {RealBitrixAdapter,MockBitrixAdapter,installBitrix,bitrixLogin,onAppInstallWebhook,verifyApplicationToken}=await import('../apps/backend/src/bitrix');const {decrypt,encrypt,session}=await import('../apps/backend/src/security');const {createApp}=await import('../apps/backend/src/main');const originalFetch=globalThis.fetch;const calls:any[]=[];const expiredTokens=new Set<string>();let refreshes=0;
 // Defaults keep every earlier subtest's behaviour; the HTTP subtests below flip them
 // to prove the OAuth exchange and the admin-id pin are still enforced without Origin.
 let oauthFailure:{status:number;body:any}|null=null;let currentUserId='7';
 // user.get is the read-only employee-directory source: pages are served from
 // directoryPages keyed by the start offset, and directoryCalls records the auth
 // token and offset of every REST request so the tests can prove which tenant's
 // installation token installedCall actually used.
 let directoryPages:any[][]=[];let departmentPages:any[][]=[];
 let directoryFailure:{status:number;body:any;start?:number}|null=null;let departmentFailure:{status:number;body:any;start?:number}|null=null;
 const directoryCalls:{method:string;auth:string;start:number;select:any;params:any}[]=[];
 // Exactly the field allowlist the hardened endpoint must send to Bitrix, so the portal
 // never even assembles e-mail, phones, photo or birthdate for Construction Core.
 const USER_SELECT=['ID','NAME','LAST_NAME','SECOND_NAME','ACTIVE','WORK_POSITION','UF_DEPARTMENT'];
 // Row census and secret material are shared by both directory subtests: a read-only
 // endpoint must leave every table byte-identical and must never echo any token.
 const WATCHED_TABLES=['tenants','users','sessions','bitrix_installations','audit_logs','domain_events','notifications','risk_settings','objects','works','contractors','import_reports'];
 const counts=async()=>{const s:any={};for(const table of WATCHED_TABLES)s[table]=(await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;s.userRows=await rows(pool,'SELECT id,role,is_active,version FROM users ORDER BY id');return JSON.stringify(s);};
 const installations=async()=>JSON.stringify(await rows(pool,'SELECT tenant_id,portal,member_id,encrypted_access_token,encrypted_refresh_token,encrypted_application_token,version FROM bitrix_installations ORDER BY tenant_id'));
 const secretMaterial=async()=>{const material=[process.env.TOKEN_ENCRYPTION_KEY!,process.env.BITRIX_CLIENT_SECRET!];for(const row of await rows(pool,'SELECT encrypted_access_token,encrypted_refresh_token,encrypted_application_token FROM bitrix_installations'))for(const column of [row.encryptedAccessToken,row.encryptedRefreshToken,row.encryptedApplicationToken])if(column){material.push(column);try{material.push(decrypt(column));}catch{}}return material;};
 globalThis.fetch=async(input:any,init:any)=>{const url=String(input);if(url.startsWith('http://127.0.0.1:'))return originalFetch(input,init);calls.push({url,body:init.body});if(url==='https://oauth.bitrix.info/oauth/token/'){refreshes++;if(oauthFailure)return new Response(JSON.stringify(oauthFailure.body),{status:oauthFailure.status});return new Response(JSON.stringify({access_token:'access-'+refreshes,refresh_token:'refresh-'+refreshes,expires_in:3600,member_id:'acceptance-member'}));}const b=JSON.parse(init.body);if(url.endsWith('/user.get.json')||url.endsWith('/department.get.json')){const method=url.endsWith('/user.get.json')?'user.get':'department.get';const start=Number(b.start??0);directoryCalls.push({method,auth:b.auth,start,select:b.select,params:b});if(expiredTokens.has(b.auth))return new Response(JSON.stringify({error:'expired_token'}),{status:401});const failure=method==='user.get'?directoryFailure:departmentFailure;if(failure&&(failure.start===undefined||failure.start===start))return new Response(JSON.stringify(failure.body),{status:failure.status});const pages=method==='user.get'?directoryPages:departmentPages;return new Response(JSON.stringify({result:pages[start/50]??[],next:start+50,total:pages.flat().length,time:{start:0,finish:1}}));}if(expiredTokens.has(b.auth))return new Response(JSON.stringify({error:'expired_token'}),{status:401});return new Response(JSON.stringify({result:url.includes('user.current')?{ID:currentUserId,NAME:'Test Admin'}:true}));};
 try{
 await t.test('Mock providers return explicit mock results',async()=>{const m=new MockBitrixAdapter();assert.equal((await m.currentUser('9')).ID,'9');assert.ok((await m.notify('','9','message')).mock);assert.ok((await m.createTask('','9','task')).mock);assert.ok((await m.upload('','','file')).mock);assert.equal((await m.departments()).length,1);});
 await t.test('Real adapter method names and payloads use simulated transport',async()=>{const r=new RealBitrixAdapter();await r.currentUser('test');await r.departments('test');await r.notify('test','9','text');await r.createTask('test','9','task');await r.upload('test','3','file.pdf','YWJj');assert.ok(calls.some(x=>x.url.endsWith('/im.notify.system.add.json')&&JSON.parse(x.body).USER_ID==='9'));assert.ok(calls.some(x=>x.url.endsWith('/tasks.task.add.json')&&JSON.parse(x.body).fields.RESPONSIBLE_ID===9));assert.ok(calls.some(x=>x.url.endsWith('/disk.folder.uploadfile.json')&&JSON.parse(x.body).fileContent[0]==='file.pdf'));assert.throws(()=>new RealBitrixAdapter('127.0.0.1'));});
 await t.test('Wizard install binds member_id without env pin and stores application_token encrypted',async()=>{const r=await installBitrix({DOMAIN:process.env.BITRIX_PORTAL,REFRESH_ID:'initial',member_id:'acceptance-member',APPLICATION_TOKEN:'wizard-app-token'});assert.equal(r.user.role,'ADMIN');const tenant=await one(pool,'SELECT * FROM tenants WHERE portal=$1',[process.env.BITRIX_PORTAL]);assert.equal(tenant.memberId,'acceptance-member');const stored=await one(pool,'SELECT * FROM bitrix_installations WHERE tenant_id=$1',[tenant.id]);assert.equal(decrypt(stored.encryptedAccessToken),'access-1');assert.equal(decrypt(stored.encryptedApplicationToken),'wizard-app-token');assert.notEqual(stored.encryptedAccessToken,'access-1');assert.notEqual(stored.encryptedApplicationToken,'wizard-app-token');});
 await t.test('Launch requires exact member_id and application_token before user.current',async()=>{const login=await bitrixLogin({DOMAIN:process.env.BITRIX_PORTAL,AUTH_ID:'access-1',member_id:'acceptance-member',APPLICATION_TOKEN:'wizard-app-token'});assert.ok(login.token&&!JSON.stringify(login).includes('access-1'));for(const bad of [{member_id:'acceptance-member',APPLICATION_TOKEN:'wrong-token'},{member_id:'wrong-member',APPLICATION_TOKEN:'wizard-app-token'}]){const n=calls.length;await assert.rejects(()=>bitrixLogin({DOMAIN:process.env.BITRIX_PORTAL,AUTH_ID:'untrusted-access',...bad}),/Bitrix/);assert.equal(calls.length,n);}await assert.rejects(()=>bitrixLogin({DOMAIN:'other.bitrix24.com',AUTH_ID:'access-1',member_id:'acceptance-member',APPLICATION_TOKEN:'wizard-app-token'}));});
 await t.test('Reinstall rejects token replacement, but legacy NULL can be filled after full verification',async()=>{let n=calls.length;await assert.rejects(()=>installBitrix({DOMAIN:process.env.BITRIX_PORTAL,REFRESH_ID:'bad-reinstall',member_id:'acceptance-member',APPLICATION_TOKEN:'different-app-token'}),/application token/i);assert.equal(calls.length,n);const tenant=await one(pool,'SELECT * FROM tenants WHERE portal=$1',[process.env.BITRIX_PORTAL]);await pool.query('UPDATE bitrix_installations SET encrypted_application_token=NULL WHERE tenant_id=$1',[tenant.id]);await installBitrix({DOMAIN:process.env.BITRIX_PORTAL,REFRESH_ID:'legacy-fill',member_id:'acceptance-member',APPLICATION_TOKEN:'wizard-app-token'});const stored=await one(pool,'SELECT * FROM bitrix_installations WHERE tenant_id=$1',[tenant.id]);assert.equal(decrypt(stored.encryptedApplicationToken),'wizard-app-token');assert.equal(decrypt(stored.encryptedAccessToken),'access-2');});
 await t.test('BITRIX_MEMBER_ID remains an optional operator pin',async()=>{process.env.BITRIX_MEMBER_ID='different-member';const n=calls.length;await assert.rejects(()=>installBitrix({DOMAIN:process.env.BITRIX_PORTAL,REFRESH_ID:'pinned',member_id:'acceptance-member',APPLICATION_TOKEN:'wizard-app-token'}),/member/i);assert.equal(calls.length,n);process.env.BITRIX_MEMBER_ID='acceptance-member';});
 await t.test('Expired token rotates once, persists pair, rejects mismatched portal',async()=>{expiredTokens.add('access-2');const tenant=await one(pool,'SELECT * FROM tenants WHERE portal=$1',[process.env.BITRIX_PORTAL]);const r=new RealBitrixAdapter();await r.installedCall(tenant.id,'user.current');const stored=await one(pool,'SELECT * FROM bitrix_installations WHERE tenant_id=$1',[tenant.id]);assert.equal(decrypt(stored.encryptedRefreshToken),'refresh-3');await r.installedCall(tenant.id,'user.current');assert.equal(refreshes,3);const n=calls.length;await assert.rejects(()=>new RealBitrixAdapter('other.bitrix24.com').installedCall(tenant.id,'user.current'));assert.equal(calls.length,n);});
 await t.test('Reinstall fails closed for an existing inactive internal admin user',async()=>{const tenant=await one(pool,'SELECT * FROM tenants WHERE portal=$1',[process.env.BITRIX_PORTAL]);const before=await one(pool,'SELECT * FROM bitrix_installations WHERE tenant_id=$1',[tenant.id]);const sessionsBefore=(await pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n;await pool.query('UPDATE users SET is_active=false WHERE tenant_id=$1 AND bitrix_user_id=$2',[tenant.id,'7']);const userBefore=await one(pool,'SELECT * FROM users WHERE tenant_id=$1 AND bitrix_user_id=$2',[tenant.id,'7']);try{await assert.rejects(()=>installBitrix({DOMAIN:process.env.BITRIX_PORTAL,REFRESH_ID:'inactive-admin-reinstall',member_id:'acceptance-member',APPLICATION_TOKEN:'wizard-app-token'}),/deactivated/i);const after=await one(pool,'SELECT * FROM bitrix_installations WHERE tenant_id=$1',[tenant.id]);assert.equal(after.version,before.version);assert.equal(after.encryptedAccessToken,before.encryptedAccessToken);assert.equal(after.encryptedRefreshToken,before.encryptedRefreshToken);assert.equal(after.encryptedApplicationToken,before.encryptedApplicationToken);assert.equal(after.expiresAt.getTime?.()??after.expiresAt,before.expiresAt.getTime?.()??before.expiresAt);assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n,sessionsBefore);const userAfter=await one(pool,'SELECT * FROM users WHERE tenant_id=$1 AND bitrix_user_id=$2',[tenant.id,'7']);assert.equal(userAfter.isActive,false);assert.equal(userAfter.id,userBefore.id);assert.equal(userAfter.role,userBefore.role);assert.equal(userAfter.version,userBefore.version);}finally{await pool.query('UPDATE users SET is_active=true WHERE tenant_id=$1 AND bitrix_user_id=$2',[tenant.id,'7']);}});
 const webhookPayload={auth:{domain:'webhook.bitrix24.com',member_id:'webhook-member-id',access_token:'wh-access-token',refresh_token:'wh-refresh-token',application_token:'wh-application-token',expires_in:3600}};
 await t.test('ONAPPINSTALL webhook fail-closed by default: no env flag, nothing written',async()=>{delete process.env.BITRIX_INSTALL_WEBHOOK_ENABLED;const res=await onAppInstallWebhook(webhookPayload);assert.equal(res.result,false);const tenant=await one(pool,'SELECT * FROM tenants WHERE member_id=$1',['webhook-member-id']);assert.equal(tenant,undefined);});
 await t.test('ONAPPINSTALL webhook enabled: valid payload stores encrypted application_token',async()=>{process.env.BITRIX_INSTALL_WEBHOOK_ENABLED='true';const res=await onAppInstallWebhook(webhookPayload);assert.equal(res.result,true);const tenant=await one(pool,'SELECT * FROM tenants WHERE member_id=$1',['webhook-member-id']);assert.equal(tenant.portal,'webhook.bitrix24.com');const stored=await one(pool,'SELECT * FROM bitrix_installations WHERE tenant_id=$1',[tenant.id]);assert.equal(decrypt(stored.encryptedApplicationToken),'wh-application-token');assert.notEqual(stored.encryptedApplicationToken,'wh-application-token');});
 await t.test('ONAPPINSTALL webhook rejects malformed/missing fields even when enabled',async()=>{process.env.BITRIX_INSTALL_WEBHOOK_ENABLED='true';assert.equal((await onAppInstallWebhook({auth:{...webhookPayload.auth,application_token:undefined}})).result,false);assert.equal((await onAppInstallWebhook({auth:{...webhookPayload.auth,domain:'not a hostname'}})).result,false);assert.equal((await onAppInstallWebhook({auth:{...webhookPayload.auth,access_token:'short'}})).result,false);assert.equal((await onAppInstallWebhook({auth:{...webhookPayload.auth,expires_in:-1}})).result,false);});
 await t.test('verifyApplicationToken accepts only the exact stored token for that member_id',async()=>{assert.equal(await verifyApplicationToken('webhook-member-id','wh-application-token'),true);assert.equal(await verifyApplicationToken('webhook-member-id','wrong-token'),false);assert.equal(await verifyApplicationToken('unknown-member-id','wh-application-token'),false);assert.equal(await verifyApplicationToken(undefined,'wh-application-token'),false);});
 // Bitrix24 drives these two endpoints itself: DOMAIN arrives in the query string,
 // AUTH_ID/REFRESH_ID/APPLICATION_TOKEN/member_id in the form body, and the documented
 // request-source proof is APPLICATION_TOKEN, not the HTTP Origin header. A real portal
 // install was rejected 400 "Invalid portal origin" before any OAuth or DB work, so these
 // subtests send no Origin at all and assert the deep verification still holds.
 await t.test('HTTP wizard handlers take DOMAIN from query string and auth fields from form body, with no Origin header',async()=>{process.env.BITRIX_INSTALL_WEBHOOK_ENABLED='false';const app=await createApp();await app.listen(0,'127.0.0.1');const base=await app.getUrl();
  const post=(path:string,fields:Record<string,string>,headers:Record<string,string>={})=>originalFetch(base+path,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams(fields)});
  const installFields={REFRESH_ID:'http-reinstall',member_id:'acceptance-member',APPLICATION_TOKEN:'wizard-app-token'};const launchFields={AUTH_ID:'http-access',member_id:'acceptance-member',APPLICATION_TOKEN:'wizard-app-token'};
  try{
   const install=await post('/auth/bitrix/install?DOMAIN=acceptance.bitrix24.com',installFields);assert.equal(install.status,201);assert.match(await install.text(),/BX24\.installFinish/);
   const launch=await post('/auth/bitrix/launch?DOMAIN=acceptance.bitrix24.com',launchFields);assert.equal(launch.status,201);assert.match(await launch.text(),/sessionStorage\.setItem/);
   // Origin is non-authoritative, not merely optional: a foreign one changes nothing.
   const foreign=await post('/auth/bitrix/launch?DOMAIN=acceptance.bitrix24.com',launchFields,{Origin:'https://attacker.example'});assert.equal(foreign.status,201);await foreign.text();
   for(const [path,fields] of [['/auth/bitrix/install',installFields],['/auth/bitrix/launch',launchFields]] as [string,Record<string,string>][]){
    const wrongDomain=await post(path+'?DOMAIN=other.bitrix24.com',fields);assert.equal(wrongDomain.status,401);await wrongDomain.text();
    const wrongMember=await post(path+'?DOMAIN=acceptance.bitrix24.com',{...fields,member_id:'wrong-member'});assert.equal(wrongMember.status,401);await wrongMember.text();
    // Wrong APPLICATION_TOKEN is rejected from stored state, before any Bitrix call.
    const n=calls.length;const wrongToken=await post(path+'?DOMAIN=acceptance.bitrix24.com',{...fields,APPLICATION_TOKEN:'attacker-token'});assert.equal(wrongToken.status,401);await wrongToken.text();assert.equal(calls.length,n);
   }
   oauthFailure={status:400,body:{error:'invalid_grant'}};const badRefresh=await post('/auth/bitrix/install?DOMAIN=acceptance.bitrix24.com',installFields);assert.equal(badRefresh.status,401);await badRefresh.text();oauthFailure=null;
   currentUserId='99';const notAdmin=await post('/auth/bitrix/install?DOMAIN=acceptance.bitrix24.com',installFields);assert.equal(notAdmin.status,401);await notAdmin.text();currentUserId='7';
   const stored=await one(pool,'SELECT * FROM bitrix_installations WHERE tenant_id=$1',[(await one(pool,'SELECT * FROM tenants WHERE portal=$1',[process.env.BITRIX_PORTAL])).id]);assert.equal(decrypt(stored.encryptedApplicationToken),'wizard-app-token');
  }finally{oauthFailure=null;currentUserId='7';await app.close();}});
 // Read-only Bitrix employee directory (GET /bitrix/directory/users). The portal token
 // never leaves RealBitrixAdapter: the endpoint only ever hands installedCall the tenantId
 // of the authenticated Actor, so a second installed tenant is provisioned here purely to
 // prove its token is unreachable from another tenant's session.
 await t.test('Employee directory is read-only, ADMIN-only, tenant-bound, paginated, sanitized and fail-closed',async()=>{
  process.env.BITRIX_INSTALL_WEBHOOK_ENABLED='false';const app=await createApp();await app.listen(0,'127.0.0.1');const base=await app.getUrl();
  const logged:string[]=[];const realLog=console.log,realError=console.error;const capture=(...a:any[])=>{logged.push(a.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' '));};
  const get=(headers:Record<string,string>={},query='')=>originalFetch(base+'/bitrix/directory/users'+query,{headers});
  // Every raw record carries fields the endpoint must drop: e-mail, phones, city, custom UF_*.
  const raw=(i:number)=>({ID:String(i),NAME:'Имя'+i,LAST_NAME:'Фамилия'+i,SECOND_NAME:i%2?'Отчество'+i:'',ACTIVE:true,WORK_POSITION:'Прораб',UF_DEPARTMENT:[1,2],EMAIL:'leak'+i+'@example.com',PERSONAL_MOBILE:'+70000000000',WORK_PHONE:'495-000',PERSONAL_CITY:'Москва',UF_EMPLOYMENT_DATE:'2020-01-01',XML_ID:'leak-xml'});
  const page=(from:number,size:number)=>Array.from({length:size},(_,i)=>raw(from+i));
  const tenant=await one(pool,'SELECT * FROM tenants WHERE portal=$1',[process.env.BITRIX_PORTAL]);
  const neighbour=await one(pool,'INSERT INTO tenants(portal,member_id,name) VALUES($1,$2,$3) RETURNING *',['neighbour.bitrix24.com','neighbour-member-id','Соседний портал']);
  await insert(pool,'bitrix_installations',neighbour.id,{portal:'neighbour.bitrix24.com',memberId:'neighbour-member-id',encryptedAccessToken:encrypt('neighbour-access-token'),encryptedRefreshToken:encrypt('neighbour-refresh-token'),encryptedApplicationToken:encrypt('neighbour-app-token'),expiresAt:new Date(Date.now()+3600000)});
  const admin=await bitrixLogin({DOMAIN:process.env.BITRIX_PORTAL,AUTH_ID:'directory-launch',member_id:'acceptance-member',APPLICATION_TOKEN:'wizard-app-token'});assert.equal(admin.user.role,'ADMIN');
  const engineer=await insert(pool,'users',tenant.id,{bitrixUserId:'4242',name:'Инженер ПТО',role:'PTO'});const engineerSession=await session(engineer);
  const adminHeaders={Authorization:'Bearer '+admin.token};
  const countsBefore=await counts();const installationsBefore=await installations();
  console.log=capture;console.error=capture;
  try{
   // A Construction Core session is mandatory; no Bitrix call is attempted without one.
   let before=directoryCalls.length;
   for(const headers of [{},{Authorization:'Bearer not-a-real-session'}]){const denied=await get(headers);assert.equal(denied.status,401);await denied.text();}
   // ADMIN-only gate for this first integration step.
   const engineerCall=await get({Authorization:'Bearer '+engineerSession.token});assert.equal(engineerCall.status,403);await engineerCall.text();
   // AUTH_MODE=bitrix is required even for a valid ADMIN session.
   process.env.AUTH_MODE='mock';const disabled=await get(adminHeaders);assert.equal(disabled.status,401);await disabled.text();process.env.AUTH_MODE='bitrix';
   // Tenant, portal and token can only come from the session: the request has no legal parameter.
   for(const query of ['?tenantId='+neighbour.id,'?portal=neighbour.bitrix24.com','?member_id=neighbour-member-id','?access_token=neighbour-access-token','?auth=neighbour-access-token','?start=1000']){const injected=await get(adminHeaders,query);assert.equal(injected.status,400);await injected.text();}
   const posted=await originalFetch(base+'/bitrix/directory/users',{method:'POST',headers:{...adminHeaders,'Content-Type':'application/json'},body:JSON.stringify({tenantId:neighbour.id,auth:'neighbour-access-token'})});assert.equal(posted.status,404);await posted.text();
   assert.equal(directoryCalls.length,before);
   // Full pagination: 50 + 50 + 3, requested with the installation token of the actor's tenant only.
   directoryPages=[page(0,50),page(50,50),page(100,3)];before=directoryCalls.length;
   const ok=await get(adminHeaders);assert.equal(ok.status,200);const text=await ok.text();const body=JSON.parse(text);
   assert.equal(body.count,103);assert.equal(body.users.length,103);assert.equal(body.truncated,false);
   assert.deepEqual(directoryCalls.slice(before).map(c=>c.start),[0,50,100]);
   // Request-side allowlist: exactly the seven fields, and no other parameter at all.
   for(const call of directoryCalls.slice(before)){assert.equal(call.method,'user.get');assert.deepEqual(call.select,USER_SELECT);assert.deepEqual(Object.keys(call.params).sort(),['auth','select','start']);}
   const installed=await one(pool,'SELECT * FROM bitrix_installations WHERE tenant_id=$1',[tenant.id]);
   assert.ok(directoryCalls.slice(before).every(c=>c.auth===decrypt(installed.encryptedAccessToken)));
   assert.ok(directoryCalls.every(c=>c.auth!=='neighbour-access-token'));
   assert.deepEqual(body.users[0],{ID:'0',NAME:'Имя0',LAST_NAME:'Фамилия0',ACTIVE:true,WORK_POSITION:'Прораб',UF_DEPARTMENT:[1,2]});
   assert.deepEqual(body.users[1],{ID:'1',NAME:'Имя1',LAST_NAME:'Фамилия1',ACTIVE:true,WORK_POSITION:'Прораб',UF_DEPARTMENT:[1,2],SECOND_NAME:'Отчество1'});
   for(const leaked of ['leak0@example.com','+70000000000','495-000','PERSONAL_CITY','UF_EMPLOYMENT_DATE','XML_ID','EMAIL','WORK_PHONE','"next"','"total"'])assert.ok(!text.includes(leaked),leaked);
   const secrets=[...(await secretMaterial()),admin.token,engineerSession.token];
   for(const secret of secrets)assert.ok(!text.includes(secret),secret);
   // The request guard bounds a portal that never stops returning full pages.
   directoryPages=Array.from({length:41},(_,p)=>page(p*50,50));before=directoryCalls.length;
   const capped=await get(adminHeaders);assert.equal(capped.status,200);const cappedBody=await capped.json();
   assert.equal(directoryCalls.length-before,40);assert.equal(cappedBody.truncated,true);assert.equal(cappedBody.count,2000);
   // A Bitrix failure mid-pagination fails closed: no partial page reaches the caller.
   directoryPages=[page(0,50),page(50,50)];directoryFailure={status:400,body:{error:'QUERY_LIMIT_EXCEEDED'},start:50};
   const failed=await get(adminHeaders);assert.equal(failed.status,400);const failedText=await failed.text();assert.ok(!failedText.includes('Имя0'));
   for(const secret of secrets)assert.ok(!failedText.includes(secret),secret);
   directoryFailure={status:200,body:{result:{ID:'1'}}};const unexpected=await get(adminHeaders);assert.equal(unexpected.status,400);await unexpected.text();directoryFailure=null;
   // Nothing at all was written while reading.
   assert.equal(await counts(),countsBefore);assert.equal(await installations(),installationsBefore);
   // expired_token stays installedCall's business: the endpoint neither sees nor rotates tokens.
   directoryPages=[page(0,2)];expiredTokens.add(decrypt(installed.encryptedAccessToken));const refreshesBefore=refreshes;
   const rotated=await get(adminHeaders);assert.equal(rotated.status,200);assert.equal((await rotated.json()).count,2);
   assert.equal(refreshes,refreshesBefore+1);
   const rotatedRow=await one(pool,'SELECT * FROM bitrix_installations WHERE tenant_id=$1',[tenant.id]);
   assert.notEqual(rotatedRow.encryptedAccessToken,installed.encryptedAccessToken);
   assert.equal(rotatedRow.encryptedApplicationToken,installed.encryptedApplicationToken);
   assert.equal(rotatedRow.version,installed.version+1);
   // That refresh is the only state change: no row was inserted, updated or deleted anywhere else.
   assert.equal(await counts(),countsBefore);
   // Every user.get request without exception - the paginated run, the capped run, both
   // failure runs, the expired attempt and its post-refresh retry - carries that same
   // select and never asks for a profile field.
   const userGetCalls=directoryCalls.filter(c=>c.method==='user.get');assert.ok(userGetCalls.length>=45);
   for(const call of userGetCalls){assert.deepEqual(call.select,USER_SELECT);for(const forbidden of ['EMAIL','PERSONAL_MOBILE','WORK_PHONE','PERSONAL_PHOTO','PERSONAL_BIRTHDAY','PERSONAL_CITY','PERSONAL_WWW','XML_ID','*','UF_*'])assert.ok(!call.select.includes(forbidden),forbidden);}
   const log=logged.join('\n');for(const secret of secrets)assert.ok(!log.includes(secret),secret);
   assert.ok(logged.some(l=>l.includes('/bitrix/directory/users')));
  }finally{console.log=realLog;console.error=realError;directoryPages=[];directoryFailure=null;await app.close();}});
 // Read-only Bitrix department directory (GET /bitrix/directory/departments). The live
 // application still holds only the user_brief scope, so department.get is exercised here
 // against the simulated transport exclusively; a real portal would answer the very same
 // call with a scope error, which the endpoint must surface rather than swallow.
 await t.test('Department directory is read-only, ADMIN-only, tenant-bound, paginated, sanitized and fail-closed',async()=>{
  process.env.BITRIX_INSTALL_WEBHOOK_ENABLED='false';const app=await createApp();await app.listen(0,'127.0.0.1');const base=await app.getUrl();
  const logged:string[]=[];const realLog=console.log,realError=console.error;const capture=(...a:any[])=>{logged.push(a.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' '));};
  const get=(headers:Record<string,string>={},query='')=>originalFetch(base+'/bitrix/directory/departments'+query,{headers});
  // Every raw department carries fields the endpoint must drop, and deliberately ragged
  // types for SORT/PARENT/UF_HEAD so the normalization rules are exercised, not assumed.
  const rawDepartment=(i:number)=>({ID:String(i),NAME:'Отдел '+i,SORT:100+i,PARENT:i===0?undefined:'0',UF_HEAD:i%2?String(1000+i):0,CODE:'leak-code',XML_ID:'leak-xml',EMAIL:'dept'+i+'@example.com',PHONE:'+70000000000',IBLOCK_SECTION_ID:'leak-section',DESCRIPTION:'leak-description',UF_SECRET:'leak-uf'});
  const ragged={ID:777,NAME:'   ',SORT:'не число',PARENT:'',UF_HEAD:null,DEPTH_LEVEL:3,ACTIVE:'Y'};
  const departmentPage=(from:number,size:number)=>Array.from({length:size},(_,i)=>rawDepartment(from+i));
  const tenant=await one(pool,'SELECT * FROM tenants WHERE portal=$1',[process.env.BITRIX_PORTAL]);
  const neighbour=await one(pool,'SELECT * FROM tenants WHERE member_id=$1',['neighbour-member-id']);
  const admin=await bitrixLogin({DOMAIN:process.env.BITRIX_PORTAL,AUTH_ID:'departments-launch',member_id:'acceptance-member',APPLICATION_TOKEN:'wizard-app-token'});assert.equal(admin.user.role,'ADMIN');
  const engineer=await one(pool,'SELECT * FROM users WHERE tenant_id=$1 AND bitrix_user_id=$2',[tenant.id,'4242']);assert.equal(engineer.role,'PTO');
  const engineerSession=await session(engineer);const adminHeaders={Authorization:'Bearer '+admin.token};
  const countsBefore=await counts();const installationsBefore=await installations();
  console.log=capture;console.error=capture;
  try{
   const secrets=[...(await secretMaterial()),admin.token,engineerSession.token];
   // Identical gate to the employee directory: session, role, mode, and no request parameters.
   const firstCall=directoryCalls.length;let before=directoryCalls.length;
   for(const headers of [{},{Authorization:'Bearer not-a-real-session'}]){const denied=await get(headers);assert.equal(denied.status,401);await denied.text();}
   const engineerCall=await get({Authorization:'Bearer '+engineerSession.token});assert.equal(engineerCall.status,403);await engineerCall.text();
   process.env.AUTH_MODE='mock';const disabled=await get(adminHeaders);assert.equal(disabled.status,401);await disabled.text();process.env.AUTH_MODE='bitrix';
   for(const query of ['?tenantId='+neighbour.id,'?portal=neighbour.bitrix24.com','?member_id=neighbour-member-id','?access_token=neighbour-access-token','?auth=neighbour-access-token','?start=1000']){const injected=await get(adminHeaders,query);assert.equal(injected.status,400);await injected.text();}
   const posted=await originalFetch(base+'/bitrix/directory/departments',{method:'POST',headers:{...adminHeaders,'Content-Type':'application/json'},body:JSON.stringify({tenantId:neighbour.id,auth:'neighbour-access-token'})});assert.equal(posted.status,404);await posted.text();
   assert.equal(directoryCalls.length,before);
   // Full pagination 50 + 50 + 3, requested as department.get with this tenant's token only.
   departmentPages=[departmentPage(0,50),departmentPage(50,50),[rawDepartment(100),rawDepartment(101),ragged]];before=directoryCalls.length;
   const ok=await get(adminHeaders);assert.equal(ok.status,200);const text=await ok.text();const body=JSON.parse(text);
   const paged=directoryCalls.slice(before);
   assert.deepEqual(paged.map(c=>c.method),['department.get','department.get','department.get']);
   assert.deepEqual(paged.map(c=>c.start),[0,50,100]);
   const installed=await one(pool,'SELECT * FROM bitrix_installations WHERE tenant_id=$1',[tenant.id]);
   assert.ok(paged.every(c=>c.auth===decrypt(installed.encryptedAccessToken)));
   assert.ok(directoryCalls.every(c=>c.auth!=='neighbour-access-token'));
   // department.get takes no select parameter: start is the only thing the endpoint sends.
   for(const call of paged){assert.deepEqual(Object.keys(call.params).sort(),['auth','start']);assert.equal(call.select,undefined);}
   assert.equal(body.count,103);assert.equal(body.departments.length,103);assert.equal(body.truncated,false);
   assert.deepEqual(Object.keys(body).sort(),['count','departments','truncated']);
   assert.deepEqual(body.departments[0],{ID:'0',NAME:'Отдел 0',SORT:100,PARENT:null,UF_HEAD:'0'});
   assert.deepEqual(body.departments[1],{ID:'1',NAME:'Отдел 1',SORT:101,PARENT:'0',UF_HEAD:'1001'});
   assert.deepEqual(body.departments[102],{ID:'777',NAME:null,SORT:null,PARENT:null,UF_HEAD:null});
   for(const record of body.departments)assert.deepEqual(Object.keys(record).sort(),['ID','NAME','PARENT','SORT','UF_HEAD']);
   for(const leaked of ['leak-code','leak-xml','leak-section','leak-description','leak-uf','dept0@example.com','+70000000000','DEPTH_LEVEL','ACTIVE','CODE','XML_ID','EMAIL','"next"','"total"','"time"'])assert.ok(!text.includes(leaked),leaked);
   for(const secret of secrets)assert.ok(!text.includes(secret),secret);
   // A portal that replays the same page adds no new ID and must stop the loop.
   departmentPages=[departmentPage(0,50),departmentPage(0,50),departmentPage(100,50)];before=directoryCalls.length;
   const replayed=await get(adminHeaders);assert.equal(replayed.status,200);const replayedBody=await replayed.json();
   assert.equal(directoryCalls.length-before,2);assert.equal(replayedBody.count,50);assert.equal(replayedBody.truncated,false);
   // The request ceiling bounds a portal that never stops returning full pages.
   departmentPages=Array.from({length:41},(_,page)=>departmentPage(page*50,50));before=directoryCalls.length;
   const capped=await get(adminHeaders);assert.equal(capped.status,200);const cappedBody=await capped.json();
   assert.equal(directoryCalls.length-before,40);assert.equal(cappedBody.truncated,true);assert.equal(cappedBody.count,2000);
   // Missing department scope is exactly what the live application would answer today:
   // it must reach the caller as a failure, never as success or an empty list.
   departmentPages=[departmentPage(0,50)];departmentFailure={status:401,body:{error:'insufficient_scope',error_description:'The request requires higher privileges than provided by the access token'}};
   const scopeless=await get(adminHeaders);assert.equal(scopeless.status,400);const scopelessText=await scopeless.text();
   assert.ok(!scopelessText.includes('departments'));assert.ok(!scopelessText.includes('Отдел 0'));
   // Mid-pagination failure returns no partial page either.
   departmentPages=[departmentPage(0,50),departmentPage(50,50)];departmentFailure={status:400,body:{error:'QUERY_LIMIT_EXCEEDED'},start:50};
   const failed=await get(adminHeaders);assert.equal(failed.status,400);const failedText=await failed.text();assert.ok(!failedText.includes('Отдел 0'));
   for(const secret of secrets)assert.ok(!failedText.includes(secret),secret);
   departmentFailure={status:200,body:{result:{ID:'1',NAME:'Не массив'}}};const unexpected=await get(adminHeaders);assert.equal(unexpected.status,400);await unexpected.text();departmentFailure=null;
   // Nothing at all was written by any of those reads, successful or failed.
   assert.equal(await counts(),countsBefore);assert.equal(await installations(),installationsBefore);
   // expired_token stays installedCall's business here too: no refresh logic in the controller.
   departmentPages=[[rawDepartment(0),rawDepartment(1)]];expiredTokens.add(decrypt(installed.encryptedAccessToken));const refreshesBefore=refreshes;
   const rotated=await get(adminHeaders);assert.equal(rotated.status,200);assert.equal((await rotated.json()).count,2);
   assert.equal(refreshes,refreshesBefore+1);
   const rotatedRow=await one(pool,'SELECT * FROM bitrix_installations WHERE tenant_id=$1',[tenant.id]);
   assert.notEqual(rotatedRow.encryptedAccessToken,installed.encryptedAccessToken);
   assert.equal(rotatedRow.encryptedApplicationToken,installed.encryptedApplicationToken);
   assert.equal(rotatedRow.version,installed.version+1);
   // That refresh is the only state change: no row was inserted, updated or deleted anywhere.
   assert.equal(await counts(),countsBefore);
   // Every department.get this endpoint issued asked for nothing but a page offset.
   const departmentGetCalls=directoryCalls.slice(firstCall).filter(c=>c.method==='department.get');assert.ok(departmentGetCalls.length>=48);
   assert.deepEqual(departmentGetCalls.filter(c=>c.select!==undefined||Object.keys(c.params).sort().join()!=='auth,start'),[]);
   const log=logged.join('\n');for(const secret of [...secrets,...(await secretMaterial())])assert.ok(!log.includes(secret),secret);
   assert.ok(logged.some(l=>l.includes('/bitrix/directory/departments')));
  }finally{console.log=realLog;console.error=realError;departmentPages=[];departmentFailure=null;await app.close();}});
 }finally{globalThis.fetch=originalFetch;delete process.env.BITRIX_MEMBER_ID;await pool.end();}
});
