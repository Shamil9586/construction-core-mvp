import { useState, type FormEvent } from 'react';
import { StatusBadge, typeClass } from '../../design-system';
import type { W01ExecutionUnitViewModel, W01PortionViewModel } from '../../view-models/w01';
import { confirmationVariant, confirmationLabel } from '../../view-models/w01';
import styles from './ExecutionSection.module.css';

/**
 * F8.1 (Phase 4) — the three minimal operational actions on a Quantity
 * Portion: RP enters fact, portions management (create), Internal SC
 * decision registration. No Customer SC anywhere here — see w01.ts's module
 * comment.
 *
 * Local to W01 on purpose: the design system (F0/F1) is explicitly out of
 * scope for F8.1 and has no form controls to build this from (`Button` is
 * its only control). These are plain `<input>`/`<textarea>` elements styled
 * with the same `--cc-*` tokens the design system already publishes
 * globally, not new design-system components — nothing under
 * `design-system/` is added to or changed.
 *
 * Every handler prop returns a `Promise` that rejects with the backend's own
 * message on failure (see `data/executionUnitsApi.ts`); each form shows that
 * message inline and leaves its fields as the user left them, rather than
 * guessing a correction.
 */

export interface W01ActionHandlers {
  onRecordFact: (portionId: string, quantity: number, version: number, comment: string) => Promise<void>;
  onCreatePortion: (executionUnitId: string, label: string, plannedQuantity: number) => Promise<void>;
  onRequestInternalSc: (portionId: string, version: number) => Promise<void>;
  /**
   * `quantity` is the inspector's own independently confirmed figure —
   * required by the backend for `decision: 'accept'` (never defaulted or
   * copied from RP fact there), `undefined` for `decision: 'reject'`, which
   * confirms nothing.
   */
  onRegisterInternalScDecision: (
    inspectionId: string,
    version: number,
    decision: 'accept' | 'reject',
    comment: string,
    photo: { fileName: string; mimeType: 'image/png' | 'image/jpeg'; base64: string },
    quantity?: number,
  ) => Promise<void>;
}

export interface ExecutionSectionProps {
  executionUnits: W01ExecutionUnitViewModel[];
  /** Omitted (Gallery preview, or no real session) renders status only — no forms, no buttons. */
  actions?: W01ActionHandlers;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось выполнить действие';
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      // "data:image/png;base64,AAAA..." — only the payload after the comma.
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

function FactForm({
  portion,
  onSubmit,
}: {
  portion: W01PortionViewModel;
  onSubmit: (quantity: number, comment: string) => Promise<void>;
}) {
  const [quantity, setQuantity] = useState('');
  const [comment, setComment] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = Number(quantity);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setError('Введите неотрицательное число');
      return;
    }
    if (!comment.trim()) {
      setError('Комментарий обязателен');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSubmit(parsed, comment.trim());
      setQuantity('');
      setComment('');
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className={styles.inlineForm} onSubmit={handleSubmit}>
      <span className={[styles.formLabel, typeClass('label')].join(' ')}>Внести факт РП</span>
      <div className={styles.formRow}>
        <input
          className={styles.input}
          type="number"
          step="any"
          min="0"
          inputMode="decimal"
          placeholder="Объём"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          disabled={pending}
          aria-label={`Факт по участку ${portion.label}`}
        />
        <input
          className={styles.input}
          type="text"
          placeholder="Комментарий"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          disabled={pending}
          aria-label={`Комментарий к факту по участку ${portion.label}`}
        />
        <button type="submit" className={styles.actionButton} disabled={pending}>
          {pending ? 'Сохранение…' : 'Сохранить факт'}
        </button>
      </div>
      {error ? <span className={styles.errorText}>{error}</span> : null}
    </form>
  );
}

