import { useState, type FormEvent, type ReactNode } from 'react';
import { AppShell, Breadcrumb, PageHeader, StatusBadge, typeClass } from '../../design-system';
import type { SdoClosingStatus, UserSummary } from '../../types/api';
import type { SdoCaseDetailViewModel } from '../../view-models/sdoCaseDetail';
import styles from './SdoCaseDetail.module.css';

/**
 * SDO Case detail (`/sdo/case/:caseId`) — SDO/ADMIN only, the SDO
 * workspace's own working surface for one Case: linked Documentation
 * Package's lock state, covered Quantity Portions with any optional
 * allocation, responsible SDO, closing status with only its currently
 * allowed actions (never a free picker — mirrors `PackageDetail`'s own
 * `AdvanceStatusControl` idiom, branching instead of single-next), total
 * amount, and the three independent append-only histories.
 *
 * `actions` follows the same convention every other F8.x screen uses:
 * `undefined` renders every section read-only — reachable here only when
 * `canAccessSdoWorkspace` already excluded the session at the route level,
 * kept as its own independent gate regardless.
 */

export interface SdoCaseDetailActionHandlers {
  onChangeStatus: (status: SdoClosingStatus, reason: string | undefined) => Promise<void>;
  onSetAmount: (amount: string) => Promise<void>;
  /** F8.3-R05 — `version` is required to correct an existing allocation, and must be omitted (undefined) to create the first one for a Portion. */
  onSetAllocation: (quantityPortionId: string, amount: string, version: number | undefined) => Promise<void>;
  /** F8.3-19 — explicit, audited cancellation of an active allocation; the row is marked inactive, never deleted. Requires the allocation's current `version`. */
  onCancelAllocation: (quantityPortionId: string, version: number) => Promise<void>;
  onAssignResponsible: (responsibleUserId: string) => Promise<void>;
  onReturnToPto: (comment: string | undefined) => Promise<void>;
  sdoUsers: UserSummary[];
}

export interface SdoCaseDetailProps {
  viewModel: SdoCaseDetailViewModel;
  sidebar: ReactNode;
  topbar?: ReactNode;
  onNavigateHome: () => void;
  onSelectObject: (objectId: string) => void;
  onSelectWork: (objectId: string, objectWorkId: string) => void;
  actions?: SdoCaseDetailActionHandlers;
  className?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось выполнить действие';
}

function StatusActionControl({
  status,
  label,
  requiresReason,
  reasonMissingMessage,
  onSubmit,
}: {
  status: SdoClosingStatus;
  label: string;
  /** F8.3-15 — true for the VERIFICATION_PASSED -> ON_CORRECTION and CLOSED -> ON_CORRECTION edges only, never for ON_RECONCILIATION -> ON_CORRECTION ("start correcting" is not "undo a completed step"). Mirrors the backend's own mandatory-reason rule, only for a clearer error before the round trip. */
  requiresReason: boolean;
  /** F8.3-15 — worded for the actual source status: "закрытого дела" is only accurate when the Case really is CLOSED, so VERIFICATION_PASSED gets its own, source-neutral wording. */
  reasonMissingMessage: string;
  onSubmit: (status: SdoClosingStatus, reason: string | undefined) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (requiresReason && !reason.trim()) {
      setError(reasonMissingMessage);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSubmit(status, reason.trim() || undefined);
      setReason('');
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={styles.inlineForm}>
      {requiresReason ? (
        <input
          className={styles.input}
          type="text"
          placeholder="Причина возврата на корректировку"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={pending}
          aria-label={`Причина: ${label}`}
        />
      ) : null}
      <button type="button" className={styles.actionButton} onClick={handleClick} disabled={pending}>
        {pending ? 'Сохранение…' : label}
      </button>
      {error ? <span className={styles.errorText}>{error}</span> : null}
    </div>
  );
}

function AmountForm({ onSubmit }: { onSubmit: (amount: string) => Promise<void> }) {
  const [amount, setAmount] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!amount.trim()) {
      setError('Укажите сумму закрытия');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSubmit(amount.trim());
      setAmount('');
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className={styles.inlineForm} onSubmit={handleSubmit}>
      <input
        className={styles.input}
        type="text"
        inputMode="decimal"
        placeholder="Сумма закрытия"
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        disabled={pending}
        aria-label="Новая сумма закрытия"
      />
      <button type="submit" className={styles.actionButton} disabled={pending}>
        {pending ? 'Сохранение…' : 'Сохранить сумму'}
      </button>
      {error ? <span className={styles.errorText}>{error}</span> : null}
    </form>
  );
}

