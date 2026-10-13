import { useState, type FormEvent, type ReactNode } from 'react';
import { AppShell, Breadcrumb, PageHeader, StatusBadge, typeClass } from '../../design-system';
import type {
  DocumentationDocumentType,
  DocumentationPackageStatus,
  StorageProvider,
} from '../../types/api';
import type { PackageDetailViewModel } from '../../view-models/documentationPackage';
import { documentTypeLabel, storageProviderLabel } from '../../view-models/documentationPackage';
import { documentationPackageStatusPresentation } from '../../view-models/status';
import styles from './PackageDetail.module.css';

/**
 * Package Detail — the working surface for one Documentation Package: its
 * status and history, linked Quantity Portions, its documents and each
 * document's versions. Reachable from both P01's "Открыть"/"Создать пакет"
 * and W01's own "Открыть пакет" (Decision 1: one shared destination, not two
 * independent screens).
 *
 * `actions` follows the same convention `ExecutionSection.tsx`/P01 already
 * use: `undefined` (no session, or a role `canManageDocumentation` excludes)
 * renders every section read-only, no forms or buttons — RP/SC/oversight
 * roles see the package exactly as it is, never a control to change it
 * (Decision 3).
 */

/**
 * Types the generic «Создать документ» form may create as a bare slot. АОСР and executive schemes have dedicated flows (a generated
 * Core AOSR; a scheme uploaded WITH its file) and are never offered as an empty shell — the backend refuses them too.
 */
export const GENERIC_DOCUMENT_TYPES: DocumentationDocumentType[] = ['ACT_CERTIFICATE'];
export const DEDICATED_DOCUMENT_FLOWS_TEXT = 'АОСР формируются, а исполнительные схемы загружаются в своих блоках выше — отдельно как пустой документ они не создаются.';
const STORAGE_PROVIDERS: StorageProvider[] = ['NONE', 'EXTERNAL_REFERENCE'];

export interface PackageDetailActionHandlers {
  onAdvanceStatus: (nextStatus: DocumentationPackageStatus, comment: string) => Promise<void>;
  onLinkPortion: (quantityPortionId: string) => Promise<void>;
  onCreateDocument: (type: DocumentationDocumentType) => Promise<void>;
  onCreateVersion: (
    documentId: string,
    storageProvider: StorageProvider,
    storageReference: string | undefined,
    comment: string | undefined,
  ) => Promise<void>;
  /**
   * F8.3 decisions 9-10 — the dedicated, audited registration; never routed
   * through `onAdvanceStatus`. F8.3-R01 corrective: optional, not required —
   * PTO only (the backend now refuses ADMIN outright despite ADMIN otherwise
   * holding `canManageDocumentation`'s DOCUMENTATION_MANAGE); the route
   * container omits this field entirely for a non-PTO actor.
   */
  onRegisterCustomerAcceptance?: (acceptedDate: string, reference: string | undefined, comment: string | undefined) => Promise<void>;
  /**
   * F8.3 "Передать в СДО" — enabled only once `viewModel.sdo.canHandoffToSdo`
   * is true; the backend re-checks readiness regardless. F8.3-R01 corrective:
   * optional, PTO only — see `onRegisterCustomerAcceptance` above.
   */
  /** F12.3 FINAL-R02: `idempotencyKey` is minted once per logical handoff attempt by `HandoffToSdoControl` below and reused across every retry. */
  onHandoffToSdo?: (comment: string | undefined, idempotencyKey: string) => Promise<void>;
  /**
   * F8.3-17 "Вернуть на корректировку" — the dedicated, audited, PTO-only,
   * pre-handoff-only operation; never routed through `onAdvanceStatus` (the
   * backend's own transition allow-list still has `ACCEPTED_BY_CUSTOMER:
   * []`). Optional, PTO only — see `onRegisterCustomerAcceptance` above for
   * the same convention. Enabled only once `viewModel.sdo.canReturnToCorrection`
   * is true; the backend re-checks (status, no SDO Case, role) regardless.
   */
  onReturnToCorrection?: (comment: string | undefined) => Promise<void>;
  /**
   * Soft archive — an obsolete / test package leaves the working set (never a delete, never a status). Offered only when the server says the
   * package may be archived right now (`viewModel.identity.canArchive`) AND the actor may do it (the route omits this for anyone else).
   */
  onArchive?: (reason: string) => Promise<void>;
}