function RequestInternalScButton({ onSubmit }: { onSubmit: () => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setPending(true);
    setError(null);
    try {
      await onSubmit();
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={styles.inlineForm}>
      <button type="button" className={styles.actionButton} onClick={handleClick} disabled={pending}>
        {pending ? 'Отправка…' : 'Предъявить на СК'}
      </button>
      {error ? <span className={styles.errorText}>{error}</span> : null}
    </div>
  );
}

function InternalScDecisionForm({
  portion,
  onSubmit,
}: {
  portion: W01PortionViewModel;
  onSubmit: (
    decision: 'accept' | 'reject',
    comment: string,
    photo: { fileName: string; mimeType: 'image/png' | 'image/jpeg'; base64: string },
    quantity?: number,
  ) => Promise<void>;
}) {
  const [comment, setComment] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [quantity, setQuantity] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDecision(decision: 'accept' | 'reject') {
    if (!comment.trim()) {
      setError('Комментарий обязателен');
      return;
    }
    if (!file) {
      setError('Нужна фотофиксация проверки');
      return;
    }
    if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
      setError('Только PNG или JPEG');
      return;
    }
    // F8.1-01 corrective, second pass — required for accept, the
    // inspector's own independently confirmed figure, never a copy of RP
    // fact; irrelevant for reject, which confirms nothing.
    let parsedQuantity: number | undefined;
    if (decision === 'accept') {
      parsedQuantity = Number(quantity);
      if (!Number.isFinite(parsedQuantity) || parsedQuantity < 0) {
        setError('Укажите подтверждённый объём');
        return;
      }
    }
    setPending(true);
    setError(null);
    try {
      const base64 = await readFileAsBase64(file);
      await onSubmit(decision, comment.trim(), { fileName: file.name, mimeType: file.type, base64 }, parsedQuantity);
      setComment('');
      setFile(null);
      setQuantity('');
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={styles.inlineForm}>
      <span className={[styles.formLabel, typeClass('label')].join(' ')}>Решение по проверке СК</span>
      <div className={styles.formRow}>
        <input
          className={styles.input}
          type="file"
          accept="image/png,image/jpeg"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          disabled={pending}
          aria-label={`Фотофиксация проверки участка ${portion.label}`}
        />
        <input
          className={styles.input}
          type="number"
          step="any"
          min="0"
          inputMode="decimal"
          placeholder="Подтверждённый объём"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          disabled={pending}
          aria-label={`Подтверждённый объём по участку ${portion.label}`}
        />
        <input
          className={styles.input}
          type="text"
          placeholder="Комментарий"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          disabled={pending}
          aria-label={`Комментарий к решению по участку ${portion.label}`}
        />
        <button
          type="button"
          className={styles.actionButton}
          onClick={() => handleDecision('accept')}
          disabled={pending}
        >
          {pending ? 'Отправка…' : 'Принять'}
        </button>
        <button
          type="button"
          className={[styles.actionButton, styles.actionButtonSecondary].join(' ')}
          onClick={() => handleDecision('reject')}
          disabled={pending}
        >
          {pending ? 'Отправка…' : 'Отклонить'}
        </button>
      </div>
      {error ? <span className={styles.errorText}>{error}</span> : null}
    </div>
  );
}

function AddPortionForm({
  unit,
  onSubmit,
}: {
  unit: W01ExecutionUnitViewModel;
  onSubmit: (label: string, plannedQuantity: number) => Promise<void>;
}) {
  const [label, setLabel] = useState('');
  const [plannedQuantity, setPlannedQuantity] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!label.trim()) {
      setError('Название участка обязательно');
      return;
    }
    const parsed = Number(plannedQuantity);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('Плановый объём должен быть больше нуля');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSubmit(label.trim(), parsed);
      setLabel('');
      setPlannedQuantity('');
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className={styles.inlineForm} onSubmit={handleSubmit}>
      <span className={[styles.formLabel, typeClass('label')].join(' ')}>
        Новый участок · остаток бюджета {unit.remainingForNewPortion}
      </span>
      <div className={styles.formRow}>
        <input
          className={styles.input}
          type="text"
          placeholder="Название участка"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          disabled={pending}
          aria-label="Название нового участка"
        />
        <input
          className={styles.input}
          type="number"
          step="any"
          min="0"
          inputMode="decimal"
          placeholder="Плановый объём"
          value={plannedQuantity}
          onChange={(event) => setPlannedQuantity(event.target.value)}
          disabled={pending}
          aria-label="Плановый объём нового участка"
        />
        <button type="submit" className={styles.actionButton} disabled={pending}>
          {pending ? 'Создание…' : 'Добавить участок'}
        </button>
      </div>
      {error ? <span className={styles.errorText}>{error}</span> : null}
    </form>
  );
}

