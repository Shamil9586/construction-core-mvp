import type { ReactNode } from 'react';
import { AppShell, Breadcrumb, PageHeader, PlanFact, StatusBadge, typeClass } from '../../design-system';
import type { GprViewModel } from '../../view-models/schedule';
import type { GprActions } from './actions';
import { DraftSection } from './DraftSection';
import { HistorySection } from './HistorySection';
import { ScheduleTable } from './ScheduleTable';
import styles from './GPR.module.css';

/**
 * GPR — «График производства работ» of ONE object. Reached from the object (Объект → График производства работ); it never lists another
 * object, and never shows a figure the schedule did not derive from the approved dates and the production facts.
 *
 * Reading order: the conclusion and the calendar's answers for the day, the table of positions (work / zone / executor / quantity / dates /
 * progress / state / delay, with the reasons for each delay), the draft being prepared, and the history of approved versions. Quality (СК
 * remarks), ИД and finance are absent by construction: nothing here receives them.
 */
export interface GprProps {
  viewModel: GprViewModel;
  sidebar: ReactNode;
  topbar?: ReactNode;
  /** Omitted without a real session (the demo runtime): the screen is then read-only. */
  actions?: GprActions;
  onNavigateHome: () => void;
  onNavigateObject: () => void;
  onSelectWork: (workId: string) => void;
  className?: string;
}

export function ProductionSchedule({ viewModel, sidebar, topbar, actions, onNavigateHome, onNavigateObject, onSelectWork, className }: GprProps) {
  const hasBaseline = viewModel.baseline !== null;
  return (
    <AppShell sidebar={sidebar} topbar={topbar} className={className}>
      <Breadcrumb
        items={[
          { label: 'Портфель', onSelect: onNavigateHome },
          { label: viewModel.objectName, onSelect: onNavigateObject },
          { label: 'График производства работ' },
        ]}
      />

      <PageHeader
        eyebrow="ОБЪЕКТ"
        title="График производства работ"
        description={`${viewModel.objectName} · расчёт на ${viewModel.asOf}`}
        actions={<StatusBadge variant={viewModel.conclusion.presentation.variant}>{viewModel.conclusion.presentation.label}</StatusBadge>}
      />

      <section className={styles.section} aria-label="Контроль сроков">
        <div className={styles.card}>
          <p className={typeClass('body')}>{viewModel.conclusion.text}</p>
          {viewModel.baseline ? (
            <>
              <span className={[styles.label, typeClass('label-strong')].join(' ')}>{viewModel.baseline.title}</span>
              <ul className={styles.plainList}>
                {viewModel.baseline.lines.map((line) => (
                  <li key={line} className={[styles.muted, typeClass('body')].join(' ')}>
                    {line}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {viewModel.expectation.length ? <PlanFact items={viewModel.expectation} /> : null}
          <span className={[styles.muted, typeClass('label')].join(' ')}>
            Выполнение — это факт РП по участкам. Подтверждение СК, исполнительная документация и закрытие на сроки графика не влияют.
          </span>
        </div>
      </section>

      {hasBaseline ? (
        <section className={styles.section}>
          <ScheduleTable rows={viewModel.rows} categories={viewModel.categories} asOf={viewModel.asOf} actions={actions} onSelectWork={onSelectWork} />
        </section>
      ) : null}

      {viewModel.unscheduled.length > 0 && hasBaseline ? (
        <section className={styles.section} aria-label="Участки вне графика">
          <div className={styles.card}>
            <span className={[styles.label, typeClass('label-strong')].join(' ')}>Не включены в график: {viewModel.unscheduled.length}</span>
            <ul className={styles.bulletList}>
              {viewModel.unscheduled.map((name) => (
                <li key={name} className={typeClass('body')}>
                  {name}
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      <DraftSection draft={viewModel.draft} scopes={viewModel.availableScopes} access={viewModel.access} hasBaseline={hasBaseline} actions={actions} />

      <HistorySection history={viewModel.history} />
    </AppShell>
  );
}