/**
 * F8.3-R05 corrective — every covered Portion is selectable, not only an
 * unallocated one: picking a Portion that already has an allocation submits
 * with its `version` (a correction); picking one with none submits with no
 * version (the first allocation). The amount field is never prefilled from
 * `allocatedAmount` — that is a display string (`formatMoney`, e.g. "750,00
 * ₽"), not a value the backend's `money` schema (a plain decimal string)
 * would accept back unedited — so the actor always types the (new) amount.
 * The backend remains the sole authority on both the exact-sum-for-CLOSED
 * rule and the optimistic-concurrency check.
 */
function AllocationForm({
  portions,
  onSubmit,
}: {
  portions: SdoCaseDetailViewModel['portions'];
  onSubmit: (quantityPortionId: string, amount: string, version: number | undefined) => Promise<void>;
}) {
  const [selected, setSelected] = useState('');
  const [amount, setAmount] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (portions.length === 0) return null;
  const selectedPortion = portions.find((portion) => portion.id === selected) ?? null;

  function handleSelect(portionId: string) {
    setSelected(portionId);
    setError(null);
    setAmount('');
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!selected || !amount.trim()) {
      setError('Выберите участок и укажите сумму');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSubmit(selected, amount.trim(), selectedPortion?.allocationVersion ?? undefined);
      setSelected('');
      setAmount('');
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className={styles.inlineForm} onSubmit={handleSubmit}>
      <select
        className={styles.input}
        value={selected}
        onChange={(event) => handleSelect(event.target.value)}
        disabled={pending}
        aria-label="Участок для распределения суммы"
      >
        <option value="">Выберите участок…</option>
        {portions.map((portion) => (
          <option key={portion.id} value={portion.id}>
            {portion.label}
            {portion.allocatedAmount !== null ? ` (текущее: ${portion.allocatedAmount})` : ''}
          </option>
        ))}
      </select>
      <input
        className={styles.input}
        type="text"
        inputMode="decimal"
        placeholder="Сумма по участку"
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        disabled={pending}
        aria-label="Сумма распределения по участку"
      />
      <button type="submit" className={styles.actionButton} disabled={pending}>
        {pending ? 'Сохранение…' : selectedPortion && selectedPortion.allocatedAmount !== null ? 'Исправить распределение' : 'Добавить распределение'}
      </button>
      {error ? <span className={styles.errorText}>{error}</span> : null}
    </form>
  );
}

/**
 * F8.3-19 — a small, explicit control per allocated Portion: cancelling
 * returns that Portion to "no active allocation" while the record itself is
 * preserved (`allocationHistory` below shows the CANCEL row). Rendered only
 * for a Portion with `canCancel` true (an active allocation exists) — a
 * cancelled or never-allocated Portion has nothing to cancel.
 */
function CancelAllocationControl({
  portionId,
  version,
  onSubmit,
}: {
  portionId: string;
  version: number;
  onSubmit: (quantityPortionId: string, version: number) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setPending(true);
    setError(null);
    try {
      await onSubmit(portionId, version);
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setPending(false);
    }
  }

  return (
    <span className={styles.inlineForm}>
      <button type="button" className={styles.actionButtonSecondary} onClick={handleClick} disabled={pending}>
        {pending ? 'Отмена…' : 'Отменить распределение'}
      </button>
      {error ? <span className={styles.errorText}>{error}</span> : null}
    </span>
  );
}

