import type { AreaScopeRead } from '../../types/areaScope';
import type { FinishSystemRead } from '../../types/finishSystem';
import type { GenerationSelection } from '../../types/finishGeneration';

const positive=/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
/** Build only the user's explicit selection; server owns coverage, quantity and producer rules. */
export function generationSelection(system:FinishSystemRead,areaIds:readonly string[],optional:readonly string[],quantities:Readonly<Record<string,string>>,grouping:GenerationSelection['grouping'],areas:readonly AreaScopeRead[]):GenerationSelection{
  const version=system.currentVersion;
  if(!version||system.lifecycle!=='ACTIVE')throw Error('Нужна действующая опубликованная версия системы.');
  const active=new Set(areas.filter(a=>a.lifecycle==='ACTIVE').map(a=>a.id));
  const selected=[...new Set(areaIds)];
  if(!selected.length||selected.length>500||selected.some(id=>!active.has(id)))throw Error('Выберите от 1 до 500 действующих зон объекта.');
  const stages=version.stages;
  const optionalKeys=new Set(stages.filter(s=>!s.required).map(s=>s.occurrenceKey));
  const included=[...new Set(optional)];
  if(included.some(key=>!optionalKeys.has(key)))throw Error('Выбран неизвестный дополнительный этап.');
  const localQuantities:NonNullable<GenerationSelection['localQuantities']>=[];
  for(const stage of stages){
    if(stage.measureScope!=='LOCAL'||(!stage.required&&!included.includes(stage.occurrenceKey)))continue;
    for(const areaScopeId of selected){
      const quantity=quantities[`${stage.occurrenceKey}|${areaScopeId}`]?.trim();
      if(!quantity)continue;
      if(!positive.test(quantity)||!/[1-9]/.test(quantity))throw Error('Локальный объём должен быть положительным десятичным числом с точкой.');
      localQuantities.push({occurrenceKey:stage.occurrenceKey,areaScopeId,quantity});
    }
  }
  return {systemVersionId:version.id,areaScopeIds:selected,
    ...(included.length?{includeOptional:included}:{}),
    ...(localQuantities.length?{localQuantities}:{}),
    grouping:grouping??'PER_OCCURRENCE'};
}