export interface PackageDetailProps {
  viewModel: PackageDetailViewModel;
  sidebar: ReactNode;
  topbar?: ReactNode;
  onNavigateHome: () => void;
  onSelectObject: (objectId: string) => void;
  onSelectWork: (objectId: string, objectWorkId: string) => void;
  /** Omitted (no session, or a role other than PTO/ADMIN) renders every section read-only. */
  actions?: PackageDetailActionHandlers;
  /** ID-AUTO-1 — the АОСР / accepted-quantity sections, built by the route container (data chain stays out of this screen). */
  aosrSection?: ReactNode;
  /** ID-AUTO-2 — back to this object's «Реестр ИД». Omitted when the viewer has no documentation access. */
  onOpenRegistry?: () => void;
  className?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось выполнить действие';
}

function AdvanceStatusControl({
  nextStatus,
  nextStatusLabel,
  onSubmit,
}: {
  nextStatus: DocumentationPackageStatus;
  nextStatusLabel: string;
  onSubmit: (nextStatus: DocumentationPackageStatus, comment: string) => Promise<void>;
}) {
  const [comment, setComment] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setPending(true);
    setError(null);
    try {
      await onSubmit(nextStatus, comment.trim());
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
        aria-label="Комментарий к смене статуса"
      />
      <button type="button" className={styles.actionButton} onClick={handleClick} disabled={pending}>
        {pending ? 'Сохранение…' : nextStatusLabel}
      </button>
      {error ? <span className={styles.errorText}>{error}</span> : null}
    </div>
  );
}

function LinkPortionForm({
  availablePortions,
  onSubmit,
}: {
  availablePortions: PackageDetailViewModel['availablePortions'];
  onSubmit: (quantityPortionId: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (availablePortions.length === 0)
    return <span className={[styles.empty, typeClass('body')].join(' ')}>Нет свободных участков: все доступные участки уже включены в активные пакеты ИД.</span>;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!selected) {
      setError('Выберите участок');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSubmit(selected);
      setSelected('');
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
        aria-label="Участок для привязки"
      >
        <option value="">Выберите участок…</option>
        {availablePortions.map((portion) => (
          <option key={portion.id} value={portion.id}>
            {portion.label}
          </option>
        ))}
      </select>
      <button type="submit" className={styles.actionButton} disabled={pending}>
        {pending ? 'Привязка…' : 'Привязать участок'}
      </button>
      {error ? <span className={styles.errorText}>{error}</span> : null}
    </form>
  );
}

function todayCivilDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function CustomerAcceptanceForm({
  onSubmit,
}: {
  onSubmit: (acceptedDate: string, reference: string | undefined, comment: string | undefined) => Promise<void>;
}) {
  const [acceptedDate, setAcceptedDate] = useState(todayCivilDate());
  const [reference, setReference] = useState('');
  const [comment, setComment] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await onSubmit(acceptedDate, reference.trim() || undefined, comment.trim() || undefined);
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
        type="date"
        value={acceptedDate}
        onChange={(event) => setAcceptedDate(event.target.value)}
        disabled={pending}
        aria-label="Дата согласия заказчика"
      />
      <input
        className={styles.input}
        type="text"
        placeholder="Номер акта (необязательно)"
        value={reference}
        onChange={(event) => setReference(event.target.value)}
        disabled={pending}
        aria-label="Номер акта согласия"
      />
      <input
        className={styles.input}
        type="text"
        placeholder="Комментарий (необязательно)"
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        disabled={pending}
        aria-label="Комментарий к согласию заказчика"
      />
      <button type="submit" className={styles.actionButton} disabled={pending}>
        {pending ? 'Сохранение…' : 'Зарегистрировать согласие заказчика'}
      </button>
      {error ? <span className={styles.errorText}>{error}</span> : null}
    </form>
  );
}