function ResponsibleForm({
  sdoUsers,
  onSubmit,
}: {
  sdoUsers: UserSummary[];
  onSubmit: (responsibleUserId: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (sdoUsers.length === 0) {
    return <span className={styles.errorText}>Нет активных сотрудников СДО</span>;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!selected) {
      setError('Выберите сотрудника СДО');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSubmit(selected);
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className={styles.inlineForm} onSubmit={handleSubmit}>
      <select
        className={styles.input}
        value={selected}
        onChange={(event) => setSelected(event.target.value)}
        disabled={pending}
        aria-label="Ответственный сотрудник СДО"
      >
        <option value="">Выберите сотрудника СДО…</option>
        {sdoUsers.map((user) => (
          <option key={user.id} value={user.id}>
            {user.name}
          </option>
        ))}
      </select>
      <button type="submit" className={styles.actionButton} disabled={pending}>
        {pending ? 'Сохранение…' : 'Назначить ответственного'}
      </button>
      {error ? <span className={styles.errorText}>{error}</span> : null}
    </form>
  );
}

function ReturnToPtoControl({ onSubmit }: { onSubmit: (comment: string | undefined) => Promise<void> }) {
  const [comment, setComment] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setPending(true);
    setError(null);
    try {
      await onSubmit(comment.trim() || undefined);
      setComment('');
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={styles.inlineForm}>
      <input
        className={styles.input}
        type="text"
        placeholder="Комментарий (необязательно)"
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        disabled={pending}
        aria-label="Комментарий к возврату в ПТО"
      />
      <button type="button" className={styles.actionButtonSecondary} onClick={handleClick} disabled={pending}>
        {pending ? 'Возврат…' : 'Вернуть в ПТО'}
      </button>
      {error ? <span className={styles.errorText}>{error}</span> : null}
    </div>
  );
}

export function SdoCaseDetail({
  viewModel,
  sidebar,
  topbar,
  onNavigateHome,
  onSelectObject,
  onSelectWork,
  actions,
  className,
}: SdoCaseDetailProps) {
  return (
    <AppShell sidebar={sidebar} topbar={topbar} className={className}>
      <Breadcrumb
        items={[
          { label: 'СДО', onSelect: onNavigateHome },
          { label: viewModel.objectName, onSelect: () => onSelectObject(viewModel.objectId) },
          { label: viewModel.workName, onSelect: () => onSelectWork(viewModel.objectId, viewModel.objectWorkId) },
          { label: 'Дело СДО' },
        ]}
      />

      <PageHeader
        eyebrow="ДЕЛО СДО"
        title={viewModel.workName}
        description={`${viewModel.objectName} · Ответственный СДО: ${viewModel.responsible}`}
        actions={
          <div className={styles.headerActions}>
            <StatusBadge variant={viewModel.status.variant}>{viewModel.status.label}</StatusBadge>
            <StatusBadge variant={viewModel.packageLocked ? 'Blocked' : 'Neutral'}>
              {viewModel.packageLocked ? 'Состав пакета заблокирован' : 'Пакет возвращён в ПТО'}
            </StatusBadge>
          </div>
        }
      />

      {actions ? (
        <section className={styles.section}>
          <span className={[styles.sectionLabel, typeClass('label')].join(' ')}>Действия по статусу</span>
          {/* F8.3-R03: no status mutation while custody is with PTO (package_locked=false) — the backend now refuses it outright. */}
          {viewModel.packageLocked ? (
            <div className={styles.actionRow}>
              {viewModel.allowedActions.map((action) => (
                <StatusActionControl
                  key={action.status}
                  status={action.status}
                  label={action.label}
                  requiresReason={viewModel.reasonRequiredForCorrection && action.status === 'ON_CORRECTION'}
                  reasonMissingMessage={
                    viewModel.rawStatus === 'CLOSED'
                      ? 'Укажите причину возврата закрытого дела на корректировку'
                      : 'Укажите причину возврата на корректировку'
                  }
                  onSubmit={actions.onChangeStatus}
                />
              ))}
            </div>
          ) : (
            <span className={[styles.empty, typeClass('body')].join(' ')}>Дело приостановлено до повторной передачи в СДО</span>
          )}
          {/* F8.3-R04: a CLOSED case must go CLOSED -> ON_CORRECTION (with reason) first — direct return-to-PTO from CLOSED is refused server-side. */}
          {viewModel.packageLocked && viewModel.rawStatus !== 'CLOSED' ? <ReturnToPtoControl onSubmit={actions.onReturnToPto} /> : null}
        </section>
      ) : null}

      <section className={styles.section}>
        <span className={[styles.sectionLabel, typeClass('label')].join(' ')}>Ответственный СДО</span>
        <span className={typeClass('body-strong')}>{viewModel.responsible}</span>
        {/* F8.3-R03: responsible assignment stays administrative — available regardless of package_locked. */}
        {actions ? <ResponsibleForm sdoUsers={actions.sdoUsers} onSubmit={actions.onAssignResponsible} /> : null}
      </section>

      <section className={styles.section}>
        <span className={[styles.sectionLabel, typeClass('label')].join(' ')}>Сумма закрытия</span>
        <span className={typeClass('body-strong')}>{viewModel.totalAmount}</span>
        {/* F8.3-19: a CLOSED case must return to ON_CORRECTION first — the backend refuses this outright, same as F8.3-R04 already established for the case's own status. */}
        {actions && viewModel.packageLocked && viewModel.rawStatus !== 'CLOSED' ? <AmountForm onSubmit={actions.onSetAmount} /> : null}
      </section>

      <section className={styles.section}>
        <span className={[styles.sectionLabel, typeClass('label')].join(' ')}>Участки объёма</span>
        {viewModel.portions.length > 0 ? (
          <ul className={styles.plainList}>
            {viewModel.portions.map((portion) => (
              <li key={portion.id} className={styles.portionRow}>
                <span className={typeClass('body')}>
                  {portion.label} · {portion.plannedQuantity}
                </span>
                <span className={styles.portionRowTrailing}>
                  <span className={typeClass('body-strong')}>{portion.allocatedAmount ?? '—'}</span>
                  {actions && viewModel.packageLocked && viewModel.rawStatus !== 'CLOSED' && portion.canCancel ? (
                    <CancelAllocationControl
                      portionId={portion.id}
                      version={portion.allocationVersion!}
                      onSubmit={actions.onCancelAllocation}
                    />
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <span className={[styles.empty, typeClass('body')].join(' ')}>Пакет не покрывает ни одного участка</span>
        )}
        <span className={[typeClass('body'), styles.secondary].join(' ')}>Распределено: {viewModel.allocatedSum}</span>
        {actions && viewModel.packageLocked && viewModel.rawStatus !== 'CLOSED' ? (
          <AllocationForm portions={viewModel.portions} onSubmit={actions.onSetAllocation} />
        ) : null}
      </section>

      <section className={styles.section}>
        <span className={[styles.sectionLabel, typeClass('label')].join(' ')}>История статусов</span>
        {viewModel.statusHistory.length > 0 ? (
          <ul className={styles.plainList}>
            {viewModel.statusHistory.map((entry) => (
              <li key={entry.id} className={typeClass('body')}>
                <span className={styles.secondary}>{entry.changedAt}</span> · {entry.fromStatus.label} →{' '}
                {entry.toStatus.label}
                {entry.reason ? ` · ${entry.reason}` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <span className={[styles.empty, typeClass('body')].join(' ')}>Изменений статуса ещё не было</span>
        )}
      </section>

      <section className={styles.section}>
        <span className={[styles.sectionLabel, typeClass('label')].join(' ')}>История передачи/возврата</span>
        {viewModel.handoffHistory.length > 0 ? (
          <ul className={styles.plainList}>
            {viewModel.handoffHistory.map((entry) => (
              <li key={entry.id} className={typeClass('body')}>
                <span className={styles.secondary}>{entry.occurredAt}</span> · {entry.eventLabel}
                {entry.comment ? ` · ${entry.comment}` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <span className={[styles.empty, typeClass('body')].join(' ')}>Ещё не передавалось</span>
        )}
      </section>

      <section className={styles.section}>
        <span className={[styles.sectionLabel, typeClass('label')].join(' ')}>История суммы закрытия</span>
        {viewModel.amountHistory.length > 0 ? (
          <ul className={styles.plainList}>
            {viewModel.amountHistory.map((entry) => (
              <li key={entry.id} className={typeClass('body')}>
                <span className={styles.secondary}>{entry.changedAt}</span> · {entry.previousAmount} →{' '}
                {entry.newAmount}
              </li>
            ))}
          </ul>
        ) : (
          <span className={[styles.empty, typeClass('body')].join(' ')}>Сумма ещё не указывалась</span>
        )}
      </section>

      <section className={styles.section}>
        <span className={[styles.sectionLabel, typeClass('label')].join(' ')}>История распределения по участкам</span>
        {viewModel.allocationHistory.length > 0 ? (
          <ul className={styles.plainList}>
            {viewModel.allocationHistory.map((entry) => (
              <li key={entry.id} className={typeClass('body')}>
                <span className={styles.secondary}>{entry.changedAt}</span> · {entry.portionLabel} ·{' '}
                {entry.previousAmount} → {entry.newAmount} · {entry.operationLabel}
              </li>
            ))}
          </ul>
        ) : (
          <span className={[styles.empty, typeClass('body')].join(' ')}>Распределение ещё не указывалось</span>
        )}
      </section>
    </AppShell>
  );
}
