import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import Decimal from 'decimal.js';
const currency = (x: any) => x == null ? '—' : new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 }).format(Number(x));
const percent = (x: any) => x == null ? 'Нет факта' : `${Number(x).toFixed(0)}%`;
const lights: any = { RED: 'Проблема', YELLOW: 'Риск', GREEN: 'В срок', GRAY: 'Нет данных' };
const severity: any = { RED: 0, YELLOW: 1, GRAY: 2, GREEN: 3 };
function stages(data: any, works: any[]) {
  const ids = new Set(works.map(w => w.id));
  const issues = (data.issues ?? []).filter(i => ids.has(i.objectWorkId) && i.status !== 'CLOSED');
  const accepted = works.filter(w => w.accepted).length;
  const ready = works.filter(w => w.docsReady).length;
  const packages = (data.packages ?? []).filter(p => ids.has(p.objectWorkId));
  const cases = (data.sdo ?? []).filter(s => ids.has(s.objectWorkId));
  const calculated = cases.filter(s => ['CALCULATED', 'READY_TO_CLOSE', 'CLOSED'].includes(s.status));
  return {
    issues,
    transferredValue: cases.reduce((sum: Decimal, x: any) => sum.add(x.estimatedValue ?? 0), new Decimal(0)).toFixed(2),
    calculatedValue: cases.reduce((sum: Decimal, x: any) => sum.add(x.calculatedValue ?? 0), new Decimal(0)).toFixed(2),
    sk: issues.length ? `Есть замечания: ${issues.length}` : accepted === works.length && accepted ? 'Принято' : accepted ? `Принято ${accepted} из ${works.length}` : 'Не проверено',
    docs: ready === works.length && ready ? 'Готова' : packages.length ? `Готовится · готово ${ready} из ${works.length}` : 'Не начата',
    sdo: calculated.length ? `Осмечено ${calculated.length} из ${works.length}` : cases.length ? `Передано ${cases.length} из ${works.length}` : 'Не передано',
  };
}
export function WorkChain({ data, works }: any) {
  return <section className="work-chain" aria-label="Сквозной производственный статус">
    <h2>От выполнения до закрытия</h2>
    {works.length === 0 && <p>Работы ещё не добавлены.</p>}
    {works.map((w: any) => {
      const state = stages(data, [w]);
      const problem = [...(w.blockers ?? []), ...state.issues.map((i: any) => i.title)];
      return <article key={w.id} className={`chain-work ${w.scheduleStatus}`}>
        <h3>{w.name}</h3><p>{w.contractor} · Ответственный: {w.responsible}</p>
        <div className="chain-metrics">
          <span>План <b>{percent(w.plannedProgress)}</b></span><span>Факт <b>{percent(w.actualProgress)}</b></span>
          <span>Отклонение <b>{w.variance == null ? '—' : `${Number(w.variance).toFixed(0)} п.п.`}</b></span>
          <span>Срок <b>{w.delayDays ?? 0} дн. отставания</b></span>
          <span>Стройконтроль <b>{state.sk}</b></span><span>ИД / ПТО <b>{state.docs}</b></span>
          <span>СДО <b>{state.sdo}</b></span><span>Передано на осмечивание <b>{currency(state.transferredValue)}</b></span><span>Рассчитано <b>{currency(state.calculatedValue)}</b></span><span>Закрыто <b>{currency(w.closed)}</b></span>
        </div>
        {problem.length > 0 && <p className="error">{problem.join(' · ')}</p>}
        {w.variance < -5 && <p>Выполненный объём ниже плана. {problem.length ? 'Сначала устранить указанные замечания и блокировки.' : 'РП: уточнить причину и план восстановления.'}</p>}
      </article>;
    })}
  </section>;
}
export default function ContractorPanel({ data }: any) {
  const [search, setSearch] = useState(''), [contractor, setContractor] = useState('ALL');
  const [light, setLight] = useState('ALL'), [plan, setPlan] = useState('ALL'), [status, setStatus] = useState('ALL'), [late, setLate] = useState(false);
  const period = new Date().toISOString().slice(0, 7);
  const planFor = (o: any) => (data.monthlyPlans ?? []).filter((p: any) => p.objectId === o.id && p.period === period);
  const objects = data.objects.filter((o: any) =>
    `${o.name} ${o.address} ${o.externalCode}`.toLowerCase().includes(search.toLowerCase()) &&
    (light === 'ALL' || light === o.healthStatus) && (status === 'ALL' || status === o.status) &&
    (plan === 'ALL' || planFor(o).some((p: any) => p.planType === plan)) &&
    (!late || data.works.some((w: any) => w.objectId === o.id && (w.delayDays > 0 || w.variance < -5)))
  );
  const groups = data.contractors.filter((c: any) => contractor === 'ALL' || c.id === contractor).map((c: any) => {
    // Membership in a contractor's group is the CURRENT assignment (active object_contractors,
    // via o.contractorIds — see read-service.ts). Once an object is in the group, `works`
    // below is used only to show that contractor's historical/actual production metrics —
    // it must never decide membership itself (a removed contractor's old works must not keep
    // the object in their group, and works are not a fallback for a missing active relation).
    const rows = objects.filter((o: any) => o.contractorIds?.includes(c.id));
    const health = rows.map((o: any) => o.healthStatus).sort((a: string, b: string) => severity[a] - severity[b])[0] ?? 'GRAY';
    return { ...c, rows, health };
  }).filter((c: any) => c.rows.length).sort((a: any, b: any) => severity[a.health] - severity[b.health]);
  return <section className="contractor-panel" aria-label="Контроль по субподрядчикам">
    <h2>Подрядчики и объекты</h2><p>Сначала показаны проблемные подрядчики. Раскройте группу и откройте объект.</p>
    <div className="product-filters">
      <label>Объект, адрес или УКО<input value={search} onChange={e => setSearch(e.target.value)} placeholder="Найти объект" /></label>
      <label>Субподрядчик<select aria-label="Субподрядчик" value={contractor} onChange={e => setContractor(e.target.value)}><option value="ALL">Все подрядчики</option>{data.contractors.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label>Светофор<select aria-label="Светофор" value={light} onChange={e => setLight(e.target.value)}><option value="ALL">Все цвета</option>{Object.entries(lights).map(([value, label]: any) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Тип плана<select aria-label="Тип плана" value={plan} onChange={e => setPlan(e.target.value)}><option value="ALL">Все типы</option><option value="INTERMEDIATE">Промежуточный</option><option value="FINAL">Итоговый</option></select></label>
      <label>Статус объекта<select aria-label="Статус объекта" value={status} onChange={e => setStatus(e.target.value)}><option value="ALL">Все статусы</option><option value="ACTIVE">В работе</option><option value="PLANNED">Запланирован</option><option value="DELAYED">Задержан</option><option value="COMPLETED">Завершён</option><option value="SUSPENDED">Приостановлен</option><option value="AT_RISK">Под риском</option><option value="ARCHIVED">Архив</option></select></label>
      <label className="late-filter"><input type="checkbox" checked={late} onChange={e => setLate(e.target.checked)} />Только отстающие</label>
    </div>
    {!groups.length && <p role="status">По выбранным фильтрам объектов нет. Измените условия поиска.</p>}
    {groups.map((c: any, index: number) => <details key={c.id} className={`contractor-group ${c.health}`} open={index === 0 ? true : undefined}>
      <summary><strong>{c.name}</strong><span>{lights[c.health]} · объектов: {c.rows.length}</span></summary>
      {c.rows.sort((a: any, b: any) => severity[a.healthStatus] - severity[b.healthStatus]).map((o: any) => {
        const ws = data.works.filter((w: any) => w.objectId === o.id && w.contractorId === c.id);
        const state = stages(data, ws), plans = planFor(o);
        return <article key={o.id} className={`portfolio-object ${o.healthStatus}`}>
          <div className="section-heading"><Link to={`/objects/${o.id}`}><h3>{o.name}</h3></Link><b className={`light-label ${o.healthStatus}`}>{lights[o.healthStatus]}</b></div>
          <p>{o.address} · УКО {o.externalCode}</p><small>{c.name} · РП: {o.responsible}</small>
          <div className="chain-metrics">
            <span>Тип плана <b>{plans.length ? [...new Set(plans.map((p: any) => p.planType === 'FINAL' ? 'Итоговый' : 'Промежуточный'))].join(', ') : 'Не задан'}</b></span>
            <span>План объекта <b>{percent(o.plannedProgress)}</b></span><span>Факт объекта <b>{percent(o.actualProgress)}</b></span>
            <span>Отклонение <b>{o.actualProgress == null || o.plannedProgress == null ? '—' : `${(o.actualProgress - o.plannedProgress).toFixed(0)} п.п.`}</b></span>
            <span>СК подрядчика <b>{state.sk}</b></span><span>ИД подрядчика <b>{state.docs}</b></span><span>СДО подрядчика <b>{state.sdo}</b></span><span>Закрыто по объекту <b>{currency(o.closed)}</b></span>
          </div>
          {state.issues.length > 0 && <p className="error">{state.issues.map((i: any) => i.title).join(' · ')}</p>}
          <Link to={`/objects/${o.id}`}>Работы, причины и дальнейшие действия →</Link>
        </article>;
      })}
    </details>)}
  </section>;
}