function HandoffToSdoControl({ onSubmit }: { onSubmit: (comment: string | undefined, idempotencyKey: string) => Promise<void> }) {
  const [comment, setComment] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // F12.3 FINAL-R02 (LOCKED DECISION 2): one key per logical attempt, reused
  // across every retry of that same attempt; a fresh key is minted only
  // once an attempt actually succeeds.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  async function handleClick() {
    setPending(true);
    setError(null);
    try {
      await onSubmit(comment.trim() || undefined, idempotencyKey);
      setComment('');
      setIdempotencyKey(crypto.randomUUID());
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
        aria-label="Комментарий к передаче в СДО"
      />
      <button type="button" className={styles.actionButton} onClick={handleClick} disabled={pending}>
        {pending ? 'Передача…' : 'Передать в СДО'}
      </button>
      {error ? <span className={styles.errorText}>{error}</span> : null}
    </div>
  );
}

function ReturnToCorrectionControl({ onSubmit }: { onSubmit: (comment: string | undefined) => Promise<void> }) {
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
        aria-label="Комментарий к возврату на корректировку"
      />
      <button type="button" className={styles.actionButton} onClick={handleClick} disabled={pending}>
        {pending ? 'Возврат…' : 'Вернуть на корректировку'}
      </button>
      {error ? <span className={styles.errorText}>{error}</span> : null}
    </div>
  );
}

/**
 * A bare «Создать документ» makes a typed SHELL with no version (that is how an untitled, version-less AOSR record got into LIVE: the
 * default option is the first type and nothing else is asked). Types that have their own one-step flow are therefore not offered here:
 * a Core AOSR is created by the AOSR section / generation, an executive scheme only together with its file.
 */
function CreateDocumentForm({ onSubmit }: { onSubmit: (type: DocumentationDocumentType) => Promise<void> }) {
  const options = GENERIC_DOCUMENT_TYPES;
  const [type, setType] = useState<DocumentationDocumentType>(options[0] ?? 'ACT_CERTIFICATE');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await onSubmit(type);
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className={styles.inlineForm} onSubmit={handleSubmit}>
      {options.length > 1 ? (
        <select
          className={styles.input}
          value={type}
          onChange={(event) => setType(event.target.value as DocumentationDocumentType)}
          disabled={pending}
          aria-label="Тип документа"
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {documentTypeLabel(option)}
            </option>
          ))}
        </select>
      ) : (
        <span className={typeClass('body')}>{documentTypeLabel(options[0] ?? 'ACT_CERTIFICATE')}</span>
      )}
      <button type="submit" className={styles.actionButton} disabled={pending}>
        {pending ? 'Создание…' : 'Создать документ'}
      </button>
      {error ? <span className={styles.errorText}>{error}</span> : null}
      <span className={[styles.secondary, typeClass('body')].join(' ')}>{DEDICATED_DOCUMENT_FLOWS_TEXT}</span>
    </form>
  );
}

function CreateVersionForm({
  documentId,
  onSubmit,
}: {
  documentId: string;
  onSubmit: (
    documentId: string,
    storageProvider: StorageProvider,
    storageReference: string | undefined,
    comment: string | undefined,
  ) => Promise<void>;
}) {
  const [storageProvider, setStorageProvider] = useState<StorageProvider>('NONE');
  const [storageReference, setStorageReference] = useState('');
  const [comment, setComment] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (storageProvider === 'EXTERNAL_REFERENCE' && !storageReference.trim()) {
      setError('Ссылка обязательна для внешней ссылки на хранилище');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSubmit(
        documentId,
        storageProvider,
        storageProvider === 'EXTERNAL_REFERENCE' ? storageReference.trim() : undefined,
        comment.trim() || undefined,
      );
      setStorageReference('');
      setComment('');
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
        value={storageProvider}
        onChange={(event) => setStorageProvider(event.target.value as StorageProvider)}
        disabled={pending}
        aria-label="Хранилище версии документа"
      >
        {STORAGE_PROVIDERS.map((option) => (
          <option key={option} value={option}>
            {storageProviderLabel(option)}
          </option>
        ))}
      </select>
      {storageProvider === 'EXTERNAL_REFERENCE' ? (
        <input
          className={styles.input}
          type="text"
          placeholder="Ссылка на документ"
          value={storageReference}
          onChange={(event) => setStorageReference(event.target.value)}
          disabled={pending}
          aria-label="Ссылка на документ"
        />
      ) : null}
      <input
        className={styles.input}
        type="text"
        placeholder="Комментарий (необязательно)"
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        disabled={pending}
        aria-label="Комментарий к версии"
      />
      <button type="submit" className={styles.actionButton} disabled={pending}>
        {pending ? 'Сохранение…' : 'Добавить версию'}
      </button>
      {error ? <span className={styles.errorText}>{error}</span> : null}
    </form>
  );
}

