/**
 * Disposable native PostgreSQL schema smoke. This is NOT production or FIN1-01..27 acceptance.
 * Reuses the normal migration runner for 001..028, then loads UNNUMBERED DRAFT only in an
 * explicitly confirmed isolated *_test database reachable via loopback.
 */
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
const url=process.env.DATABASE_URL;
if (process.env.FIN_SDO_ISOLATED_CONFIRM!=='YES'||!url)throw Error('Requires explicit FIN_SDO_ISOLATED_CONFIRM=YES and isolated DATABASE_URL');
const parsed=new URL(url);
if(!['127.0.0.1','localhost','::1'].includes(parsed.hostname)||!parsed.pathname.endsWith('_test'))throw Error('Refuse non-loopback/non-* _test DATABASE_URL');
const pool=new Pool({connectionString:url,connectionTimeoutMillis:5000});
let passed=0,failed=0;
async function expectDbRefusal(label:string,sql:string,args:any[]=[]){
 const c=await pool.connect();
 try {
   await c.query('BEGIN');
   try{
     await c.query(sql,args);
     // Constraint triggers are DEFERRABLE: an invalid mutation may only fail at COMMIT.
     await c.query('COMMIT');
     failed++;
     console.error('FAIL (unexpected SQL success): '+label);
   }catch(e:any){
     passed++;
     console.log('PASS (SQL rejected): '+label+' ['+e.code+']');
   }
   await c.query('ROLLBACK');
 }finally{c.release()}
}
async function main(){
 const who=await pool.query('SELECT current_database() name, inet_server_addr() AS addr');
 assert.match(who.rows[0].name,/_test$/);
 const address=String(who.rows[0].addr);
 // GitHub Docker publishes on host 127.0.0.1 but PostgreSQL sees its own private bridge address.
 // The enforceable connection guard is the URL host 127.0.0.1 plus explicit *_test database and isolated-confirm flag.
 console.log('isolated PostgreSQL: '+who.rows[0].name+' '+address);
 const sql=readFileSync(resolve('design/fin-sdo-1/schema-UNNUMBERED.sql'),'utf8');
 await pool.query(sql);
 const tenant=await pool.query("INSERT INTO tenants(portal,member_id,name) VALUES('fin1-isolated.example.test','fin1-isolated-member','FIN isolated') RETURNING id");
 const tenant2=await pool.query("INSERT INTO tenants(portal,member_id,name) VALUES('fin2-isolated.example.test','fin2-isolated-member','FIN isolated 2') RETURNING id");
 const t=tenant.rows[0].id,t2=tenant2.rows[0].id;
 const user=await pool.query("INSERT INTO users(tenant_id,bitrix_user_id,name,role) VALUES($1,'fin-isolated-user','FIN tester','SDO') RETURNING id",[t]);
 const u=user.rows[0].id;
 const h=await pool.query("INSERT INTO fin_historical_subjects(tenant_id,name,created_by) VALUES($1,'Duplicate name',$2) RETURNING id",[t,u]);
 const h2=await pool.query("INSERT INTO fin_historical_subjects(tenant_id,name,created_by) VALUES($1,'Duplicate name',$2) RETURNING id",[t,u]);
 assert.notEqual(h.rows[0].id,h2.rows[0].id);passed++;
 const subject=await pool.query("INSERT INTO fin_subjects(tenant_id,origin,historical_subject_id,created_by) VALUES($1,'HISTORICAL',$2,$3) RETURNING id",[t,h.rows[0].id,u]);
 const p=await pool.query("INSERT INTO fin_party_scopes(tenant_id,kind) VALUES($1,'UNALLOCATED') RETURNING id",[t]);
 const party=p.rows[0].id;
 const contract=await pool.query("INSERT INTO fin_contract_scopes(tenant_id,kind,party_scope_id,created_by) VALUES($1,'NOT_SPECIFIED',$2,$3) RETURNING id",[t,party,u]);
 // All official book entities must be written in one transaction: unfinished books cannot COMMIT.
 let bookId:string,revId:string,lineId:string,lrId:string;
 const c=await pool.connect();
 try{
   await c.query('BEGIN');
   const book=await c.query("INSERT INTO fin_quarter_plan_books(tenant_id,plan_year,plan_quarter,created_by) VALUES($1,2026,4,$2) RETURNING id",[t,u]);
   bookId=book.rows[0].id;
   const rev=await c.query("INSERT INTO fin_quarter_book_revisions(tenant_id,book_id,revision_no,new_total_rub,actor_id,effective_on,command_id) VALUES($1,$2,1,10000000.00,$3,'2026-10-24',gen_random_uuid()) RETURNING id",[t,bookId,u]);
   revId=rev.rows[0].id;
   const l=await c.query("INSERT INTO fin_quarter_plan_lines(tenant_id,book_id,subject_id,party_scope_id,contract_scope_id,created_in_book_revision) VALUES($1,$2,$3,$4,$5,1) RETURNING id",[t,bookId,subject.rows[0].id,party,contract.rows[0].id]);
   lineId=l.rows[0].id;
   const lr=await c.query("INSERT INTO fin_quarter_plan_line_revisions(tenant_id,book_revision_id,book_id,plan_line_id,line_revision_no,new_amount_rub,actor_id,effective_on) VALUES($1,$2,$3,$4,1,10000000.00,$5,'2026-10-24') RETURNING id",[t,revId,bookId,lineId,u]);
   lrId=lr.rows[0].id;
   await c.query('UPDATE fin_quarter_plan_books SET version=1,head_revision_no=1 WHERE id=$1',[bookId]);
   await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e}finally{c.release()}
 await expectDbRefusal('duplicate quarterly book',"INSERT INTO fin_quarter_plan_books(tenant_id,plan_year,plan_quarter,created_by) VALUES($1,2026,4,$2)",[t,u]);
 await expectDbRefusal('below 10m official book revision',"INSERT INTO fin_quarter_book_revisions(tenant_id,book_id,revision_no,new_total_rub,actor_id,effective_on,command_id) VALUES($1,$2,2,9990000.00,$3,'2026-10-24',gen_random_uuid())",[t,bookId,u]);
 await expectDbRefusal('foreign-tenant historical subject',"INSERT INTO fin_subjects(tenant_id,origin,historical_subject_id,created_by) VALUES($1,'HISTORICAL',$2,$3)",[t2,h.rows[0].id,u]);
 await expectDbRefusal('direct book head tampering without paired revision',"UPDATE fin_quarter_plan_books SET version=2,head_revision_no=2 WHERE id=$1",[bookId]);
 await expectDbRefusal('direct new line with no immutable line revision',"INSERT INTO fin_quarter_plan_lines(tenant_id,book_id,subject_id,party_scope_id,contract_scope_id,created_in_book_revision) VALUES($1,$2,$3,$4,$5,1)",[t,bookId,subject.rows[0].id,party,contract.rows[0].id]);
 await expectDbRefusal('immutable quarter book revision','UPDATE fin_quarter_book_revisions SET new_total_rub=12000000.00 WHERE id=$1',[revId]);
 await expectDbRefusal('immutable quarter line revision','DELETE FROM fin_quarter_plan_line_revisions WHERE id=$1',[lrId]);
 await expectDbRefusal('duplicate line key',"INSERT INTO fin_quarter_plan_lines(tenant_id,book_id,subject_id,party_scope_id,contract_scope_id,created_in_book_revision) VALUES($1,$2,$3,$4,$5,1)",[t,bookId,subject.rows[0].id,party,contract.rows[0].id]);
 await expectDbRefusal('party other tenant',"INSERT INTO fin_party_scopes(tenant_id,kind,historical_party_id) VALUES($1,'HISTORICAL',$2)",[t2,party]);

 await expectDbRefusal('immutable plan quarter identity',"UPDATE fin_quarter_plan_books SET plan_quarter=3 WHERE id=$1",[bookId]);
 await expectDbRefusal('immutable historical identity',"UPDATE fin_historical_subjects SET name='Changed' WHERE id=$1",[h.rows[0].id]);
 await expectDbRefusal('reject sub-centimillion line precision',
 "INSERT INTO fin_quarter_plan_line_revisions(tenant_id,book_revision_id,book_id,plan_line_id,line_revision_no,previous_amount_rub,new_amount_rub,actor_id,effective_on) VALUES($1,$2,$3,$4,2,10000000.00,10000000.01,$5,'2026-10-24')",
 [t,revId,bookId,lineId,u]);
 await expectDbRefusal('reject second empty book revision',
 "INSERT INTO fin_quarter_book_revisions(tenant_id,book_id,revision_no,previous_total_rub,new_total_rub,reason,actor_id,effective_on,command_id) VALUES($1,$2,2,10000000.00,11000000.00,'Correction',$3,'2026-10-24',gen_random_uuid())",
 [t,bookId,u]);
 const hparty=await pool.query("INSERT INTO fin_historical_parties(tenant_id,name,created_by) VALUES($1,'Second party',$2) RETURNING id",[t,u]);
 const secondParty=await pool.query("INSERT INTO fin_party_scopes(tenant_id,kind,historical_party_id) VALUES($1,'HISTORICAL_PARTY',$2) RETURNING id",[t,hparty.rows[0].id]);
 const secondContract=await pool.query("INSERT INTO fin_contract_scopes(tenant_id,kind,party_scope_id,created_by) VALUES($1,'NOT_SPECIFIED',$2,$3) RETURNING id",[t,secondParty.rows[0].id,u]);
 await expectDbRefusal('contract must belong to same party as line',
 "INSERT INTO fin_quarter_plan_lines(tenant_id,book_id,subject_id,party_scope_id,contract_scope_id,created_in_book_revision) VALUES($1,$2,$3,$4,$5,1)",
 [t,bookId,subject.rows[0].id,party,secondContract.rows[0].id]);
 // Demonstrate what a restrictive FIN DB runtime role must deny:
 // native proof with a dedicated role (application integration remains a release gate).
 await pool.query('CREATE ROLE fin_sdo_limited_test NOLOGIN');
 await pool.query('GRANT USAGE ON SCHEMA public TO fin_sdo_limited_test');
 await pool.query('GRANT SELECT ON TABLE fin_quarter_plan_books TO fin_sdo_limited_test');
 const client=await pool.connect();
 try {
   await client.query('BEGIN');
   await client.query('SET LOCAL ROLE fin_sdo_limited_test');
   try {
     await client.query('UPDATE fin_quarter_plan_books SET head_revision_no=2,version=2 WHERE id=$1',[bookId]);
     failed++;console.error('FAIL: limited role could modify book');
   }catch(e:any) {
     assert.equal(e.code,'42501');
     passed++;console.log('PASS limited DB role forbids direct book UPDATE [42501]');
   }
   await client.query('ROLLBACK');
 }finally{client.release()}


 // The role has explicit SELECT on one finance table but NO finance table DML.
 // 42501 (not immutable-trigger P0001 / numeric CHECK 23514) proves denial at
 // the privilege boundary. Still NOT proof of deployment runtime-role wiring.
 const privilegedBypassCases:[string,string,unknown[]][]=[
  ['direct immutable book revision overwrite','UPDATE fin_quarter_book_revisions SET new_total_rub=12000000.00 WHERE id=$1',[revId]],
  ['direct immutable book revision delete','DELETE FROM fin_quarter_book_revisions WHERE id=$1',[revId]],
  ['direct immutable line history delete','DELETE FROM fin_quarter_plan_line_revisions WHERE id=$1',[lrId]],
  ['direct current-quarter plan mutation','UPDATE fin_quarter_plan_books SET version=2,head_revision_no=2 WHERE id=$1',[bookId]],
  ['direct FIN ledger insertion',"INSERT INTO fin_command_ledger(tenant_id,actor_id,kind,scope_id,idempotency_key,fingerprint,result) VALUES($1,$2,'fake',gen_random_uuid(),'forged-key','bad','{}')",[t,u]],
  ['direct FIN original subject overwrite',"UPDATE fin_historical_subjects SET name='X' WHERE id=$1",[h.rows[0].id]],
  ['direct cross-tenant edit-session creation',"INSERT INTO fin_plan_edit_sessions(tenant_id,actor_id,plan_year,plan_quarter) VALUES($1,$2,2028,2)",[t2,u]],
  ['direct edit-buffer lines delete',"DELETE FROM fin_plan_edit_session_lines WHERE tenant_id=$1",[t]]
 ];
 for(const [label,sql,args] of privilegedBypassCases){
  const limited=await pool.connect();
  try{
   await limited.query('BEGIN');
   await limited.query('SET LOCAL ROLE fin_sdo_limited_test');
   try { await limited.query(sql,args);
      failed++;console.error('FAIL restricted role unexpectedly executed '+label);
   }catch(e:any){assert.equal(e.code,'42501',label+' must be blocked by privileges');passed++;console.log('PASS restricted finance SQL privilege denial: '+label);}
   await limited.query('ROLLBACK');
  }finally{limited.release()}
 }
 const sum=await pool.query("SELECT b.new_total_rub::text AS total, sum(l.new_amount_rub)::text AS lines FROM fin_quarter_book_revisions b JOIN fin_quarter_plan_line_revisions l ON l.book_revision_id=b.id AND l.tenant_id=b.tenant_id WHERE b.id=$1 GROUP BY b.id",[revId]);
 assert.equal(sum.rows[0].total,'10000000.00');assert.equal(sum.rows[0].lines,'10000000.00');passed++;
 console.log(JSON.stringify({passed,failed,unproven:['runtime-role restricted write path','native concurrency','role ownership/grants wired into application','full FIN1-01..27 acceptance','FIN1-01..27']},null,2));
 if(failed)process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>pool.end());
