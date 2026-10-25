import { createHash, randomUUID } from 'node:crypto';
import { Injectable, ForbiddenException, BadRequestException, NotFoundException, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { runCommandTx, runSnapshotRead } from './tx-context';
import { runFinSdoCommandTx, runFinSdoSnapshotRead } from './fin-sdo-1-db';
import type { Actor } from './security';
import { millionRubToKopeks, kopeksToRub, FinPlanInputError } from '../../../packages/domain/fin-sdo-1';
import { Permission, hasPermission, type Role } from '../../../packages/domain';

const query = async (c:any,sql:string,args:any[]=[]) => (await c.query(sql,args)).rows;
const one = async (c:any,sql:string,args:any[]=[]) => (await query(c,sql,args))[0]??null;
const error = (code:string):never => { throw new ConflictException({code}); };
const writeRole=(a:Actor)=>{ if(!hasPermission(a.role,Permission.FIN_SDO_PLAN_WRITE))throw new ForbiddenException('FIN_ACCESS_DENIED'); };
const readRole=(a:Actor)=>{ if(!hasPermission(a.role,Permission.FIN_SDO_PLAN_READ))throw new ForbiddenException('FIN_ACCESS_DENIED'); };
const quarter=(year:number,q:number)=>{ if(!Number.isInteger(year)||year<2000||year>2200||![1,2,3,4].includes(q))throw new BadRequestException('FIN_QUARTER_INVALID'); };
const rub=(million:string):string=>{
  try {return kopeksToRub(millionRubToKopeks(million));}
  catch(e){if(e instanceof FinPlanInputError)throw new UnprocessableEntityException({code:e.code});throw e;}
};
const canonical=(a:any)=>[a.subject_id,a.party_scope_id,a.contract_scope_id].join(':');
const mapFinProtectedFailure=(e:any):never=>{
  // Never expose PostgreSQL function internals, role names, object existence or SQL text via HTTP.
  if(e?.code==='42501')throw new ForbiddenException('FIN_ACCESS_DENIED');
  if(e?.code==='23505')throw new ConflictException('FIN_COMMAND_CONFLICT');
  if(e?.code==='23514'||e?.code==='22001')throw new UnprocessableEntityException('FIN_COMMAND_INVALID');
  throw e;
};
const commandScope=(tenant:string,year:number,q:number):string=>{
  const h=createHash('sha256').update(tenant+':RUB:'+year+':'+q).digest('hex').slice(0,32);
  return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-8'+h.slice(17,20)+'-'+h.slice(20);
};
async function guardedLedger(c:any,a:Actor,kind:string,scope:string,key:string,payload:unknown,body:()=>Promise<any>){
  const lock=[a.tenantId,a.id,kind,scope,key].join('|');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 713))',[lock]);
  const fingerprint=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const prior=await one(c,'SELECT fingerprint,result FROM fin_command_ledger WHERE tenant_id=$1 AND actor_id=$2 AND kind=$3 AND scope_id=$4 AND idempotency_key=$5',[a.tenantId,a.id,kind,scope,key]);
  if(prior){if(prior.fingerprint!==fingerprint)error('FIN_IDEMPOTENCY_PAYLOAD_MISMATCH');return prior.result;}
  const result=await body();
  await c.query('INSERT INTO fin_command_ledger(tenant_id,actor_id,kind,scope_id,idempotency_key,fingerprint,result) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[a.tenantId,a.id,kind,scope,key,fingerprint,JSON.stringify(result)]);
  return result;
}
type LineInput={
  coreObjectId?:string; historicalSubjectId?:string;
  partyKind:'CORE_CONTRACTOR'|'HISTORICAL_PARTY'|'UNALLOCATED'; partyId?:string;
  contractKind:'KNOWN'|'NOT_SPECIFIED'; contractNumber?:string; amountMln:string;
};
type Quarter={year:number;quarter:number};
type BufferInput=Quarter&{expectedBookVersion:number;lines:LineInput[]};
type CommitInput=Quarter&{bufferId:string;expectedBookVersion:number;effectiveOn:string;reason?:string;idempotencyKey:string};

