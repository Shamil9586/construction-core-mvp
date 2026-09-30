import {test} from 'node:test';import assert from 'node:assert/strict';
// PBX-2 — Core user & access administration. Simulated Bitrix transport only
// (no real portal). The last-ADMIN concurrency proof is in
// pbx2-last-admin-postgres-concurrency.test.ts (native PostgreSQL).
test('PBX-2 /admin/users: list, add, role change, deactivate/reactivate, invariants',async(t)=>{
 delete process.env.DATABASE_URL;process.env.DB_MODE='pglite';process.env.PGLITE_DIR='memory://';process.env.AUTH_MODE='bitrix';process.env.BITRIX_PORTAL='pbx2.bitrix24.com';delete process.env.BITRIX_MEMBER_ID;process.env.BITRIX_ADMIN_USER_ID='7';process.env.BITRIX_CLIENT_ID='local.test';process.env.BITRIX_CLIENT_SECRET='pbx2-client-secret';process.env.TOKEN_ENCRYPTION_KEY='4'.repeat(64);
 const {pool,one,insert}=await import('../apps/backend/src/db');const {migrate}=await import('../scripts/migrate');await migrate();const {createApp}=await import('../apps/backend/src/main');const {session}=await import('../apps/backend/src/security');
 const originalFetch=globalThis.fetch;
 // Bitrix portal directory: employee ID -> record. WORK_POSITION/department are deliberately "director-like".
 const portal:Record<string,any>={'7':{ID:'7',NAME:'Admin'},'31':{ID:'31',NAME:'Ирина',LAST_NAME:'Петрова',SECOND_NAME:'Ивановна',ACTIVE:true,WORK_POSITION:'Генеральный директор',UF_DEPARTMENT:[1]},'32':{ID:'32',NAME:'Олег',LAST_NAME:'Сидоров',ACTIVE:false,WORK_POSITION:'Технический директор',UF_DEPARTMENT:[2]}};
 const bitrixCalls:string[]=[];
 globalThis.fetch=async(input:any,init:any)=>{const url=String(input);if(url.startsWith('http://127.0.0.1:'))return originalFetch(input,init);if(url==='https://oauth.bitrix.info/oauth/token/')return new Response(JSON.stringify({access_token:'pbx2-access-secret',refresh_token:'pbx2-refresh-secret',expires_in:3600,member_id:'pbx2-member'}));
  if(url.includes('/rest/user.get')){bitrixCalls.push('user.get');const id=JSON.parse(init.body).filter?.ID;return new Response(JSON.stringify({result:id&&portal[id]?[portal[id]]:[]}));}
  return new Response(JSON.stringify({result:url.includes('user.current')?portal['7']:true}));};
 const app=await createApp();await app.listen(0,'127.0.0.1');const base=await app.getUrl();
 const post=(path:string,fields:Record<string,string>)=>originalFetch(base+path,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields)});
 const api=async(method:string,path:string,token:string|null,body?:any)=>{const r=await originalFetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let data:any;try{data=JSON.parse(text)}catch{data=text}return {status:r.status,data};};
 const audits=async(entityId:string)=>(await pool.query("SELECT action,old_value,new_value FROM audit_logs WHERE entity_id=$1 ORDER BY created_at,id",[entityId])).rows;
 try{
  const i=await post('/auth/bitrix/install?DOMAIN=pbx2.bitrix24.com',{REFRESH_ID:'r',member_id:'pbx2-member',APPLICATION_TOKEN:'app-token'});assert.equal(i.status,201);await i.text();
  const tenantA=await one(pool,'SELECT * FROM tenants WHERE portal=$1',['pbx2.bitrix24.com']);
  const admin=await one(pool,'SELECT * FROM users WHERE tenant_id=$1 AND bitrix_user_id=$2',[tenantA.id,'7']);assert.equal(admin.role,'ADMIN');
  const tokenFor=async(u:any)=>(await session(u)).token;
  const adminToken=await tokenFor(admin);
  const mk=async(bid:string,name:string,role:string,active=true)=>{const u=await insert(pool,'users',tenantA.id,{bitrixUserId:bid,name,role,isActive:active});return u;};
  const pto=await mk('41','Пто Пользователь','PTO');
  const oldInactive=await mk('42','Отключённый','SDO',false);
  const legacyTd=await mk('43','Легаси ТД','TECHNICAL_DIRECTOR');
  const ptoToken=await tokenFor(pto);

  await t.test('A. ADMIN reads all Core users incl. inactive, only whitelisted fields; GET /users stays active-only',async()=>{
   const r=await api('GET','/admin/users',adminToken);assert.equal(r.status,200);
   const byB=Object.fromEntries(r.data.users.map((u:any)=>[u.bitrixUserId,u]));
   assert.equal(byB['42'].isActive,false);assert.equal(byB['43'].role,'TECHNICAL_DIRECTOR');assert.equal(byB['7'].role,'ADMIN');
   const allowed=['id','name','role','bitrixUserId','isActive','createdAt','updatedAt','version'];
   for(const u of r.data.users)assert.deepEqual(Object.keys(u).sort(),[...allowed].sort());
   assert.ok(!JSON.stringify(r.data).match(/token|hash|secret|contractor/i));
   const legacy=await api('GET','/users',adminToken);assert.ok(Array.isArray(legacy.data));assert.ok(!legacy.data.some((u:any)=>u.bitrixUserId==='42'));
  });
  await t.test('B. non-ADMIN and anonymous cannot use administration routes',async()=>{
   assert.equal((await api('GET','/admin/users',null)).status,401);
   assert.equal((await api('GET','/admin/users',ptoToken)).status,403);
   assert.equal((await api('POST','/admin/users',ptoToken,{bitrixUserId:'31',role:'PTO'})).status,403);
   assert.equal((await api('PATCH','/admin/users/'+pto.id,ptoToken,{role:'ADMIN'})).status,403);
   assert.equal((await one(pool,'SELECT role FROM users WHERE id=$1',[pto.id])).role,'PTO');
  });
  await t.test('C. existing Bitrix employee is added with the explicitly selected role; name comes from Bitrix',async()=>{
   const r=await api('POST','/admin/users',adminToken,{bitrixUserId:'31',role:'DEPUTY_DIRECTOR'});assert.equal(r.status,201);
   assert.equal(r.data.role,'DEPUTY_DIRECTOR');assert.equal(r.data.name,'Петрова Ирина Ивановна');assert.equal(r.data.isActive,true);
   const row=await one(pool,'SELECT * FROM users WHERE id=$1',[r.data.id]);assert.equal(row.tenantId,tenantA.id);assert.equal(row.bitrixUserId,'31');
   const a=await audits(r.data.id);assert.equal(a[0].action,'CREATE');assert.equal(a[0].new_value.role,'DEPUTY_DIRECTOR');
   // a client-supplied name / tenant is refused in bitrix mode
   assert.equal((await api('POST','/admin/users',adminToken,{bitrixUserId:'32',role:'PTO',name:'Подмена'})).status,400);
   assert.equal((await api('POST','/admin/users',adminToken,{bitrixUserId:'32',role:'PTO',tenantId:tenantA.id})).status,400);
   // missing role is not inferred
   assert.equal((await api('POST','/admin/users',adminToken,{bitrixUserId:'32'})).status,400);
  });
  await t.test('D. unknown Bitrix ID cannot be added in bitrix mode',async()=>{
   const before=(await pool.query('SELECT count(*)::int n FROM users')).rows[0].n;
   const r=await api('POST','/admin/users',adminToken,{bitrixUserId:'99999',role:'PTO'});assert.equal(r.status,400);
   assert.equal((await pool.query('SELECT count(*)::int n FROM users')).rows[0].n,before);
  });
  await t.test('E. duplicate bitrixUserId (active or inactive) creates no second row',async()=>{
   const before=(await pool.query('SELECT count(*)::int n FROM users')).rows[0].n;
   assert.equal((await api('POST','/admin/users',adminToken,{bitrixUserId:'31',role:'PTO'})).status,409);
   const inactive=await api('POST','/admin/users',adminToken,{bitrixUserId:'42',role:'PTO'});assert.equal(inactive.status,409);assert.match(inactive.data.message,/Включите доступ/);
   assert.equal((await pool.query('SELECT count(*)::int n FROM users')).rows[0].n,before);
  });
  await t.test('F. TECHNICAL_DIRECTOR cannot be newly assigned (create or change)',async()=>{
   assert.equal((await api('POST','/admin/users',adminToken,{bitrixUserId:'32',role:'TECHNICAL_DIRECTOR'})).status,400);
   assert.equal((await api('PATCH','/admin/users/'+pto.id,adminToken,{role:'TECHNICAL_DIRECTOR'})).status,400);
   assert.equal((await one(pool,'SELECT role FROM users WHERE id=$1',[pto.id])).role,'PTO');
   // an existing legacy user stays readable and can be moved OFF the legacy role
   assert.equal((await api('PATCH','/admin/users/'+legacyTd.id,adminToken,{role:'DEPUTY_DIRECTOR'})).status,200);
   await pool.query("UPDATE users SET role='TECHNICAL_DIRECTOR' WHERE id=$1",[legacyTd.id]);
  });
  await t.test('G. CONTRACTOR_VIEWER is not accepted by the internal contract',async()=>{
   assert.equal((await api('POST','/admin/users',adminToken,{bitrixUserId:'32',role:'CONTRACTOR_VIEWER'})).status,400);
   assert.equal((await api('PATCH','/admin/users/'+pto.id,adminToken,{role:'CONTRACTOR_VIEWER'})).status,400);
   const cv=await mk('44','Подрядчик','CONTRACTOR_VIEWER');
   assert.equal((await api('PATCH','/admin/users/'+cv.id,adminToken,{role:'PTO'})).status,400);
   assert.equal((await api('PATCH','/admin/users/'+cv.id,adminToken,{isActive:false})).status,400);
  });
  await t.test('department-head roles: PTO_HEAD / CONSTRUCTION_CONTROL_HEAD / SDO_HEAD are assignable; DEPARTMENT_HEAD is legacy-only',async()=>{
   for(const [id,role] of [['33','PTO_HEAD'],['34','CONSTRUCTION_CONTROL_HEAD'],['35','SDO_HEAD']]){
    portal[id]={ID:id,NAME:'Имя'+id,LAST_NAME:'Фам'+id,ACTIVE:true,WORK_POSITION:'Рабочий',UF_DEPARTMENT:[1]};
    const r=await api('POST','/admin/users',adminToken,{bitrixUserId:id,role});assert.equal(r.status,201,role);assert.equal(r.data.role,role);
    assert.equal((await audits(r.data.id))[0].new_value.role,role);
   }
   assert.equal((await api('POST','/admin/users',adminToken,{bitrixUserId:'31',role:'DEPARTMENT_HEAD'})).status,400);
   const u=await mk('36','Ктото','PTO');
   for(const role of ['PTO_HEAD','CONSTRUCTION_CONTROL_HEAD','SDO_HEAD']){const r=await api('PATCH','/admin/users/'+u.id,adminToken,{role});assert.equal(r.status,200,role);assert.equal(r.data.role,role);}
   assert.equal((await api('PATCH','/admin/users/'+u.id,adminToken,{role:'DEPARTMENT_HEAD'})).status,400);
   assert.equal((await one(pool,'SELECT role FROM users WHERE id=$1',[u.id])).role,'SDO_HEAD');
   // an existing legacy DEPARTMENT_HEAD stays readable, is not converted, and can be moved to a current role
   const dh=await mk('37','Легаси ДН','DEPARTMENT_HEAD');
   const listed=(await api('GET','/admin/users',adminToken)).data.users.find((x:any)=>x.id===dh.id);assert.equal(listed.role,'DEPARTMENT_HEAD');
   assert.equal((await api('PATCH','/admin/users/'+dh.id,adminToken,{isActive:false})).status,200);
   assert.equal((await one(pool,'SELECT role FROM users WHERE id=$1',[dh.id])).role,'DEPARTMENT_HEAD','deactivation keeps the legacy role');
   assert.equal((await api('PATCH','/admin/users/'+dh.id,adminToken,{isActive:true,role:'PTO_HEAD'})).status,200);
  });
  await t.test('strict validation: no foreign fields, empty patch refused',async()=>{
   for(const body of [{}, {role:'PTO',tenantId:tenantA.id},{bitrixUserId:'1'},{name:'x'},{version:1},{isActive:'yes'}])assert.equal((await api('PATCH','/admin/users/'+pto.id,adminToken,body)).status,400,JSON.stringify(body));
   assert.equal((await api('PATCH','/admin/users/not-a-uuid',adminToken,{role:'PTO'})).status,400);
   assert.equal((await api('PATCH','/admin/users/'+pto.id,adminToken,{role:'PTO'})).status,200); // no-op
  });
  await t.test('H/R. role change is audited; Bitrix position/department never assigns a role',async()=>{
   const bx=bitrixCalls.length;
   const r=await api('PATCH','/admin/users/'+pto.id,adminToken,{role:'PROJECT_MANAGER'});assert.equal(r.status,200);assert.equal(r.data.role,'PROJECT_MANAGER');
   const a=await audits(pto.id);const last=a[a.length-1];assert.equal(last.action,'ROLE_CHANGE');assert.equal(last.old_value.role,'PTO');assert.equal(last.new_value.role,'PROJECT_MANAGER');
   assert.equal(bitrixCalls.length,bx,'a role change never consults Bitrix');
   // employee 32 is ACTIVE=false with a director title in Bitrix: adding it gives exactly the selected role, nothing derived
   const add=await api('POST','/admin/users',adminToken,{bitrixUserId:'32',role:'SDO_HEAD'});assert.equal(add.status,201);assert.equal(add.data.role,'SDO_HEAD');
   portal['31'].WORK_POSITION='Рабочий';portal['31'].UF_DEPARTMENT=[9];portal['32'].ACTIVE=true;
   const list=await api('GET','/admin/users',adminToken);assert.equal(list.data.users.find((u:any)=>u.bitrixUserId==='31').role,'DEPUTY_DIRECTOR');
   assert.equal(list.data.users.find((u:any)=>u.bitrixUserId==='32').isActive,true);
  });
  await t.test('I/J/K/L/M. deactivate audited, sessions deleted, token 401, reactivate audited, old token stays dead',async()=>{
   const u=await mk('51','Сессионный','PTO');const t1=await tokenFor(u),t2=await tokenFor(u);
   const other=await mk('52','Другой','PTO');const otherToken=await tokenFor(other);
   assert.equal((await api('GET','/me',t1)).status,200);
   const d=await api('PATCH','/admin/users/'+u.id,adminToken,{isActive:false});assert.equal(d.status,200);assert.equal(d.data.isActive,false);
   assert.equal((await pool.query('SELECT count(*)::int n FROM sessions WHERE user_id=$1',[u.id])).rows[0].n,0);
   assert.equal((await pool.query('SELECT count(*)::int n FROM sessions WHERE user_id=$1',[other.id])).rows[0].n,1,'other users keep sessions');
   assert.equal((await api('GET','/me',t1)).status,401);assert.equal((await api('GET','/me',t2)).status,401);assert.equal((await api('GET','/me',otherToken)).status,200);
   const re=await api('PATCH','/admin/users/'+u.id,adminToken,{isActive:true});assert.equal(re.status,200);assert.equal(re.data.role,'PTO','same role restored');
   assert.equal((await pool.query('SELECT count(*)::int n FROM sessions WHERE user_id=$1',[u.id])).rows[0].n,0,'reactivation creates no session');
   assert.equal((await api('GET','/me',t1)).status,401);assert.equal((await api('GET','/me',t2)).status,401);
   assert.equal((await api('GET','/me',await tokenFor(await one(pool,'SELECT * FROM users WHERE id=$1',[u.id])))).status,200,'a fresh session works');
   const a=await audits(u.id);assert.deepEqual(a.map((x:any)=>x.action),['DEACTIVATE','REACTIVATE']);
   assert.equal(a[0].old_value.isActive,true);assert.equal(a[0].new_value.isActive,false);assert.equal(a[1].new_value.isActive,true);
   assert.ok(!JSON.stringify(a).match(/token|hash|secret/i));
   // reactivation with an explicit other role: role change + reactivation, both audited
   await api('PATCH','/admin/users/'+u.id,adminToken,{isActive:false});
   const both=await api('PATCH','/admin/users/'+u.id,adminToken,{isActive:true,role:'SDO'});assert.equal(both.data.role,'SDO');
   assert.deepEqual((await audits(u.id)).map((x:any)=>x.action).slice(-2).sort(),['REACTIVATE','ROLE_CHANGE']); // same-transaction rows share created_at
  });
  await t.test('N/O. last active ADMIN cannot be deactivated or downgraded; a second admin lifts the block',async()=>{
   assert.equal((await api('PATCH','/admin/users/'+admin.id,adminToken,{isActive:false})).status,409);
   assert.equal((await api('PATCH','/admin/users/'+admin.id,adminToken,{role:'PTO'})).status,409);
   assert.equal((await api('PATCH','/admin/users/'+admin.id,adminToken,{role:'PTO',isActive:false})).status,409);
   const row=await one(pool,'SELECT role,is_active FROM users WHERE id=$1',[admin.id]);assert.equal(row.role,'ADMIN');assert.equal(row.isActive,true);
   assert.equal((await pool.query('SELECT count(*)::int n FROM sessions WHERE user_id=$1',[admin.id])).rows[0].n>0,true,'refused deactivation keeps sessions');
   // an INACTIVE second admin does not count
   const dormant=await mk('61','Спящий админ','ADMIN',false);
   assert.equal((await api('PATCH','/admin/users/'+admin.id,adminToken,{isActive:false})).status,409);
   assert.equal((await api('PATCH','/admin/users/'+dormant.id,adminToken,{isActive:true})).status,200);
   assert.equal((await api('PATCH','/admin/users/'+admin.id,adminToken,{role:'GENERAL_DIRECTOR'})).status,200);
   // now dormant is the last one
   const dToken=await tokenFor(await one(pool,'SELECT * FROM users WHERE id=$1',[dormant.id]));
   assert.equal((await api('PATCH','/admin/users/'+dormant.id,dToken,{isActive:false})).status,409);
   await pool.query("UPDATE users SET role='ADMIN' WHERE id=$1",[admin.id]);
  });
  await t.test('Q. tenant A cannot see or modify tenant B users',async()=>{
   const tb=(await pool.query("INSERT INTO tenants(portal,member_id,name) VALUES('other.bitrix24.com','other-member','B') RETURNING *")).rows[0];
   const bAdmin=await insert(pool,'users',tb.id,{bitrixUserId:'7',name:'B Admin',role:'ADMIN'});const bUser=await insert(pool,'users',tb.id,{bitrixUserId:'71',name:'B User',role:'PTO'});
   const bToken=await tokenFor(bAdmin);
   const seenByA=await api('GET','/admin/users',adminToken);assert.ok(!seenByA.data.users.some((u:any)=>u.id===bUser.id||u.id===bAdmin.id));
   const seenByB=await api('GET','/admin/users',bToken);assert.deepEqual(seenByB.data.users.map((u:any)=>u.bitrixUserId).sort(),['7','71']);
   for(const body of [{role:'ADMIN'},{isActive:false}]){assert.equal((await api('PATCH','/admin/users/'+bUser.id,adminToken,body)).status,404);}
   assert.equal((await api('PATCH','/admin/users/'+pto.id,bToken,{isActive:false})).status,404);
   const row=await one(pool,'SELECT role,is_active FROM users WHERE id=$1',[bUser.id]);assert.equal(row.role,'PTO');assert.equal(row.isActive,true);
   // same Bitrix ID in another tenant is an independent identity (tenant-scoped uniqueness)
   assert.equal((await pool.query("SELECT count(*)::int n FROM users WHERE bitrix_user_id='7'")).rows[0].n,2);
  });
 }finally{globalThis.fetch=originalFetch;await app.close();}
});
