import { useState } from 'react';
import { Button, typeClass } from '../../design-system';
import {
  EMPTY_DRAFT,
  NO_ACTIVE_PM_LABEL,
  NO_CONTRACTORS_LABEL,
  validateDraft,
  type CreateObjectDraft,
  type CreateOptionsState,
  type DraftErrors,
  type SubmitFailure,
} from '../../view-models/createObject';
import styles from './CreateObjectForm.module.css';

/**
 * OBJ-1 — «Добавить объект». An inline panel under the C01 header (no modal: nothing to
 * trap focus in, and it stacks to one column at narrow widths). Presentational: the route
 * owns fetching and submitting; this owns the draft and field validation only.
 */
export interface CreateObjectFormProps {
  options: CreateOptionsState;
  submitting: boolean;
  failure: SubmitFailure | null;
  onSubmit: (draft: CreateObjectDraft) => void;
  onCancel: () => void;
  onRetryOptions: () => void;
}

export function CreateObjectForm({ options, submitting, failure, onSubmit, onCancel, onRetryOptions }: CreateObjectFormProps) {
  const [draft, setDraft] = useState<CreateObjectDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<DraftErrors>({});
  const set = <K extends keyof CreateObjectDraft>(key: K, value: CreateObjectDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const submit = () => {
    const found = validateDraft(draft);
    setErrors(found);
    if (Object.keys(found).length === 0) onSubmit(draft);
  };

  const field = (key: keyof CreateObjectDraft, label: string, control: (id: string, invalid: boolean) => React.ReactNode, hint?: string) => {
    const id = `create-object-${key}`;
    const error = errors[key] ?? (key === 'externalCode' && failure?.kind === 'DuplicateCode' ? failure.message : undefined);
    return (
      <div className={[styles.field, key === 'name' || key === 'address' ? styles.wide : ''].join(' ')}>
        <label htmlFor={id} className={typeClass('label')}>{label}</label>
        {control(id, !!error)}
        {hint ? <span className={[styles.hint, typeClass('label')].join(' ')}>{hint}</span> : null}
        {error ? <span id={`${id}-error`} role="alert" className={[styles.error, typeClass('label')].join(' ')}>{error}</span> : null}
      </div>
    );
  };
  const text = (key: 'externalCode' | 'name' | 'address' | 'organizationName' | 'customerName' | 'contractValue', inputMode?: 'decimal') => (id: string, invalid: boolean) => (
    <input id={id} className={styles.input} value={draft[key]} inputMode={inputMode} disabled={submitting} aria-invalid={invalid || undefined} aria-describedby={invalid ? `${id}-error` : undefined} onChange={(e) => set(key, e.target.value)} />
  );
  const date = (key: 'startDate' | 'plannedFinishDate') => (id: string, invalid: boolean) => (
    <input id={id} type="date" className={styles.input} value={draft[key]} disabled={submitting} aria-invalid={invalid || undefined} aria-describedby={invalid ? `${id}-error` : undefined} onChange={(e) => set(key, e.target.value)} />
  );

  return (
    <section className={styles.panel} aria-label="Новый объект">
      <h2 className={typeClass('heading-card')}>Новый объект</h2>
      {options.kind === 'Loading' ? <p role="status" className={typeClass('body')}>Загрузка списков…</p> : null}
      {options.kind === 'Error' ? (
        <div role="alert" className={styles.banner}>
          <span className={typeClass('body')}>Не удалось загрузить списки: {options.message}</span>
          <Button variant="Secondary" onClick={onRetryOptions}>Повторить</Button>
        </div>
      ) : null}
      {options.kind === 'NoProjectManager' ? (
        <div role="alert" className={styles.banner}>
          <span className={typeClass('body')}>{NO_ACTIVE_PM_LABEL}</span>
        </div>
      ) : null}
      {options.kind === 'Ready' ? (
        <form
          className={styles.form}
          noValidate
          onSubmit={(e) => { e.preventDefault(); if (!submitting) submit(); }}
        >
          {field('externalCode', 'Код объекта / УКО', text('externalCode'))}
          {field('name', 'Наименование объекта', text('name'))}
          {field('address', 'Адрес', text('address'))}
          {field('organizationName', 'Организация', text('organizationName'))}
          {field('customerName', 'Заказчик (необязательно)', text('customerName'))}
          {field('projectManagerId', 'РП', (id, invalid) => (
            <select id={id} className={styles.input} value={draft.projectManagerId} disabled={submitting} aria-invalid={invalid || undefined} aria-describedby={invalid ? `${id}-error` : undefined} onChange={(e) => set('projectManagerId', e.target.value)}>
              <option value="">Выберите РП</option>
              {options.options.projectManagers.map((pm) => <option key={pm.id} value={pm.id}>{pm.name}</option>)}
            </select>
          ))}
          {field('startDate', 'Дата начала', date('startDate'))}
          {field('plannedFinishDate', 'Плановая дата завершения', date('plannedFinishDate'))}
          {field('contractValue', 'Стоимость объекта', text('contractValue', 'decimal'), 'В рублях, например 0.00')}
          {options.hasContractors ? (
            <fieldset className={styles.fieldset} disabled={submitting}>
              <legend className={typeClass('label')}>Подрядчики (необязательно)</legend>
              {options.options.contractors.map((c) => (
                <label key={c.id} className={[styles.check, typeClass('body')].join(' ')}>
                  <input
                    type="checkbox"
                    checked={draft.contractorIds.includes(c.id)}
                    onChange={(e) => set('contractorIds', e.target.checked ? [...draft.contractorIds, c.id] : draft.contractorIds.filter((x) => x !== c.id))}
                  />
                  {c.name}
                </label>
              ))}
            </fieldset>
          ) : (
            <p className={[styles.hint, typeClass('body')].join(' ')}>{NO_CONTRACTORS_LABEL}</p>
          )}
          {failure?.kind === 'Api' ? <div role="alert" className={styles.banner}><span className={typeClass('body')}>{failure.message}</span></div> : null}
          <div className={styles.actions}>
            <Button type="submit" loading={submitting} disabled={submitting}>Создать объект</Button>
            <Button variant="Secondary" disabled={submitting} onClick={onCancel}>Отмена</Button>
          </div>
        </form>
      ) : (
        <div className={styles.actions}><Button variant="Secondary" onClick={onCancel}>Закрыть</Button></div>
      )}
    </section>
  );
}