/** FIN-1 only: NONE in object coordination, never mutate production, GPR or F8.3. */
@Injectable()
export class FinSdo1Service {
  private async checkCurrentWriter(c:any,a:Actor){
    const u=await one(c,'SELECT role FROM users WHERE tenant_id=$1 AND id=$2 AND is_active=true FOR SHARE',[a.tenantId,a.id]);
    if(!u||!hasPermission(u.role as Role,Permission.FIN_SDO_PLAN_WRITE))throw new ForbiddenException('FIN_ACCESS_DENIED');
  }
  /** S-01 read-only PostgreSQL projection. No table SELECT for FIN login. */
  async discoverProtected(a:Actor,bearer:string){
    readRole(a);
    if(typeof bearer!=='string'||bearer.length<32||bearer.length>256)
      throw new ForbiddenException('FIN_ACCESS_DENIED');
    return runFinSdoSnapshotRead(async tx=>{
      const result=await tx.c.query('SELECT public.fin_sdo_read_directory($1) AS result',[bearer]);
      return result.rows[0].result;
    }).catch(mapFinProtectedFailure);
  }
  async readBookProtected(a:Actor,bearer:string,q:Quarter,knownAt?:string){
    readRole(a);quarter(q.year,q.quarter);
    if(typeof bearer!=='string'||bearer.length<32||bearer.length>256)
      throw new ForbiddenException('FIN_ACCESS_DENIED');
    return runFinSdoSnapshotRead(async tx=>{
      const result=await tx.c.query(
        'SELECT public.fin_sdo_read_quarter($1,$2,$3,$4::timestamptz) AS result',
        [bearer,q.year,q.quarter,knownAt??null]
      );
      return result.rows[0].result;
    }).catch(mapFinProtectedFailure);
  }
  async discover(a:Actor){
    readRole(a);
    return runSnapshotRead(async tx=>{
      const c=tx.c;
      return {
        core:await query(c,'SELECT id,name,address,status FROM objects WHERE tenant_id=$1 ORDER BY name,id',[a.tenantId]),
        historical:await query(c,'SELECT id,name,address,customer_name FROM fin_historical_subjects WHERE tenant_id=$1 ORDER BY name,id',[a.tenantId]),
        contractors:await query(c,'SELECT id,name,status FROM contractors WHERE tenant_id=$1 ORDER BY name,id',[a.tenantId]),
        historicalParties:await query(c,'SELECT id,name FROM fin_historical_parties WHERE tenant_id=$1 ORDER BY name,id',[a.tenantId])
      };
    });
  }
  /**
   * S-01 protected FIN identity command, used only by the explicitly gated
   * HTTP slice. The token is the actual authenticated bearer from the request.
   * PostgreSQL re-authenticates it and derives actor/tenant in its own trust
   * boundary; no application-supplied actor_id or tenant_id reaches SQL.
   */
  async createHistoricalSubjectProtected(a:Actor,bearer:string,b:{name:string;address?:string;customerName?:string;idempotencyKey:string}){
    writeRole(a);
    if(typeof bearer!=='string'||bearer.length<32||bearer.length>256)throw new ForbiddenException('FIN_ACCESS_DENIED');
    return runFinSdoCommandTx(async tx=>{
      const res=await tx.c.query(
        'SELECT public.fin_sdo_create_historical_subject($1,$2,$3,$4,$5) AS result',
        [bearer,b.name,b.address??null,b.customerName??null,b.idempotencyKey]
      );
      return res.rows[0].result;
    }).catch(mapFinProtectedFailure);
  }
  async createHistoricalPartyProtected(a:Actor,bearer:string,b:{name:string;idempotencyKey:string}){
    writeRole(a);
    if(typeof bearer!=='string'||bearer.length<32||bearer.length>256)throw new ForbiddenException('FIN_ACCESS_DENIED');
    return runFinSdoCommandTx(async tx=>{
      const res=await tx.c.query(
        'SELECT public.fin_sdo_create_historical_party($1,$2,$3) AS result',
        [bearer,b.name,b.idempotencyKey]
      );
      return res.rows[0].result;
    }).catch(mapFinProtectedFailure);
  }
  async createHistoricalSubject(a:Actor,b:{name:string;address?:string;customerName?:string;idempotencyKey:string}){
    writeRole(a);
    return runCommandTx(async tx=>{
      const c=tx.c;await this.checkCurrentWriter(c,a);
      return guardedLedger(c,a,'historical-subject-create',a.tenantId,b.idempotencyKey,b,async()=>{
        const id=randomUUID();
        await c.query('INSERT INTO fin_historical_subjects(id,tenant_id,name,address,customer_name,created_by) VALUES($1,$2,$3,$4,$5,$6)',[id,a.tenantId,b.name,b.address??null,b.customerName??null,a.id]);
        return {id,name:b.name,origin:'HISTORICAL'};
      });
    });
  }
  async createHistoricalParty(a:Actor,b:{name:string;idempotencyKey:string}){
    writeRole(a);
    return runCommandTx(async tx=>{
      const c=tx.c;await this.checkCurrentWriter(c,a);
      return guardedLedger(c,a,'historical-party-create',a.tenantId,b.idempotencyKey,b,async()=>{
        const id=randomUUID();
        await c.query('INSERT INTO fin_historical_parties(id,tenant_id,name,created_by) VALUES($1,$2,$3,$4)',[id,a.tenantId,b.name,a.id]);
        return {id,name:b.name};
      });
    });
  }
  private async resolveLine(c:any,a:Actor,v:LineInput){
    if(!!v.coreObjectId===!!v.historicalSubjectId)throw new BadRequestException('FIN_SUBJECT_XOR');
    const isCore=!!v.coreObjectId, oid=v.coreObjectId??v.historicalSubjectId;
    let s=await one(c,'SELECT id FROM fin_subjects WHERE tenant_id=$1 AND '+(isCore?'core_object_id':'historical_subject_id')+'=$2',[a.tenantId,oid]);
    if(!s){
      const target=await one(c,'SELECT id FROM '+(isCore?'objects':'fin_historical_subjects')+' WHERE tenant_id=$1 AND id=$2',[a.tenantId,oid]);
      if(!target)throw new NotFoundException('FIN_SUBJECT_NOT_FOUND');
      s=await one(c,'INSERT INTO fin_subjects(tenant_id,origin,core_object_id,historical_subject_id,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',[a.tenantId,isCore?'CORE':'HISTORICAL',v.coreObjectId??null,v.historicalSubjectId??null,a.id])??
        await one(c,'SELECT id FROM fin_subjects WHERE tenant_id=$1 AND '+(isCore?'core_object_id':'historical_subject_id')+'=$2',[a.tenantId,oid]);
    }
    if(!s)error('FIN_SUBJECT_CONFLICT');
    let p:any;
    if(v.partyKind==='UNALLOCATED'){
      if(v.partyId)throw new BadRequestException('FIN_PARTY_INVALID');
      p=await one(c,"INSERT INTO fin_party_scopes(tenant_id,kind) VALUES($1,'UNALLOCATED') ON CONFLICT DO NOTHING RETURNING id",[a.tenantId])??
        await one(c,"SELECT id FROM fin_party_scopes WHERE tenant_id=$1 AND kind='UNALLOCATED'",[a.tenantId]);
    }else{
      if(!v.partyId)throw new BadRequestException('FIN_PARTY_REQUIRED');
      const col=v.partyKind==='CORE_CONTRACTOR'?'core_contractor_id':'historical_party_id';
      const table=v.partyKind==='CORE_CONTRACTOR'?'contractors':'fin_historical_parties';
      if(!await one(c,'SELECT id FROM '+table+' WHERE tenant_id=$1 AND id=$2',[a.tenantId,v.partyId]))throw new NotFoundException('FIN_PARTY_NOT_FOUND');
      p=await one(c,'INSERT INTO fin_party_scopes(tenant_id,kind,'+col+') VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id',[a.tenantId,v.partyKind,v.partyId])??
        await one(c,'SELECT id FROM fin_party_scopes WHERE tenant_id=$1 AND '+col+'=$2',[a.tenantId,v.partyId]);
    }
    if(!p)error('FIN_PARTY_SCOPE_CONFLICT');
    let k:any;
    if(v.contractKind==='NOT_SPECIFIED'){
      if(v.contractNumber)throw new BadRequestException('FIN_CONTRACT_INVALID');
      k=await one(c,"INSERT INTO fin_contract_scopes(tenant_id,kind,party_scope_id,created_by) VALUES($1,'NOT_SPECIFIED',$2,$3) ON CONFLICT DO NOTHING RETURNING id",[a.tenantId,p.id,a.id])??
        await one(c,"SELECT id FROM fin_contract_scopes WHERE tenant_id=$1 AND party_scope_id=$2 AND kind='NOT_SPECIFIED'",[a.tenantId,p.id]);
    }else{
      if(!v.contractNumber?.trim())throw new BadRequestException('FIN_CONTRACT_REQUIRED');
      const number=v.contractNumber.trim();
      k=await one(c,"INSERT INTO fin_contract_scopes(tenant_id,kind,party_scope_id,number,created_by) VALUES($1,'KNOWN',$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id",[a.tenantId,p.id,number,a.id])??
        await one(c,"SELECT id FROM fin_contract_scopes WHERE tenant_id=$1 AND party_scope_id=$2 AND kind='KNOWN' AND number=$3",[a.tenantId,p.id,number]);
    }
    if(!k)error('FIN_CONTRACT_SCOPE_CONFLICT');
    return {subject_id:s.id,party_scope_id:p.id,contract_scope_id:k.id};
  }
  /**
   * FIN S-01 protected create-only technical edit buffer.
   * PostgreSQL independently authenticates the bearer and resolves every
   * tenant-qualified CORE/HISTORICAL subject, party and contract reference.
   * No effective book, original, approved workflow or financial total created.
   */
  async saveBufferProtected(a:Actor,bearer:string,b:BufferInput){
    writeRole(a);quarter(b.year,b.quarter);
    if(typeof bearer!=='string'||bearer.length<32||bearer.length>256)
      throw new ForbiddenException('FIN_ACCESS_DENIED');
    if(!Number.isInteger(b.expectedBookVersion)||b.expectedBookVersion<0||!b.lines.length||b.lines.length>1000)
      throw new BadRequestException('FIN_BUFFER_INVALID');
    b.lines.forEach(v=>rub(v.amountMln));
    return runFinSdoCommandTx(async tx=>{
      const result=await tx.c.query(
        'SELECT public.fin_sdo_create_edit_buffer($1,$2,$3,$4,$5::jsonb) AS result',
        [bearer,b.year,b.quarter,b.expectedBookVersion,JSON.stringify(b.lines)]
      );
      return result.rows[0].result;
    }).catch(mapFinProtectedFailure);
  }
  async saveBuffer(a:Actor,b:BufferInput){
    writeRole(a);quarter(b.year,b.quarter);
    if(!Number.isInteger(b.expectedBookVersion)||b.expectedBookVersion<0||b.lines.length>1000)throw new BadRequestException('FIN_BUFFER_INVALID');
    b.lines.forEach(v=>rub(v.amountMln));
    return runCommandTx(async tx=>{
      const c=tx.c;await this.checkCurrentWriter(c,a);
      const current=await one(c,"SELECT version FROM fin_quarter_plan_books WHERE tenant_id=$1 AND currency_code='RUB' AND plan_year=$2 AND plan_quarter=$3",[a.tenantId,b.year,b.quarter]);
      if(Number(current?.version??0)!==b.expectedBookVersion)error('FIN_QUARTER_BOOK_VERSION_CONFLICT');
      const session=await one(c,'INSERT INTO fin_plan_edit_sessions(tenant_id,actor_id,plan_year,plan_quarter,expected_book_version) VALUES($1,$2,$3,$4,$5) RETURNING id',[a.tenantId,a.id,b.year,b.quarter,b.expectedBookVersion]);
      const seen=new Set<string>();
      for(const v of b.lines){
        const s=await this.resolveLine(c,a,v);
        const key=canonical(s);
        if(seen.has(key))throw new BadRequestException('FIN_DUPLICATE_PLAN_LINE');
        seen.add(key);
        await c.query('INSERT INTO fin_plan_edit_session_lines(tenant_id,edit_session_id,subject_id,party_scope_id,contract_scope_id,amount_rub) VALUES($1,$2,$3,$4,$5,$6::numeric)',[a.tenantId,session.id,s.subject_id,s.party_scope_id,s.contract_scope_id,rub(v.amountMln)]);
      }
      const total=await one(c,'SELECT coalesce(sum(amount_rub),0)::text AS total FROM fin_plan_edit_session_lines WHERE tenant_id=$1 AND edit_session_id=$2',[a.tenantId,session.id]);
      return {bufferId:session.id,version:1,uncommitted:true,totalRub:total.total};
    });
  }
  async listBuffersProtected(a:Actor,bearer:string,q:Quarter){
    writeRole(a);quarter(q.year,q.quarter);
    if(typeof bearer!=='string'||bearer.length<32||bearer.length>256)
      throw new ForbiddenException('FIN_ACCESS_DENIED');
    return runFinSdoSnapshotRead(async tx=>{
      const result=await tx.c.query(
        'SELECT public.fin_sdo_list_edit_buffers($1,$2,$3) AS result',
        [bearer,q.year,q.quarter]
      );
      return result.rows[0].result;
    }).catch(mapFinProtectedFailure);
  }
  async readBufferProtected(a:Actor,bearer:string,id:string){
    writeRole(a);
    if(typeof bearer!=='string'||bearer.length<32||bearer.length>256)
      throw new ForbiddenException('FIN_ACCESS_DENIED');
    return runFinSdoSnapshotRead(async tx=>{
      const result=await tx.c.query(
        'SELECT public.fin_sdo_read_edit_buffer($1,$2::uuid) AS result',
        [bearer,id]
      );
      return result.rows[0].result;
    }).catch(mapFinProtectedFailure);
  }
  async updateBufferProtected(a:Actor,bearer:string,id:string,b:BufferInput&{expectedBufferVersion:number}){
    writeRole(a);quarter(b.year,b.quarter);
    if(typeof bearer!=='string'||bearer.length<32||bearer.length>256)
      throw new ForbiddenException('FIN_ACCESS_DENIED');
    if(!Number.isInteger(b.expectedBufferVersion)||b.expectedBufferVersion<1||
      !Number.isInteger(b.expectedBookVersion)||b.expectedBookVersion<0||
      !b.lines.length||b.lines.length>1000)throw new BadRequestException('FIN_BUFFER_INVALID');
    b.lines.forEach(v=>rub(v.amountMln));
    return runFinSdoCommandTx(async tx=>{
      const result=await tx.c.query(
        'SELECT public.fin_sdo_update_edit_buffer($1,$2::uuid,$3,$4,$5,$6,$7::jsonb) AS result',
        [bearer,id,b.expectedBufferVersion,b.year,b.quarter,b.expectedBookVersion,JSON.stringify(b.lines)]
      );
      return result.rows[0].result;
    }).catch(mapFinProtectedFailure);
  }
  async listBuffers(a:Actor,q:Quarter){
    writeRole(a);quarter(q.year,q.quarter);
    return runSnapshotRead(async tx=>query(tx.c,
      'SELECT s.id,s.version,s.expected_book_version,s.updated_at,coalesce(sum(l.amount_rub),0)::text AS total_rub,count(l.id)::int AS line_count FROM fin_plan_edit_sessions s LEFT JOIN fin_plan_edit_session_lines l ON l.tenant_id=s.tenant_id AND l.edit_session_id=s.id WHERE s.tenant_id=$1 AND s.actor_id=$2 AND s.plan_year=$3 AND s.plan_quarter=$4 GROUP BY s.id ORDER BY s.updated_at DESC,s.id LIMIT 30',
      [a.tenantId,a.id,q.year,q.quarter]
    ));
  }
  async updateBuffer(a:Actor,id:string,b:BufferInput&{expectedBufferVersion:number}){
    writeRole(a);quarter(b.year,b.quarter);
    if(!Number.isInteger(b.expectedBufferVersion)||b.expectedBufferVersion<1||!Number.isInteger(b.expectedBookVersion)||b.expectedBookVersion<0||b.lines.length>1000)
      throw new BadRequestException('FIN_BUFFER_INVALID');
    b.lines.forEach(v=>rub(v.amountMln));
    return runCommandTx(async tx=>{
      const c=tx.c;await this.checkCurrentWriter(c,a);
      const session=await one(c,'SELECT * FROM fin_plan_edit_sessions WHERE tenant_id=$1 AND actor_id=$2 AND id=$3 FOR UPDATE',[a.tenantId,a.id,id]);
      if(!session)throw new NotFoundException('FIN_BUFFER_NOT_FOUND');
      if(Number(session.version)!==b.expectedBufferVersion)error('FIN_BUFFER_CAS_CONFLICT');
      if(Number(session.plan_year)!==b.year||Number(session.plan_quarter)!==b.quarter||Number(session.expected_book_version)!==b.expectedBookVersion)
        error('FIN_BUFFER_QUARTER_MISMATCH');
      const current=await one(c,"SELECT version FROM fin_quarter_plan_books WHERE tenant_id=$1 AND currency_code='RUB' AND plan_year=$2 AND plan_quarter=$3",[a.tenantId,b.year,b.quarter]);
      if(Number(current?.version??0)!==b.expectedBookVersion)error('FIN_QUARTER_BOOK_VERSION_CONFLICT');
      const seen=new Set<string>(),rows:({subject_id:string;party_scope_id:string;contract_scope_id:string;amount_rub:string})[]=[];
      for(const v of b.lines){
        const ids=await this.resolveLine(c,a,v),key=canonical(ids);
        if(seen.has(key))throw new BadRequestException('FIN_DUPLICATE_PLAN_LINE');
        seen.add(key);rows.push({...ids,amount_rub:rub(v.amountMln)});
      }
      await c.query('DELETE FROM fin_plan_edit_session_lines WHERE tenant_id=$1 AND edit_session_id=$2',[a.tenantId,id]);
      for(const r of rows)await c.query('INSERT INTO fin_plan_edit_session_lines(tenant_id,edit_session_id,subject_id,party_scope_id,contract_scope_id,amount_rub) VALUES($1,$2,$3,$4,$5,$6::numeric)',[a.tenantId,id,r.subject_id,r.party_scope_id,r.contract_scope_id,r.amount_rub]);
      const updated=await c.query('UPDATE fin_plan_edit_sessions SET version=version+1,updated_at=now() WHERE tenant_id=$1 AND actor_id=$2 AND id=$3 AND version=$4',[a.tenantId,a.id,id,b.expectedBufferVersion]);
      if(updated.rowCount!==1)error('FIN_BUFFER_CAS_CONFLICT');
      const result=await one(c,'SELECT coalesce(sum(amount_rub),0)::text AS total FROM fin_plan_edit_session_lines WHERE tenant_id=$1 AND edit_session_id=$2',[a.tenantId,id]);
      return {bufferId:id,version:b.expectedBufferVersion+1,uncommitted:true,totalRub:result.total};
    });
  }
  async readBuffer(a:Actor,id:string){
    writeRole(a);
    return runSnapshotRead(async tx=>{
      const b=await one(tx.c,'SELECT id,plan_year,plan_quarter,expected_book_version FROM fin_plan_edit_sessions WHERE tenant_id=$1 AND actor_id=$2 AND id=$3',[a.tenantId,a.id,id]);
      if(!b)throw new NotFoundException('FIN_BUFFER_NOT_FOUND');
      return {buffer:b,lines:await query(tx.c,
        'SELECT l.subject_id,l.party_scope_id,l.contract_scope_id,l.amount_rub::text AS amount_rub,s.origin,s.core_object_id,s.historical_subject_id,p.kind AS party_kind,p.core_contractor_id,p.historical_party_id,k.kind AS contract_kind,k.number AS contract_number FROM fin_plan_edit_session_lines l JOIN fin_subjects s ON s.tenant_id=l.tenant_id AND s.id=l.subject_id JOIN fin_party_scopes p ON p.tenant_id=l.tenant_id AND p.id=l.party_scope_id JOIN fin_contract_scopes k ON k.tenant_id=l.tenant_id AND k.id=l.contract_scope_id WHERE l.tenant_id=$1 AND l.edit_session_id=$2 ORDER BY l.id',
        [a.tenantId,id])};
    });
  }
  async readBook(a:Actor,b:Quarter,knownAt?:string){
    readRole(a);quarter(b.year,b.quarter);
    return runSnapshotRead(async tx=>{
      const c=tx.c;
      const book=await one(c,"SELECT id,version FROM fin_quarter_plan_books WHERE tenant_id=$1 AND currency_code='RUB' AND plan_year=$2 AND plan_quarter=$3",[a.tenantId,b.year,b.quarter]);
      if(!book)return {status:'NO_PLAN',year:b.year,quarter:b.quarter,currencyCode:'RUB',original:null,current:null,history:[],lines:[]};
      const history=await query(c,'SELECT id,revision_no,previous_total_rub::text,new_total_rub::text,reason,actor_id,effective_on,recorded_at FROM fin_quarter_book_revisions WHERE tenant_id=$1 AND book_id=$2 ORDER BY revision_no',[a.tenantId,book.id]);
      const visible=knownAt?history.filter((h:any)=>new Date(h.recorded_at).getTime()<=new Date(knownAt).getTime()):history;
      const last=visible.at(-1);
      if(!last)return {status:'NO_PLAN_AT_KNOWN_AT',year:b.year,quarter:b.quarter,history:[],lines:[]};
      const lines=await query(c,
        'SELECT l.id,l.subject_id,l.party_scope_id,l.contract_scope_id,l.created_in_book_revision,r.new_amount_rub::text AS amount_rub,(CASE WHEN l.created_in_book_revision=1 THEN (SELECT lr0.new_amount_rub::text FROM fin_quarter_plan_line_revisions lr0 JOIN fin_quarter_book_revisions b0 ON b0.id=lr0.book_revision_id AND b0.tenant_id=lr0.tenant_id WHERE lr0.tenant_id=l.tenant_id AND lr0.plan_line_id=l.id AND b0.revision_no=1 LIMIT 1) ELSE NULL END) AS original_amount_rub,s.origin,s.core_object_id,s.historical_subject_id,p.kind AS party_kind,p.core_contractor_id,p.historical_party_id,k.kind AS contract_kind,k.number AS contract_number FROM fin_quarter_plan_lines l JOIN fin_subjects s ON s.tenant_id=l.tenant_id AND s.id=l.subject_id JOIN fin_party_scopes p ON p.tenant_id=l.tenant_id AND p.id=l.party_scope_id JOIN fin_contract_scopes k ON k.tenant_id=l.tenant_id AND k.id=l.contract_scope_id JOIN LATERAL (SELECT lr.new_amount_rub FROM fin_quarter_plan_line_revisions lr JOIN fin_quarter_book_revisions br ON br.id=lr.book_revision_id AND br.tenant_id=lr.tenant_id WHERE lr.tenant_id=l.tenant_id AND lr.plan_line_id=l.id AND br.revision_no<=$3 ORDER BY br.revision_no DESC LIMIT 1) r ON TRUE WHERE l.tenant_id=$1 AND l.book_id=$2 ORDER BY l.id',
        [a.tenantId,book.id,last.revision_no]);
      return {status:'ACTIVE',bookId:book.id,bookVersion:book.version,revisionNo:last.revision_no,year:b.year,quarter:b.quarter,currencyCode:'RUB',original:history[0].new_total_rub,current:last.new_total_rub,history:visible,lines};
    });
  }
  async commitBuffer(a:Actor,b:CommitInput){
    writeRole(a);quarter(b.year,b.quarter);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(b.effectiveOn))throw new BadRequestException('FIN_EFFECTIVE_DATE_INVALID');
    return runCommandTx(async tx=>{
      const c=tx.c;await this.checkCurrentWriter(c,a);
      const scope=commandScope(a.tenantId,b.year,b.quarter);
      return guardedLedger(c,a,'quarter-commit',scope,b.idempotencyKey,b,async()=>{
        const e=await one(c,'SELECT * FROM fin_plan_edit_sessions WHERE tenant_id=$1 AND actor_id=$2 AND id=$3 FOR UPDATE',[a.tenantId,a.id,b.bufferId]);
        if(!e||Number(e.plan_year)!==b.year||Number(e.plan_quarter)!==b.quarter)throw new NotFoundException('FIN_BUFFER_NOT_FOUND');
        if(Number(e.expected_book_version)!==b.expectedBookVersion)error('FIN_BUFFER_VERSION_CONFLICT');
        const incoming=await query(c,'SELECT subject_id,party_scope_id,contract_scope_id,amount_rub::text AS amount_rub FROM fin_plan_edit_session_lines WHERE tenant_id=$1 AND edit_session_id=$2 ORDER BY subject_id,party_scope_id,contract_scope_id',[a.tenantId,e.id]);
        const total=await one(c,'SELECT coalesce(sum(amount_rub),0)::text AS value FROM fin_plan_edit_session_lines WHERE tenant_id=$1 AND edit_session_id=$2',[a.tenantId,e.id]);
        if(!incoming.length||!(await one(c,'SELECT ($1::numeric>=10000000.00) AS allowed',[total.value])).allowed)
          throw new UnprocessableEntityException({code:'FIN_QUARTER_TOTAL_BELOW_MIN'});
        let book=await one(c,"SELECT * FROM fin_quarter_plan_books WHERE tenant_id=$1 AND currency_code='RUB' AND plan_year=$2 AND plan_quarter=$3 FOR UPDATE",[a.tenantId,b.year,b.quarter]);
        if(!book){
          if(b.expectedBookVersion!==0)error('FIN_QUARTER_BOOK_VERSION_CONFLICT');
          book=await one(c,"INSERT INTO fin_quarter_plan_books(tenant_id,currency_code,plan_year,plan_quarter,created_by) VALUES($1,'RUB',$2,$3,$4) ON CONFLICT DO NOTHING RETURNING *",[a.tenantId,b.year,b.quarter,a.id]);
          if(!book)error('FIN_QUARTER_BOOK_ALREADY_EXISTS');
        }
        if(Number(book.version)!==b.expectedBookVersion)error('FIN_QUARTER_BOOK_VERSION_CONFLICT');
        if(b.expectedBookVersion>0&&!b.reason?.trim())throw new BadRequestException('FIN_REASON_REQUIRED');
        const old=await query(c,
          'SELECT l.id,l.subject_id,l.party_scope_id,l.contract_scope_id,r.new_amount_rub::text AS amount_rub,r.line_revision_no FROM fin_quarter_plan_lines l JOIN LATERAL (SELECT lr.new_amount_rub,lr.line_revision_no FROM fin_quarter_plan_line_revisions lr JOIN fin_quarter_book_revisions br ON br.id=lr.book_revision_id AND br.tenant_id=lr.tenant_id WHERE lr.tenant_id=l.tenant_id AND lr.plan_line_id=l.id AND br.revision_no<=$3 ORDER BY br.revision_no DESC LIMIT 1) r ON TRUE WHERE l.tenant_id=$1 AND l.book_id=$2',
          [a.tenantId,book.id,b.expectedBookVersion]);
        const lookup=new Map<string,any>(old.map((v:any)=>[canonical(v),v]));
        const keys=new Set(incoming.map((v:any)=>canonical(v)));
        if(old.some((v:any)=>!keys.has(canonical(v))))throw new BadRequestException('FIN_EXISTING_LINE_OMITTED');
        const changed=incoming.filter((v:any)=>!lookup.has(canonical(v))||lookup.get(canonical(v)).amount_rub!==v.amount_rub);
        if(!changed.length)throw new BadRequestException('FIN_NO_CHANGES');
        const revision=b.expectedBookVersion+1;
        const previous=b.expectedBookVersion?
          (await one(c,'SELECT new_total_rub::text AS total FROM fin_quarter_book_revisions WHERE tenant_id=$1 AND book_id=$2 AND revision_no=$3',[a.tenantId,book.id,b.expectedBookVersion]))?.total:null;
        const brId=randomUUID();
        await c.query('INSERT INTO fin_quarter_book_revisions(id,tenant_id,book_id,revision_no,previous_total_rub,new_total_rub,reason,actor_id,effective_on,command_id) VALUES($1,$2,$3,$4,$5::numeric,$6::numeric,$7,$8,$9::date,$10)',[brId,a.tenantId,book.id,revision,previous,total.value,b.reason??null,a.id,b.effectiveOn,randomUUID()]);
        for(const v of changed){
          const prior=lookup.get(canonical(v));
          let lineId=prior?.id;
          if(!lineId){
            lineId=randomUUID();
            await c.query("INSERT INTO fin_quarter_plan_lines(id,tenant_id,book_id,subject_id,party_scope_id,contract_scope_id,currency_code,created_in_book_revision) VALUES($1,$2,$3,$4,$5,$6,'RUB',$7)",[lineId,a.tenantId,book.id,v.subject_id,v.party_scope_id,v.contract_scope_id,revision]);
          }
          await c.query('INSERT INTO fin_quarter_plan_line_revisions(tenant_id,book_revision_id,book_id,plan_line_id,line_revision_no,previous_amount_rub,new_amount_rub,actor_id,effective_on,reason) VALUES($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8,$9::date,$10)',[a.tenantId,brId,book.id,lineId,Number(prior?.line_revision_no??0)+1,prior?.amount_rub??null,v.amount_rub,a.id,b.effectiveOn,b.reason??null]);
        }
        const cas=await c.query('UPDATE fin_quarter_plan_books SET head_revision_no=$4,version=$4 WHERE tenant_id=$1 AND id=$2 AND version=$3',[a.tenantId,book.id,b.expectedBookVersion,revision]);
        if(cas.rowCount!==1)error('FIN_QUARTER_BOOK_VERSION_CONFLICT');
        return {bookId:book.id,bookVersion:revision,revisionNo:revision,totalRub:total.value};
      });
    });
  }
}
