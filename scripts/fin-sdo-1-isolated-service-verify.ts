/** FIN-SDO-1 service native behavior checks on the disposable PostgreSQL from fin-sdo-1-isolated-pg-verify.ts. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../apps/backend/src/db';
import { FinSdo1Service } from '../apps/backend/src/fin-sdo-1.service';
import type { Actor } from '../apps/backend/src/security';
const url=process.env.DATABASE_URL;
if(process.env.FIN_SDO_ISOLATED_CONFIRM!=='YES'||!url)throw Error('Isolated PostgreSQL only');
const host=new URL(url);
if(!['localhost','127.0.0.1','::1'].includes(host.hostname)||!host.pathname.endsWith('_test'))throw Error('unsafe database');
const service=new FinSdo1Service();
let tests=0;
const report=(label:string)=>{tests++;console.log('PASS '+label)};
function line(historicalSubjectId:string,amountMln:string){return {historicalSubjectId,partyKind:'UNALLOCATED' as const,contractKind:'NOT_SPECIFIED' as const,amountMln};}
async function expectCode(fn:()=>Promise<unknown>,code:string){
 try{await fn();assert.fail('expected '+code)}catch(e:any){
   const response=typeof e.getResponse==='function'?e.getResponse():null;
   const actual=typeof response==='object'&&response?JSON.stringify(response):String(e.message);
   if(!actual.includes(code))throw Error('Expected '+code+' but got '+actual);
 }
}
async function main(){
 const identity=await pool.query("SELECT u.id,u.tenant_id,u.name,u.role FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE t.portal='fin1-isolated.example.test'");
 assert.equal(identity.rows.length,1);
 const a={...identity.rows[0],tenantId:identity.rows[0].tenant_id} as Actor;
 const q={year:2027,quarter:1};
 const h1=await service.createHistoricalSubject(a,{name:'Same address',idempotencyKey:randomUUID()});
 const h2=await service.createHistoricalSubject(a,{name:'Same address',idempotencyKey:randomUUID()});
 assert.notEqual(h1.id,h2.id);report('FIN1-04 historical duplicate names retain unique identities');
 const discovered=await service.discover(a);
 assert.ok(discovered.historical.some((o:any)=>o.id===h1.id));report('FIN1-01 subject discovery independent of F8.3');
 let b=await service.saveBuffer(a,{...q,expectedBookVersion:0,lines:[line(h1.id,'6.00')]});
 let noPlan=await service.readBook(a,q);
 assert.equal(noPlan.status,'NO_PLAN');report('FIN1-06 technical buffer 6.00 is not official');
 b=await service.updateBuffer(a,b.bufferId,{...q,expectedBookVersion:0,expectedBufferVersion:1,
   lines:[line(h1.id,'6.00'),line(h2.id,'4.00')]});
 assert.equal(b.version,2);
 assert.equal((await service.readBuffer(a,b.bufferId)).lines.length,2);
 assert.ok((await service.listBuffers(a,q)).some((v:any)=>v.id===b.bufferId));
 report('FIN1-06 persisted private buffer extends from 6.00 to 6+4.00 with CAS');
 await expectCode(()=>service.updateBuffer(a,b.bufferId,{...q,expectedBookVersion:0,expectedBufferVersion:1,
   lines:[line(h1.id,'6.00'),line(h2.id,'4.00')]}),'FIN_BUFFER_CAS_CONFLICT');
 report('FIN1-15 technical buffer stale update denied');
 const attempt={...q,expectedBookVersion:0,bufferId:b.bufferId,effectiveOn:'2027-01-01',idempotencyKey:randomUUID()};
 const saved=await service.commitBuffer(a,attempt);
 assert.equal(saved.totalRub,'10000000.00');
 assert.equal(saved.revisionNo,1);
 let state=await service.readBook(a,q);
 assert.equal(state.original,'10000000.00');assert.equal(state.lines.length,2);report('FIN1-06/09 atomic 6+4 creates original=10.00');
 const replay=await service.commitBuffer(a,attempt);
 assert.deepEqual(replay,saved);report('FIN1-16 lost-response retry no double revision');
 await expectCode(()=>service.commitBuffer(a,{...attempt,effectiveOn:'2027-01-02'}),'FIN_IDEMPOTENCY_PAYLOAD_MISMATCH');report('FIN1-17 same-key payload mismatch');
 const low=await service.saveBuffer(a,{year:2027,quarter:2,expectedBookVersion:0,lines:[line(h1.id,'9.99')]});
 await expectCode(()=>service.commitBuffer(a,{year:2027,quarter:2,expectedBookVersion:0,bufferId:low.bufferId,effectiveOn:'2027-04-01',idempotencyKey:randomUUID()}),'FIN_QUARTER_TOTAL_BELOW_MIN');
 assert.equal((await service.readBook(a,{year:2027,quarter:2})).status,'NO_PLAN');report('FIN1-07 below-min rollback retains NO_PLAN');
 // Original plus correct batch delta 10->10.5, head_version=2.
 const b2=await service.saveBuffer(a,{...q,expectedBookVersion:1,lines:[line(h1.id,'6.50'),line(h2.id,'4.00')]});
 const c2=await service.commitBuffer(a,{...q,bufferId:b2.bufferId,expectedBookVersion:1,effectiveOn:'2027-01-10',reason:'Уточнение объёма',idempotencyKey:randomUUID()});
 assert.equal(c2.totalRub,'10500000.00');
 state=await service.readBook(a,q);
 assert.equal(state.original,'10000000.00');assert.equal(state.current,'10500000.00');assert.equal(state.history.length,2);report('FIN1-10/11 immutable original and batch revision');
 // Stale edit cannot overwrite accepted history.
 const stale=await service.saveBuffer(a,{...q,expectedBookVersion:2,lines:[line(h1.id,'7.00'),line(h2.id,'4.00')]});
 const stale2=await service.saveBuffer(a,{...q,expectedBookVersion:2,lines:[line(h1.id,'7.50'),line(h2.id,'4.00')]});
 const c3=await service.commitBuffer(a,{...q,bufferId:stale.bufferId,expectedBookVersion:2,effectiveOn:'2027-01-15',reason:'Обновление',idempotencyKey:randomUUID()});
 assert.equal(c3.revisionNo,3);
 await expectCode(()=>service.commitBuffer(a,{...q,bufferId:stale2.bufferId,expectedBookVersion:2,effectiveOn:'2027-01-15',reason:'Дубликат',idempotencyKey:randomUUID()}),'FIN_QUARTER_BOOK_VERSION_CONFLICT');
 report('FIN1-15 stale version cannot overwrite head');

 // Native PostgreSQL two-connection races, with real simultaneous writes.
 // The two independent idempotency keys intentionally do NOT serialize each
 // other; book uniqueness plus row CAS must do the work.
 const qi={year:2028,quarter:1};
 const firstI=await service.saveBuffer(a,{...qi,expectedBookVersion:0,lines:[line(h1.id,'10.00')]});
 const otherI=await service.saveBuffer(a,{...qi,expectedBookVersion:0,lines:[line(h2.id,'12.00')]});
 const creations=await Promise.allSettled([
  service.commitBuffer(a,{...qi,bufferId:firstI.bufferId,expectedBookVersion:0,effectiveOn:'2028-01-02',idempotencyKey:randomUUID()}),
  service.commitBuffer(a,{...qi,bufferId:otherI.bufferId,expectedBookVersion:0,effectiveOn:'2028-01-02',idempotencyKey:randomUUID()})
 ]);
 assert.equal(creations.filter(x=>x.status==='fulfilled').length,1,'exactly one original may commit');
 const rejectFirst=creations.find(x=>x.status==='rejected') as PromiseRejectedResult;
 assert.ok(rejectFirst,'a second initial writer must fail with 409');
 assert.equal(rejectFirst.reason?.status,409, 'initial race loser must be 409');
 const firstRevisions=await pool.query('SELECT count(*)::int n FROM fin_quarter_book_revisions WHERE tenant_id=$1 AND book_id=(SELECT id FROM fin_quarter_plan_books WHERE tenant_id=$1 AND plan_year=2028 AND plan_quarter=1)',[a.tenantId]);
 assert.equal(firstRevisions.rows[0].n,1);
 assert.equal((await service.readBook(a,qi)).history.length,1);
 report('FIN1-14 native concurrent initial book: one original, loser 409, no orphan');
 const qr={year:2028,quarter:2};
 const init=await service.saveBuffer(a,{...qr,expectedBookVersion:0,lines:[line(h1.id,'10.00')]});
 await service.commitBuffer(a,{...qr,bufferId:init.bufferId,expectedBookVersion:0,effectiveOn:'2028-04-01',idempotencyKey:randomUUID()});
 const changes=await Promise.all([
  service.saveBuffer(a,{...qr,expectedBookVersion:1,lines:[line(h1.id,'11.00')]}),
  service.saveBuffer(a,{...qr,expectedBookVersion:1,lines:[line(h1.id,'12.00')]})
 ]);
 const correctionRace=await Promise.allSettled(changes.map((v,i)=>service.commitBuffer(a,{
    ...qr,bufferId:v.bufferId,expectedBookVersion:1,effectiveOn:'2028-04-10',
    reason:'Parallel correction '+i,idempotencyKey:randomUUID()
 })));
 assert.equal(correctionRace.filter(x=>x.status==='fulfilled').length,1,'single concurrent correction');
 const rejectCorrection=correctionRace.find(x=>x.status==='rejected') as PromiseRejectedResult;
 assert.ok(rejectCorrection);assert.equal(rejectCorrection.reason?.status,409);
 const raced=await service.readBook(a,qr);
 assert.equal(raced.history.length,2);assert.equal(raced.bookVersion,2);
 assert.equal(raced.original,'10000000.00');
 assert.ok(['11000000.00','12000000.00'].includes(raced.current));
 report('FIN1-15 native concurrent corrections: one CAS winner, immutable original');
 const qHundred={year:2028,quarter:3};
 const amounts=['100.00','110.00','105.00'];
 for(let i=0;i<3;i++){
  const v=await service.saveBuffer(a,{...qHundred,expectedBookVersion:i,lines:[line(h1.id,amounts[i])]});
  await service.commitBuffer(a,{...qHundred,bufferId:v.bufferId,expectedBookVersion:i,effectiveOn:'2028-08-01',
    ...(i?{reason:'Corrected version '+i}:{}),idempotencyKey:randomUUID()});
 }
 const hist=await service.readBook(a,qHundred);
 assert.equal(hist.original,'100000000.00');assert.equal(hist.current,'105000000.00');
 assert.deepEqual(hist.history.map((v:any)=>v.new_total_rub),['100000000.00','110000000.00','105000000.00']);
 assert.deepEqual(hist.history.map((v:any)=>v.previous_total_rub),[null,'100000000.00','110000000.00']);
 report('FIN1-11 actual 100 to 110 to 105 history');
 const noRights={...a,role:'PROJECT_MANAGER' as Actor['role']};
 await expectCode(()=>service.discover(noRights),'FIN_ACCESS_DENIED');report('FIN1-19 negative financial role');
 const stateAsKnown=await service.readBook(a,q,'2020-01-01T00:00:00+03:00');
 assert.equal(stateAsKnown.status,'NO_PLAN_AT_KNOWN_AT');report('FIN1-21 known-at cutoff excludes later plan');
 console.log(JSON.stringify({nativeServiceAssertions:tests,candidate:'NOT ACCEPTED',unverified:['restricted runtime SQL role','HTTP direct endpoint','concurrency on first book','FIN1 full matrix']},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>pool.end());