/** The package card's answers (Work, scope, current quantity, AOSR method, responsible, creator) plus — for an archived package — who/when/why. */
function PackageIdentitySection({ viewModel }: { viewModel: PackageDetailViewModel }) {
  const { identity } = viewModel;
  return (
    <section className={styles.section} aria-label="Пакет">
      {identity.archive ? (
        <div className={styles.archivedBanner} role="note">
          <span className={typeClass('body-strong')}>{identity.archive.badgeText}</span>
          <span className={typeClass('body')}>{identity.archive.byText}</span>
          <span className={typeClass('body')}>{identity.archive.reasonText}</span>
          <span className={[styles.secondary, typeClass('body')].join(' ')}>
            Пакет сохранён для аудита вместе с документами, способом АОСР, участками и историей. Новые действия по нему недоступны.
          </span>
        </div>
      ) : null}
      <dl className={styles.identityGrid}>
        <div className={styles.identityRow}>
          <dt className={[styles.sectionLabel, typeClass('label')].join(' ')}>Работа</dt>
          <dd className={typeClass('body-strong')}>{identity.workName}</dd>
        </div>
        <div className={styles.identityRow}>
          <dt className={[styles.sectionLabel, typeClass('label')].join(' ')}>Участок</dt>
          <dd className={[identity.scopeMissing ? styles.errorText : '', typeClass('body-strong')].join(' ')}>{identity.scopeText}</dd>
        </div>
        <div className={styles.identityRow}>
          <dt className={[styles.sectionLabel, typeClass('label')].join(' ')}>Текущий объём</dt>
          <dd className={typeClass('body-strong')}>
            {identity.quantityText ?? '—'}
            {identity.quantitySourceText ? <span className={[styles.secondary, typeClass('body')].join(' ')}> · {identity.quantitySourceText}</span> : null}
          </dd>
        </div>
        <div className={styles.identityRow}>
          <dt className={[styles.sectionLabel, typeClass('label')].join(' ')}>АОСР</dt>
          <dd className={typeClass('body-strong')}>{identity.methodText}</dd>
        </div>
        <div className={styles.identityRow}>
          <dt className={[styles.sectionLabel, typeClass('label')].join(' ')}>Ответственный ПТО</dt>
          <dd className={typeClass('body-strong')}>{identity.responsible}</dd>
        </div>
      </dl>
      <span className={[styles.secondary, typeClass('label')].join(' ')}>{identity.createdText}</span>
      {identity.scopeMissing && !identity.archive ? (
        <span className={[styles.errorText, typeClass('body')].join(' ')}>
          Участок не выбран: пакет нельзя продвигать дальше, пока не выбран участок производства (его можно добавить ниже).
        </span>
      ) : null}
    </section>
  );
}

export const ARCHIVE_REASON_PRESETS = ['Тестовый пакет', 'Создан ошибочно', 'Пакет больше не используется'] as const;

