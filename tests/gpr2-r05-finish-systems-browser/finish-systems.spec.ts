import { test, expect, type Page } from '@playwright/test';
import { demoInspections, demoObjects, demoWorks } from '../../apps/frontend/src/screens/demo/fixtures';

const objectId=demoObjects[0]!.id;
const url=`/app.html/object/${objectId}/finish/systems`;
const snapshot={objects:demoObjects,works:demoWorks,contractors:[],dependencies:[],inspections:demoInspections};
const workType={id:'11111111-1111-4111-8111-111111111111',name:'Штукатурка',scope:'CORPORATE',unit:'м²',isActive:true};
const pm={id:'u-pm',tenantId:'t-1',name:'Руководитель проекта',role:'PROJECT_MANAGER'};

async function setup(page:Page,role='PROJECT_MANAGER'){
  const calls:{method:string;path:string;headers:Record<string,string>;body:string|null}[]=[];
  let systems:unknown[]=[];
  let postStatus=200;
  await page.addInitScript(()=>window.sessionStorage.setItem('session','test-token'));
  await page.route(u=>u.pathname.startsWith('/api/'),async route=>{
    const request=route.request(),u=new URL(request.url());
    calls.push({method:request.method(),path:u.pathname,headers:request.headers(),body:request.postData()});
    let status=200,body:unknown;
    if(u.pathname==='/api/me')body={...pm,role};
    else if(u.pathname==='/api/snapshot')body=snapshot;
    else if(u.pathname==='/api/health')body={status:'ok',authMode:'mock',databaseMode:'postgres'};
    else if(u.pathname===`/api/v2/objects/${objectId}/work-types`&&request.method()==='GET')body={items:[workType],nextCursor:null};
    else if(u.pathname===`/api/v2/objects/${objectId}/finish-systems`&&request.method()==='GET')body={items:systems,nextCursor:null};
    else if(u.pathname===`/api/v2/objects/${objectId}/finish-systems`&&request.method()==='POST'){
      status=postStatus;
      if(status===200){const p=JSON.parse(request.postData()??'{}');systems=[{id:'system-1',code:p.finishType?.code??'TYPE-1',name:p.finishType?.name??'Отделка',lifecycle:'ACTIVE',version:'1',versions:[],currentVersion:null}];body={resultIds:['system-1'],appliedVersions:{},warnings:[]}}
      else body={code:'VALIDATION_FAILED',message:'Проверьте данные',requestId:'req-1'};
    }else if(/^\/api\/objects\/[^/]+\/schedule$/.test(u.pathname)){status=403;body={message:'forbidden'}}
    else{status=599;body={message:`unexpected ${request.method()} ${u.pathname}`}}
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  return {calls,failNext:()=>{postStatus=422},succeed:()=>{postStatus=200}};
}

test('РП creates an object-local system with a stage, retries with the same key, then sees it',async({page})=>{
  const api=await setup(page);
  await page.goto(url);
  await expect(page.getByText('Систем отделки пока нет.')).toBeVisible();
  await expect(page.getByRole('heading',{name:'Новая опубликованная версия системы'})).toBeVisible();
  await page.getByLabel('Код',{exact:true}).fill('TYPE-1');
  await page.getByLabel('Название',{exact:true}).fill('Отделка');
  await page.getByLabel('Ключ этапа').fill('STAGE-1');
  await page.getByLabel('Вид работы').selectOption(workType.id);
  await page.getByLabel('Измерение').selectOption('LOCAL');
  api.failNext();
  await page.getByRole('button',{name:'Опубликовать версию'}).click();
  await expect(page.getByRole('alert')).toContainText('Проверьте данные');
  const posts=()=>api.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/finish-systems'));
  expect(posts()).toHaveLength(1);
  api.succeed();
  await page.getByRole('button',{name:'Опубликовать версию'}).click();
  await expect(page.getByRole('heading',{name:'Отделка'})).toBeVisible();
  expect(posts()).toHaveLength(2);
  expect(posts()[0]!.headers['idempotency-key']).toBe(posts()[1]!.headers['idempotency-key']);
  expect(JSON.parse(posts()[1]!.body!)).toEqual({finishType:{code:'TYPE-1',name:'Отделка'},stages:[{occurrenceKey:'STAGE-1',position:1,workTypeId:workType.id,required:true,measureScope:'LOCAL',measureUnit:'м²'}]});
  expect(api.calls.filter(c=>c.path.startsWith('/api/v2/')).every(c=>c.path.startsWith(`/api/v2/objects/${objectId}/`))).toBe(true);
});

test('non-PM direct URL has no R05 calls and no create form',async({page})=>{
  const api=await setup(page,'PTO');await page.goto(url);
  await expect(page.getByText('Раздел «Системы отделки» доступен руководителю проекта.')).toBeVisible();
  await expect(page.getByRole('heading',{name:'Новая опубликованная версия системы'})).toHaveCount(0);
  expect(api.calls.filter(c=>c.path.startsWith('/api/v2/'))).toEqual([]);
});
