import { useCallback, useEffect, useState } from 'react';
import { AreaScopeApiError, AreaScopePaginationError } from '../data/areaScopeApi';
import { listFinishSystems } from '../data/finishSystemApi';
import type { FinishSystemRead } from '../types/finishSystem';
import { describeApiError, type ErrorView } from '../view-models/areaScope';
export type FinishSystemLoad={status:'Idle'}|{status:'Loading'}|{status:'Ready';items:FinishSystemRead[]}|{status:'Unavailable';error:ErrorView}|{status:'Error';error:ErrorView};
function view(e:unknown):ErrorView{if(e instanceof AreaScopeApiError)return describeApiError(e,[]);return {kind:'other',message:e instanceof AreaScopePaginationError?e.message:e instanceof Error?e.message:'Ошибка загрузки систем отделки',lines:[],reference:null};}
export function useFinishSystems(objectId:string|undefined,enabled:boolean){const [load,setLoad]=useState<FinishSystemLoad>({status:'Idle'});const [tick,setTick]=useState(0);const reload=useCallback(()=>setTick(v=>v+1),[]);useEffect(()=>{if(!enabled||!objectId){setLoad({status:'Idle'});return;}const c=new AbortController();setLoad({status:'Loading'});listFinishSystems(objectId,c.signal).then(items=>{if(!c.signal.aborted)setLoad({status:'Ready',items})},e=>{if(c.signal.aborted)return;const error=view(e);if(error.kind==='unavailable')setLoad({status:'Unavailable',error:{...error,message:'Раздел «Системы отделки» недоступен.'}});else setLoad({status:'Error',error})});return()=>c.abort()},[objectId,enabled,tick]);return {load,reload};}