/** «Архивировать пакет» — restrained: collapsed by default, a mandatory reason, and an explicit confirmation before anything happens. */
function ArchivePackageControl({ onSubmit }: { onSubmit: (reason: string) => Promise<void> }) {
  const [step, setStep] = useState<'closed' | 'form' | 'confirm'>('closed');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = reason.trim();

  async function handleConfirm() {
    setPending(true);
    setError(null);
    try {
      await onSubmit(trimmed);
    } catch (submitError) {
      setError(errorMessage(submitError));
      setStep('form');
    } finally {
      setPending(false);
    }
  }

  if (step === 'closed') {
    return (
      <button type="button" className={styles.archiveLink} onClick={() => setStep('form')}>
        Архивировать пакет
      </button>
    );
  }
  return (
    <div className={styles.archiveBox} role="group" aria-label="Архивирование пакета">
      <span className={[styles.secondary, typeClass('body')].join(' ')}>
        Пакет будет скрыт из рабочего списка и перестанет занимать участки. Удалить пакет нельзя: он и его история сохраняются.
      </span>
      {step === 'form' ? (
        <>
          <label className={typeClass('label')} htmlFor="archive-reason">Причина архивирования</label>
          <input
            id="archive-reason"
            className={styles.input}
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            disabled={pending}
            placeholder="Например: Тестовый пакет"
          />
          <div className={styles.inlineForm}>
            {ARCHIVE_REASON_PRESETS.map((preset) => (
              <button key={preset} type="button" className={styles.chipButton} onClick={() => setReason(preset)}>
                {preset}
              </button>
            ))}
          </div>
          <div className={styles.inlineForm}>
            <button type="button" className={styles.actionButton} disabled={trimmed.length === 0} onClick={() => setStep('confirm')}>
              Продолжить
            </button>
            <button type="button" className={styles.chipButton} onClick={() => { setStep('closed'); setReason(''); setError(null); }}>
              Отмена
            </button>
          </div>
        </>
      ) : (
        <>
          <span className={typeClass('body-strong')}>Архивировать пакет? Причина: «{trimmed}»</span>
          <div className={styles.inlineForm}>
            <button type="button" className={styles.actionButton} disabled={pending} onClick={handleConfirm}>
              {pending ? 'Архивирование…' : 'Да, архивировать'}
            </button>
            <button type="button" className={styles.chipButton} disabled={pending} onClick={() => setStep('form')}>
              Назад
            </button>
          </div>
        </>
      )}
      {error ? <span className={styles.errorText}>{error}</span> : null}
    </div>
  );
}

