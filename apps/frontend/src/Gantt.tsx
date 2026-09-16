import React from 'react';
import { Tooltip } from 'antd';

/**
 * Диаграмма Ганта карточки объекта (ТЗ §44) — перенос сильной стороны
 * construction-erp (apps/frontend/src/components/Gantt.tsx: цветные полосы
 * по scheduleStatus + тултип план/факт) поверх реальных полей construction-core
 * (works из ReadService.snapshot(): plannedStartDate/plannedFinishDate/
 * actualProgress/plannedProgress/scheduleStatus — GREEN/YELLOW/RED/GRAY,
 * см. packages/domain ScheduleStatusService). Сознательно НЕ используется
 * внешняя Гантт-библиотека — чистые div/flex, как и в остальной части
 * construction-core.
 */
export interface GanttTask {
  id: string;
  name: string;
  plannedStartDate: string;
  plannedFinishDate: string;
  actualProgress?: number | null;
  plannedProgress?: number | null;
  scheduleStatus: string;
}

const STATUS_COLOR: Record<string, string> = {
  GREEN: '#279b82',
  YELLOW: '#dcb555',
  RED: '#db655d',
  GRAY: '#a5aeb6',
};

function daysBetween(a: Date, b: Date) {
  return Math.max(1, Math.round((b.getTime() - a.getTime()) / 86400000));
}

export function Gantt({ tasks }: { tasks: GanttTask[] }) {
  if (tasks.length === 0) return <div className="muted" style={{ padding: 16 }}>Нет работ для отображения графика.</div>;

  const starts = tasks.map((t) => +new Date(t.plannedStartDate));
  const finishes = tasks.map((t) => +new Date(t.plannedFinishDate));
  const rangeStart = new Date(Math.min(...starts));
  const rangeEnd = new Date(Math.max(...finishes));
  const totalDays = daysBetween(rangeStart, rangeEnd);
  const todayOffsetPct = Math.min(100, Math.max(0, (daysBetween(rangeStart, new Date()) / totalDays) * 100));

  return (
    <div className="gantt-scroll">
      <div style={{ minWidth: 900, padding: 12, position: 'relative' }}>
        <div className="today" style={{ left: `${todayOffsetPct}%`, position: 'absolute', top: 0, bottom: 0, width: 2, background: '#467aaf', zIndex: 3 }} />
        {tasks.map((t) => {
          const start = new Date(t.plannedStartDate);
          const finish = new Date(t.plannedFinishDate);
          const offsetPct = (daysBetween(rangeStart, start) / totalDays) * 100;
          const widthPct = Math.max(2, (daysBetween(start, finish) / totalDays) * 100);
          const color = STATUS_COLOR[t.scheduleStatus] ?? '#1677ff';
          const actual = Math.max(0, Math.min(100, t.actualProgress ?? 0));

          return (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ width: 260, fontSize: 13, paddingRight: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</div>
              <div style={{ position: 'relative', flex: 1, height: 22, background: '#f5f5f5', borderRadius: 3 }}>
                <Tooltip
                  title={
                    <>
                      {t.plannedStartDate.slice(0, 10)} — {t.plannedFinishDate.slice(0, 10)}
                      <br />
                      Факт: {t.actualProgress == null ? '—' : Math.round(t.actualProgress) + '%'} / план на сегодня: {t.plannedProgress == null ? '—' : Math.round(t.plannedProgress) + '%'}
                    </>
                  }
                >
                  <div className="gantt-bar-chip" style={{ position: 'absolute', left: `${offsetPct}%`, width: `${widthPct}%`, top: 0, height: '100%', background: color, opacity: 0.85, borderRadius: 3 }}>
                    <div style={{ position: 'absolute', inset: 0, width: `${actual}%`, background: 'rgba(0,0,0,0.25)', borderRadius: 3 }} />
                  </div>
                </Tooltip>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
