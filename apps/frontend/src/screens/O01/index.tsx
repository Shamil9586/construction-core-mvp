import type { ReactNode } from 'react';
import {
  AppShell,
  Breadcrumb,
  DataTable,
  PageHeader,
  PlanFact,
  ProgressBar,
  WorkSummaryRow,
  typeClass,
  workSummaryExecutionColumns,
} from '../../design-system';
import type { O01ViewModel } from '../../view-models/o01';
import type { O01ScheduleView } from '../../view-models/schedule';
import { PtoTeamSection, type PtoTeamLoad } from './PtoTeamSection';
import { ScheduleConclusion } from './ScheduleConclusion';
import styles from './O01.module.css';

/**
 * O01 — Object Overview.
 *
 * Quality (СК), ИД and finance are absent by construction: `O01ViewModel`
 * carries only identity, readiness, schedule and the work list, so there is no
 * field here a screen could mix into the production picture even by accident.
 *
 * The readiness figure is the one `display`-scale number this screen gets
 * (Design Rules — `display` appears once per screen, here). No existing
 * component exposes that style, so it is rendered directly rather than adding a
 * one-off prop to `PlanFact` for a style no other screen uses.
 */

export interface O01Props {
  viewModel: O01ViewModel;
  sidebar: ReactNode;
  topbar?: ReactNode;
  /** PBX-3A — present only for roles that may read the PTO team; absent means the block is not rendered. */
  ptoTeam?: PtoTeamLoad;
  /**
   * GPR-1 — the Object's production-schedule conclusion («По графику» / «Есть отставание»), from its approved schedule. Omitted (the design
   * preview, the demo runtime) the card keeps its original statement; see `ScheduleConclusion`.
   */
  schedule?: O01ScheduleView;
  /** Opens «График производства работ» of this object. */
  onOpenSchedule?: () => void;
  /**
   * ID-AUTO-2 — navigation only: a link to this object's «Реестр ИД». O01 itself still carries no ИД data; the link is omitted for a role
   * without documentation access.
   */
  onOpenRegistry?: () => void;
  onNavigateHome: () => void;
  onSelectWork: (workId: string) => void;
  className?: string;
}

interface DetailEntry {
  label: string;
  value: string;
}

export function ObjectOverview({
  viewModel,
  sidebar,
  topbar,
  ptoTeam,
  schedule,
  onOpenSchedule,
  onOpenRegistry,
  onNavigateHome,
  onSelectWork,
  className,
}: O01Props) {
  const details: DetailEntry[] = [
    { label: 'Заказчик', value: viewModel.details.customerName },
    { label: 'Организация', value: viewModel.details.organizationName },
    { label: 'Руководитель проекта', value: viewModel.details.responsible },
    { label: 'Начало работ', value: viewModel.details.startDate },
    { label: 'Плановое завершение', value: viewModel.details.plannedFinishDate },
  ];

  return (
    <AppShell sidebar={sidebar} topbar={topbar} className={className}>
      <Breadcrumb
        items={[
          { label: 'Портфель', onSelect: onNavigateHome },
          { label: viewModel.name },
        ]}
      />

      <PageHeader
        eyebrow="ОБЪЕКТ"
        title={viewModel.name}
        description={`${viewModel.details.externalCode} · ${viewModel.details.address}`}
      />

      <section className={styles.section}>
        <dl className={styles.details}>
          {details.map((entry) => (
            <div className={styles.detailItem} key={entry.label}>
              <dt className={[styles.detailLabel, typeClass('label')].join(' ')}>{entry.label}</dt>
              <dd className={[styles.detailValue, typeClass('body-strong')].join(' ')}>{entry.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className={styles.section}>
        <div className={styles.readinessCard}>
          <h2 className={[styles.readinessLabel, typeClass('label')].join(' ')}>
            Физическая готовность
          </h2>
          <span className={typeClass('display')}>{viewModel.readiness.formatted}</span>
          <span className={[styles.cardNote, typeClass('label')].join(' ')}>
            Фактическое выполнение СМР — отдельно от документации и закрытия.
          </span>
          <div className={styles.readinessBar}>
            <ProgressBar value={viewModel.readiness.value} label="Физическая готовность" size="Block" />
          </div>
        </div>

        <div className={styles.scheduleCard}>
          <h2 className={[styles.detailLabel, typeClass('label')].join(' ')}>
            Состояние графика
          </h2>
          {/*
            Plan and fact are both real, confirmed figures and stand on their own,
            per Design Rules §7. The object-level conclusion is NOT derived from them
            or from `healthStatus` (which mixes in issues, staleness and late ИД/СДО):
            it comes from the Object's approved production schedule (GPR-1) and is
            rendered by `ScheduleConclusion`, which keeps the original "not
            determined" statement whenever no schedule is offered to this viewer.
          */}
          <div className={styles.scheduleRow}>
            <PlanFact
              items={[
                { label: 'План на дату', value: viewModel.schedule.plan },
                { label: 'Факт', value: viewModel.schedule.fact },
              ]}
            />
          </div>
          <ScheduleConclusion schedule={schedule} onOpenSchedule={onOpenSchedule} />
        </div>
      </section>

      {ptoTeam ? <PtoTeamSection load={ptoTeam} /> : null}

      {onOpenRegistry ? (
        <section className={styles.section} aria-label="Исполнительная документация">
          <button type="button" className={styles.registryLink} onClick={onOpenRegistry}>
            Реестр ИД объекта
          </button>
          <span className={[styles.cardNote, typeClass('label')].join(' ')}>
            Документальная готовность по всем пакетам исполнительной документации объекта.
          </span>
        </section>
      ) : null}

      <section className={styles.section}>
        <DataTable
          columns={workSummaryExecutionColumns}
          title="Работы объекта"
          stackOnNarrow
          context={`${viewModel.works.length} работ объекта`}
          state={viewModel.works.length === 0 ? 'Empty' : 'Default'}
          emptyLabel="Работ пока нет"
        >
          {viewModel.works.map((work) => (
            <WorkSummaryRow
              key={work.id}
              name={work.name}
              performer={work.performer}
              plan={work.plan}
              fact={work.fact}
              smr={work.smr}
              status={work.scheduleCompliance}
              execution={{ state: work.execution, blocker: work.blocker }}
              tone={work.needsAttention ? 'Attention' : 'Neutral'}
              interactive
              onActivate={() => onSelectWork(work.id)}
            />
          ))}
        </DataTable>
      </section>

      {viewModel.blockedWorks.length > 0 ? (
        <section className={styles.section}>
          <h2 className={[styles.sectionTitle, typeClass('heading-card')].join(' ')}>
            Блокировки в производстве
          </h2>
          <div className={styles.blockersCard}>
            <ul className={styles.blockedWorkList}>
              {viewModel.blockedWorks.map((blocked) => (
                <li key={blocked.workId} className={styles.blockedWorkItem}>
                  <span className={typeClass('body-strong')}>{blocked.workName}</span>
                  <ul className={styles.blockerReasonList}>
                    {blocked.reasons.map((reason) => (
                      <li key={reason} className={typeClass('body')}>
                        {reason}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}
    </AppShell>
  );
}
