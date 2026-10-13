import { useId, useState, type FormEvent } from 'react';
import { Button, StatusBadge, typeClass } from '../../design-system';
import type { ScheduleAccess } from '../../types/schedule';
import type { ChangeViewModel, DraftRowViewModel, DraftViewModel, ScopeOptionViewModel } from '../../view-models/schedule';
import { useAsyncAction, type GprActions } from './actions';
import styles from './GPR.module.css';

/**
 * Preparing the schedule: the DRAFT. Dates, order and the advisory «follows» reference are the only things a planner enters — the quantity,
 * the zone and the executor of every scope are shown from the production model and cannot be typed here. A draft is explicitly not
 * authoritative: plan-versus-fact keeps measuring against the approved dates until an approver approves exactly the draft they saw.
 */

const joined = (...classes: (string | false | undefined)[]) => classes.filter(Boolean).join(' ');

function Changes({ changes }: { changes: ChangeViewModel[] }) {
  if (changes.length === 0) return null;
  return (
    <div className={styles.reasonPanel}>
      <span className={joined(styles.label, typeClass('label-strong'))}>Что изменится относительно утверждённого графика</span>
      <ul className={styles.plainList}>
        {changes.map((change) => (
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
    </div>
  );
}

function DraftRow({ row, draft, canEdit, actions }: { row: DraftRowViewModel; draft: DraftViewModel; canEdit: boolean; actions: GprActions }) {
  const id = useId();
  const [start, setStart] = useState(row.start);
  const [finish, setFinish] = useState(row.finish);
  const [sequence, setSequence] = useState(String(row.sequence));
  const [predecessor, setPredecessor] = useState(row.predecessorItemId ?? '');
  const { pending, error, run, setError } = useAsyncAction();
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const dirty = start !== row.start || finish !== row.finish || sequence !== String(row.sequence) || predecessor !== (row.predecessorItemId ?? '');

  async function save(event: FormEvent) {
    event.preventDefault();
    const order = Number(sequence);
    if (!start || !finish) return setError('Укажите даты начала и окончания');
    if (finish < start) return setError('Дата окончания раньше даты начала');
    if (!Number.isInteger(order) || order < 1) return setError('Порядок — целое число от 1');
    await run(() =>
      actions.onEditEntry(row.entryId, {
        version: row.version,
        ...(start !== row.start ? { plannedStart: start } : {}),
        ...(finish !== row.finish ? { plannedFinish: finish } : {}),
        ...(sequence !== String(row.sequence) ? { sequence: order } : {}),
        ...(predecessor !== (row.predecessorItemId ?? '') ? { predecessorItemId: predecessor || null } : {}),
      }),
    );
  }

  const options = draft.predecessorOptions.filter((option) => option.value !== row.itemId);
  const title = row.zone ? `${row.name} · ${row.zone}` : row.name;

  return (
    <li className={styles.draftItem}>
      <div className={styles.draftHead}>
        <div className={styles.draftIdentity}>
          <span className={typeClass('body-strong')}>{title}</span>
          <span className={joined(styles.muted, typeClass('meta'))}>
            {row.executor} · {row.plan}
          </span>
          {row.baselineText ? <span className={joined(styles.muted, typeClass('meta'))}>{row.baselineText}</span> : null}
          {row.followsNote ? <span className={joined(styles.muted, typeClass('meta'))}>{row.followsNote}</span> : null}
        </div>
        {row.change ? <StatusBadge variant="Attention">{row.change === 'ADDED' ? 'Добавлено' : 'Изменено'}</StatusBadge> : null}
      </div>
      {canEdit ? (
        <form className={styles.form} onSubmit={save} aria-label={`Изменить: ${title}`}>
          <div className={styles.fields}>
            <div className={styles.field}>
              <label htmlFor={`${id}-start`} className={joined(styles.label, typeClass('label'))}>
                Начало
              </label>
              <input id={`${id}-start`} className={styles.input} type="date" value={start} onChange={(e) => setStart(e.target.value)} disabled={pending} required />
            </div>
            <div className={styles.field}>
              <label htmlFor={`${id}-finish`} className={joined(styles.label, typeClass('label'))}>
                Окончание
              </label>
              <input id={`${id}-finish`} className={styles.input} type="date" value={finish} onChange={(e) => setFinish(e.target.value)} disabled={pending} required />
            </div>
            <div className={styles.field}>
              <label htmlFor={`${id}-seq`} className={joined(styles.label, typeClass('label'))}>
                Порядок в графике
              </label>
              <input id={`${id}-seq`} className={styles.input} type="number" min={1} step={1} value={sequence} onChange={(e) => setSequence(e.target.value)} disabled={pending} />
            </div>
            <div className={styles.field}>
              <label htmlFor={`${id}-pred`} className={joined(styles.label, typeClass('label'))}>
                Следует за
              </label>
              <select id={`${id}-pred`} className={styles.select} value={predecessor} onChange={(e) => setPredecessor(e.target.value)} disabled={pending}>
                <option value="">Ни за чем</option>
                {options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {error ? (
            <p role="alert" className={joined(styles.error, typeClass('body'))}>
              {error}
            </p>
          ) : null}
          <div className={styles.actions}>
            <Button type="submit" loading={pending} disabled={!dirty}>
              Сохранить
            </Button>
            {confirmingRemove ? (
              <>
                <span className={typeClass('body')}>Убрать из графика?</span>
                <Button variant="Secondary" onClick={() => run(() => actions.onRemoveEntry(row.entryId, row.version))} disabled={pending}>
                  Да, убрать
                </Button>
                <Button variant="Secondary" onClick={() => setConfirmingRemove(false)} disabled={pending}>
                  Нет
                </Button>
              </>
            ) : (
              <Button variant="Secondary" onClick={() => setConfirmingRemove(true)} disabled={pending}>
                Убрать из графика
              </Button>
            )}
          </div>
        </form>
      ) : (
        <span className={typeClass('body')}>
          {row.start} — {row.finish}
        </span>
      )}
    </li>
  );
}

function AddEntryForm({ draft, scopes, actions }: { draft: DraftViewModel; scopes: ScopeOptionViewModel[]; actions: GprActions }) {
  const id = useId();
  const [scope, setScope] = useState('');
  const [start, setStart] = useState('');
  const [finish, setFinish] = useState('');
  const [predecessor, setPredecessor] = useState('');
  const { pending, error, run, setError } = useAsyncAction();

  function choose(value: string) {
    setScope(value);
    const chosen = scopes.find((candidate) => candidate.value === value);
    // The work's own window is only a default: the planner decides the dates of THIS scope.
    if (chosen) {
      setStart(chosen.suggestedStart);
      setFinish(chosen.suggestedFinish);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const chosen = scopes.find((candidate) => candidate.value === scope);
    if (!chosen) return setError('Выберите участок производства');
    if (!start || !finish) return setError('Укажите даты начала и окончания');
    if (finish < start) return setError('Дата окончания раньше даты начала');
    const ok = await run(() =>
      actions.onAddEntry({
        objectWorkId: chosen.workId,
        executionUnitId: chosen.unitId,
        plannedStart: start,
        plannedFinish: finish,
        ...(predecessor ? { predecessorItemId: predecessor } : {}),
      }),
    );
    if (ok) {
      setScope('');
      setStart('');
      setFinish('');
      setPredecessor('');
    }
  }

  if (scopes.length === 0) {
    return <p className={joined(styles.hint, typeClass('body'))}>Все производственные участки объекта уже включены в черновик (или в объекте нет работ).</p>;
  }
  return (
    <form className={styles.form} onSubmit={submit} aria-label="Добавить участок в график">
      <span className={joined(styles.label, typeClass('label-strong'))}>Добавить участок производства</span>
      <div className={styles.fields}>
        <div className={joined(styles.field, styles.fieldWide)}>
          <label htmlFor={`${id}-scope`} className={joined(styles.label, typeClass('label'))}>
            Участок (работа · зона — объём)
          </label>
          <select id={`${id}-scope`} className={styles.select} value={scope} onChange={(e) => choose(e.target.value)} disabled={pending}>
            <option value="">Выберите…</option>
            {scopes.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor={`${id}-start`} className={joined(styles.label, typeClass('label'))}>
            Начало
          </label>
          <input id={`${id}-start`} className={styles.input} type="date" value={start} onChange={(e) => setStart(e.target.value)} disabled={pending} />
        </div>
        <div className={styles.field}>
          <label htmlFor={`${id}-finish`} className={joined(styles.label, typeClass('label'))}>
            Окончание
          </label>
          <input id={`${id}-finish`} className={styles.input} type="date" value={finish} onChange={(e) => setFinish(e.target.value)} disabled={pending} />
        </div>
        <div className={styles.field}>
          <label htmlFor={`${id}-pred`} className={joined(styles.label, typeClass('label'))}>
            Следует за
          </label>
          <select id={`${id}-pred`} className={styles.select} value={predecessor} onChange={(e) => setPredecessor(e.target.value)} disabled={pending}>
            <option value="">Ни за чем</option>
            {draft.predecessorOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error ? (
        <p role="alert" className={joined(styles.error, typeClass('body'))}>
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button type="submit" loading={pending}>
          Добавить в график
        </Button>
      </div>
    </form>
  );
}

function ApprovePanel({ draft, actions }: { draft: DraftViewModel; actions: GprActions }) {
  const id = useId();
  const [comment, setComment] = useState('');
  const [reason, setReason] = useState('');
  const { pending, error, run, setError } = useAsyncAction();
  const empty = draft.rows.length === 0;
  const unchanged = draft.isCorrection && draft.changes.length === 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (draft.isCorrection && !reason.trim()) return setError('Укажите причину корректировки');
    await run(() =>
      actions.onApprove({
        version: draft.version,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
        ...(draft.isCorrection ? { correctionReason: reason.trim() } : {}),
      }),
    );
  }

  return (
    <form className={styles.reasonPanel} onSubmit={submit} aria-label={draft.isCorrection ? 'Утвердить корректировку' : 'Утвердить график'}>
      <span className={joined(styles.label, typeClass('label-strong'))}>{draft.isCorrection ? 'Утверждение корректировки' : 'Утверждение графика'}</span>
      <p className={joined(styles.hint, typeClass('body'))}>
        {draft.isCorrection
          ? 'После утверждения корректировка станет действующим графиком; прежняя версия сохранится в истории без изменений.'
          : 'После утверждения график станет действующим: отставание будет считаться по его датам. Утверждённые даты не переписываются — только корректируются с причиной.'}
      </p>
      <div className={styles.fields}>
        {draft.isCorrection ? (
          <div className={joined(styles.field, styles.fieldWide)}>
            <label htmlFor={`${id}-reason`} className={joined(styles.label, typeClass('label'))}>
              Причина корректировки
            </label>
            <textarea id={`${id}-reason`} className={styles.textarea} value={reason} onChange={(e) => setReason(e.target.value)} disabled={pending} maxLength={2000} />
          </div>
        ) : null}
        <div className={joined(styles.field, styles.fieldWide)}>
          <label htmlFor={`${id}-comment`} className={joined(styles.label, typeClass('label'))}>
            Комментарий (необязательно)
          </label>
          <textarea id={`${id}-comment`} className={styles.textarea} value={comment} onChange={(e) => setComment(e.target.value)} disabled={pending} maxLength={500} />
        </div>
      </div>
      {empty ? <p className={joined(styles.hint, typeClass('body'))}>Добавьте хотя бы один участок: пустой график утвердить нельзя.</p> : null}
      {unchanged ? <p className={joined(styles.hint, typeClass('body'))}>В черновике нет изменений относительно утверждённого графика.</p> : null}
      {error ? (
        <p role="alert" className={joined(styles.error, typeClass('body'))}>
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button type="submit" loading={pending} disabled={empty || unchanged}>
          {draft.isCorrection ? 'Утвердить корректировку' : 'Утвердить график'}
        </Button>
      </div>
    </form>
  );
}

function DiscardControl({ draft, actions }: { draft: DraftViewModel; actions: GprActions }) {
  const [confirming, setConfirming] = useState(false);
  const { pending, error, run } = useAsyncAction();
  return (
    <div className={styles.form}>
      {error ? (
        <p role="alert" className={joined(styles.error, typeClass('body'))}>
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        {confirming ? (
          <>
            <span className={typeClass('body')}>Отменить черновик? Введённые в нём данные будут потеряны.</span>
            <Button variant="Secondary" onClick={() => run(() => actions.onDiscardDraft(draft.version))} loading={pending}>
              Да, отменить черновик
            </Button>
            <Button variant="Secondary" onClick={() => setConfirming(false)} disabled={pending}>
              Нет
            </Button>
          </>
        ) : (
          <Button variant="Secondary" onClick={() => setConfirming(true)}>
            Отменить черновик
          </Button>
        )}
      </div>
    </div>
  );
}

export interface DraftSectionProps {
  draft: DraftViewModel | null;
  scopes: ScopeOptionViewModel[];
  access: ScheduleAccess;
  hasBaseline: boolean;
  actions?: GprActions;
}

export function DraftSection({ draft, scopes, access, hasBaseline, actions }: DraftSectionProps) {
  const titleId = useId();
  const { pending, error, run } = useAsyncAction();

  if (!actions) return null;

  if (!draft) {
    if (!access.canCreateDraft) return null;
    return (
      <section className={styles.section} aria-labelledby={titleId}>
        <h2 id={titleId} className={joined(styles.sectionTitle, typeClass('heading-card'))}>
          {hasBaseline ? 'Корректировка графика' : 'Подготовка графика'}
        </h2>
        <div className={styles.card}>
          <p className={joined(styles.muted, typeClass('body'))}>
            {hasBaseline
              ? 'Корректировка создаётся как черновик — копия утверждённого графика. Утверждённые даты остаются в силе, пока корректировка не утверждена; утверждение требует причины.'
              : 'График готовится как черновик: выберите участки производства объекта, задайте даты и порядок. Пока график не утверждён, сроки не контролируются.'}
          </p>
          {error ? (
            <p role="alert" className={joined(styles.error, typeClass('body'))}>
              {error}
            </p>
          ) : null}
          <div className={styles.actions}>
            <Button loading={pending} onClick={() => run(actions.onCreateDraft)}>
              {hasBaseline ? 'Внести корректировку' : 'Подготовить график'}
            </Button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.section} aria-labelledby={titleId}>
      <h2 id={titleId} className={joined(styles.sectionTitle, typeClass('heading-card'))}>
        {draft.title}
      </h2>
      <div className={styles.card}>
        <p className={joined(styles.muted, typeClass('body'))}>
          {draft.basedOn ? `${draft.basedOn}. Утверждённые даты остаются в силе, пока корректировка не утверждена.` : 'Черновик не влияет на контроль сроков, пока график не утверждён.'}
        </p>
        {draft.rows.length ? (
          <ul className={styles.draftList}>
            {draft.rows.map((row) => (
              <DraftRow key={`${row.entryId}:${row.version}`} row={row} draft={draft} canEdit={access.canEdit} actions={actions} />
            ))}
          </ul>
        ) : (
          <p className={joined(styles.hint, typeClass('body'))}>В черновике пока нет участков.</p>
        )}
        {access.canEdit ? <AddEntryForm draft={draft} scopes={scopes} actions={actions} /> : null}
        {draft.isCorrection ? <Changes changes={draft.changes} /> : null}
        {access.canApprove ? <ApprovePanel key={draft.version} draft={draft} actions={actions} /> : null}
        {access.canEdit ? <DiscardControl draft={draft} actions={actions} /> : null}
      </div>
    </section>
  );
}
