import { useCallback, useEffect, useRef, useState } from 'react';
import { AreaScopeApiError, AreaScopePaginationError, newIdempotencyKey, violationsOf } from '../data/areaScopeApi';
import { listFinishSystems, listFinishWorkTypes, upsertFinishSystem } from '../data/finishSystemApi';
import type { FinishSystemRead, FinishSystemUpsertPayload, FinishWorkType } from '../types/finishSystem';
import { describeApiError, type ErrorView } from '../view-models/areaScope';
export type FinishSystemLoad={status:'Idle'}|{status:'Loading'}|{status:'Ready';items:FinishSystemRead[]}|{status:'Unavailable';error:ErrorView}|{status:'Error';error:ErrorView};
function view(e:unknown):ErrorView{if(e instanceof AreaScopeApiError){const v=describeApiError(e,violationsOf(e.details));return v.kind==='unavailable'?{...v,message:'Раздел «Системы отделки» недоступен.'}:v}return {kind:'other',message:e instanceof AreaScopePaginationError?e.message:e instanceof Error?e.message:'Ошибка загрузки систем отделки',lines:[],reference:null};}
export function useFinishSystems(objectId:string|undefined,enabled:boolean){
  const [state,setState]=useState<{objectId:string|undefined;load:FinishSystemLoad}>({objectId:undefined,load:{status:'Idle'}});
  const [tick,setTick]=useState(0);const reload=useCallback(()=>setTick(v=>v+1),[]);
  useEffect(()=>{
    if(!enabled||!objectId){setState({objectId,load:{status:'Idle'}});return;}
    const c=new AbortController();setState(previous=>previous.objectId===objectId&&previous.load.status==='Ready'?previous:{objectId,load:{status:'Loading'}});
    listFinishSystems(objectId,c.signal).then(items=>{if(!c.signal.aborted)setState({objectId,load:{status:'Ready',items}})},e=>{
      if(c.signal.aborted)return;const error=view(e);
      setState({objectId,load:error.kind==='unavailable'?{status:'Unavailable',error:{...error,message:'Раздел «Системы отделки» недоступен.'}}:{status:'Error',error}});
    });return()=>c.abort();
  },[objectId,enabled,tick]);
  return {load:state.objectId===objectId?state.load:{status:'Loading'} as FinishSystemLoad,reload};
}

export type FinishWorkTypeLoad={status:'Loading'}|{status:'Ready';items:FinishWorkType[]}|{status:'Error';error:ErrorView};
export function useFinishWorkTypes(objectId:string|undefined,enabled:boolean):FinishWorkTypeLoad{
  const [state,setState]=useState<{objectId:string|undefined;load:FinishWorkTypeLoad}>({objectId:undefined,load:{status:'Loading'}});
  useEffect(()=>{
    if(!enabled||!objectId)return;
    const c=new AbortController();setState({objectId,load:{status:'Loading'}});
    listFinishWorkTypes(objectId,c.signal).then(items=>{if(!c.signal.aborted)setState({objectId,load:{status:'Ready',items}})},e=>{if(!c.signal.aborted)setState({objectId,load:{status:'Error',error:view(e)}})});
    return()=>c.abort();
  },[objectId,enabled]);
  return state.objectId===objectId?state.load:{status:'Loading'};
}

export type FinishSystemCreateState={status:'Idle'}|{status:'Submitting'}|{status:'Saved'}|{status:'Error';error:ErrorView};
export function useFinishSystemCreate(objectId:string|undefined,onSaved:()=>void){
  const [state,setState]=useState<FinishSystemCreateState>({status:'Idle'});
  const attempt=useRef<{objectId:string;fingerprint:string;key:string}|null>(null);
  const inFlight=useRef(false);
  const submit=useCallback(async(payload:FinishSystemUpsertPayload):Promise<boolean>=>{
    if(!objectId||inFlight.current)return false;
    const fingerprint=JSON.stringify(payload);
    if(!attempt.current||attempt.current.objectId!==objectId||attempt.current.fingerprint!==fingerprint)attempt.current={objectId,fingerprint,key:newIdempotencyKey()};
    inFlight.current=true;setState({status:'Submitting'});
    try{await upsertFinishSystem(objectId,payload,attempt.current.key);attempt.current=null;setState({status:'Saved'});onSaved();return true;}
    catch(e){setState({status:'Error',error:view(e)});return false;}
    finally{inFlight.current=false;}
  },[objectId,onSaved]);
  const reset=useCallback(()=>setState({status:'Idle'}),[]);
  return {state,submit,reset};
}
