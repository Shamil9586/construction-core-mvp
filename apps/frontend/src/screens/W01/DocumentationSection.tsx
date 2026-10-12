import { useMemo, useState } from 'react';
import { StatusBadge, typeClass } from '../../design-system';
import type { W01DocumentationPackageViewModel } from '../../view-models/w01';
import type { PtoWorkAssignmentView } from '../../data/documentationApi';
import { formatQuantityWithUnit } from '../../formatters';
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
  /**
   * A package is created WITH its production scope (the chosen Quantity Portions). No responsible argument: the backend derives it from the
   * actor + the persisted PTO assignment. `idempotencyKey` makes a double click / retry return the same package.
   */
  onCreatePackage: (quantityPortionIds: string[], idempotencyKey: string) => Promise<void>;
  onOpenPackage: (packageId: string) => void;
}

/**
 * PILOT-W01 UI03 — the PTO handoff («Передать в работу») for this work. `view` is the backend's own
 * read model (eligibility, who may assign, who may create the package); `onAssign` persists the
 * assignment and never creates a package. Omitted (no session / read-model not loaded) renders no
 * handoff block and no package-create control.
 */
export interface DocumentationHandoff {
  view: PtoWorkAssignmentView;
  onAssign: (assigneeUserId: string) => Promise<void>;
}

