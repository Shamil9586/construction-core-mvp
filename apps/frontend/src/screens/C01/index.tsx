import type { ReactNode } from 'react';
import {
  AppShell,
  Button,
  DataTable,
  ObjectRow,
  objectColumns,
  PageHeader,
  StatusBadge,
  typeClass,
} from '../../design-system';
import {
  C01_ATTENTION_EMPTY_LABEL,
  C01_INSUFFICIENT_DATA_LABEL,
  type C01ViewModel,
} from '../../view-models/c01';
import styles from './C01.module.css';

/**
 * C01 — Company Control Center.
 *
 * Reuses `AppShell`/`ObjectRow`/`DataTable` exactly as F2/F3 shipped them; the
 * only screen-local markup is the attention queue, which does not fit either
 * existing row shape (it lists objects, not table cells, and pairs each with a
 * sentence rather than a measurement) and does not warrant a new design-system
 * primitive for one screen.
 *
 * Takes a pre-built `C01ViewModel` rather than raw API objects — deriving that
 * is `view-models/c01.ts`'s job, not this component's. `sidebar`/`topbar` are
 * passed straight through to `AppShell`, matching that component's own
 * contract: this screen does not decide how navigation is wired, only what
 * C01's own content is.
 */

export interface C01Props {
  viewModel: C01ViewModel;
  sidebar: ReactNode;
  topbar?: ReactNode;
  onSelectObject: (objectId: string) => void;
  className?: string;
}

export function CompanyControlCenter({
  viewModel,
  sidebar,
  topbar,
  onSelectObject,
  className,
}: C01Props) {
  const attentionTone = (variant: C01ViewModel['attention'][number]['status']['variant']) =>
    variant === 'OnTrack' || variant === 'Neutral' ? 'Neutral' : 'Attention';

  return (
    <AppShell sidebar={sidebar} topbar={topbar} className={className}>
      <PageHeader
        eyebrow="ИСПОЛНИТЕЛЬНЫЙ ОБЗОР"
        title="Портфель объектов"
        description="Физическая готовность, состояние графика и объекты, которые требуют внимания."
      />

      <section className={styles.section}>
        <DataTable
          columns={objectColumns}
          title="Объекты компании"
          context={`${viewModel.portfolio.length} объектов`}
          state={viewModel.portfolio.length === 0 ? 'Empty' : 'Default'}
          emptyLabel="Объектов нет"
        >
          {viewModel.portfolio.map((row) => (
            <ObjectRow
              key={row.id}
              name={row.name}
              meta={row.meta}
              responsible={row.responsible}
              smr={row.smr}
              smrProgress={row.smrProgress}
              status={row.status}
              tone={attentionTone(row.status.variant)}
              interactive
              onActivate={() => onSelectObject(row.id)}
            />
          ))}
        </DataTable>
      </section>

      <section className={styles.section}>
        <h2 className={[styles.sectionTitle, typeClass('heading-card')].join(' ')}>
          Требует внимания
        </h2>

        {viewModel.attention.length === 0 && viewModel.unevaluatedObjectCount === 0 ? (
          <p className={[styles.empty, typeClass('body')].join(' ')}>
            {C01_ATTENTION_EMPTY_LABEL}
          </p>
        ) : null}

        {viewModel.attention.length > 0 ? (
          <ul className={styles.attentionList}>
            {viewModel.attention.map((item) => (
              <li key={item.objectId} className={styles.attentionRow}>
                <StatusBadge variant={item.status.variant}>{item.status.label}</StatusBadge>
                <div className={styles.attentionBody}>
                  <span className={typeClass('body-strong')}>{item.objectName}</span>
                  <span className={[styles.attentionMessage, typeClass('body')].join(' ')}>
                    {item.message}
                  </span>
                </div>
                <Button variant="Secondary" arrow="forward" onClick={() => onSelectObject(item.objectId)}>
                  Открыть объект
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        {viewModel.unevaluatedObjectCount > 0 ? (
          <p className={[styles.insufficientData, typeClass('label')].join(' ')}>
            {C01_INSUFFICIENT_DATA_LABEL}
          </p>
        ) : null}
      </section>
    </AppShell>
  );
}
