import { readSessionToken } from '../auth/sessionToken';
import { AreaScopeApiError, AreaScopePaginationError } from './areaScopeApi';
import type { GenerationConfirmResult, GenerationPreviewResponse, GenerationSelection } from '../types/finishGeneration';

const rec=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const str=(v:unknown):v is string=>typeof v==='string';
async function json(r:Response):Promise<unknown>{
  const text=await r.text();if(!(r.headers.get('content-type')??'').toLowerCase().includes('json'))return undefined;
  try{return JSON.parse(text)}catch{return undefined}
}
async function fail(r:Response):Promise<AreaScopeApiError>{
  const b=await json(r), v=rec(b)?b:{};
  return new AreaScopeApiError(r.status,str(v.message)?v.message:`HTTP ${r.status}`,str(v.code)?v.code:undefined,v.details,str(v.requestId)?v.requestId:undefined);
}
function headers(extra:Record<string,string>={}):Record<string,string>{
  const token=readSessionToken();return token?{...extra,Authorization:`Bearer ${token}`}:extra;
}
const url=(objectId:string,finishTypeId:string,action:'preview'|'confirm')=>
  `/api/v2/objects/${encodeURIComponent(objectId)}/finish-systems/${encodeURIComponent(finishTypeId)}/${action}`;
const bad=()=>new AreaScopePaginationError('Неверный ответ сервера: расчёт генерации не подтверждён.');
function result(body:unknown):GenerationConfirmResult{
  if(!rec(body)||!Array.isArray(body.resultIds)||!body.resultIds.every(str)||!rec(body.appliedVersions)||
    !str(body.appliedVersions.aggregate)||!str(body.appliedVersions.scope)||!Array.isArray(body.warnings))throw bad();
  return body as unknown as GenerationConfirmResult;
}
/** Preview has no idempotency key and never creates Works. A malformed projection fails closed. */
export async function previewFinishGeneration(objectId:string,finishTypeId:string,expectedVersion:string,selection:GenerationSelection):Promise<GenerationPreviewResponse>{
  const r=await fetch(url(objectId,finishTypeId,'preview'),{method:'POST',headers:headers({'Content-Type':'application/json'}),body:JSON.stringify({expectedVersion,payload:selection})});
  if(!r.ok)throw await fail(r);
  const body=await json(r);
  if(!rec(body)||!rec(body.preview))throw bad();
  const p=body.preview;
  if(!/^[0-9a-f]{64}$/.test(str(p.previewFingerprint)?p.previewFingerprint:'')||!str(p.scopeVersion)||
    !str(p.systemVersionId)||p.systemVersionId!==selection.systemVersionId||!rec(p.sourceVersions)||
    p.sourceVersions.systemVersion!==selection.systemVersionId||typeof p.canConfirm!=='boolean'||
    !Array.isArray(p.proposedWorks)||!Array.isArray(p.existingWorks)||!Array.isArray(p.items)||
    !Array.isArray(p.blockers)||!Array.isArray(p.missingInputs)||!Array.isArray(p.warnings)||
    !rec(body.appliedVersions)||!str(body.appliedVersions.aggregate)||!str(body.appliedVersions.scope)||
    !Array.isArray(body.resultIds)||body.resultIds.length!==0)throw bad();
  return body as unknown as GenerationPreviewResponse;
}
/** Confirmation is fenced to the exact preview and the caller holds the retry key. */
export async function confirmFinishGeneration(objectId:string,finishTypeId:string,expectedVersion:string,selection:GenerationSelection,preview:GenerationPreviewResponse,key:string):Promise<GenerationConfirmResult>{
  const p=preview.preview;
  const r=await fetch(url(objectId,finishTypeId,'confirm'),{method:'POST',headers:headers({'Content-Type':'application/json','Idempotency-Key':key}),body:JSON.stringify({
    expectedVersion,expectedScopeVersion:p.scopeVersion,payload:{...selection,previewFingerprint:p.previewFingerprint,expectedSourceVersions:{systemVersion:selection.systemVersionId}}
  })});
  if(!r.ok)throw await fail(r);
  return result(await json(r));
}
