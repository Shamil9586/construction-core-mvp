import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button, StatusBadge, typeClass } from '../../design-system';
import type { DelayReasonCategory } from '../../types/schedule';
import type { GprRowViewModel, ReasonViewModel } from '../../view-models/schedule';
import { errorMessage, useAsyncAction, type GprActions, type ResponsibleOptions } from './actions';
import styles from './GPR.module.css';

/**
 * Why a scope is late: the recorded reasons (category, comment, who recorded them and when, who it is about, open / resolved) and — for those
 * who may — the form that records another. These are PLANNING reasons; a construction remark is a СК issue and lives elsewhere.
 *
 * Plain controls styled from the design tokens, like W01's execution forms: the design system's only control is `Button`.
 */

function ResolveForm({ reason, actions }: { reason: ReasonViewModel; actions: GprActions }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');
  const { pending, error, run } = useAsyncAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const ok = await run(() => actions.onResolveReason(reason.id, reason.version, comment.trim() || undefined));
    if (ok) {
      setComment('');
      setOpen(false);
    }
  }

  if (!open) {
    return (
      <div className={styles.actions}>
        <Button variant="Secondary" onClick={() => setOpen(true)}>
          Закрыть причину
        </Button>
      </div>
    );
  }
  return (
    <form className={styles.form} onSubmit={submit} aria-label={`Закрыть причину: ${reason.category}`}>
      <div className={styles.field}>
        <label htmlFor={`${id}-comment`} className={[styles.label, typeClass('label')].join(' ')}>
          Что изменилось (необязательно)
        </label>
        <textarea id={`${id}-comment`} className={styles.textarea} value={comment} onChange={(e) => setComment(e.target.value)} disabled={pending} maxLength={2000} />
      </div>
      {error ? (
        <p role="alert" className={[styles.error, typeClass('body')].join(' ')}>
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button type="submit" loading={pending}>
          Закрыть причину
        </Button>
        <Button variant="Secondary" onClick={() => setOpen(false)} disabled={pending}>
          Отмена
        </Button>
      </div>
    </form>
  );
}

function ReasonItem({ reason, actions, canResolve }: { reason: ReasonViewModel; actions?: GprActions; canResolve: boolean }) {
  return (
    <li className={styles.reasonItem}>
      <div className={styles.reasonHead}>
        <span className={typeClass('body-strong')}>{reason.category}</span>
        <StatusBadge variant={reason.open ? 'Attention' : 'Neutral'}>{reason.statusLabel}</StatusBadge>
      </div>
      <span className={typeClass('body')}>{reason.comment}</span>
      <span className={[styles.muted, typeClass('meta')].join(' ')}>
        {reason.provenance}
        {reason.responsible ? ` · ${reason.responsible}` : ''}
      </span>
      <span className={[styles.muted, typeClass('meta')].join(' ')}>{reason.evidence}</span>
      {reason.resolution ? <span className={[styles.muted, typeClass('meta')].join(' ')}>{reason.resolution}</span> : null}
      {reason.open && canResolve && actions ? <ResolveForm reason={reason} actions={actions} /> : null}
    </li>
  );
}

function ReasonForm({ itemId, categories, actions, onDone }: { itemId: string; categories: DelayReasonCategory[]; actions: GprActions; onDone: () => void }) {
  const id = useId();
  const [category, setCategory] = useState('');
  const [comment, setComment] = useState('');
  const [responsible, setResponsible] = useState('');
  const [options, setOptions] = useState<ResponsibleOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const { pending, error, run, setError } = useAsyncAction();

  // The "about whom" choices are fetched once, when the form opens — not with every schedule load, and not again when the route re-renders.
  const loadOptions = useRef(actions.loadResponsibleOptions);
  useEffect(() => {
    let cancelled = false;
    loadOptions.current().then(
      (loaded) => {
        if (!cancelled) setOptions(loaded);
      },
      (failure: unknown) => {
        if (!cancelled) setOptionsError(errorMessage(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!category) return setError('Выберите причину');
    if (!comment.trim()) return setError('Опишите причину отставания');
    const [kind, ref] = responsible ? (responsible.split(':') as ['u' | 'c', string]) : [null, null];
    const ok = await run(() =>
      actions.onRecordReason({
        itemId,
        categoryCode: category,
        comment: comment.trim(),
        ...(kind === 'u' ? { responsibleUserId: ref } : {}),
        ...(kind === 'c' ? { responsibleContractorId: ref } : {}),
      }),
    );
    if (ok) onDone();
  }

  return (
    <form className={styles.form} onSubmit={submit} aria-label="Указать причину отставания">
      <div className={styles.fields}>
        <div className={styles.field}>
          <label htmlFor={`${id}-category`} className={[styles.label, typeClass('label')].join(' ')}>
            Причина
          </label>
          <select id={`${id}-category`} className={styles.select} value={category} onChange={(e) => setCategory(e.target.value)} disabled={pending}>
            <option value="">Выберите…</option>
            {categories.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor={`${id}-responsible`} className={[styles.label, typeClass('label')].join(' ')}>
            Ответственный (необязательно)
          </label>
          <select id={`${id}-responsible`} className={styles.select} value={responsible} onChange={(e) => setResponsible(e.target.value)} disabled={pending || options === null}>
            <option value="">Не указан</option>
            {options && options.contractors.length ? (
              <optgroup label="Подрядчик">
                {options.contractors.map((c) => (
                  <option key={c.id} value={`c:${c.id}`}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {options && options.people.length ? (
              <optgroup label="Сотрудник">
                {options.people.map((p) => (
                  <option key={p.id} value={`u:${p.id}`}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </div>
        <div className={[styles.field, styles.fieldWide].join(' ')}>
          <label htmlFor={`${id}-comment`} className={[styles.label, typeClass('label')].join(' ')}>
            Описание
          </label>
          <textarea id={`${id}-comment`} className={styles.textarea} value={comment} onChange={(e) => setComment(e.target.value)} disabled={pending} maxLength={2000} />
        </div>
      </div>
      {optionsError ? <p className={[styles.hint, typeClass('meta')].join(' ')}>Список ответственных недоступен: {optionsError}</p> : null}
      {error ? (
        <p role="alert" className={[styles.error, typeClass('body')].join(' ')}>
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button type="submit" loading={pending}>
          Записать причину
        </Button>
        <Button variant="Secondary" onClick={onDone} disabled={pending}>
          Отмена
        </Button>
      </div>
    </form>
  );
}

export interface ReasonPanelProps {
  row: GprRowViewModel;
  categories: DelayReasonCategory[];
  actions?: GprActions;
}

export function ReasonPanel({ row, categories, actions }: ReasonPanelProps) {
  const [adding, setAdding] = useState(false);
  // Recording a NEW reason needs a delay that is real now; closing an OPEN one does not — a zone that has caught up (or been re-planned)
  // must still let its explanation be closed.
  const canRecord = row.canRecordReason;
  const canResolve = row.canResolveReason;
  return (
    <div className={styles.reasonPanel}>
      <span className={[styles.label, typeClass('label-strong')].join(' ')}>Причины отставания</span>
      {row.reasons.length ? (
        <ul className={styles.reasonList}>
          {row.reasons.map((reason) => (
            <ReasonItem key={reason.id} reason={reason} actions={actions} canResolve={canResolve} />
          ))}
        </ul>
      ) : (
        <p className={[styles.hint, typeClass('body')].join(' ')}>Причина отставания не указана.</p>
      )}
      {canRecord && actions ? (
        adding ? (
          <ReasonForm itemId={row.itemId} categories={categories} actions={actions} onDone={() => setAdding(false)} />
        ) : (
          <div className={styles.actions}>
            <Button variant="Secondary" onClick={() => setAdding(true)}>
              Указать причину
            </Button>
          </div>
        )
      ) : null}
    </div>
  );
}
