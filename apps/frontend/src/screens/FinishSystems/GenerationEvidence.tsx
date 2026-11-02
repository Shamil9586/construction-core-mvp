import type { GenerationConfirmResult, GenerationPreviewResponse } from '../../types/finishGeneration';

/** Show the backend's decision for every selected stage and zone, including existing and blocked obligations. */
export function PreviewObligations({items}:{items:GenerationPreviewResponse['preview']['items']}){
  if(!items.length)return <p>Обязательств для выбранных зон нет.</p>;
  const status={PROPOSED:'Будет создана',EXISTING:'Уже существует',BLOCKED:'Заблокирована'};
  return <div><strong>Этапы по зонам</strong><ul>{items.map((item,i)=><li key={`${item.occurrenceKey}|${item.areaScopeId}|${i}`}>
    {item.occurrenceKey} · зона {item.areaScopeId}: {status[item.status]}{item.quantity?` · ${item.quantity} ${item.unit}`:''}
  </li>)}</ul></div>;
}

export function GeneratedWorks({result,onOpenWork}:{result:GenerationConfirmResult;onOpenWork:(workId:string)=>void}){
  return <div role="status"><strong>Создано работ: {result.resultIds.length}</strong>
    {result.resultIds.length>0?<ul>{result.resultIds.map(id=><li key={id}><button type="button" onClick={()=>onOpenWork(id)}>Открыть работу {id}</button></li>)}</ul>:<p>Новых работ нет.</p>}
  </div>;
}
