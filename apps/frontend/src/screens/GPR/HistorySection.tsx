import { useId } from 'react';
import { typeClass } from '../../design-system';
import type { HistoryViewModel } from '../../view-models/schedule';
import styles from './GPR.module.css';

/**
 * Every approved version of the schedule, newest first, with who approved it, why it was corrected and exactly what it changed against the
 * version it replaced (before → after). An approved plan is never rewritten, so this list is the evidence, not a summary of it.
 */
export function HistorySection({ history }: { history: HistoryViewModel[] }) {
  const titleId = useId();
  if (history.length === 0) return null;
  return (
    <section className={styles.section} aria-labelledby={titleId}>
      <h2 id={titleId} className={[styles.sectionTitle, typeClass('heading-card')].join(' ')}>
        История версий графика
      </h2>
      <div className={styles.card}>
        {history.map((revision) => (
          <details key={revision.revisionNo} className={styles.historyItem}>
            <summary className={typeClass('body-strong')}>
              {revision.title} — {revision.statusLabel}
            </summary>
            <div className={styles.historyBody}>
              <span className={[styles.muted, typeClass('meta')].join(' ')}>{revision.provenance}</span>
              {revision.correctionReason ? <span className={typeClass('body')}>Причина корректировки: {revision.correctionReason}</span> : null}
              {revision.comment ? <span className={typeClass('body')}>Комментарий: {revision.comment}</span> : null}
              {revision.changes.length ? (
                <ul className={styles.plainList}>
                  {revision.changes.map((change) => (
                    <li key={change.itemId}>
                      <span className={typeClass('body-strong')}>{change.label}</span>
                      <ul className={styles.changeLines}>
                        {change.lines.map((line) => (
                          <li key={line} className={typeClass('body')}>
                            {line}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className={[styles.muted, typeClass('body')].join(' ')}>Без изменений относительно предыдущей версии.</span>
              )}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
