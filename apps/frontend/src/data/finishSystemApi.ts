import { readSessionToken } from '../auth/sessionToken';
import type { FinishSystemPage, FinishSystemRead, FinishSystemUpsertPayload, FinishWorkType } from '../types/finishSystem';
import { AreaScopeApiError, AreaScopePaginationError } from './areaScopeApi';
const base=(objectId:string)=>`/api/v2/objects/${encodeURIComponent(objectId)}/finish-systems`;
const rec=(v:unknown): v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const strOrNull=(v:unknown):v is string|null=>v===null||typeof v==='string';
async function json(response:Response):Promise<unknown>{const text=await response.text();if(!(response.headers.get('content-type')??'').toLowerCase().includes('json'))return undefined;try{return JSON.parse(text)}catch{return undefined}}
async function error(response:Response){const body=await json(response);const r=rec(body)?body:{};return new AreaScopeApiError(response.status,typeof r.message==='string'?r.message:`HTTP ${response.status}`,typeof r.code==='string'?r.code:undefined,r.details,typeof r.requestId==='string'?r.requestId:undefined)}
function headers(): Record<string,string>{const token=readSessionToken();return token?{Authorization:`Bearer ${token}`}:{}};
function page(body:unknown):FinishSystemPage{if(!rec(body)||!Array.isArray(body.items)||!Object.prototype.hasOwnProperty.call(body,'nextCursor')||!strOrNull(body.nextCursor))throw new AreaScopePaginationError('Неверный ответ сервера: искажённая страница систем отделки.');return {items:body.items as FinishSystemRead[],nextCursor:body.nextCursor};}
export async function getFinishSystemPage(objectId:string,cursor:string|null,signal?:AbortSignal):Promise<FinishSystemPage>{const p=new URLSearchParams({limit:'200'});if(cursor)p.set('cursor',cursor);const r=await fetch(`${base(objectId)}?${p}`,{headers:headers(),signal});if(!r.ok)throw await error(r);const body=await json(r);if(body===undefined)throw new AreaScopePaginationError('Неверный ответ сервера: ожидался JSON.');return page(body)}
export async function listFinishSystems(objectId:string,signal?:AbortSignal):Promise<FinishSystemRead[]>{const all:FinishSystemRead[]=[];const seen=new Set<string>();let cursor:string|null=null;for(let i=0;i<200;i++){const p=await getFinishSystemPage(objectId,cursor,signal);all.push(...p.items);if(p.nextCursor===null)return all;if(seen.has(p.nextCursor))throw new AreaScopePaginationError('Сервер повторил курсор: список систем неполный.');seen.add(p.nextCursor);cursor=p.nextCursor;}throw new AreaScopePaginationError('Список систем отделки превысил лимит страниц.')}

/** Q1 is object-scoped and paginated; a partial catalogue must never be offered as a complete set of choices. */
export async function listFinishWorkTypes(objectId:string,signal?:AbortSignal):Promise<FinishWorkType[]>{
  const all:FinishWorkType[]=[];const seen=new Set<string>();let cursor:string|null=null;
  for(let i=0;i<200;i++){
    const p=new URLSearchParams({limit:'200'});if(cursor)p.set('cursor',cursor);
    const r=await fetch(`/api/v2/objects/${encodeURIComponent(objectId)}/work-types?${p}`,{headers:headers(),signal});
    if(!r.ok)throw await error(r);
    const body=await json(r);
    if(!rec(body)||!Array.isArray(body.items)||!Object.prototype.hasOwnProperty.call(body,'nextCursor')||!strOrNull(body.nextCursor))throw new AreaScopePaginationError('Неверный ответ сервера: каталог видов работ неполный.');
    for(const item of body.items){
      if(!rec(item)||typeof item.id!=='string'||typeof item.name!=='string'||typeof item.unit!=='string'||(item.scope!=='CORPORATE'&&item.scope!=='OBJECT')||(item.isActive!==null&&typeof item.isActive!=='boolean'))throw new AreaScopePaginationError('Неверный ответ сервера: искажённый вид работы.');
      all.push(item as unknown as FinishWorkType);
    }
    if(body.nextCursor===null)return all;
    if(seen.has(body.nextCursor))throw new AreaScopePaginationError('Сервер повторил курсор: каталог видов работ неполный.');
    seen.add(body.nextCursor);cursor=body.nextCursor;
  }
  throw new AreaScopePaginationError('Каталог видов работ превысил лимит страниц.');
}

/** The caller retains one Idempotency-Key for an uncertain retry of the identical payload. */
export async function upsertFinishSystem(objectId:string,payload:FinishSystemUpsertPayload,idempotencyKey:string):Promise<void>{
  const r=await fetch(base(objectId),{method:'POST',headers:{...headers(),'Content-Type':'application/json','Idempotency-Key':idempotencyKey},body:JSON.stringify(payload)});
  if(!r.ok)throw await error(r);
  if(!rec(await json(r)))throw new AreaScopePaginationError('Неверный ответ сервера: результат публикации не подтверждён.');
}
