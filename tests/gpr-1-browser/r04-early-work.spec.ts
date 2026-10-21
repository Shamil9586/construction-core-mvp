import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// Runs on the existing disposable PGlite + real Core UI harness only.
for (const width of [1440,390]) test(`R04 Early Work W01 keeps unknown planning values and identity (${width}px)`,async({page,request})=>{
    const login=await request.post('http://127.0.0.1:3001/auth/mock',{data:{role:'PROJECT_MANAGER',key:'gpr-1-browser-key'}});
    const {token}=await login.json();const headers={Authorization:'Bearer '+token};
    const snapshot=await (await request.get('http://127.0.0.1:3001/snapshot',{headers})).json();
    const object=snapshot.objects.find((o:any)=>o.name==='Тест после удаления ролей');
    const dictionaries=await(await request.get('http://127.0.0.1:3001/dictionaries',{headers})).json();
    const create=await request.post('http://127.0.0.1:3001/works',{headers,data:{objectId:object.id,workTypeId:dictionaries.workTypes[0].id,name:'Ранняя работа '+width,unit:'м²',plannedQuantity:'100',idempotencyKey:randomUUID()}});
    expect(create.status()).toBe(201);const work=await create.json();
    await page.setViewportSize({width,height:1000});
    await page.addInitScript(value=>sessionStorage.setItem('session',value),token);
    const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`/app.html/object/${object.id}/work/${work.id}`);
    await expect(page.getByRole('heading',{level:1,name:work.name})).toBeVisible();
    await expect(page.getByText('Не назначен',{exact:true}).first()).toBeVisible();
    await expect(page.getByText('Не назначен подрядчик',{exact:true})).toBeVisible();
    await expect(page.getByText('Не назначен ответственный',{exact:true})).toBeVisible();
    await expect(page.getByText('График не утверждён',{exact:true}).first()).toBeVisible();
    expect(errors).toEqual([]);
    expect(new URL(page.url()).pathname).toContain(work.id);
});
