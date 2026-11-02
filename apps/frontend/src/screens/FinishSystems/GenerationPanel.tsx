import { useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../design-system';
import { newIdempotencyKey, AreaScopeApiError, violationsOf } from '../../data/areaScopeApi';
import { confirmFinishGeneration, previewFinishGeneration } from '../../data/finishGenerationApi';
import type { AreaScopeRead } from '../../types/areaScope';
import type { FinishSystemRead } from '../../types/finishSystem';
import type { GenerationConfirmResult, GenerationPreviewResponse, GenerationSelection } from '../../types/finishGeneration';
import { describeApiError } from '../../view-models/areaScope';
import { generationSelection } from './generationSelection';
import { GeneratedWorks, PreviewObligations } from './GenerationEvidence';
import styles from './FinishSystems.module.css';

type Areas={status:'Loading'}|{status:'Ready';items:AreaScopeRead[]}|{status:'Error';message:string};
type Review={status:'Idle'}|{status:'Loading'}|{status:'Ready';data:GenerationPreviewResponse;selection:GenerationSelection}
  |{status:'Error';message:string};
type Commit={status:'Idle'}|{status:'Loading'}|{status:'Error';message:string}|{status:'Saved';result:GenerationConfirmResult};
function errorText(e:unknown):string{
  if(e instanceof AreaScopeApiError){
    if(e.status===403||e.status===404)return 'Генерация для этого объекта недоступна.';
    const v=describeApiError(e,violationsOf(e.details));
    return [v.message,...v.lines,v.reference].filter(Boolean).join(' ');
  }
  return e instanceof Error?e.message:'Не удалось выполнить операцию.';
}
const qkey=(stage:string,area:string)=>`${stage}|${area}`;

export function GenerationPanel({objectId,system,areas,onGenerated,onOpenWork,recentResult}:{objectId:string;system:FinishSystemRead;areas:Areas;onGenerated:(result:GenerationConfirmResult)=>void;onOpenWork:(workId:string)=>void;recentResult:GenerationConfirmResult|null}){
  const id=useId();const [selected,setSelected]=useState<string[]>([]);const [optional,setOptional]=useState<string[]>([]);
  const [quantities,setQuantities]=useState<Record<string,string>>({});const [grouping,setGrouping]=useState<'PER_OCCURRENCE'|'PER_AREA'>('PER_OCCURRENCE');
  const [review,setReview]=useState<Review>({status:'Idle'});const [commit,setCommit]=useState<Commit>({status:'Idle'});
  const generation=useRef(0);const inFlight=useRef(false);
  const retry=useRef<{fingerprint:string;key:string}|null>(null);
  const version=system.currentVersion;
  if(!version||system.lifecycle!=='ACTIVE')return null;
  const active=areas.status==='Ready'?areas.items.filter(a=>a.lifecycle==='ACTIVE'):[];
  const included=version.stages.filter(s=>s.required||optional.includes(s.occurrenceKey));
  const local=included.filter(s=>s.measureScope==='LOCAL');
  const busy=review.status==='Loading'||commit.status==='Loading';
  const invalidate=()=>{generation.current++;setReview({status:'Idle'});setCommit({status:'Idle'});retry.current=null};
  const toggle=(value:string,list:string[],setter:(next:string[])=>void)=>{
    invalidate();setter(list.includes(value)?list.filter(x=>x!==value):[...list,value]);
  };
  const preview=async(e:FormEvent)=>{
    e.preventDefault();if(busy||inFlight.current||areas.status!=='Ready')return;
    let selection:GenerationSelection;
    try{selection=generationSelection(system,selected,optional,quantities,grouping,areas.items)}
    catch(error){setReview({status:'Error',message:errorText(error)});return}
    const current=++generation.current;retry.current=null;setCommit({status:'Idle'});setReview({status:'Loading'});inFlight.current=true;
    try{const data=await previewFinishGeneration(objectId,system.id,system.version,selection);
      if(current===generation.current)setReview({status:'Ready',data,selection});}
    catch(error){if(current===generation.current)setReview({status:'Error',message:errorText(error)});}
    finally{inFlight.current=false}
  };
  const confirm=async()=>{
    if(inFlight.current||review.status!=='Ready'||!review.data.preview.canConfirm||commit.status==='Saved')return;
    const {selection,data}=review;const fingerprint=JSON.stringify({objectId,finishTypeId:system.id,expectedVersion:system.version,selection,previewFingerprint:data.preview.previewFingerprint,scope:data.preview.scopeVersion});
    if(!retry.current||retry.current.fingerprint!==fingerprint)retry.current={fingerprint,key:newIdempotencyKey()};
    const current=generation.current;inFlight.current=true;setCommit({status:'Loading'});
    try{const result=await confirmFinishGeneration(objectId,system.id,system.version,selection,data,retry.current.key);
      if(current===generation.current){retry.current=null;setCommit({status:'Saved',result});onGenerated(result)}}
    catch(error){
      if(current===generation.current){
        if(error instanceof AreaScopeApiError&&[409,422].includes(error.status)){retry.current=null;setReview({status:'Error',message:`${errorText(error)} Обновите предварительный расчёт.`});setCommit({status:'Idle'})}
        else setCommit({status:'Error',message:errorText(error)});
      }
    }finally{inFlight.current=false}
  };
  return <section className={styles.generation} aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>Генерация работ · версия {version.versionNumber}</h3>
    <p className={styles.meta}>Сначала проверьте расчёт. Работы создаются только после отдельного подтверждения.</p>
    {areas.status==='Loading'?<p aria-live="polite">Загрузка зон объекта…</p>:null}
    {areas.status==='Error'?<p role="alert" className={styles.alert}>Зоны объекта недоступны: {areas.message}</p>:null}
    {areas.status==='Ready'&&active.length===0?<p role="status">Нет действующих зон для генерации.</p>:null}
    {recentResult?<GeneratedWorks result={recentResult} onOpenWork={onOpenWork}/>:null}
    <form onSubmit={preview} className={styles.generationForm}>
      <fieldset disabled={busy||areas.status!=='Ready'}><legend>Зоны объекта</legend>
        <div className={styles.choiceList}>{active.map(a=><label key={a.id}><input type="checkbox" checked={selected.includes(a.id)} onChange={()=>toggle(a.id,selected,setSelected)}/> {a.code} · {a.name} ({a.measureQuantity&&a.measureUnit?`${a.measureQuantity} ${a.measureUnit}`:'объём не задан'})</label>)}</div>
      </fieldset>
      {version.stages.some(s=>!s.required)?<fieldset disabled={busy}><legend>Дополнительные этапы</legend><div className={styles.choiceList}>
        {version.stages.filter(s=>!s.required).map(s=><label key={s.id}><input type="checkbox" checked={optional.includes(s.occurrenceKey)} onChange={()=>toggle(s.occurrenceKey,optional,setOptional)}/> {s.occurrenceKey} · {s.workTypeName??s.workTypeId}</label>)}
      </div></fieldset>:null}
      {local.length>0&&selected.length>0?<fieldset disabled={busy}><legend>Локальные объёмы (если применимо)</legend>
        <div className={styles.quantityGrid}>{local.flatMap(s=>selected.map(areaId=>{
          const area=active.find(a=>a.id===areaId);
          return <label key={qkey(s.occurrenceKey,areaId)}>{s.occurrenceKey} · {area?.code??areaId} ({s.measureUnit})
            <input inputMode="decimal" placeholder="Например, 12.5" value={quantities[qkey(s.occurrenceKey,areaId)]??''}
              onChange={e=>{invalidate();setQuantities(v=>({...v,[qkey(s.occurrenceKey,areaId)]:e.target.value}))}}/>
          </label>;
        }))}</div>
      </fieldset>:null}
      <label>Группировка работ <select disabled={busy} value={grouping} onChange={e=>{invalidate();setGrouping(e.target.value as typeof grouping)}}><option value="PER_OCCURRENCE">По этапу</option><option value="PER_AREA">По зоне</option></select></label>
      <Button type="submit" variant="Secondary" loading={review.status==='Loading'} disabled={busy||areas.status!=='Ready'||active.length===0||selected.length===0}>Предварительный расчёт</Button>
    </form>
    {review.status==='Error'?<p role="alert" className={styles.alert}>{review.message}</p>:null}
    {review.status==='Ready'?<div className={styles.preview} aria-live="polite">
      <h4>Предварительный расчёт</h4>
      <p>Новых работ: {review.data.preview.proposedWorks.length}; существующих связей: {review.data.preview.existingWorks.length}; препятствий: {review.data.preview.blockers.length}.</p>
      <PreviewObligations items={review.data.preview.items}/>
      {review.data.preview.proposedWorks.length>0?<ul>{review.data.preview.proposedWorks.map((w,i)=><li key={w.key||i}>{w.name} — {w.quantity} {w.unit}</li>)}</ul>:null}
      {review.data.preview.existingWorks.length>0?<details><summary>Существующие работы</summary><ul>{review.data.preview.existingWorks.map((w,i)=><li key={w.workId+'-'+w.areaScopeId+'-'+i}>{w.name} · зона {w.areaScopeId}: {w.quantity} {w.unit} (вся работа {w.workPlannedQuantity} {w.unit})</li>)}</ul></details>:null}
      {review.data.preview.missingInputs.length>0?<div role="status"><strong>Недостающие данные</strong><ul>{review.data.preview.missingInputs.map((x,i)=><li key={i}>{x.kind} · {x.occurrenceKey} · {x.areaScopeId??'—'}{x.quantity?` · ${x.quantity} ${x.unit??''}`:''}</li>)}</ul></div>:null}
      {review.data.preview.blockers.length>0?<div role="alert" className={styles.alert}><strong>Подтверждение заблокировано</strong><ul>{review.data.preview.blockers.map((x,i)=><li key={i}>{x.error}{x.rule?` · ${x.rule}`:''} · {x.occurrenceKey??'—'} · {x.areaScopeId??'—'}</li>)}</ul></div>:null}
      {review.data.preview.warnings.length>0?<div role="status"><strong>Предупреждения</strong><ul>{review.data.preview.warnings.map((x,i)=><li key={i}>{x.code}{x.path?` · ${x.path}`:''}</li>)}</ul></div>:null}
      {review.data.preview.canConfirm&&commit.status!=='Saved'?<Button type="button" loading={commit.status==='Loading'} disabled={busy} onClick={confirm}>Создать работы по этому расчёту</Button>:null}
      {commit.status==='Error'?<p role="alert" className={styles.alert}>{commit.message} Повторная отправка сохраняет тот же ключ.</p>:null}
      {commit.status==='Saved'&&!recentResult?<GeneratedWorks result={commit.result} onOpenWork={onOpenWork}/>:null}
    </div>:null}
  </section>;
}
