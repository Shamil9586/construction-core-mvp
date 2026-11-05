/** FIN1 HTTP/RBAC smoke: disposable PostgreSQL only, no LIVE connections. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pool } from '../apps/backend/src/db';
const url=process.env.DATABASE_URL;
if(process.env.FIN_SDO_ISOLATED_CONFIRM!=='YES'||!url)throw Error('FIN native test confirmation required');
const parsed=new URL(url);
if(!['127.0.0.1','localhost','::1'].includes(parsed.hostname)||!parsed.pathname.endsWith('_test'))throw Error('Refuse non-disposable database');
process.env.FIN_SDO_1_ROUTES='enabled';
process.env.AUTH_MODE='mock';
process.env.MOCK_LOGIN_KEY='test-only-key-never-LIVE';
process.env.APP_ORIGIN='http://127.0.0.1';
let app:any;
async function main(){
 const rows=(await pool.query("SELECT u.id,u.tenant_id,u.role FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE t.portal='fin1-isolated.example.test' AND u.bitrix_user_id='fin-isolated-user'")).rows;
 assert.equal(rows.length,1);
 const sdo=rows[0],tid=sdo.tenant_id;
 const otherTenant=(await pool.query("SELECT id FROM tenants WHERE portal='fin2-isolated.example.test'")).rows[0].id;
 async function user(tenantId:string,role:string):Promise<string>{
   return (await pool.query('INSERT INTO users(tenant_id,bitrix_user_id,name,role) VALUES($1,$2,$3,$4) RETURNING id',
   [tenantId,'fin-http-'+randomUUID(),'FIN test '+role,role])).rows[0].id;
 }
 const leader=await user(tid,'GENERAL_DIRECTOR');
 const pto=await user(tid,'PTO');
 const admin=await user(tid,'ADMIN');
 const tenant2=await user(otherTenant,'SDO');
 async function token(actorId:string,tenantId:string):Promise<string>{
   const secret=randomBytes(36).toString('base64url');
   const hash=createHash('sha256').update(secret).digest('hex');
   await pool.query("INSERT INTO sessions(tenant_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[tenantId,actorId,hash]);
   return secret;
 }
 const tok={
   sdo:await token(sdo.id,tid),
   leader:await token(leader,tid),
   pto:await token(pto,tid),
   admin:await token(admin,tid),
   tenant2:await token(tenant2,otherTenant)
 };
 const {createApp}=await import('../apps/backend/src/main');
 app=await createApp();
 await app.listen(0,'127.0.0.1');
 const server=app.getHttpServer();
 const addr=server.address();
 assert.ok(addr&&typeof addr!=='string');
 const base='http://127.0.0.1:'+addr.port;
 async function request(path:string,bearer:string,verb='GET',body?:unknown){
   const resp=await fetch(base+'/fin-sdo-1/'+path,{
     method:verb,
     headers:{Authorization:'Bearer '+bearer,...(body===undefined?{}:{'Content-Type':'application/json'})},
     ...(body===undefined?{}:{body:JSON.stringify(body)})
   });
   const json=await resp.json();
   return {status:resp.status,json};
 }
 let p=await request('quarter?year=2027&quarter=1',tok.sdo);
 assert.equal(p.status,200);assert.equal(p.json.status,'ACTIVE');assert.equal(p.json.current,'11000000.00');
 console.log('PASS FIN1-19 SDO financial plan read');
 p=await request('quarter?year=2027&quarter=1',tok.leader);
 assert.equal(p.status,200);assert.equal(p.json.status,'ACTIVE');
 console.log('PASS FIN1-19 GD read-only plan');
 p=await request('subjects',tok.pto);
 assert.equal(p.status,403);
 assert.ok(!JSON.stringify(p.json).includes('Same address'));
 console.log('PASS FIN1-19 PTO denied direct finance API');
 p=await request('historical-subjects',tok.leader,'POST',{name:'illegal',idempotencyKey:randomUUID()});
 assert.equal(p.status,403);
 console.log('PASS FIN1-19 CEO cannot create historical object');
 p=await request('quarter?year=2027&quarter=1',tok.tenant2);
 assert.equal(p.status,200);assert.equal(p.json.status,'NO_PLAN');
 assert.ok(!JSON.stringify(p.json).includes('11000000'));
 console.log('PASS FIN1-18 tenant isolation no foreign totals');
 p=await request('quarter?year=2027&quarter=1',tok.admin);
 assert.equal(p.status,200);
 console.log('PASS FIN1-19 ADMIN current-tenant view');
 p=await request('buffers/'+randomUUID(),tok.pto);
 assert.equal(p.status,403);
 console.log('PASS FIN1-19 buffer read denied');
 const b=await request('buffers',tok.sdo,'POST',{year:2027,quarter:3,expectedBookVersion:0,lines:[]});
 assert.equal(b.status,400);console.log('PASS FIN1-22 rejects empty technical input');
 // Create a real committed quarter via HTTP, then revoke SDO and attempt an exact idempotency replay.
 const subj=(await request('subjects',tok.sdo)).json.historical[0].id;
 const buf=await request('buffers',tok.sdo,'POST',{year:2027,quarter:4,expectedBookVersion:0,
   lines:[{historicalSubjectId:subj,partyKind:'UNALLOCATED',contractKind:'NOT_SPECIFIED',amountMln:'10.00'}]});
 assert.equal(buf.status,200);
 const command={year:2027,quarter:4,bufferId:buf.json.bufferId,expectedBufferVersion:buf.json.version,expectedBookVersion:0,effectiveOn:'2027-10-01',idempotencyKey:randomUUID()};
 const first=await request('commit',tok.sdo,'POST',command);
 assert.equal(first.status,200);assert.equal(first.json.totalRub,'10000000.00');
 console.log('PASS FIN1-08 HTTP exact 10.00 million initial plan');
 // Test revoked role after token issuance; authenticates on every request.
 await pool.query("UPDATE users SET role='PTO' WHERE tenant_id=$1 AND id=$2",[tid,sdo.id]);
 p=await request('quarter?year=2027&quarter=1',tok.sdo);
 assert.equal(p.status,403);console.log('PASS FIN1-17 role revocation denies previously valid bearer');
 p=await request('commit',tok.sdo,'POST',command);
 assert.equal(p.status,403);
 assert.ok(!JSON.stringify(p.json).includes('10000000.00'));
 console.log('PASS FIN1-17 revoked writer receives 403 before idempotent replay');
 console.log('FIN-1 HTTP/RBAC smoke completed; no data moved outside disposable DB.');
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(app)await app.close().catch(()=>{});await pool.end()});
