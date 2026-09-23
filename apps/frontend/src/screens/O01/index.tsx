import type { ReactNode } from 'react';
import {
  AppShell,
  Breadcrumb,
  DataTable,
  PageHeader,
  PlanFact,
  ProgressBar,
  StatusBadge,
  WorkSummaryRow,
  typeClass,
  workSummaryColumns,
} from '../../design-system';
import type { O01ViewModel } from '../../view-models/o01';
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
          <span className={[styles.readinessLabel, typeClass('label')].join(' ')}>
            Физическая готовность
          </span>
          <span className={typeClass('display')}>{viewModel.readiness.formatted}</span>
          <div className={styles.readinessBar}>
            <ProgressBar value={viewModel.readiness.value} label="Физическая готовность" size="Block" />
          </div>
        </div>

        <div className={styles.scheduleCard}>
          <span className={[styles.detailLabel, typeClass('label')].join(' ')}>
            Состояние графика
          </span>
          <div className={styles.scheduleRow}>
            <PlanFact
              items={[
                { label: 'План на дату', value: viewModel.schedule.plan },
                { label: 'Факт', value: viewModel.schedule.fact },
              ]}
            />
            <StatusBadge variant={viewModel.schedule.status.variant}>
              {viewModel.schedule.status.label}
            </StatusBadge>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <DataTable
          columns={workSummaryColumns}
          title="Работы объекта"
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
              status={work.status}
              tone={work.needsAttention ? 'Attention' : 'Neutral'}
              interactive
              onActivate={() => onSelectWork(work.id)}
            />
          ))}
        </DataTable>
      </section>

      {viewModel.blockedWorks.length > 0 ? (
        <section className={styles.section}>
          <div className={styles.blockersCard}>
            <span className={[styles.detailLabel, typeClass('label')].join(' ')}>
              Блокировки в производстве
            </span>
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
