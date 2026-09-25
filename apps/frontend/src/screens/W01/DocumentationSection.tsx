import { StatusBadge, typeClass } from '../../design-system';
import type { W01DocumentationPackageViewModel } from '../../view-models/w01';
import styles from './DocumentationSection.module.css';

/**
 * F8.2 (W01 Integration) — "Исполнительная документация" section: package
 * existence, status, covered portions, responsible PTO. Read-only, the same
 * as the rest of W01 aside from `ExecutionSection` — the Foundation
 * contract's W01 scope is display only, creating or editing a package is a
 * P01/PTO action (`documentation.controller.ts`'s routes), not this
 * screen's. Rendered unconditionally (never omitted for a zero-package
 * work): a Documentation Package is a capability every work already has,
 * not one only some works opt into the way execution units are — "package
 * existence" is exactly the fact a missing section would hide.
 */

export interface DocumentationSectionProps {
  documentationPackages: W01DocumentationPackageViewModel[];
}

function PackageCard({ pkg }: { pkg: W01DocumentationPackageViewModel }) {
  return (
    <div className={styles.packageCard}>
      <div className={styles.packageHeader}>
        <StatusBadge variant={pkg.status.variant}>{pkg.status.label}</StatusBadge>
      </div>
      <dl className={styles.packageDetails}>
        <div className={styles.detailRow}>
          <dt className={[styles.detailLabel, typeClass('label')].join(' ')}>Ответственный ПТО</dt>
          <dd className={typeClass('body-strong')}>{pkg.responsible}</dd>
        </div>
        <div className={styles.detailRow}>
          <dt className={[styles.detailLabel, typeClass('label')].join(' ')}>Покрыто участков</dt>
          <dd className={typeClass('body-strong')}>{pkg.coveredPortionCount || '—'}</dd>
        </div>
      </dl>
    </div>
  );
}

export function DocumentationSection({ documentationPackages }: DocumentationSectionProps) {
  return (
    <section className={styles.section}>
      <span className={[styles.sectionLabel, typeClass('label')].join(' ')}>
        Исполнительная документация
      </span>
      {documentationPackages.length > 0 ? (
        <div className={styles.packageList}>
          {documentationPackages.map((pkg) => (
            <PackageCard key={pkg.id} pkg={pkg} />
          ))}
        </div>
      ) : (
        <span className={[styles.empty, typeClass('body')].join(' ')}>
          Пакет исполнительной документации ещё не создан
        </span>
      )}
    </section>
  );
}
