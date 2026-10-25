import { test, expect, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/**
 * FIN-SDO-1 frontend/browser smoke. Real application and Design System
 * render in Chromium; FIN endpoints and session are INTERCEPTED in-memory.
 * This is NOT a PostgreSQL, backend, security or LIVE end-to-end test.
 * See native protected S-01 CI for trusted DB invariants.
 */
const CORE = '00000000-0000-4000-8000-000000000101';
const HIST = '00000000-0000-4000-8000-000000000102';
const PARTY = '00000000-0000-4000-8000-000000000103';
const actor = (role: string) => ({ id: 'u-'+role, tenantId: 'tenant-fin-browser', name: 'Тест '+role, role });
type DraftLine = {
 coreObjectId?: string; historicalSubjectId?: string;
 partyKind: 'UNALLOCATED' | 'HISTORICAL_PARTY' | 'CORE_CONTRACTOR';
 partyId?: string; contractKind: 'NOT_SPECIFIED' | 'KNOWN';
 contractNumber?: string; amountMln: string;
};
type Draft = { id: string; year: number; quarter: number; version: number; expectedBookVersion: number; lines: DraftLine[] };
type FinState = {
 calls: Array<{method: string; path: string; body: any}>;
 drafts: Draft[];
 original: string | null;
 current: string | null;
 version: number;
 history: any[];
 lines: any[];
};
function rubOf(lines: DraftLine[]): string {
 const total=lines.reduce((sum,line)=>{
  if(!/^(0|[1-9]\d*)\.\d{2}$/.test(line.amountMln))throw Error('Invalid mock money');
  const [whole,frac]=line.amountMln.split('.');
  return sum+(BigInt(whole)*100n+BigInt(frac))*10000n;
 },0n);
 return total.toString()+'.00';
}
function projection(line: DraftLine, original: boolean, i: number) {
 return {
  id: 'line-'+i, origin: line.coreObjectId?'CORE':'HISTORICAL',
  core_object_id: line.coreObjectId??null,
  historical_subject_id: line.historicalSubjectId??null,
  party_kind: line.partyKind,
  core_contractor_id: line.partyKind==='CORE_CONTRACTOR'?line.partyId:null,
  historical_party_id: line.partyKind==='HISTORICAL_PARTY'?line.partyId:null,
  contract_kind: line.contractKind, contract_number: line.contractNumber??null,
  amount_rub: rubOf([line]),original_amount_rub: original?rubOf([line]):null
 };
}
function fixture(initialActive=false): FinState {
 const values: DraftLine[]=[
   {coreObjectId:CORE,partyKind:'UNALLOCATED',contractKind:'NOT_SPECIFIED',amountMln:'6.00'},
   {historicalSubjectId:HIST,partyKind:'HISTORICAL_PARTY',partyId:PARTY,
    contractKind:'KNOWN',contractNumber:'ДС-1',amountMln:'4.00'}
 ];
 return {
  calls:[],drafts:[],original:initialActive?'10000000.00':null,
  current:initialActive?'10000000.00':null,version:initialActive?1:0,
  history:initialActive?[{revision_no:1,new_total_rub:'10000000.00',previous_total_rub:null,
   reason:null,actor_id:'u-SDO',effective_on:'2026-10-25',recorded_at:'2026-10-25T12:00:00Z'}]:[],
  lines:initialActive?values.map((x,i)=>projection(x,true,i)):[],
 };
}
async function harness(page:Page,role:string,state:FinState){
 await page.addInitScript(()=>window.sessionStorage.setItem('session','fin-browser-valid-token'));
 await page.route((u)=>u.pathname.startsWith('/api/'),async(route:Route)=>{
  const req=route.request(),u=new URL(req.url()),p=u.pathname,m=req.method();
  const body=['POST','PATCH'].includes(m)?req.postDataJSON():null;
  state.calls.push({method:m,path:p,body});
  let code=200;let payload:any={};
  if(p==='/api/me')payload=actor(role);
  else if(p==='/api/snapshot')payload={objects:[],works:[],contractors:[],dependencies:[],inspections:[]};
  else if(p==='/api/health')payload={status:'ok',authMode:'bitrix',databaseMode:'postgres'};
  else if(p==='/api/fin-sdo-1/subjects')payload={
   core:[{id:CORE,name:'Объект CORE без СМР'}],
   historical:[{id:HIST,name:'Исторический объект'}],
   contractors:[],historicalParties:[{id:PARTY,name:'Исторический субподрядчик'}]
  };
  else if(p==='/api/fin-sdo-1/quarter')payload=state.original===null
    ?{status:'NO_PLAN',year:2026,quarter:1,history:[],lines:[],original:null,current:null}
    :{status:'ACTIVE',bookVersion:state.version,year:2026,quarter:1,
       original:state.original,current:state.current,history:state.history,lines:state.lines};
  else if(p==='/api/fin-sdo-1/buffers'&&m==='GET')payload=state.drafts.map(x=>({
     id:x.id,version:x.version,total_rub:rubOf(x.lines),line_count:x.lines.length
  }));
  else if(p==='/api/fin-sdo-1/buffers'&&m==='POST'){
   const d:Draft={id:randomUUID(),year:body.year,quarter:body.quarter,version:1,
     expectedBookVersion:body.expectedBookVersion,lines:body.lines};
   state.drafts.push(d);
   payload={bufferId:d.id,version:1,uncommitted:true,totalRub:rubOf(d.lines)};
  }
  else if(/^\/api\/fin-sdo-1\/buffers\/[^/]+$/.test(p)){
   const id=p.split('/').at(-1)!;
   const d=state.drafts.find(x=>x.id===id);
   if(!d){code=403;payload={message:'FIN_ACCESS_DENIED'};}
   else if(m==='GET')payload={buffer:{id:d.id,version:d.version,plan_year:d.year,
      plan_quarter:d.quarter,expected_book_version:d.expectedBookVersion},
      lines:d.lines.map((x,i)=>({id:'draft-'+i,...projection(x,false,i)}))};
   else if(m==='PATCH'){
    if(body.expectedBufferVersion!==d.version){code=409;payload={message:'FIN_COMMAND_CONFLICT'};}
    else{d.lines=body.lines;d.version++;payload={bufferId:id,version:d.version,uncommitted:true,totalRub:rubOf(d.lines)};}
   }
  }
  else if(p==='/api/fin-sdo-1/commit'&&m==='POST'){
   const d=state.drafts.find(x=>x.id===body.bufferId);
   if(!d||body.expectedBookVersion!==state.version){code=409;payload={message:'FIN_COMMAND_CONFLICT'};}
   else if(BigInt(rubOf(d.lines).split('.')[0])<10000000n){code=422;payload={message:'FIN_QUARTER_TOTAL_BELOW_MIN'};}
   else if(state.version>0&&!body.reason?.trim()){code=422;payload={message:'FIN_CORRECTION_REASON_REQUIRED'};}
   else {
     const total=rubOf(d.lines);
     state.original??=total;state.current=total;state.version++;
     state.lines=d.lines.map((x,i)=>projection(x,state.version===1,i));
     state.history.push({revision_no:state.version,new_total_rub:total,
       reason:body.reason??null,actor_id:'u-'+role,effective_on:body.effectiveOn,
       recorded_at:'2026-10-26T11:00:00Z'});
     payload={bookId:randomUUID(),bookVersion:state.version,revisionNo:state.version,totalRub:total};
   }
  }
  else if(p==='/api/fin-sdo-1/historical-subjects'&&m==='POST')
   payload={id:randomUUID(),name:body.name,origin:'HISTORICAL'};
  else if(p==='/api/fin-sdo-1/historical-parties'&&m==='POST')
   payload={id:randomUUID(),name:body.name};
  else{code=599;payload={message:'Unmocked '+m+' '+p};}
  await route.fulfill({status:code,contentType:'application/json',body:JSON.stringify(payload)});
 });
}

test('FIN browser: SDO saves 6m draft, resumes to 10m, then commits original; never equates draft with book',async({page})=>{
 const state=fixture();
 await harness(page,'SDO',state);
 await page.goto('/app.html/sdo/plan');
 await expect(page.getByRole('heading',{level:1,name:'СДО · План закрытия'})).toBeVisible();
 await expect(page.getByText('План ещё не записан (NO_PLAN).',{exact:false})).toBeVisible();
 await page.getByRole('button',{name:'Добавить строку'}).click();
 await page.getByLabel('Объект').first().selectOption('c:'+CORE);
 await page.getByLabel('Сумма млн ₽').first().fill('6.00');
 await expect(page.getByText('ниже порога 10,00 млн ₽',{exact:false})).toBeVisible();
 await expect(page.getByRole('button',{name:'Записать квартальный план'})).toBeDisabled();
 await page.getByRole('button',{name:'Сохранить незавершённый ввод'}).click();
 await expect(page.getByRole('status')).toContainText('Технический ввод сохранён');
 expect(state.original).toBeNull();
 await page.getByRole('button',{name:'Добавить строку'}).click();
 await page.getByLabel('Объект').nth(1).selectOption('h:'+HIST);
 await page.getByLabel('Сумма млн ₽').nth(1).fill('4.00');
 await expect(page.getByText('Общий итог ввода:')).toContainText('10.00 млн ₽');
 await page.getByRole('button',{name:'Сохранить незавершённый ввод'}).click();
 expect(state.drafts[0].lines).toHaveLength(2);
 expect(state.original).toBeNull();
 await expect(page.getByRole('button',{name:'Записать квартальный план'})).toBeEnabled();
 await page.getByRole('button',{name:'Записать квартальный план'}).click();
 await expect(page.getByText('Новая действующая версия квартального плана записана.')).toBeVisible();
 await expect(page.getByText('Первоначальный:')).toContainText('10.00 млн ₽');
 expect(state.original).toBe('10000000.00');
 expect(state.history).toHaveLength(1);
 const writes=state.calls.filter(x=>x.path==='/api/fin-sdo-1/commit');
 expect(writes).toHaveLength(1);
 expect(writes[0].body).toMatchObject({expectedBookVersion:0,bufferId:state.drafts[0].id});
 await expect(page.getByRole('heading',{name:'План по объектам, исполнителям и договорам'})).toBeVisible();
});

test('FIN browser: 9.99m is a private draft; original commit disabled; no approval/customer fact controls',async({page})=>{
 const state=fixture();
 await harness(page,'SDO',state);
 await page.goto('/app.html/sdo/plan');
 await expect(page.getByRole('heading',{name:'СДО · План закрытия'})).toBeVisible();
 await page.getByRole('button',{name:'Добавить строку'}).click();
 await page.getByLabel('Объект').first().selectOption('c:'+CORE);
 await page.getByLabel('Сумма млн ₽').first().fill('9.99');
 await page.getByRole('button',{name:'Сохранить незавершённый ввод'}).click();
 await expect(page.getByRole('button',{name:'Записать квартальный план'})).toBeDisabled();
 expect(state.original).toBeNull();
 expect(state.calls.filter(x=>x.path==='/api/fin-sdo-1/commit')).toHaveLength(0);
 await expect(page.getByText('План ещё не записан (NO_PLAN).',{exact:false})).toBeVisible();
 await expect(page.getByText('Финансовый факт заказчика сюда не включён.')).toBeVisible();
 await expect(page.getByRole('button',{name:/Согласовать с заказчиком|AGREED|Финансовый факт|Экспорт XLSX/})).toHaveCount(0);
});

test('FIN browser: GENERAL_DIRECTOR sees original/history but no editable controls; PTO denied',async({browser})=>{
 const director=await browser.newPage();
 try{
  const state=fixture(true);
  await harness(director,'GENERAL_DIRECTOR',state);
  await director.goto('/app.html/sdo/plan');
  await expect(director.getByRole('heading',{name:'СДО · План закрытия'})).toBeVisible();
  await expect(director.getByText('Первоначальный:')).toContainText('10.00 млн ₽');
  await expect(director.getByRole('button',{name:'Добавить строку'})).toHaveCount(0);
  await expect(director.getByRole('button',{name:'Записать квартальный план'})).toHaveCount(0);
  await director.getByRole('button',{name:/История изменений/}).click();
  await expect(director.getByRole('table').last()).toContainText('10000000.00');
  expect(state.calls.some(x=>x.path==='/api/fin-sdo-1/buffers')).toBe(false);
  expect(state.calls.filter(x=>x.method==='POST'&&x.path.startsWith('/api/fin-sdo-1/'))).toHaveLength(0);
 }finally{await director.close();}
 const denied=await browser.newPage();
 try{
  const state=fixture(true);
  await harness(denied,'PTO',state);
  await denied.goto('/app.html/sdo/plan');
  await expect(denied.getByText('Финансовые планы недоступны для вашей роли.')).toBeVisible();
  expect(state.calls.filter(x=>x.path.startsWith('/api/fin-sdo-1/'))).toHaveLength(0);
 }finally{await denied.close();}
});
