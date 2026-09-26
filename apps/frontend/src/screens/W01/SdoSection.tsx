import { StatusBadge, typeClass } from '../../design-system';
import type { W01SdoCaseViewModel } from '../../view-models/w01';
import styles from './SdoSection.module.css';

/**
 * F8.3 — "СДО / Закрытие" section: read-only SDO Case state for every
 * internal role that can see documentation at all (`canAccessDocumentation`
 * — the same audience `DocumentationSection` above already serves; SDO
 * itself has no F8.2 access and sees this work through its own `/sdo`
 * workspace instead). No actions here by design — status/amount/allocation
 * changes happen only in the SDO workspace, never from W01 (Production
 * Invariants: this section never renders anything that could be confused
 * with physical readiness, and physical readiness never depends on it).
 */

export interface SdoSectionProps {
  sdoClosingCases: W01SdoCaseViewModel[];
  /** `false` only for a confirmed excluded role, same convention `DocumentationSection`'s own `visible` prop uses. */
  visible?: boolean;
}

function SdoCaseCard({ sdoCase }: { sdoCase: W01SdoCaseViewModel }) {
  return (
    <div className={styles.caseCard}>
      <div className={styles.caseHeader}>
        <StatusBadge variant={sdoCase.status.variant}>{sdoCase.status.label}</StatusBadge>
      </div>
      <dl className={styles.caseDetails}>
        <div className={styles.detailRow}>
          <dt className={[styles.detailLabel, typeClass('label')].join(' ')}>Ответственный СДО</dt>
          <dd className={typeClass('body-strong')}>{sdoCase.responsible}</dd>
        </div>
        <div className={styles.detailRow}>
          <dt className={[styles.detailLabel, typeClass('label')].join(' ')}>Сумма закрытия</dt>
          <dd className={typeClass('body-strong')}>{sdoCase.totalAmount}</dd>
        </div>
      </dl>
    </div>
  );
}

export function SdoSection({ sdoClosingCases, visible = true }: SdoSectionProps) {
  return (
    <section className={styles.section}>
      <span className={[styles.sectionLabel, typeClass('label')].join(' ')}>СДО / Закрытие</span>
      {!visible ? (
        <span className={[styles.empty, typeClass('body')].join(' ')}>Раздел недоступен для вашей роли</span>
      ) : sdoClosingCases.length > 0 ? (
        <div className={styles.caseList}>
          {sdoClosingCases.map((sdoCase) => (
            <SdoCaseCard key={sdoCase.id} sdoCase={sdoCase} />
          ))}
        </div>
      ) : (
        <span className={[styles.empty, typeClass('body')].join(' ')}>Дело СДО ещё не открыто</span>
      )}
    </section>
  );
}