function PortionRow({ portion, actions }: { portion: W01PortionViewModel; actions?: W01ActionHandlers }) {
  return (
    <div className={styles.portionRow}>
      <div className={styles.portionHeader}>
        <span className={typeClass('body-strong')}>{portion.label}</span>
        <StatusBadge variant={confirmationVariant(portion.internalSc)}>
          {confirmationLabel(portion.internalSc)}
        </StatusBadge>
      </div>
      <div className={styles.portionFigures}>
        <span className={typeClass('body')}>
          {portion.planned.value} <span className={styles.meta}>{portion.planned.meta}</span>
        </span>
        <span className={typeClass('body')}>
          {portion.fact.value} <span className={styles.meta}>{portion.fact.meta}</span>
        </span>
      </div>
      {actions && portion.canEnterFact ? (
        <FactForm
          portion={portion}
          onSubmit={(quantity, comment) => actions.onRecordFact(portion.id, quantity, portion.version, comment)}
        />
      ) : null}
      {actions && portion.canRequestInternalSc ? (
        <RequestInternalScButton onSubmit={() => actions.onRequestInternalSc(portion.id, portion.version)} />
      ) : null}
      {actions && portion.decidableInspection ? (
        <InternalScDecisionForm
          portion={portion}
          onSubmit={(decision, comment, photo, quantity) =>
            actions.onRegisterInternalScDecision(
              portion.decidableInspection!.id,
              portion.decidableInspection!.version,
              decision,
              comment,
              photo,
              quantity,
            )
          }
        />
      ) : null}
    </div>
  );
}

function ExecutionUnitCard({ unit, actions }: { unit: W01ExecutionUnitViewModel; actions?: W01ActionHandlers }) {
  return (
    <div className={styles.unitCard}>
      <div className={styles.unitHeader}>
        <span className={typeClass('body-strong')}>{unit.location ?? 'Единица исполнения'}</span>
        <span className={[styles.meta, typeClass('label')].join(' ')}>
          {unit.plan.value} / {unit.actual.value} {unit.plan.meta}
        </span>
      </div>
      {unit.portions.length > 0 ? (
        <div className={styles.portionList}>
          {unit.portions.map((portion) => (
            <PortionRow key={portion.id} portion={portion} actions={actions} />
          ))}
        </div>
      ) : (
        <span className={[styles.meta, typeClass('body')].join(' ')}>Участки ещё не выделены</span>
      )}
      {actions ? (
        <AddPortionForm unit={unit} onSubmit={(label, qty) => actions.onCreatePortion(unit.id, label, qty)} />
      ) : null}
    </div>
  );
}

export function ExecutionSection({ executionUnits, actions }: ExecutionSectionProps) {
  if (executionUnits.length === 0) return null;

  return (
    <section className={styles.section}>
      <span className={[styles.sectionLabel, typeClass('label')].join(' ')}>Единицы исполнения и участки</span>
      <div className={styles.unitList}>
        {executionUnits.map((unit) => (
          <ExecutionUnitCard key={unit.id} unit={unit} actions={actions} />
        ))}
      </div>
    </section>
  );
}
