import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { listFinishSystems, listFinishWorkTypes, upsertFinishSystem } from '../apps/frontend/src/data/finishSystemApi';
import { StageProvenance, VersionExclusions } from '../apps/frontend/src/screens/FinishSystems/Provenance';
import { localSystemPayload } from '../apps/frontend/src/screens/FinishSystems/createSystemPayload';
import type { FinishSystemStage } from '../apps/frontend/src/types/finishSystem';

const page = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('finish systems pagination follows cursor and returns all pages', async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    return calls.length === 1
      ? page({ items: [{ id: 'a', code: 'TYPE-1' }], nextCursor: 'next' })
      : page({ items: [{ id: 'b', code: 'TYPE-2' }], nextCursor: null });
  }) as typeof fetch;
  try { assert.deepEqual((await listFinishSystems('object-1')).map((x) => x.id), ['a', 'b']); assert.equal(calls.length, 2); }
  finally { globalThis.fetch = original; }
});

test('finish systems missing nextCursor fails closed', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => page({ items: [{ id: 'a' }] })) as typeof fetch;
  try { await assert.rejects(() => listFinishSystems('object-1')); }
  finally { globalThis.fetch = original; }
});

test('finish systems render stage provenance ids and every individual exclusion', () => {
  const stage = { sourceTemplateVersionId: 'tv-1', sourceTemplateStageId: 'ts-9' } as FinishSystemStage;
  const stageHtml = renderToStaticMarkup(React.createElement(StageProvenance, { stage }));
  assert.match(stageHtml, /data-field="sourceTemplateVersionId">tv-1</);
  assert.match(stageHtml, /data-field="sourceTemplateStageId">ts-9</);
  const nullStage = { sourceTemplateVersionId: null, sourceTemplateStageId: null } as FinishSystemStage;
  assert.equal((renderToStaticMarkup(React.createElement(StageProvenance, { stage: nullStage })).match(/>—</g) ?? []).length, 2);

  const exclusions = [
    { templateStageId: 'ts-1', sourceTemplateVersionId: 'tv-1', reason: 'Не применимо к объекту' },
    { templateStageId: 'ts-2', sourceTemplateVersionId: 'tv-2', reason: 'Заменено локальным этапом' },
  ];
  const html = renderToStaticMarkup(React.createElement(VersionExclusions, { exclusions }));
  assert.equal((html.match(/data-testid="exclusion"/g) ?? []).length, 2);
  for (const x of exclusions) {
    assert.ok(html.includes(`data-field="templateStageId">${x.templateStageId}<`));
    assert.ok(html.includes(`data-field="sourceTemplateVersionId">${x.sourceTemplateVersionId}<`));
    assert.ok(html.includes(`data-field="reason">${x.reason}<`));
  }
  assert.equal(renderToStaticMarkup(React.createElement(VersionExclusions, { exclusions: [] })), '');
});

test('finish systems error preserves unavailable status', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => page({ message: 'forbidden' }, 403)) as typeof fetch;
  try { await assert.rejects(() => listFinishSystems('object-1'), (error: any) => error.status === 403); }
  finally { globalThis.fetch = original; }
});

test('selected-object WorkTypes follow every page and fail closed for an incomplete catalogue', async () => {
  const original=globalThis.fetch;const calls:string[]=[];
  globalThis.fetch=(async(input:RequestInfo|URL)=>{calls.push(String(input));return page(calls.length===1?
    {items:[{id:'wt-1',name:'Штукатурка',unit:'м²',scope:'CORPORATE',isActive:true}],nextCursor:'second'}:
    {items:[{id:'wt-2',name:'Покраска',unit:'м²',scope:'OBJECT',isActive:true}],nextCursor:null})}) as typeof fetch;
  try{
    assert.deepEqual((await listFinishWorkTypes('object /1')).map(x=>x.id),['wt-1','wt-2']);
    assert.ok(calls.every(x=>x.includes('/objects/object%20%2F1/work-types?')));
    assert.match(calls[1]!,/cursor=second/);
  }finally{globalThis.fetch=original}
  globalThis.fetch=(async()=>page({items:[]})) as typeof fetch;
  try{await assert.rejects(()=>listFinishWorkTypes('object-1'))}finally{globalThis.fetch=original}
});

test('local S3 form builds contract payload with WorkType unit and publishes with one idempotency key',async()=>{
  const type={id:'wt-1',name:'Штукатурка',scope:'CORPORATE' as const,unit:'м²',isActive:true};
  const draft=[{key:'row-1',occurrenceKey:'FINISH-1',workTypeId:type.id,required:true,measureScope:'LOCAL' as const,proposedHoldHours:'2,5'}];
  const payload=localSystemPayload('','TYPE-1','Отделка',draft,[type]);
  assert.deepEqual(payload,{finishType:{code:'TYPE-1',name:'Отделка'},stages:[{occurrenceKey:'FINISH-1',position:1,workTypeId:'wt-1',required:true,measureScope:'LOCAL',measureUnit:'м²',proposedHoldHours:'2.5'}]});
  assert.deepEqual(localSystemPayload('system-1','','',draft,[type]),{finishTypeId:'system-1',stages:payload.stages});
  assert.throws(()=>localSystemPayload('','TYPE-1','Отделка',[{...draft[0]!,workTypeId:'other'}],[type]),/Выберите вид работы/);
  const original=globalThis.fetch;let request:RequestInit|undefined;let url='';
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{url=String(input);request=init;return page({affectedIds:['system-1'],version:'1'})}) as typeof fetch;
  try{await upsertFinishSystem('object /1',payload,'fixed-key')}
  finally{globalThis.fetch=original}
  assert.equal(url,'/api/v2/objects/object%20%2F1/finish-systems');assert.equal(request?.method,'POST');
  assert.equal((request?.headers as Record<string,string>)['Idempotency-Key'],'fixed-key');
  assert.deepEqual(JSON.parse(String(request?.body)),payload);
});
