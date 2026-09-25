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

const DOCUMENT_TYPES: DocumentationDocumentType[] = ['AOSR', 'ACT_CERTIFICATE', 'EXECUTIVE_SCHEME'];
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

  if (availablePortions.length === 0) return null;

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

function CreateDocumentForm({ onSubmit }: { onSubmit: (type: DocumentationDocumentType) => Promise<void> }) {
  const [type, setType] = useState<DocumentationDocumentType>('AOSR');
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
      <select
        className={styles.input}
        value={type}
        onChange={(event) => setType(event.target.value as DocumentationDocumentType)}
        disabled={pending}
        aria-label="Тип документа"
      >
        {DOCUMENT_TYPES.map((option) => (
          <option key={option} value={option}>
            {documentTypeLabel(option)}
          </option>
        ))}
      </select>
      <button type="submit" className={styles.actionButton} disabled={pending}>
        {pending ? 'Создание…' : 'Создать документ'}
      </button>
      {error ? <span className={styles.errorText}>{error}</span> : null}
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

export function PackageDetail({
  viewModel,
  sidebar,
  topbar,
  onNavigateHome,
  onSelectObject,
  onSelectWork,
  actions,
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
            {actions && viewModel.nextStatus && viewModel.nextStatusLabel ? (
              <AdvanceStatusControl
                nextStatus={viewModel.nextStatus}
                nextStatusLabel={viewModel.nextStatusLabel}
                onSubmit={actions.onAdvanceStatus}
              />
            ) : null}
          </div>
        }
      />

      <section className={styles.section}>
        <span className={[styles.sectionLabel, typeClass('label')].join(' ')}>Участки</span>
        {viewModel.portions.length > 0 ? (
          <ul className={styles.plainList}>
            {viewModel.portions.map((portion) => (
              <li key={portion.id} className={typeClass('body')}>
                {portion.label}
              </li>
            ))}
          </ul>
        ) : (
          <span className={[styles.empty, typeClass('body')].join(' ')}>Участки ещё не привязаны</span>
        )}
        {actions ? (
          <LinkPortionForm availablePortions={viewModel.availablePortions} onSubmit={actions.onLinkPortion} />
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
                {actions ? <CreateVersionForm documentId={doc.id} onSubmit={actions.onCreateVersion} /> : null}
              </div>
            ))}
          </div>
        ) : (
          <span className={[styles.empty, typeClass('body')].join(' ')}>Документы ещё не созданы</span>
        )}
        {actions ? <CreateDocumentForm onSubmit={actions.onCreateDocument} /> : null}
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
    </AppShell>
  );
}
