import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell, typeClass } from '../../design-system';
import { AppSidebar } from '../AppSidebar';
import { useCoreRuntime } from '../CoreRuntimeContext';
import { RouteForbidden } from '../RouteStatus';
import { readSessionToken } from '../../auth/sessionToken';
import { httpErrorMessage } from '../../http';
import { canonicalMln, formatMlnHundredths, formatRubAsMln, formatRubExact, rubToCanonicalMln, sumMlnHundredths } from '../../formatters/finPlanMoney';

type Obj={id:string;name:string};
type Directory={core:Obj[];historical:Obj[];contractors:Obj[];historicalParties:Obj[]};
type Line={key:string;coreObjectId?:string;historicalSubjectId?:string;partyKind:'CORE_CONTRACTOR'|'HISTORICAL_PARTY'|'UNALLOCATED';partyId?:string;contractKind:'KNOWN'|'NOT_SPECIFIED';contractNumber?:string;amountMln:string};
type Revision={revision_no:number;previous_total_rub:string|null;new_total_rub:string;reason:string|null;actor_id:string;effective_on:string;recorded_at:string};
type Book={status:string;bookVersion?:number;original?:string;current?:string;history?:Revision[];lines?:any[]};
const finRead=['SDO','SDO_HEAD','GENERAL_DIRECTOR','DEPUTY_DIRECTOR','ADMIN'];
const finWrite=['SDO','SDO_HEAD','ADMIN'];
const MIN_QUARTER_HUNDREDTHS=1000n; // 10,00 млн ₽ (DEC-02)
const thisYear=()=>new Date().getFullYear();
/** DEC-05: the business date defaults to today in Europe/Moscow, not the UTC date. */
const moscowToday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const key=()=>crypto.randomUUID();

