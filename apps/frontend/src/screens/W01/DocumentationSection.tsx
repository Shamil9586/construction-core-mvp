import { useState } from 'react';
import { StatusBadge, typeClass } from '../../design-system';
import type { W01DocumentationPackageViewModel } from '../../view-models/w01';
import type { CreatePackageResponsible } from '../../data/documentationApi';
import styles from './DocumentationSection.module.css';

/**
 * F8.2.1 — "Исполнительная документация" section: package existence,
 * status, covered portions, responsible PTO, now with the create/open
 * actions Decision 1 asks W01 to offer alongside P01's own (the same
 * `documentationApi` functions and the same package detail destination — see
 * `app/routes/WorkRoute.tsx`, never a second, screen-local copy).
 *
 * `actions` follows the same convention `ExecutionSection.tsx`/P01 already
 * use: `undefined` (no session, or a role `canManageDocumentation` excludes)
 * renders status only — RP/SC/oversight roles see the package exactly as
 * F8.2 always showed it, never a control to create or open one (Decision 3).
 * A work with no package at all gets "Создать пакет"; a work with one or
 * more gets "Открыть пакет" per card *and* "Создать ещё один пакет"
 * (Corrective F8.2.1-03 — a work may have more than one Documentation
 * Package, so the create action stays available once one already exists).
 */

export interface DocumentationSectionActionHandlers {
  onCreatePackage: (responsibleUserId: string) => Promise<void>;
  onOpenPackage: (packageId: string) => void;
  /** F8.2.1-04 (Corrective Patch) — how the create action resolves its responsible PTO user: PTO defaults to itself, ADMIN must pick one. */
  responsible: CreatePackageResponsible;
}

export interface DocumentationSectionProps {
  documentationPackages: W01DocumentationPackageViewModel[];
  actions?: DocumentationSectionActionHandlers;
  /**
   * F8.2.1 — `false` only for a *confirmed* excluded role (SDO,
   * `canAccessDocumentation`); defaults to `true` so every existing caller
   * (the design-system preview, which has no session at all) is unchanged.
   * An empty `documentationPackages` array on its own is ambiguous — "no
   * package yet" and "no access to see one" both produce it — so this is a
   * separate, explicit signal rather than inferred from the array being
   * empty.
   */
  visible?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось выполнить действие';
}

function CreatePackageButton({
  onCreate,
  responsible,
  label = 'Создать пакет',
}: {
  onCreate: (responsibleUserId: string) => Promise<void>;
  responsible: CreatePackageResponsible;
  /** Corrective F8.2.1-03 — "Создать ещё один пакет" when the work already has one. */
  label?: string;
}) {
  const [selected, setSelected] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(responsibleUserId: string) {
    setPending(true);
    setError(null);
    try {
      await onCreate(responsibleUserId);
    } catch (submitError) {
      setError(errorMessage(submitError));
      setPending(false);
    }
  }

  // F8.2.1-04 — ADMIN is not itself a PTO user (the backend requires an
  // active PTO responsible), so it picks one here rather than the button
  // defaulting to `session.user.id` the way it safely can for PTO.
  if (responsible.mode === 'pick') {
    if (responsible.ptoUsers.length === 0) {
      return (
        <div className={styles.emptyAction}>
          <span className={styles.errorText}>Нет активных сотрудников ПТО</span>
        </div>
      );
    }
    return (
      <div className={styles.emptyAction}>
        <select
          className={styles.pickerSelect}
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          disabled={pending}
          aria-label="Ответственный сотрудник ПТО"
        >
          <option value="">Выберите сотрудника ПТО…</option>
          {responsible.ptoUsers.map((user) => (
            <option key={user.id} value={user.id}>
              {user.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={styles.actionButton}
          onClick={() => handleCreate(selected)}
          disabled={pending || !selected}
        >
          {pending ? 'Создание…' : label}
        </button>
        {error ? <span className={styles.errorText}>{error}</span> : null}
      </div>
    );
  }

  return (
    <div className={styles.emptyAction}>
      <button
        type="button"
        className={styles.actionButton}
        onClick={() => handleCreate(responsible.userId)}
        disabled={pending}
      >
        {pending ? 'Создание…' : label}
      </button>
      {error ? <span className={styles.errorText}>{error}</span> : null}
    </div>
  );
}

function PackageCard({
  pkg,
  onOpenPackage,
}: {
  pkg: W01DocumentationPackageViewModel;
  onOpenPackage?: (packageId: string) => void;
}) {
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
      {onOpenPackage ? (
        <button type="button" className={styles.actionButtonSecondary} onClick={() => onOpenPackage(pkg.id)}>
          Открыть пакет
        </button>
      ) : null}
    </div>
  );
}

export function DocumentationSection({ documentationPackages, actions, visible = true }: DocumentationSectionProps) {
  return (
    <section className={styles.section}>
      <span className={[styles.sectionLabel, typeClass('label')].join(' ')}>
        Исполнительная документация
      </span>
      {!visible ? (
        <span className={[styles.empty, typeClass('body')].join(' ')}>
          Раздел недоступен для вашей роли
        </span>
      ) : documentationPackages.length > 0 ? (
        <>
          <div className={styles.packageList}>
            {documentationPackages.map((pkg) => (
              <PackageCard key={pkg.id} pkg={pkg} onOpenPackage={actions?.onOpenPackage} />
            ))}
          </div>
          {actions ? (
            <CreatePackageButton
              onCreate={actions.onCreatePackage}
              responsible={actions.responsible}
              label="Создать ещё один пакет"
            />
          ) : null}
        </>
      ) : actions ? (
        <>
          <span className={[styles.empty, typeClass('body')].join(' ')}>
            Пакет исполнительной документации ещё не создан
          </span>
          <CreatePackageButton onCreate={actions.onCreatePackage} responsible={actions.responsible} />
        </>
      ) : (
        <span className={[styles.empty, typeClass('body')].join(' ')}>
          Пакет исполнительной документации ещё не создан
        </span>
      )}
    </section>
  );
}