export interface DocumentationSectionProps {
  documentationPackages: W01DocumentationPackageViewModel[];
  actions?: DocumentationSectionActionHandlers;
  handoff?: DocumentationHandoff;
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

export const ALL_SCOPE_COVERED_TEXT = 'Все доступные участки уже включены в активные пакеты ИД.';
export const NO_PORTIONS_TEXT = 'У работы нет участков производства: пакет ИД создаётся на участок. Сначала создайте участок в разделе «Единицы исполнения и участки».';

/**
 * «Создать пакет ИД» — the engineer chooses the production scope (one or more UNCLAIMED Quantity Portions). The list is the backend's own
 * read model; a single eligible portion is preselected but still sent explicitly. With no eligible portion left, no package can be created
 * and the reason is shown instead. The idempotency key is minted per selection, so a double click / retry returns the same package.
 */
function CreatePackageForm({
  scope,
  onCreate,
  label = 'Создать пакет ИД',
}: {
  scope: PtoWorkAssignmentView['packageScope'];
  onCreate: (quantityPortionIds: string[], idempotencyKey: string) => Promise<void>;
  /** "Создать ещё один пакет" when the work already has one. */
  label?: string;
}) {
  const eligible = scope.eligiblePortions;
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = chosen ?? (eligible.length === 1 ? [eligible[0]!.id] : []);
  const selectionKey = [...selected].sort().join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const idempotencyKey = useMemo(() => crypto.randomUUID(), [selectionKey]);

  if (scope.totalPortions === 0) {
    return <span className={[styles.empty, typeClass('body')].join(' ')}>{NO_PORTIONS_TEXT}</span>;
  }
  if (eligible.length === 0) {
    return <span className={[styles.empty, typeClass('body')].join(' ')}>{ALL_SCOPE_COVERED_TEXT}</span>;
  }

  async function handleCreate() {
    setPending(true);
    setError(null);
    try {
      await onCreate(selected, idempotencyKey);
    } catch (submitError) {
      setError(errorMessage(submitError));
      setPending(false);
    }
  }

  if (!open) {
    return (
      <div className={styles.emptyAction}>
        <button type="button" className={styles.actionButton} onClick={() => setOpen(true)}>
          {label}
        </button>
      </div>
    );
  }

  return (
    <div className={styles.emptyAction}>
      <fieldset className={styles.scopeFieldset} disabled={pending}>
        <legend className={[styles.detailLabel, typeClass('label')].join(' ')}>Участки пакета</legend>
        {eligible.map((portion) => (
          <label key={portion.id} className={[styles.scopeOption, typeClass('body')].join(' ')}>
            <input
              type="checkbox"
              checked={selected.includes(portion.id)}
              onChange={(event) =>
                setChosen(event.target.checked ? [...selected, portion.id] : selected.filter((id) => id !== portion.id))
              }
            />
            <span className={typeClass('body-strong')}>{portion.zone}</span>
            {portion.currentQuantity ? (
              <span className={styles.detailLabel}>{formatQuantityWithUnit(portion.currentQuantity, portion.unit)}</span>
            ) : null}
          </label>
        ))}
      </fieldset>
      <div className={styles.scopeActions}>
        <button type="button" className={styles.actionButton} onClick={handleCreate} disabled={pending || selected.length === 0}>
          {pending ? 'Создание…' : 'Создать пакет'}
        </button>
        <button type="button" className={styles.actionButtonSecondary} onClick={() => setOpen(false)} disabled={pending}>
          Отмена
        </button>
      </div>
      {error ? <span className={styles.errorText}>{error}</span> : null}
    </div>
  );
}

/** Engineer picker + submit, shared by the first handoff and the pre-package change of responsible. */
function AssigneePicker({
  engineers,
  onAssign,
  label,
}: {
  engineers: { id: string; name: string }[];
  onAssign: (assigneeUserId: string) => Promise<void>;
  label: string;
}) {
  const [selected, setSelected] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAssign() {
    setPending(true);
    setError(null);
    try {
      await onAssign(selected);
      setSelected('');
    } catch (submitError) {
      setError(errorMessage(submitError));
    }
    setPending(false);
  }

  return (
    <div className={styles.emptyAction}>
      <select
        className={styles.pickerSelect}
        value={selected}
        onChange={(event) => setSelected(event.target.value)}
        disabled={pending}
        aria-label="Сотрудник ПТО"
      >
        <option value="">Выберите сотрудника ПТО…</option>
        {engineers.map((engineer) => (
          <option key={engineer.id} value={engineer.id}>
            {engineer.name}
          </option>
        ))}
      </select>
      <button type="button" className={styles.actionButton} onClick={handleAssign} disabled={pending || !selected}>
        {pending ? 'Передача…' : label}
      </button>
      {error ? <span className={styles.errorText}>{error}</span> : null}
    </div>
  );
}

/**
 * The handoff state of the work. Assignment and package creation are two separate actions: the
 * assigned object PTO_HEAD hands the work off here; the selected engineer (not the head) then
 * sees «Создать пакет ИД» below. Every flag comes from the backend read model.
 */
function HandoffBlock({ handoff }: { handoff: DocumentationHandoff }) {
  const { view } = handoff;
  const alternatives = view.eligible.filter((engineer) => engineer.id !== view.assignment?.assigneeUserId);

  if (view.assignment) {
    return (
      <div className={styles.packageCard}>
        <div className={styles.packageHeader}>
          <StatusBadge variant="OnTrack">Передано в работу</StatusBadge>
        </div>
        <dl className={styles.packageDetails}>
          <div className={styles.detailRow}>
            <dt className={[styles.detailLabel, typeClass('label')].join(' ')}>Ответственный ПТО</dt>
            <dd className={typeClass('body-strong')}>{view.assignment.assigneeName}</dd>
          </div>
        </dl>
        {view.canReassign ? (
          alternatives.length > 0 ? (
            <AssigneePicker engineers={alternatives} onAssign={handoff.onAssign} label="Изменить ответственного" />
          ) : null
        ) : null}
      </div>
    );
  }

  if (view.canAssign) {
    if (view.eligible.length === 0) {
      return (
        <span className={[styles.errorText, typeClass('body')].join(' ')}>
          {view.head
            ? 'Передача в работу недоступна: в команде начальника ПТО нет доступных сотрудников'
            : 'Передача в работу недоступна: на объекте не назначен начальник ПТО'}
        </span>
      );
    }
    return <AssigneePicker engineers={view.eligible} onAssign={handoff.onAssign} label="Передать в работу" />;
  }

  return <span className={[styles.empty, typeClass('body')].join(' ')}>Не передано в работу</span>;
}

function PackageCard({
  pkg,
  onOpenPackage,
}: {
  pkg: W01DocumentationPackageViewModel;
  onOpenPackage?: (packageId: string) => void;
}) {
  const { identity } = pkg;
  return (
    <div className={styles.packageCard}>
      <div className={styles.packageHeader}>
        <span className={[styles.packageTitle, typeClass('body-strong')].join(' ')}>{identity.workName}</span>
        <StatusBadge variant={pkg.status.variant}>{pkg.status.label}</StatusBadge>
      </div>
      <dl className={styles.packageDetails}>
        <div className={styles.detailRow}>
          <dt className={[styles.detailLabel, typeClass('label')].join(' ')}>Участок</dt>
          <dd className={[identity.scopeMissing ? styles.errorText : '', typeClass('body-strong')].join(' ')}>{identity.scopeText}</dd>
        </div>
        <div className={styles.detailRow}>
          <dt className={[styles.detailLabel, typeClass('label')].join(' ')}>Текущий объём</dt>
          <dd className={typeClass('body-strong')}>{identity.quantityText ?? '—'}</dd>
        </div>
        <div className={styles.detailRow}>
          <dt className={[styles.detailLabel, typeClass('label')].join(' ')}>АОСР</dt>
          <dd className={[identity.methodDeclared ? '' : styles.detailLabel, typeClass('body-strong')].join(' ')}>{identity.methodText}</dd>
        </div>
        <div className={styles.detailRow}>
          <dt className={[styles.detailLabel, typeClass('label')].join(' ')}>Ответственный ПТО</dt>
          <dd className={typeClass('body-strong')}>{identity.responsible}</dd>
        </div>
      </dl>
      <span className={[styles.detailLabel, typeClass('label')].join(' ')}>{identity.createdText}</span>
      {onOpenPackage ? (
        <button type="button" className={styles.actionButtonSecondary} onClick={() => onOpenPackage(pkg.id)}>
          Открыть пакет
        </button>
      ) : null}
    </div>
  );
}

export function DocumentationSection({ documentationPackages, actions, handoff, visible = true }: DocumentationSectionProps) {
  const canCreate = !!actions && !!handoff?.view.canCreatePackage;
  return (
    <section className={styles.section}>
      <h2 className={[styles.sectionLabel, typeClass('label')].join(' ')}>
        Исполнительная документация
      </h2>
      {!visible ? (
        <span className={[styles.empty, typeClass('body')].join(' ')}>
          Раздел недоступен для вашей роли
        </span>
      ) : documentationPackages.length > 0 ? (
        <>
          {handoff ? <HandoffBlock handoff={handoff} /> : null}
          <div className={styles.packageList}>
            {documentationPackages.map((pkg) => (
              <PackageCard key={pkg.id} pkg={pkg} onOpenPackage={actions?.onOpenPackage} />
            ))}
          </div>
          {canCreate ? <CreatePackageForm scope={handoff!.view.packageScope} onCreate={actions!.onCreatePackage} label="Создать ещё один пакет" /> : null}
        </>
      ) : (
        <>
          <span className={[styles.empty, typeClass('body')].join(' ')}>
            Пакет исполнительной документации ещё не создан
          </span>
          {handoff ? <HandoffBlock handoff={handoff} /> : null}
          {canCreate ? <CreatePackageForm scope={handoff!.view.packageScope} onCreate={actions!.onCreatePackage} /> : null}
        </>
      )}
    </section>
  );
}
