import { useCallback, useEffect, useState } from 'react';
import { AppShell, typeClass } from '../../design-system';
import { AppSidebar } from '../AppSidebar';
import { useCoreRuntime } from '../CoreRuntimeContext';
import { RouteForbidden } from '../RouteStatus';
import { readSessionToken } from '../../auth/sessionToken';
import { parseResponse } from '../../http';

type Obj={id:string;name:string};
type Directory={core:Obj[];historical:Obj[];contractors:Obj[];historicalParties:Obj[]};
type Line={key:string;coreObjectId?:string;historicalSubjectId?:string;partyKind:'CORE_CONTRACTOR'|'HISTORICAL_PARTY'|'UNALLOCATED';partyId?:string;contractKind:'KNOWN'|'NOT_SPECIFIED';contractNumber?:string;amountMln:string};
type Book={status:string;bookVersion?:number;original?:string;current?:string;history?:Array<{revision_no:number;new_total_rub:string;reason:string;actor_id:string;effective_on:string;recorded_at:string}>;lines?:any[]};
const finRead=['SDO','SDO_HEAD','GENERAL_DIRECTOR','DEPUTY_DIRECTOR','ADMIN'];
const finWrite=['SDO','SDO_HEAD','ADMIN'];
const thisYear=()=>new Date().getFullYear();
const key=()=>crypto.randomUUID();
async function api(path:string,method='GET',body?:unknown):Promise<any>{
 const token=readSessionToken();
 return parseResponse(await fetch('/api/fin-sdo-1/'+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
}
function totalMln(lines:Line[]):string{
 // Integer kopeks per 0.01 million, never JS float.
 let total=0n;
 for(const r of lines){if(!/^(?:0|[1-9]\d*)\.\d{2}$/.test(r.amountMln))return '—';const [a,b]=r.amountMln.split('.');total+=BigInt(a)*100n+BigInt(b);}
 return (total/100n).toString()+'.'+(total%100n).toString().padStart(2,'0');
}
const newLine=():Line=>({key:key(),partyKind:'UNALLOCATED',contractKind:'NOT_SPECIFIED',amountMln:'0.00'});
const formInput={padding:8,borderRadius:4,border:'1px solid #b7bdc7',maxWidth:'100%'};
const moneyRender=(rub:string|undefined|null)=>rub===undefined||rub===null?'—':rub+' ₽';

/** New finance screen; /sdo remains the operational F8.3 workspace. */
export function FinSdoPlanRoute(){
 const {session}=useCoreRuntime();
 const role=session?.user.role??'';
 const allowed=finRead.includes(role),editable=finWrite.includes(role);
 const [year,setYear]=useState(thisYear());
 const [quarter,setQuarter]=useState(1);
 const [dir,setDir]=useState<Directory|null>(null);
 const [book,setBook]=useState<Book|null>(null);
 const [lines,setLines]=useState<Line[]>([]);
 const [bufferId,setBufferId]=useState('');
 const [bufferVersion,setBufferVersion]=useState(0);
 const [dirty,setDirty]=useState(false);
 const [savedBuffers,setSavedBuffers]=useState<Array<{id:string;version:number;total_rub:string;line_count:number}>>([]);
 const [effectiveOn,setEffectiveOn]=useState(new Date().toISOString().slice(0,10));
 const [reason,setReason]=useState('');
 const [historicalName,setHistoricalName]=useState('');
 const [partyName,setPartyName]=useState('');
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState('');
 const [error,setError]=useState('');
 const [showHistory,setShowHistory]=useState(false);

 const refresh=useCallback(async()=>{
   const [directory,quarterBook,buffers]=await Promise.all([api('subjects'),api('quarter?year='+year+'&quarter='+quarter),editable?api('buffers?year='+year+'&quarter='+quarter):Promise.resolve([])]);
   setSavedBuffers(buffers);
   setDir(directory);setBook(quarterBook);
   const restored:Line[]=(quarterBook.lines??[]).map((r:any)=>({
     key:key(),coreObjectId:r.core_object_id??undefined,historicalSubjectId:r.historical_subject_id??undefined,
     partyKind:r.party_kind,partyId:r.core_contractor_id??r.historical_party_id??undefined,
     contractKind:r.contract_kind,contractNumber:r.contract_number??undefined,
     amountMln:r.amount_rub?convertRub(r.amount_rub):'0.00'
   }));
   setLines(restored);
   setBufferId('');setBufferVersion(0);setDirty(false);
 },[year,quarter,editable]);
 useEffect(()=>{if(!allowed)return;let active=true;setError('');refresh().catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[allowed,refresh]);
 if(!allowed)return <RouteForbidden label="Финансовые планы недоступны для вашей роли." />;
 const patch=(id:string,p:Partial<Line>)=>{setDirty(true);setLines(old=>old.map(x=>x.key===id?{...x,...p}:x));};
 async function task(fn:()=>Promise<any>,ok:string){
   setBusy(true);setError('');setMessage('');
   try{await fn();setMessage(ok)}catch(e:any){setError(e?.message??'Ошибка записи')}finally{setBusy(false)}
 }
 const saveBuffer=()=>task(async()=>{
   const payload={year,quarter,expectedBookVersion:book?.bookVersion??0,
     lines:lines.map(({key:_,...r})=>({...r,amountMln:r.amountMln.replace(',','.')}))};
   const s=bufferId
     ?await api('buffers/'+encodeURIComponent(bufferId),'PATCH',{...payload,expectedBufferVersion:bufferVersion})
     :await api('buffers','POST',payload);
   setBufferId(s.bufferId);setBufferVersion(s.version);setDirty(false);
   const available=await api('buffers?year='+year+'&quarter='+quarter);
   setSavedBuffers(available);
 },'Технический ввод сохранён; в действующем плане не учтено.');
 const loadBuffer=(id:string)=>task(async()=>{
   const v=await api('buffers/'+encodeURIComponent(id));
   if(Number(v.buffer.plan_year)!==year||Number(v.buffer.plan_quarter)!==quarter)
      throw Error('Технический буфер другого квартала');
   setLines((v.lines??[]).map((r:any)=>({
      key:key(),coreObjectId:r.core_object_id??undefined,historicalSubjectId:r.historical_subject_id??undefined,
      partyKind:r.party_kind,partyId:r.core_contractor_id??r.historical_party_id??undefined,
      contractKind:r.contract_kind,contractNumber:r.contract_number??undefined,
      amountMln:convertRub(r.amount_rub)
   })));
   setBufferId(id);setBufferVersion(Number(v.buffer.version));setDirty(false);
 },'Технический ввод восстановлен.');
 const commit=()=>task(async()=>{
   if(!bufferId)throw Error('Сначала сохраните технический ввод');
   await api('commit','POST',{year,quarter,bufferId,expectedBookVersion:book?.bookVersion??0,effectiveOn,reason:reason||undefined,idempotencyKey:key()});
   await refresh();
 },'Новая действующая версия квартального плана записана.');
 const historical=()=>task(async()=>{
   await api('historical-subjects','POST',{name:historicalName,idempotencyKey:key()});
   setHistoricalName('');
   await refresh();
 },'Исторический объект создан без производственных записей.');
 const historicalParty=()=>task(async()=>{
   await api('historical-parties','POST',{name:partyName,idempotencyKey:key()});
   setPartyName('');
   await refresh();
 },'Историческая сторона создана.');
 const belowMin=totalMln(lines)==='—'||BigInt(totalMln(lines).replace('.',''))<1000n;
 return <AppShell sidebar={<AppSidebar/>}>
   <section style={{padding:'12px 0',maxWidth:1250}}>
     <h1 className={typeClass('heading-page')}>СДО · План закрытия</h1>
     <p>Квартальное финансовое планирование · RUB · ввод в млн ₽. Финансовый факт заказчика сюда не включён.</p>
     <div style={{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}}>
       <label>Год <input aria-label="Год плана" style={{...formInput,width:90}} type="number" min="2000" max="2200" value={year} onChange={e=>setYear(Number(e.target.value))}/></label>
       <label>Квартал <select aria-label="Квартал плана" style={formInput} value={quarter} onChange={e=>setQuarter(Number(e.target.value))}>{[1,2,3,4].map(n=><option key={n} value={n}>Q{n}</option>)}</select></label>
       <button type="button" onClick={()=>{refresh().catch(e=>setError(e.message))}}>Обновить</button>
     </div>
     {error&&<p role="alert" style={{color:'#b91c1c'}}>{error}</p>}
     {message&&<p role="status">{message}</p>}
     <h2>Действующий квартальный план</h2>
     {book?.status==='NO_PLAN'?<p>План ещё не записан (NO_PLAN). Нулевая строка не является действующим планом.</p>:
      <p>Первоначальный: <strong>{book?.original?convertRub(book.original)+' млн ₽':'—'}</strong> · Текущий: <strong>{book?.current?convertRub(book.current)+' млн ₽':'—'}</strong> · версия {book?.bookVersion??'—'}</p>}
     {editable&&dir&&<>
       <h2>Незавершённый ввод — в плане не учтено</h2>
       {savedBuffers.length>0&&<section aria-label="Сохранённые технические буферы"><p>Ваши сохранённые черновые вводы этого квартала:</p>{savedBuffers.slice(0,10).map(v=><button type="button" key={v.id} disabled={busy} onClick={()=>loadBuffer(v.id)} style={{marginRight:6,marginBottom:6}}>Продолжить {v.line_count} стр. / {convertRub(v.total_rub)} млн ₽</button>)}</section>}
       <p>Строки заполняются постепенно; действующая версия записывается только целиком, если общий итог ≥ 10,00 млн ₽.</p>
       <div style={{overflowX:'auto'}}>
       <table style={{width:'100%',borderCollapse:'collapse'}}>
       <thead><tr><th>Объект</th><th>Исполнитель</th><th>Договор</th><th>млн ₽</th><th></th></tr></thead>
       <tbody>{lines.map(line=><tr key={line.key}>
         <td><select aria-label="Объект" style={formInput} value={line.coreObjectId?'c:'+line.coreObjectId:line.historicalSubjectId?'h:'+line.historicalSubjectId:''}
             onChange={e=>{const [kind,id]=e.target.value.split(':');patch(line.key,{coreObjectId:kind==='c'?id:undefined,historicalSubjectId:kind==='h'?id:undefined})}}>
            <option value="">Выберите объект</option>
            <optgroup label="Construction Core">{dir.core.map(v=><option key={v.id} value={'c:'+v.id}>{v.name}</option>)}</optgroup>
            <optgroup label="Исторические">{dir.historical.map(v=><option key={v.id} value={'h:'+v.id}>{v.name}</option>)}</optgroup>
         </select></td>
         <td><select aria-label="Исполнитель" style={formInput} value={line.partyKind==='UNALLOCATED'?'u':line.partyKind==='CORE_CONTRACTOR'?'c:'+line.partyId:'h:'+line.partyId}
           onChange={e=>{const [k,id]=e.target.value.split(':');patch(line.key,{partyKind:k==='c'?'CORE_CONTRACTOR':k==='h'?'HISTORICAL_PARTY':'UNALLOCATED',partyId:k==='u'?undefined:id,contractKind:'NOT_SPECIFIED',contractNumber:undefined})}}>
            <option value="u">Не распределено</option>
            <optgroup label="Подрядчики Core">{dir.contractors.map(v=><option key={v.id} value={'c:'+v.id}>{v.name}</option>)}</optgroup>
            <optgroup label="Исторические">{dir.historicalParties.map(v=><option key={v.id} value={'h:'+v.id}>{v.name}</option>)}</optgroup>
         </select></td>
         <td><input aria-label="Номер договора" style={{...formInput,width:150}} placeholder="Не указан" value={line.contractNumber??''}
           onChange={e=>patch(line.key,{contractKind:e.target.value.trim()?'KNOWN':'NOT_SPECIFIED',contractNumber:e.target.value||undefined})}/></td>
         <td><input aria-label="Сумма млн ₽" style={{...formInput,width:120}} inputMode="decimal" value={line.amountMln} onChange={e=>patch(line.key,{amountMln:e.target.value})}/></td>
         <td><button type="button" onClick={()=>{setDirty(true);setLines(x=>x.filter(v=>v.key!==line.key));}}>Удалить из ввода</button></td>
       </tr>)}</tbody></table></div>
       <button type="button" disabled={busy} onClick={()=>{setDirty(true);setLines(x=>[...x,newLine()]);}}>Добавить строку</button>
       <p>Общий итог ввода: <strong>{totalMln(lines)} млн ₽</strong> {belowMin?'— ниже порога 10,00 млн ₽':''}</p>
       <p><button type="button" disabled={busy||!lines.length} onClick={saveBuffer}>Сохранить незавершённый ввод</button>
       {' '}<small>Буфер: {bufferId?bufferId+' (v'+bufferVersion+')':'ещё не сохранён'}{dirty?' · Есть несохранённые изменения':''}</small></p>
       <label>Дата действия <input type="date" value={effectiveOn} onChange={e=>setEffectiveOn(e.target.value)}/></label>
       {' '}<label>Причина <input style={formInput} value={reason} onChange={e=>setReason(e.target.value)} placeholder={book?.status==='ACTIVE'?'Обязательна для корректировки':'Первоначальный план'}/></label>
       <p><button type="button" disabled={busy||belowMin||!bufferId||dirty} onClick={commit}>Записать квартальный план</button></p>
       <h2>Исторические данные</h2>
       <label>Наименование объекта <input style={formInput} value={historicalName} onChange={e=>setHistoricalName(e.target.value)}/></label>
       {' '}<button type="button" disabled={busy||!historicalName.trim()} onClick={historical}>Создать исторический объект</button>
       <p><label>Исторический исполнитель <input style={formInput} value={partyName} onChange={e=>setPartyName(e.target.value)}/></label>
       {' '}<button type="button" disabled={busy||!partyName.trim()} onClick={historicalParty}>Добавить исполнителя</button></p>
     </>}
     {book?.history?.length?<>
       <h2><button type="button" onClick={()=>setShowHistory(!showHistory)}>История изменений {showHistory?'▴':'▾'}</button></h2>
       {showHistory&&<table><thead><tr><th>Версия</th><th>Итог RUB</th><th>Причина</th><th>Автор</th><th>Дата действия</th><th>Зарегистрировано</th></tr></thead>
        <tbody>{book.history.map((h:any)=><tr key={h.revision_no}><td>{h.revision_no}</td><td>{h.new_total_rub}</td><td>{h.reason??'Оригинал'}</td><td>{h.actor_id}</td><td>{h.effective_on}</td><td>{new Date(h.recorded_at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})}</td></tr>)}</tbody></table>}
     </>:null}
   </section>
 </AppShell>;
}
function convertRub(v:string):string{
 const match=/^(\d+)\.(\d{2})$/.exec(v);
 if(!match)return '0.00';
 const total=BigInt(match[1])*100n+BigInt(match[2]);
 return (total/100000000n).toString()+'.'+((total%100000000n)/1000000n).toString().padStart(2,'0');
}
