import type { FinishSystemStageInput, FinishSystemUpsertPayload, FinishWorkType } from '../../types/finishSystem';

export interface StageDraft { key:string; occurrenceKey:string;workTypeId:string;required:boolean;measureScope:'MAIN'|'LOCAL';proposedHoldHours:string }

/** Build the no-template R05 command while taking the stage unit from the selected WorkType, never free text. */
export function localSystemPayload(finishTypeId:string,code:string,name:string,stages:readonly StageDraft[],types:readonly FinishWorkType[]):FinishSystemUpsertPayload{
  const inputs:FinishSystemStageInput[]=stages.map((s,i)=>{
    const workType=types.find(t=>t.id===s.workTypeId);
    if(!workType)throw Error(`Выберите вид работы для этапа ${i+1}.`);
    return {occurrenceKey:s.occurrenceKey.trim(),position:i+1,workTypeId:workType.id,required:s.required,measureScope:s.measureScope,measureUnit:workType.unit,
      ...(s.proposedHoldHours.trim()?{proposedHoldHours:s.proposedHoldHours.trim().replace(',','.')}:{} )};
  });
  if(inputs.length===0)throw Error('Добавьте хотя бы один этап.');
  if(!finishTypeId&&(!code.trim()||!name.trim()))throw Error('Укажите код и название системы.');
  return finishTypeId?{finishTypeId,stages:inputs}:{finishType:{code:code.trim(),name:name.trim()},stages:inputs};
}
