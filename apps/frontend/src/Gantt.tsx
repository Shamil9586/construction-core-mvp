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
  /** R04: an Early Work may not have its provisional dates yet (NULL) — such a row gets no interval, see ganttLayout(). */
  plannedStartDate: string | null;
  plannedFinishDate: string | null;
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

/** A planned date that can be placed on the axis, or null (NULL or unparsable). Never replaced by today or any other default. */
function planDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
const dateLabel = (v: string | null | undefined) => (planDate(v) ? v!.slice(0, 10) : 'не задано');

export type GanttRow =
  | { kind: 'interval'; task: GanttTask; offsetPct: number; widthPct: number }
  /** No complete planned interval: no bar, no colour, no position on the axis — "Даты не определены". */
  | { kind: 'undated'; task: GanttTask };

/**
 * R04 CP01: the axis is built from the works that have BOTH planned dates; a work without them is listed, never placed, and never moves the
 * axis. With no dated work there is no axis and no "today" marker. The arithmetic for dated works is unchanged.
 */
export function ganttLayout(tasks: GanttTask[], now = new Date()): { rows: GanttRow[]; todayOffsetPct: number | null } {
  const dated = tasks.map((task) => ({ task, start: planDate(task.plannedStartDate), finish: planDate(task.plannedFinishDate) }));
  const placed = dated.filter((x): x is { task: GanttTask; start: Date; finish: Date } => x.start !== null && x.finish !== null);
  if (placed.length === 0) return { rows: tasks.map((task) => ({ kind: 'undated', task })), todayOffsetPct: null };
  const rangeStart = new Date(Math.min(...placed.map((x) => +x.start)));
  const rangeEnd = new Date(Math.max(...placed.map((x) => +x.finish)));
  const totalDays = daysBetween(rangeStart, rangeEnd);
  const todayOffsetPct = Math.min(100, Math.max(0, (daysBetween(rangeStart, now) / totalDays) * 100));
  const rows = dated.map(({ task, start, finish }): GanttRow => start && finish
    ? { kind: 'interval', task, offsetPct: (daysBetween(rangeStart, start) / totalDays) * 100, widthPct: Math.max(2, (daysBetween(start, finish) / totalDays) * 100) }
    : { kind: 'undated', task });
  return { rows, todayOffsetPct };
}

export function Gantt({ tasks }: { tasks: GanttTask[] }) {
  if (tasks.length === 0) return <div className="muted" style={{ padding: 16 }}>Нет работ для отображения графика.</div>;

  const { rows, todayOffsetPct } = ganttLayout(tasks);

  return (
    <div className="gantt-scroll">
      <div style={{ minWidth: 900, padding: 12, position: 'relative' }}>
        {todayOffsetPct !== null && <div className="today" style={{ left: `${todayOffsetPct}%`, position: 'absolute', top: 0, bottom: 0, width: 2, background: '#467aaf', zIndex: 3 }} />}
        {rows.map((row) => {
          const t = row.task;
          const fact = <>Факт: {t.actualProgress == null ? '—' : Math.round(t.actualProgress) + '%'} / план на сегодня: {t.plannedProgress == null ? '—' : Math.round(t.plannedProgress) + '%'}</>;
          const color = STATUS_COLOR[t.scheduleStatus] ?? '#1677ff';
          const actual = Math.max(0, Math.min(100, t.actualProgress ?? 0));

          return (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ width: 260, fontSize: 13, paddingRight: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</div>
              <div style={{ position: 'relative', flex: 1, height: 22, background: '#f5f5f5', borderRadius: 3 }}>
                {row.kind === 'interval' ? (
                  <Tooltip
                    title={
                      <>
                        {dateLabel(t.plannedStartDate)} — {dateLabel(t.plannedFinishDate)}
                        <br />
                        {fact}
                      </>
                    }
                  >
                    <div className="gantt-bar-chip" style={{ position: 'absolute', left: `${row.offsetPct}%`, width: `${row.widthPct}%`, top: 0, height: '100%', background: color, opacity: 0.85, borderRadius: 3 }}>
                      <div style={{ position: 'absolute', inset: 0, width: `${actual}%`, background: 'rgba(0,0,0,0.25)', borderRadius: 3 }} />
                    </div>
                  </Tooltip>
                ) : (
                  <Tooltip
                    title={
                      <>
                        Начало: {dateLabel(t.plannedStartDate)} · окончание: {dateLabel(t.plannedFinishDate)}
                        <br />
                        {fact}
                      </>
                    }
                  >
                    <div className="gantt-undated muted" style={{ fontSize: 12, lineHeight: '22px', paddingLeft: 8 }}>Даты не определены</div>
                  </Tooltip>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