export function PackageDetail({
  viewModel,
  sidebar,
  topbar,
  onNavigateHome,
  onSelectObject,
  onSelectWork,
  actions,
  aosrSection,
  onOpenRegistry,
  className,
}: PackageDetailProps) {
  return (
    <AppShell sidebar={sidebar} topbar={topbar} className={className}>
      <Breadcrumb
        items={[
          { label: 'Портфель', onSelect: onNavigateHome },
          { label: viewModel.objectName, onSelect: () => onSelectObject(viewModel.objectId) },
          {
            label: viewModel.workName,
            onSelect: () => onSelectWork(viewModel.objectId, viewModel.objectWorkId),
          },
          { label: 'Пакет ИД' },
        ]}
      />

      <PageHeader
        eyebrow="ПАКЕТ ИД"
        title={viewModel.workName}
        description={`${viewModel.objectName} · Ответственный ПТО: ${viewModel.responsible}`}
        actions={
          <div className={styles.headerActions}>
            <StatusBadge variant={viewModel.status.variant}>{viewModel.status.label}</StatusBadge>
            {viewModel.identity.archive ? <StatusBadge variant="Neutral">{viewModel.identity.archive.badgeText}</StatusBadge> : null}
            {onOpenRegistry ? (
              <button type="button" className={styles.registryButton} onClick={onOpenRegistry}>
                Реестр ИД объекта
              </button>
            ) : null}
            {actions && !viewModel.identity.archive && viewModel.nextStatus && viewModel.nextStatusLabel ? (
              <AdvanceStatusControl
                nextStatus={viewModel.nextStatus}
                nextStatusLabel={viewModel.nextStatusLabel}
                onSubmit={actions.onAdvanceStatus}
              />
            ) : null}
          </div>
        }
      />

      <PackageIdentitySection viewModel={viewModel} />

      <section className={styles.section} id="package-focus-scope">
        <span className={[styles.sectionLabel, typeClass('label')].join(' ')}>Участки</span>
        {viewModel.portions.length > 0 ? (
          <ul className={styles.plainList}>
            {viewModel.portions.map((portion) => (
              <li key={portion.id} className={typeClass('body')}>
                {portion.label}
                {portion.quantityText ? <span className={styles.secondary}> · {portion.quantityText}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <span className={[styles.empty, typeClass('body')].join(' ')}>Участок не выбран</span>
        )}
        {actions && viewModel.contentEditable && !viewModel.identity.archive ? (
          <LinkPortionForm availablePortions={viewModel.availablePortions} onSubmit={actions.onLinkPortion} />
        ) : null}
      </section>

      {viewModel.identity.archive ? null : (
        <>
        {aosrSection}

        <section className={styles.section}>
          <span className={[styles.sectionLabel, typeClass('label')].join(' ')}>СДО / Закрытие</span>
          <StatusBadge variant={viewModel.sdo.packageLocked ? 'Blocked' : viewModel.sdo.ready ? 'OnTrack' : 'Neutral'}>
            {viewModel.sdo.packageLocked
              ? 'Состав пакета заблокирован: передан в СДО'
              : viewModel.sdo.ready
                ? 'Готов к передаче в СДО'
                : 'Не готов к передаче в СДО'}
          </StatusBadge>
          {!viewModel.sdo.ready && viewModel.sdo.missingReasons.length > 0 ? (
            <ul className={styles.plainList}>
              {viewModel.sdo.missingReasons.map((reason) => (
                <li key={reason} className={typeClass('body')}>
                  {reason}
                </li>
              ))}
            </ul>
          ) : null}
          {viewModel.sdo.customerAcceptance ? (
            <span className={typeClass('body')}>
              Согласие заказчика зарегистрировано {viewModel.sdo.customerAcceptance.acceptedDate}
              {viewModel.sdo.customerAcceptance.reference ? ` · ${viewModel.sdo.customerAcceptance.reference}` : ''}
            </span>
          ) : null}
          {actions?.onRegisterCustomerAcceptance && viewModel.sdo.canRegisterCustomerAcceptance ? (
            <CustomerAcceptanceForm onSubmit={actions.onRegisterCustomerAcceptance} />
          ) : null}
          {actions?.onHandoffToSdo && viewModel.sdo.canHandoffToSdo ? <HandoffToSdoControl onSubmit={actions.onHandoffToSdo} /> : null}
          {actions?.onReturnToCorrection && viewModel.sdo.canReturnToCorrection ? (
            <ReturnToCorrectionControl onSubmit={actions.onReturnToCorrection} />
          ) : null}
        </section>

        <section className={styles.section}>
          <span className={[styles.sectionLabel, typeClass('label')].join(' ')}>Документы</span>
          {viewModel.documents.length > 0 ? (
            <div className={styles.documentList}>
              {viewModel.documents.map((doc) => (
                <div key={doc.id} className={styles.documentCard}>
                  <span className={typeClass('body-strong')}>{doc.typeLabel}</span>
                  {doc.versions.length > 0 ? (
                    <ul className={styles.plainList}>
                      {doc.versions.map((version) => (
                        <li key={version.id} className={typeClass('body')}>
                          <span className={typeClass('body-strong')}>v{version.versionNumber}</span>{' '}
                          <span className={styles.secondary}>{version.storageProviderLabel}</span>
                          {version.storageReference ? ` · ${version.storageReference}` : ''}
                          {version.comment ? ` · ${version.comment}` : ''}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className={[styles.empty, typeClass('body')].join(' ')}>Версий ещё нет</span>
                  )}
                  {actions && viewModel.contentEditable ? <CreateVersionForm documentId={doc.id} onSubmit={actions.onCreateVersion} /> : null}
                </div>
              ))}
            </div>
          ) : (
            <span className={[styles.empty, typeClass('body')].join(' ')}>Документы ещё не созданы</span>
          )}
          {actions && viewModel.contentEditable ? <CreateDocumentForm onSubmit={actions.onCreateDocument} /> : null}
        </section>

        <section className={styles.section}>
          <span className={[styles.sectionLabel, typeClass('label')].join(' ')}>История статусов</span>
          {viewModel.history.length > 0 ? (
            <ul className={styles.plainList}>
              {viewModel.history.map((entry) => (
                <li key={entry.id} className={typeClass('body')}>
                  <span className={styles.secondary}>{entry.changedAt}</span> ·{' '}
                  {documentationPackageStatusPresentation(entry.fromStatus).label} →{' '}
                  {documentationPackageStatusPresentation(entry.toStatus).label}
                  {entry.comment ? ` · ${entry.comment}` : ''}
                </li>
              ))}
            </ul>
          ) : (
            <span className={[styles.empty, typeClass('body')].join(' ')}>Изменений статуса ещё не было</span>
          )}
        </section>

          {actions?.onArchive && viewModel.identity.canArchive ? (
            <section className={styles.section} aria-label="Архив">
              <ArchivePackageControl onSubmit={actions.onArchive} />
            </section>
          ) : null}
        </>
      )}
    </AppShell>
  );
}
