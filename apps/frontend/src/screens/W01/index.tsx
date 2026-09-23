import type { ReactNode } from 'react';
import {
  AppShell,
  Breadcrumb,
  PageHeader,
  PlanFact,
  ProgressBar,
  StatusBadge,
  typeClass,
} from '../../design-system';
import type { W01ViewModel, WorkConfirmation } from '../../view-models/w01';
import styles from './W01.module.css';

/**
 * W01 — Work Card.
 *
 * Plan, fact and СК confirmation are three separate `PlanFact`/`StatusBadge`
 * blocks placed side by side, never one component computing a difference
 * between them — the same structural guarantee `PlanFact` itself documents.
 *
 * Work type is the only part of the specified work definition (type, finish
 * type, layer, execution conditions, zone) that `Work` carries. The rest is not
 * rendered — see `view-models/w01.ts` for why that is a capability gap, not a
 * missing value.
 */

export interface W01Props {
  viewModel: W01ViewModel;
  sidebar: ReactNode;
  topbar?: ReactNode;
  onNavigateHome: () => void;
  onSelectObject: (objectId: string) => void;
  className?: string;
}

function ConfirmationBlock({ confirmation }: { confirmation: WorkConfirmation }) {
  switch (confirmation.kind) {
    // An explicit confirmed-quantity figure — reachable only where the data
    // source actually has one (never inferred from `accepted`, see
    // view-models/w01.ts). Rendered as its own PlanFact figure so it reads
    // next to Fact without either merging into or correcting the other.
    case 'ConfirmedQuantity':
      return (
        <PlanFact
          items={[{ label: 'Подтверждено СК', value: confirmation.value, meta: confirmation.meta }]}
        />
      );
    // Accepted is a decision about the work as a whole, not a quantity — no
    // number is shown here, only the status, so it can never be read as a
    // confirmed figure equal to (or different from) Fact.
    case 'Accepted':
      return (
        <div className={styles.confirmationStack}>
          <span className={[styles.confirmationLabel, typeClass('label')].join(' ')}>
            Подтверждение СК
          </span>
          <StatusBadge variant="OnTrack">Принято СК</StatusBadge>
        </div>
      );
    case 'Pending':
      return (
        <div className={styles.confirmationStack}>
          <span className={[styles.confirmationLabel, typeClass('label')].join(' ')}>
            Подтверждение СК
          </span>
          <StatusBadge variant="Neutral">На проверке</StatusBadge>
        </div>
      );
    case 'NotSubmitted':
      return (
        <div className={styles.confirmationStack}>
          <span className={[styles.confirmationLabel, typeClass('label')].join(' ')}>
            Подтверждение СК
          </span>
          <StatusBadge variant="Neutral">Не предъявлено</StatusBadge>
        </div>
      );
    default: {
      const exhaustive: never = confirmation;
      return exhaustive;
    }
  }
}

export function WorkCard({
  viewModel,
  sidebar,
  topbar,
  onNavigateHome,
  onSelectObject,
  className,
}: W01Props) {
  return (
    <AppShell sidebar={sidebar} topbar={topbar} className={className}>
      <Breadcrumb
        items={[
          { label: 'Портфель', onSelect: onNavigateHome },
          { label: viewModel.objectName, onSelect: () => onSelectObject(viewModel.objectId) },
          { label: viewModel.name },
        ]}
      />

      <PageHeader
        eyebrow="РАБОТА"
        title={viewModel.name}
        description={`${viewModel.objectName} · ${viewModel.performer}`}
        actions={
          <StatusBadge variant={viewModel.status.variant}>{viewModel.status.label}</StatusBadge>
        }
      />

      <section className={styles.section}>
        <div className={styles.card}>
          <PlanFact
            items={[
              { label: 'План работы', value: viewModel.plan.value, meta: viewModel.plan.meta },
              { label: 'Факт выполнения', value: viewModel.fact.value, meta: viewModel.fact.meta },
            ]}
          />
        </div>

        <div className={styles.card}>
          <ConfirmationBlock confirmation={viewModel.confirmation} />
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.card}>
          <span className={[styles.readinessLabel, typeClass('label')].join(' ')}>
            Готовность выполнения
          </span>
          <div className={styles.readinessBar}>
            <ProgressBar value={viewModel.readiness} label={viewModel.name} size="Block" />
          </div>
        </div>

        <div className={styles.card}>
          <dl className={styles.scheduleList}>
            <div className={styles.scheduleItem}>
              <dt className={[styles.detailLabel, typeClass('label')].join(' ')}>Плановое начало</dt>
              <dd className={typeClass('body-strong')}>{viewModel.schedule.plannedStart}</dd>
            </div>
            <div className={styles.scheduleItem}>
              <dt className={[styles.detailLabel, typeClass('label')].join(' ')}>
                Плановое окончание
              </dt>
              <dd className={typeClass('body-strong')}>{viewModel.schedule.plannedFinish}</dd>
            </div>
            <div className={styles.scheduleItem}>
              <dt className={[styles.detailLabel, typeClass('label')].join(' ')}>
                Фактическое начало
              </dt>
              <dd className={typeClass('body-strong')}>{viewModel.schedule.actualStart}</dd>
            </div>
            <div className={styles.scheduleItem}>
              <dt className={[styles.detailLabel, typeClass('label')].join(' ')}>
                Фактическое окончание
              </dt>
              <dd className={typeClass('body-strong')}>{viewModel.schedule.actualFinish}</dd>
            </div>
          </dl>
        </div>
      </section>

      {viewModel.blockers.length > 0 ? (
        <section className={styles.section}>
          <div className={styles.card}>
            <span className={[styles.readinessLabel, typeClass('label')].join(' ')}>
              Причины блокировки
            </span>
            <ul className={styles.blockerList}>
              {viewModel.blockers.map((reason) => (
                <li key={reason} className={typeClass('body')}>
                  {reason}
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}
    </AppShell>
  );
}