/** The request never reached an answer: the server may or may not have applied it. */
class FinNetworkError extends Error {}
class FinHttpError extends Error { constructor(readonly status:number,readonly code:string|undefined,message:string){super(message)} }
async function api(path:string,method='GET',body?:unknown):Promise<any>{
 const token=readSessionToken();
 let response:Response;
 try{response=await fetch('/api/fin-sdo-1/'+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
 catch{throw new FinNetworkError('network')}
 const contentType=response.headers.get('content-type')??'',text=await response.text();
 if(!response.ok){const message=httpErrorMessage(response.status,contentType,text);throw new FinHttpError(response.status,/^FIN_[A-Z0-9_]+$/.test(message)?message:undefined,message);}
 try{return JSON.parse(text)}catch{throw new FinHttpError(response.status,undefined,'Неверный ответ сервера')}
}
/** FIN API contract codes (§7.2) in user language; the code is kept visible for support/traceability. */
const FIN_MESSAGES:Record<string,string>={
 FIN_QUARTER_TOTAL_BELOW_MIN:'Общий квартальный план должен быть не меньше 10,00 млн ₽; версия не записана.',
 FIN_QUARTER_BOOK_VERSION_CONFLICT:'Действующий план квартала изменён другим пользователем; ваша версия не записана.',
 FIN_QUARTER_BOOK_ALREADY_EXISTS:'Квартальный план уже записан другим пользователем; ваша версия не записана.',
 FIN_BUFFER_VERSION_CONFLICT:'Технический ввод создан для другой версии плана, а план с тех пор изменён; ваша версия не записана.',
 FIN_BUFFER_CAS_CONFLICT:'Технический ввод изменён в другом окне или вкладке; ваши изменения не сохранены.',
 FIN_BUFFER_QUARTER_MISMATCH:'Технический ввод относится к другому кварталу или версии плана; изменения не сохранены.',
 FIN_IDEMPOTENCY_PAYLOAD_MISMATCH:'Повтор команды с изменёнными данными отклонён; ничего не записано.',
 FIN_CORRECTION_REASON_REQUIRED:'Для корректировки действующего плана укажите причину; версия не записана.',
 FIN_EXISTING_LINE_OMITTED:'В корректировке должны остаться все строки действующего плана (сумму можно сделать 0,00); версия не записана.',
 FIN_NO_CHANGES:'Изменений относительно действующей версии нет; новая версия не записана.',
 FIN_ACCESS_DENIED:'Нет прав на это действие в финансовом плане; ничего не записано.',
 FIN_COMMAND_CONFLICT:'Данные изменены параллельно; ничего не записано.',
 FIN_COMMAND_INVALID:'Данные не приняты сервером; ничего не записано.',
};
/** Codes after which the effective head must be re-read and the user asked to reconcile (§6.2, no silent rebase). */
const HEAD_CONFLICTS=['FIN_QUARTER_BOOK_VERSION_CONFLICT','FIN_QUARTER_BOOK_ALREADY_EXISTS','FIN_BUFFER_VERSION_CONFLICT','FIN_COMMAND_CONFLICT'];
function describe(e:unknown):string{
 if(e instanceof FinNetworkError)return 'Нет ответа сервера: результат неизвестен. Повторите действие — повтор той же команды безопасен и не создаст вторую версию.';
 if(e instanceof FinHttpError){
   if(e.code&&FIN_MESSAGES[e.code])return FIN_MESSAGES[e.code]+' ('+e.code+')';
   if(e.status===401)return 'Сессия истекла; войдите снова. Ничего не записано.';
   if(e.status===403||e.status===404)return 'Нет прав на это действие или данные недоступны; ничего не записано.';
   if(e.status===409)return 'Данные изменены параллельно; ничего не записано (HTTP 409).';
   if(e.status===400||e.status===422)return 'Данные не приняты сервером; ничего не записано (HTTP '+e.status+').';
   return 'Ошибка сервера (HTTP '+e.status+'); план не записан.';
 }
 return e instanceof Error&&e.message?e.message:'Ошибка; ничего не записано.';
}
const newLine=():Line=>({key:key(),partyKind:'UNALLOCATED',contractKind:'NOT_SPECIFIED',amountMln:'0.00'});
const formInput={padding:8,borderRadius:4,border:'1px solid #b7bdc7',maxWidth:'100%'};
const toLine=(r:any):Line=>({
 key:key(),coreObjectId:r.core_object_id??undefined,historicalSubjectId:r.historical_subject_id??undefined,
 partyKind:r.party_kind,partyId:r.core_contractor_id??r.historical_party_id??undefined,
 contractKind:r.contract_kind,contractNumber:r.contract_number??undefined,
 amountMln:rubToCanonicalMln(r.amount_rub)??''
});

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
 // The book version the saved buffer was created against; commit must send exactly it.
 const [bufferBookVersion,setBufferBookVersion]=useState(0);
 const [dirty,setDirty]=useState(false);
 const [savedBuffers,setSavedBuffers]=useState<Array<{id:string;version:number;total_rub:string;line_count:number}>>([]);
 const [effectiveOn,setEffectiveOn]=useState(moscowToday());
 const [reason,setReason]=useState('');
 const [historicalName,setHistoricalName]=useState('');
 const [partyName,setPartyName]=useState('');
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState('');
 const [error,setError]=useState('');
 const [showHistory,setShowHistory]=useState(false);
 // FIN1-16: a commit whose answer was lost is retried with the SAME idempotency key while its payload is unchanged.
 const pendingCommit=useRef<{fingerprint:string;key:string}|null>(null);

 const refresh=useCallback(async()=>{
   const [directory,quarterBook,buffers]=await Promise.all([api('subjects'),api('quarter?year='+year+'&quarter='+quarter),editable?api('buffers?year='+year+'&quarter='+quarter):Promise.resolve([])]);
   setSavedBuffers(buffers);
   setDir(directory);setBook(quarterBook);
   setLines((quarterBook.lines??[]).map(toLine));
   setBufferId('');setBufferVersion(0);setDirty(false);setReason('');
 },[year,quarter,editable]);
 useEffect(()=>{if(!allowed)return;let active=true;setError('');refresh().catch(e=>{if(active)setError(describe(e))});return()=>{active=false}},[allowed,refresh]);
 if(!allowed)return <RouteForbidden label="Финансовые планы недоступны для вашей роли." />;
 const patch=(id:string,p:Partial<Line>)=>{setDirty(true);setLines(old=>old.map(x=>x.key===id?{...x,...p}:x));};
 /** Keeps the user's input on screen, re-reads only the effective head and detaches the stale buffer. */
 async function reconcileHead(){
   const head:Book=await api('quarter?year='+year+'&quarter='+quarter);
   setBook(head);setBufferId('');setBufferVersion(0);setDirty(true);
   return ' Действующая версия перечитана: '+(head.status==='ACTIVE'?'версия '+head.bookVersion+', текущий '+formatRubAsMln(head.current)+' млн ₽':'план не записан')+'. Ваш ввод остался на экране и не записан — сверьте строки с действующим планом и сохраните ввод заново.';
 }
 async function task(fn:()=>Promise<string|void>,ok:string){
   setBusy(true);setError('');setMessage('');
   try{const note=await fn();setMessage(note||ok)}
   catch(e){
     let text=describe(e);
     try{
       if(e instanceof FinHttpError&&e.code&&HEAD_CONFLICTS.includes(e.code))text+=await reconcileHead();
       else if(e instanceof FinHttpError&&e.code==='FIN_BUFFER_CAS_CONFLICT'){
         setSavedBuffers(await api('buffers?year='+year+'&quarter='+quarter));setBufferId('');setBufferVersion(0);setDirty(true);
         text+=' Восстановите актуальный ввод из списка или сохраните этот как новый.';
       }
     }catch(again){text+=' Не удалось перечитать план: '+describe(again)}
     setError(text);
   }
   finally{setBusy(false)}
 }
 const payloadLines=()=>lines.map(({key:_,...r})=>({...r,amountMln:canonicalMln(r.amountMln)??r.amountMln}));
 const saveBuffer=()=>task(async()=>{
   if(bufferId){
     const s=await api('buffers/'+encodeURIComponent(bufferId),'PATCH',{year,quarter,expectedBookVersion:bufferBookVersion,lines:payloadLines(),expectedBufferVersion:bufferVersion});
     setBufferVersion(s.version);
   }else{
     const expectedBookVersion=book?.bookVersion??0;
     const s=await api('buffers','POST',{year,quarter,expectedBookVersion,lines:payloadLines()});
     setBufferId(s.bufferId);setBufferVersion(s.version);setBufferBookVersion(expectedBookVersion);
   }
   setDirty(false);
   setSavedBuffers(await api('buffers?year='+year+'&quarter='+quarter));
 },'Технический ввод сохранён; в действующем плане не учтено.');
 const loadBuffer=(id:string)=>task(async()=>{
   const v=await api('buffers/'+encodeURIComponent(id));
   if(Number(v.buffer.plan_year)!==year||Number(v.buffer.plan_quarter)!==quarter)
      throw Error('Технический буфер другого квартала');
   setLines((v.lines??[]).map(toLine));
   const createdFor=Number(v.buffer.expected_book_version),head=book?.bookVersion??0;
   if(createdFor!==head){
     setBufferId('');setBufferVersion(0);setDirty(true);
     return 'Технический ввод восстановлен, но он создан для версии плана '+createdFor+', а действующая — '+head+': сверьте строки и сохраните ввод заново.';
   }
   setBufferId(id);setBufferVersion(Number(v.buffer.version));setBufferBookVersion(createdFor);setDirty(false);
 },'Технический ввод восстановлен.');
 const commit=()=>task(async()=>{
   if(!bufferId)throw Error('Сначала сохраните технический ввод');
   const command={year,quarter,bufferId,expectedBufferVersion:bufferVersion,expectedBookVersion:bufferBookVersion,effectiveOn,reason:reason.trim()||undefined};
   const fingerprint=JSON.stringify(command);
   const idempotencyKey=pendingCommit.current?.fingerprint===fingerprint?pendingCommit.current.key:key();
   pendingCommit.current={fingerprint,key:idempotencyKey};
   try{await api('commit','POST',{...command,idempotencyKey});}
   catch(e){
     // Only an unknown outcome keeps the key for a safe replay; a definite rejection never reuses it.
     if(!(e instanceof FinNetworkError||(e instanceof FinHttpError&&e.status>=500)))pendingCommit.current=null;
     throw e;
   }
   pendingCommit.current=null;
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
 const total=sumMlnHundredths(lines.map(x=>x.amountMln));
 const belowMin=total===null||total<MIN_QUARTER_HUNDREDTHS;
 const active=book?.status==='ACTIVE';
 const inputIssues=lines.flatMap((x,i)=>[
   ...(x.coreObjectId||x.historicalSubjectId?[]:['Строка '+(i+1)+': выберите объект.']),
   ...(canonicalMln(x.amountMln)===null?['Строка '+(i+1)+': сумма в млн ₽ — неотрицательное число, ровно два знака после запятой (например 6,00).']:[]),
 ]).join(' ');
 const commitBlocked=!bufferId?'Сначала сохраните незавершённый ввод.':dirty?'Есть несохранённые изменения — сохраните ввод.':
   inputIssues?'Исправьте строки ввода.':belowMin?'Общий итог ниже 10,00 млн ₽.':active&&!reason.trim()?'Для корректировки укажите причину.':'';
 const alertText=[error,inputIssues].filter(Boolean).join(' ');
 return <AppShell sidebar={<AppSidebar/>}>
   <section style={{padding:'12px 0',maxWidth:1250}}>
     <h1 className={typeClass('heading-page')}>СДО · План закрытия</h1>
     <p>Квартальное финансовое планирование · RUB · ввод в млн ₽. Финансовый факт заказчика сюда не включён.</p>
     <div style={{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}}>
       <label>Год <input aria-label="Год плана" style={{...formInput,width:90}} type="number" min="2000" max="2200" value={year} onChange={e=>setYear(Number(e.target.value))}/></label>
       <label>Квартал <select aria-label="Квартал плана" style={formInput} value={quarter} onChange={e=>setQuarter(Number(e.target.value))}>{[1,2,3,4].map(n=><option key={n} value={n}>Q{n}</option>)}</select></label>
       <button type="button" onClick={()=>{setError('');refresh().catch(e=>setError(describe(e)))}}>Обновить</button>
     </div>
     {alertText&&<p role="alert" style={{color:'#b91c1c'}}>{alertText}</p>}
     {message&&<p role="status">{message}</p>}
     <h2>Действующий квартальный план</h2>
     {book?.status==='NO_PLAN'?<p>План ещё не записан (NO_PLAN). Нулевая строка не является действующим планом.</p>:
      book&&<p data-testid="fin-book-summary">Первоначальный: <strong>{formatRubAsMln(book.original)} млн ₽</strong> · Текущий: <strong>{formatRubAsMln(book.current)} млн ₽</strong> · версия {book.bookVersion??'—'}</p>}
     {active&&dir&&<section aria-label="Действующий финансовый план" style={{overflowX:'auto'}}>
       <h2>План по объектам, исполнителям и договорам</h2>
       <table aria-label="Действующий квартальный план по строкам" style={{width:'100%',borderCollapse:'collapse'}}>
         <thead><tr><th>Объект</th><th>Исполнитель</th><th>Договор</th><th>Первоначально, млн ₽</th><th>Текущий, млн ₽</th></tr></thead>
         <tbody>{(book.lines??[]).map((r:any)=><tr key={r.id}>
           <td>{r.origin==='CORE'
                ?dir.core.find(x=>x.id===r.core_object_id)?.name??r.core_object_id
                :dir.historical.find(x=>x.id===r.historical_subject_id)?.name??r.historical_subject_id}</td>
           <td>{r.party_kind==='UNALLOCATED'?'Не распределено':r.party_kind==='CORE_CONTRACTOR'
                ?dir.contractors.find(x=>x.id===r.core_contractor_id)?.name??r.core_contractor_id
                :dir.historicalParties.find(x=>x.id===r.historical_party_id)?.name??r.historical_party_id}</td>
           <td>{r.contract_kind==='NOT_SPECIFIED'?'Не указан':r.contract_number}</td>
           <td>{formatRubAsMln(r.original_amount_rub)}</td>
           <td>{formatRubAsMln(r.amount_rub)}</td>
         </tr>)}</tbody>
       </table>
       <p style={{fontSize:13}}>«—» в первоначальном плане — строка добавлена позже первой версии. Отчётные строки доступны только ролям с FIN_SDO_PLAN_READ; технические буферы здесь не учитываются.</p>
     </section>}
     {editable&&dir&&<>
       <h2>Незавершённый ввод — в плане не учтено</h2>
       {savedBuffers.length>0&&<section aria-label="Сохранённые технические буферы"><p>Ваши сохранённые черновые вводы этого квартала:</p>{savedBuffers.slice(0,10).map(v=><button type="button" key={v.id} disabled={busy} onClick={()=>loadBuffer(v.id)} style={{marginRight:6,marginBottom:6}}>Продолжить {v.line_count} стр. / {formatRubAsMln(v.total_rub)} млн ₽</button>)}</section>}
       <p>Строки заполняются постепенно; действующая версия записывается только целиком, если общий итог ≥ 10,00 млн ₽. Сумма вводится в млн ₽ с двумя знаками (6,00 или 6.00).</p>
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
         <td><input aria-label="Сумма млн ₽" aria-invalid={canonicalMln(line.amountMln)===null} style={{...formInput,width:120}} inputMode="decimal" value={line.amountMln} onChange={e=>patch(line.key,{amountMln:e.target.value})}/></td>
         <td><button type="button" onClick={()=>{setDirty(true);setLines(x=>x.filter(v=>v.key!==line.key));}}>Удалить из ввода</button></td>
       </tr>)}</tbody></table></div>
       <button type="button" disabled={busy} onClick={()=>{setDirty(true);setLines(x=>[...x,newLine()]);}}>Добавить строку</button>
       <p>Общий итог ввода: <strong data-testid="fin-input-total">{total===null?'—':formatMlnHundredths(total)+' млн ₽'}</strong>{' '}
         {total!==null&&belowMin?'— ниже порога 10,00 млн ₽, не хватает '+formatMlnHundredths(MIN_QUARTER_HUNDREDTHS-total)+' млн ₽':''}</p>
       <p><button type="button" disabled={busy||!lines.length||!!inputIssues} onClick={saveBuffer}>Сохранить незавершённый ввод</button>
       {' '}<small>Буфер: {bufferId?bufferId+' (v'+bufferVersion+')':'ещё не сохранён'}{dirty?' · Есть несохранённые изменения':''}</small></p>
       <label>Дата действия <input type="date" value={effectiveOn} onChange={e=>setEffectiveOn(e.target.value)}/></label>
       {active&&<>{' '}<label>Причина <input aria-label="Причина корректировки" style={formInput} value={reason} onChange={e=>setReason(e.target.value)} placeholder="Обязательна для корректировки"/></label></>}
       <p><button type="button" disabled={busy||!!commitBlocked} onClick={commit}>Записать квартальный план</button>
       {commitBlocked&&<>{' '}<small data-testid="fin-commit-blocked">{commitBlocked}</small></>}</p>
       <h2>Исторические данные</h2>
       <label>Наименование объекта <input style={formInput} value={historicalName} onChange={e=>setHistoricalName(e.target.value)}/></label>
       {' '}<button type="button" disabled={busy||!historicalName.trim()} onClick={historical}>Создать исторический объект</button>
       <p><label>Исторический исполнитель <input style={formInput} value={partyName} onChange={e=>setPartyName(e.target.value)}/></label>
       {' '}<button type="button" disabled={busy||!partyName.trim()} onClick={historicalParty}>Добавить исполнителя</button></p>
     </>}
     {book?.history?.length?<>
       <h2><button type="button" onClick={()=>setShowHistory(!showHistory)}>История изменений {showHistory?'▴':'▾'}</button></h2>
       {showHistory&&<table aria-label="История изменений квартального плана"><thead><tr><th>Версия</th><th>Было, млн ₽</th><th>Стало, млн ₽</th><th>Итог, RUB</th><th>Причина</th><th>Автор</th><th>Дата действия</th><th>Зарегистрировано (МСК)</th></tr></thead>
        <tbody>{book.history.map(h=><tr key={h.revision_no}><td>{h.revision_no}</td><td>{formatRubAsMln(h.previous_total_rub)}</td><td>{formatRubAsMln(h.new_total_rub)}</td><td>{formatRubExact(h.new_total_rub)}</td><td>{h.reason??(h.revision_no===1?'Первоначальный план':'—')}</td><td>{h.actor_id}</td><td>{h.effective_on}</td><td>{new Date(h.recorded_at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})}</td></tr>)}</tbody></table>}
     </>:null}
   </section>
 </AppShell>;
}
