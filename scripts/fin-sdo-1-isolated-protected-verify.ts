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
 await owner.query('GRANT USAGE ON SCHEMA public TO fin_sdo_isolated_login');
 await owner.query('GRANT EXECUTE ON FUNCTION public.fin_sdo_session_principal(text,text) TO fin_sdo_isolated_login');
 await owner.query('GRANT EXECUTE ON FUNCTION public.fin_sdo_create_historical_subject(text,text,text,text,text) TO fin_sdo_isolated_login');

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

 assert.equal((await owner.query('SELECT name FROM fin_historical_subjects WHERE id=$1',[result.id])).rows[0].name,'Protected SDO historical object');
 console.log('S-01 vertical slice isolated proof COMPLETE. OTHER FIN WRITERS AND READERS REMAIN BLOCKED.');
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{
  // Ephemeral CI database gets destroyed after job. Never drop a role in production.
  await restrictedFinConnectionPool().end().catch(()=>{});
  await owner.end();
});
