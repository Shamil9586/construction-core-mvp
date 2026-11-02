import { useEffect, useId, useState, type FormEvent } from 'react';
import { Button } from '../../design-system';
import type { FinishSystemRead, FinishSystemUpsertPayload, FinishWorkType } from '../../types/finishSystem';
import type { ErrorView } from '../../view-models/areaScope';
import styles from './FinishSystems.module.css';
import { localSystemPayload, type StageDraft } from './createSystemPayload';

export type CreateState={status:'Idle'}|{status:'Submitting'}|{status:'Saved'}|{status:'Error';error:ErrorView};
type WorkTypeState={status:'Loading'}|{status:'Ready';items:FinishWorkType[]}|{status:'Error';error:ErrorView};
export interface CreateSystemProps{
  systems:FinishSystemRead[];workTypes:WorkTypeState;create:CreateState;
  onCreate:(payload:FinishSystemUpsertPayload)=>Promise<boolean>;onDismissResult:()=>void;
}
const stage=():StageDraft=>({key:globalThis.crypto.randomUUID(),occurrenceKey:'',workTypeId:'',required:true,measureScope:'MAIN',proposedHoldHours:''});

export function CreateSystem({systems,workTypes,create,onCreate,onDismissResult}:CreateSystemProps){
  const [finishTypeId,setFinishTypeId]=useState('');const [code,setCode]=useState('');const [name,setName]=useState('');
  const [stages,setStages]=useState<StageDraft[]>([stage()]);const [validation,setValidation]=useState('');
  const id=useId();const submitting=create.status==='Submitting';
  const available=workTypes.status==='Ready'?workTypes.items.filter(t=>t.isActive!==false):[];
  useEffect(()=>{if(finishTypeId&&!systems.some(s=>s.id===finishTypeId&&s.lifecycle==='ACTIVE'))setFinishTypeId('')},[finishTypeId,systems]);
  const changed=()=>{setValidation('');if(create.status==='Error'||create.status==='Saved')onDismissResult()};
  const updateStage=(key:string,patch:Partial<StageDraft>)=>{changed();setStages(items=>items.map(s=>s.key===key?{...s,...patch}:s))};
  const submit=async(e:FormEvent)=>{
    e.preventDefault();if(submitting||workTypes.status!=='Ready')return;
    try{
      const payload=localSystemPayload(finishTypeId,code,name,stages,available);
      if(await onCreate(payload)){setCode('');setName('');setFinishTypeId('');setStages([stage()]);setValidation('')}
    }catch(error){setValidation(error instanceof Error?error.message:'Проверьте заполнение этапов.')}
  };
  return <section className={styles.createPanel} aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>Новая опубликованная версия системы</h2>
    <p className={styles.meta}>Система объекта без корпоративного шаблона. Публикация создаёт неизменяемую версию; работы появятся только после отдельного подтверждения генерации.</p>
    {workTypes.status==='Loading'?<p aria-live="polite">Загрузка видов работ…</p>:null}
    {workTypes.status==='Error'?<div role="alert" className={styles.alert}>Каталог видов работ недоступен: {workTypes.error.message}</div>:null}
    {workTypes.status==='Ready'&&available.length===0?<p role="status">Нет доступных видов работ для этапов.</p>:null}
    {create.status==='Saved'?<p role="status">Версия опубликована. Список обновляется.</p>:null}
    {create.status==='Error'?<div role="alert" className={styles.alert}><strong>{create.error.message}</strong>{create.error.lines.length?<ul>{create.error.lines.map(line=><li key={line}>{line}</li>)}</ul>:null}{create.error.reference?<small>{create.error.reference}</small>:null}</div>:null}
    {validation?<p role="alert" className={styles.alert}>{validation}</p>:null}
    <form onSubmit={submit} aria-busy={submitting} className={styles.createForm}>
      <label htmlFor={`${id}-system`}>Система отделки</label>
      <select id={`${id}-system`} value={finishTypeId} onChange={e=>{changed();setFinishTypeId(e.target.value)}} disabled={submitting}>
        <option value="">Новая система объекта</option>
        {systems.filter(s=>s.lifecycle==='ACTIVE').map(s=><option value={s.id} key={s.id}>{s.code} · {s.name} (новая версия)</option>)}
      </select>
      {!finishTypeId?<div className={styles.formRow}><label>Код<input value={code} onChange={e=>{changed();setCode(e.target.value)}} required={!finishTypeId} disabled={submitting} maxLength={64} autoComplete="off"/></label><label>Название<input value={name} onChange={e=>{changed();setName(e.target.value)}} required={!finishTypeId} disabled={submitting} maxLength={500}/></label></div>:null}
      <h3>Локальные этапы</h3>
      <ol className={styles.stageForm}>{stages.map((s,i)=>{
        const wt=available.find(t=>t.id===s.workTypeId);
        return <li key={s.key}><div className={styles.stageFormHead}><strong>Этап {i+1}</strong><Button type="button" variant="Secondary" disabled={submitting||stages.length===1} onClick={()=>{changed();setStages(items=>items.filter(x=>x.key!==s.key))}}>Убрать</Button></div>
          <div className={styles.formRow}><label>Ключ этапа<input required maxLength={64} value={s.occurrenceKey} onChange={e=>updateStage(s.key,{occurrenceKey:e.target.value})} disabled={submitting} autoComplete="off"/></label>
          <label>Вид работы<select required value={s.workTypeId} onChange={e=>updateStage(s.key,{workTypeId:e.target.value})} disabled={submitting||workTypes.status!=='Ready'}><option value="">Выберите вид работы</option>{available.map(t=><option key={t.id} value={t.id}>{t.name} · {t.scope==='OBJECT'?'объект':'корпоративный'} · {t.unit}</option>)}</select></label></div>
          <div className={styles.formRow}><label>Измерение<select value={s.measureScope} onChange={e=>updateStage(s.key,{measureScope:e.target.value as StageDraft['measureScope']})} disabled={submitting}><option value="MAIN">Основной объём</option><option value="LOCAL">Локальный объём</option></select></label>
          <label>Предложенная выдержка, ч (необязательно)<input inputMode="decimal" value={s.proposedHoldHours} onChange={e=>updateStage(s.key,{proposedHoldHours:e.target.value})} disabled={submitting} autoComplete="off"/></label></div>
          <label className={styles.checkbox}><input type="checkbox" checked={s.required} onChange={e=>updateStage(s.key,{required:e.target.checked})} disabled={submitting}/> Обязательный этап</label>
          <small className={styles.meta}>Единица этапа: {wt?.unit??'выберите вид работы'}</small>
        </li>})}</ol>
      <div className={styles.createActions}><Button type="button" variant="Secondary" disabled={submitting||stages.length>=100} onClick={()=>{changed();setStages(items=>[...items,stage()])}}>Добавить этап</Button>
      <Button type="submit" loading={submitting} disabled={submitting||workTypes.status!=='Ready'||available.length===0}>{submitting?'Публикация…':'Опубликовать версию'}</Button></div>
    </form>
  </section>;
}
