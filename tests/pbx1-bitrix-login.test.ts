import {test} from 'node:test';import assert from 'node:assert/strict';
// PBX-1 — Bitrix login to Core. Simulated Bitrix transport only (no real portal):
// this proves the local contract, it is NOT live-portal evidence.
test('PBX-1 Bitrix launch lands in /app.html under the stored Core identity and role',async(t)=>{
 delete process.env.DATABASE_URL;process.env.DB_MODE='pglite';process.env.PGLITE_DIR='memory://';process.env.AUTH_MODE='bitrix';process.env.BITRIX_PORTAL='pbx1.bitrix24.com';delete process.env.BITRIX_MEMBER_ID;process.env.BITRIX_ADMIN_USER_ID='7';process.env.BITRIX_CLIENT_ID='local.test';process.env.BITRIX_CLIENT_SECRET='pbx1-client-secret';process.env.TOKEN_ENCRYPTION_KEY='3'.repeat(64);
 const {pool,one,insert}=await import('../apps/backend/src/db');const {migrate}=await import('../scripts/migrate');await migrate();const {createApp}=await import('../apps/backend/src/main');
 const originalFetch=globalThis.fetch;let currentUser:any={ID:'7',NAME:'Admin'};
 globalThis.fetch=async(input:any,init:any)=>{const url=String(input);if(url.startsWith('http://127.0.0.1:'))return originalFetch(input,init);if(url==='https://oauth.bitrix.info/oauth/token/')return new Response(JSON.stringify({access_token:'pbx1-access-secret',refresh_token:'pbx1-refresh-secret',expires_in:3600,member_id:'pbx1-member'}));return new Response(JSON.stringify({result:url.includes('user.current')?currentUser:true}));};
 const app=await createApp();await app.listen(0,'127.0.0.1');const base=await app.getUrl();
 const post=(path:string,fields:Record<string,string>)=>originalFetch(base+path,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields)});
 const install={REFRESH_ID:'pbx1-refresh-in',member_id:'pbx1-member',APPLICATION_TOKEN:'pbx1-app-token'};
 const launch={AUTH_ID:'pbx1-auth-in',member_id:'pbx1-member',APPLICATION_TOKEN:'pbx1-app-token'};
 const launchAs=(u:any)=>{currentUser=u;return post('/auth/bitrix/launch?DOMAIN=pbx1.bitrix24.com',launch);};
 const tokenOf=(html:string)=>/sessionStorage\.setItem\('session',"([^"]+)"\)/.exec(html)![1];
 try{
  await t.test('A. install completion and launch route to /app.html, never legacy /',async()=>{
   const i=await post('/auth/bitrix/install?DOMAIN=pbx1.bitrix24.com',install);assert.equal(i.status,201);const ih=await i.text();
   assert.match(ih,/BX24\.installFinish\(\);location\.replace\('\/app\.html'\)/);assert.doesNotMatch(ih,/location\.replace\('\/'\)/);
   const l=await launchAs({ID:'7',NAME:'Admin'});assert.equal(l.status,201);const lh=await l.text();
   assert.match(lh,/location\.replace\('\/app\.html'\);/);assert.doesNotMatch(lh,/location\.replace\('\/'\)/);
   // D. the page carries the Core token only — no Bitrix access/refresh/application secret.
   for(const secret of ['pbx1-access-secret','pbx1-refresh-secret','pbx1-app-token','pbx1-auth-in','pbx1-refresh-in','pbx1-client-secret'])assert.ok(!ih.includes(secret)&&!lh.includes(secret),secret);
   assert.equal((await one(pool,'SELECT role FROM users WHERE bitrix_user_id=$1',['7'])).role,'ADMIN');
  });
  const tenant=async()=>one(pool,'SELECT * FROM tenants WHERE portal=$1',['pbx1.bitrix24.com']);
  await t.test('B/C. mapped active user gets the stored Core role; WORK_POSITION and departments grant nothing',async()=>{
   const t0=await tenant();await insert(pool,'users',t0.id,{bitrixUserId:'21',name:'Pto User',role:'PTO'});
   const l=await launchAs({ID:'21',NAME:'Pto',WORK_POSITION:'Генеральный директор',UF_DEPARTMENT:[1],UF_HEAD:'21'});assert.equal(l.status,201);
   const html=await l.text();const me=await originalFetch(base+'/me',{headers:{Authorization:'Bearer '+tokenOf(html)}});assert.equal(me.status,200);
   const actor:any=await me.json();assert.equal(actor.role,'PTO');assert.equal(actor.bitrixUserId,'21');
   const stored=await one(pool,'SELECT * FROM users WHERE bitrix_user_id=$1',['21']);assert.equal(stored.role,'PTO');
   // A Bitrix-derived manager title must not open ADMIN-only surface.
   const dir=await originalFetch(base+'/bitrix/directory/users',{headers:{Authorization:'Bearer '+tokenOf(html)}});assert.equal(dir.status,403);await dir.text();
  });
  await t.test('B. unknown Bitrix user is denied and not provisioned',async()=>{
   const before=(await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;const s=(await pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n;
   const l=await launchAs({ID:'999',NAME:'Stranger',WORK_POSITION:'Директор'});assert.equal(l.status,401);await l.text();
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n,before);assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n,s);
  });
  await t.test('B. inactive Core user is denied and not reactivated',async()=>{
   await pool.query('UPDATE users SET is_active=false WHERE bitrix_user_id=$1',['21']);const s=(await pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n;
   const l=await launchAs({ID:'21',NAME:'Pto'});assert.equal(l.status,401);await l.text();
   assert.equal((await one(pool,'SELECT is_active FROM users WHERE bitrix_user_id=$1',['21'])).isActive,false);assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n,s);
  });
  await t.test('B. tenant/portal mismatch is denied before any Bitrix call',async()=>{
   for(const [q,f] of [['?DOMAIN=other.bitrix24.com',launch],['?DOMAIN=pbx1.bitrix24.com',{...launch,member_id:'other-member'}],['?DOMAIN=pbx1.bitrix24.com',{...launch,APPLICATION_TOKEN:'wrong'}]] as [string,any][]){const r=await post('/auth/bitrix/launch'+q,f);assert.equal(r.status,401);await r.text();}
  });
  await t.test('D. session artifact is an opaque Core token; logout ends it; expiry is fail-closed; mock sign-in unavailable',async()=>{
   const html=await (await launchAs({ID:'7',NAME:'Admin'})).text();const token=tokenOf(html);const auth={Authorization:'Bearer '+token};
   assert.equal((await originalFetch(base+'/me',{headers:auth})).status,200);
   const mock=await originalFetch(base+'/auth/mock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'x',role:'ADMIN'})});assert.equal(mock.status,401);await mock.text();
   await pool.query("UPDATE sessions SET expires_at=now()-interval '1 minute'");assert.equal((await originalFetch(base+'/me',{headers:auth})).status,401);
   const html2=await (await launchAs({ID:'7',NAME:'Admin'})).text();const auth2={Authorization:'Bearer '+tokenOf(html2)};
   assert.equal((await originalFetch(base+'/auth/logout',{method:'POST',headers:auth2})).status,201);assert.equal((await originalFetch(base+'/me',{headers:auth2})).status,401);
   // relaunch after logout works
   assert.equal((await launchAs({ID:'7',NAME:'Admin'})).status,201);
  });
 }finally{globalThis.fetch=originalFetch;await app.close();}
});
