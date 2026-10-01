import { useState, type ReactNode } from 'react';
import { AppShell, Button, DataTable, PageHeader, StatusBadge, typeClass } from '../../design-system';
import type { DataTableColumn } from '../../design-system';
import type { Handover, TeamsOverview } from '../../data/functionTeamsApi';
import {
  HANDOVER_STATUS_LABEL,
  UNRESOLVED_LABEL,
  buildRedistributeCommand,
  canSubmitRedistribution,
  describeOp,
  objectMemberOptions,
  replacementHandoverGaps,
  type RedistributeOp,
} from '../../view-models/teams';
import type { RedistributeCommand } from '../../data/functionTeamsApi';
import styles from './Teams.module.css';

/**
 * «Команды и объекты» (`/teams`, PBX-3A) — the Deputy Director / Admin management surface for the
 * PTO function: PTO_HEADs, their organizational engineers, objects they lead, object PTO teams,
 * assignments that need redistribution, handovers, and the explicit «Перераспределить» action.
 * GENERAL_DIRECTOR sees the same data read-only (`canRedistribute=false`): no controls are rendered.
 * An inherited engineer (organizational manager ≠ object lead) is valid and only annotated.
 */
export type TeamsLoad = { status: 'Loading' } | { status: 'Error'; message: string } | { status: 'Loaded'; overview: TeamsOverview };
export interface TeamsNotice { kind: 'success' | 'error'; text: string }

export interface TeamsScreenProps {
  sidebar: ReactNode;
  load: TeamsLoad;
  canRedistribute: boolean;
  notice: TeamsNotice | null;
  busy: boolean;
  onRetry: () => void;
  onDismissNotice: () => void;
  onRedistribute: (command: RedistributeCommand) => Promise<boolean>;
  onAdminComplete: (handover: Handover, reason: string) => Promise<boolean>;
}

const headColumns: DataTableColumn[] = [
  { key: 'head', header: 'Начальник ПТО', width: 220 },
  { key: 'team', header: 'Организационная команда', width: 'fill' },
  { key: 'objects', header: 'Ведёт объекты', width: 280 },
];
const objectColumns: DataTableColumn[] = [
  { key: 'object', header: 'Объект', width: 240 },
  { key: 'lead', header: 'Начальник ПТО объекта', width: 220 },
  { key: 'members', header: 'Инженеры ПТО объекта', width: 'fill' },
];
const handoverColumns: DataTableColumn[] = [
  { key: 'object', header: 'Объект', width: 220 },
  { key: 'flow', header: 'Передача', width: 260 },
  { key: 'reason', header: 'Причина', width: 'fill' },
  { key: 'status', header: 'Статус', width: 200 },
  { key: 'actions', header: 'Действия', width: 220, align: 'end' },
];

type OpKind = RedistributeOp['kind'];
const OP_LABEL: Record<OpKind, string> = {
  orgTransfer: 'Перевести инженера в команду начальника',
  orgEnd: 'Закрыть членство в команде',
  lead: 'Назначить начальника объекта',
  memberEnd: 'Снять инженера с объекта',
  memberAdd: 'Добавить инженера на объект',
  handover: 'Зафиксировать передачу дел',
};

function Select({ label, value, onChange, options, placeholder }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; placeholder: string }) {
  const id = `sel-${label.replace(/\s+/g, '-')}`;
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={typeClass('label')}>{label}</label>
      <select id={id} className={styles.input} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{placeholder}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function RedistributePanel({ overview, busy, onCancel, onSubmit }: { overview: TeamsOverview; busy: boolean; onCancel: () => void; onSubmit: (c: RedistributeCommand) => Promise<boolean> }) {
  const [ops, setOps] = useState<RedistributeOp[]>([]);
  const [reason, setReason] = useState('');
  const [kind, setKind] = useState<OpKind>('orgTransfer');
  const [f, setF] = useState({ member: '', manager: '', object: '', outgoing: '', incoming: '' });
  const set = (patch: Partial<typeof f>) => setF((c) => ({ ...c, ...patch }));

  const activeHeads = overview.heads.filter((h) => h.isActive).map((h) => ({ value: h.userId, label: h.name }));
  const engineers = overview.engineers.map((e) => ({ value: e.userId, label: e.isActive ? e.name : `${e.name} (недоступен)` }));
  const activeEngineers = overview.engineers.filter((e) => e.isActive).map((e) => ({ value: e.userId, label: e.name }));
  const objects = overview.objects.map((o) => ({ value: o.objectId, label: o.name }));
  const people = [...overview.heads.map((h) => ({ value: h.userId, label: h.name })), ...engineers];
  const nameOf = (id: string) => people.find((p) => p.value === id)?.label ?? id;
  const objectNameOf = (id: string) => objects.find((o) => o.value === id)?.label ?? id;

  const draft: RedistributeOp | null =
    kind === 'orgTransfer' && f.member && f.manager ? { kind, memberUserId: f.member, toManagerUserId: f.manager }
    : kind === 'orgEnd' && f.member ? { kind, memberUserId: f.member }
    : kind === 'lead' && f.object && f.manager ? { kind, objectId: f.object, leadUserId: f.manager }
    : kind === 'memberEnd' && f.object && f.member ? { kind, objectId: f.object, memberUserId: f.member }
    : kind === 'memberAdd' && f.object && f.member ? { kind, objectId: f.object, memberUserId: f.member }
    : kind === 'handover' && f.object && f.outgoing && f.incoming && f.outgoing !== f.incoming ? { kind, objectId: f.object, outgoingUserId: f.outgoing, incomingUserId: f.incoming }
    : null;

  const needsMember = kind === 'orgTransfer' || kind === 'orgEnd' || kind === 'memberEnd' || kind === 'memberAdd';
  const needsManager = kind === 'orgTransfer' || kind === 'lead';
  const needsObject = kind !== 'orgTransfer' && kind !== 'orgEnd';

  return (
    <div className={styles.panel} role="group" aria-label="Перераспределение ПТО">
      <p className={typeClass('body')}>
        Соберите изменения и примените их одной операцией: все шаги выполняются вместе или не выполняются вовсе. Смена
        начальника объекта не снимает инженеров с объекта — их перемещение задаётся отдельными шагами.
      </p>
      <div className={styles.opForm}>
        <Select label="Действие" value={kind} onChange={(v) => { setKind(v as OpKind); setF({ member: '', manager: '', object: '', outgoing: '', incoming: '' }); }} options={(Object.keys(OP_LABEL) as OpKind[]).map((k) => ({ value: k, label: OP_LABEL[k] }))} placeholder="Выберите действие" />
        {needsObject ? <Select label="Объект" value={f.object} onChange={(v) => set({ object: v, member: '' })} options={objects} placeholder="Выберите объект" /> : null}
        {needsMember ? <Select label="Инженер" value={f.member} onChange={(v) => set({ member: v })} options={kind === 'memberAdd' || kind === 'memberEnd' ? objectMemberOptions(overview, kind, f.object, ops) : kind === 'orgTransfer' ? activeEngineers : engineers} placeholder="Выберите инженера" /> : null}
        {needsManager ? <Select label="Начальник ПТО" value={f.manager} onChange={(v) => set({ manager: v })} options={activeHeads} placeholder="Выберите начальника" /> : null}
        {kind === 'handover' ? (
          <>
            <Select label="Кто передаёт" value={f.outgoing} onChange={(v) => set({ outgoing: v })} options={people} placeholder="Выберите сотрудника" />
            <Select label="Кто принимает" value={f.incoming} onChange={(v) => set({ incoming: v })} options={people} placeholder="Выберите сотрудника" />
          </>
        ) : null}
        <Button variant="Secondary" disabled={!draft || busy} onClick={() => { if (draft) { setOps((c) => [...c, draft]); setF({ member: '', manager: '', object: '', outgoing: '', incoming: '' }); } }}>
          Добавить шаг
        </Button>
      </div>
      {ops.length > 0 ? (
        <ol className={styles.pending} aria-label="Шаги перераспределения">
          {ops.map((op, index) => (
            <li key={index} className={typeClass('body')}>
              <span className={styles.inline}>
                {describeOp(op, nameOf, objectNameOf)}
                <button type="button" className={styles.linkButton} onClick={() => setOps((c) => c.filter((_, i) => i !== index))}>Убрать</button>
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {replacementHandoverGaps(ops).length > 0 ? (
        <div className={[styles.banner, styles.bannerWarning].join(' ')} role="alert">
          <span className={typeClass('body')}>
            Замена инженеров на объекте требует передачи дел: добавьте шаг «Зафиксировать передачу дел» для каждого снятого и каждого добавленного инженера ({replacementHandoverGaps(ops).map(objectNameOf).join(', ')}).
          </span>
        </div>
      ) : null}
      <div className={styles.field}>
        <label htmlFor="redistribute-reason" className={typeClass('label')}>Причина перераспределения</label>
        <input id="redistribute-reason" className={styles.input} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} />
      </div>
      <div className={styles.actions}>
        <Button loading={busy} disabled={busy || !canSubmitRedistribution(reason, ops)} onClick={() => { void onSubmit(buildRedistributeCommand(reason, ops)).then((ok) => { if (ok) onCancel(); }); }}>
          Применить перераспределение
        </Button>
        <Button variant="Secondary" disabled={busy} onClick={onCancel}>Отмена</Button>
      </div>
    </div>
  );
}

function HandoverActions({ handover, busy, onAdminComplete }: { handover: Handover; busy: boolean; onAdminComplete: TeamsScreenProps['onAdminComplete'] }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (handover.status !== 'OPEN') return null;
  if (!open) return <Button variant="Secondary" disabled={busy} aria-label={`Завершить передачу административно: ${handover.objectName ?? ''}`} onClick={() => setOpen(true)}>Завершить административно</Button>;
  return (
    <div className={styles.field}>
      <label htmlFor={`admin-reason-${handover.id}`} className={typeClass('label')}>Причина (обязательна)</label>
      <input id={`admin-reason-${handover.id}`} className={styles.input} value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className={styles.actions}>
        <Button disabled={busy || reason.trim() === ''} onClick={() => { void onAdminComplete(handover, reason.trim()).then((ok) => { if (ok) setOpen(false); }); }}>Завершить</Button>
        <Button variant="Secondary" onClick={() => setOpen(false)}>Отмена</Button>
      </div>
    </div>
  );
}

export function TeamsScreen(props: TeamsScreenProps) {
  const { sidebar, load, canRedistribute, notice, busy } = props;
  const [panelOpen, setPanelOpen] = useState(false);

  return (
    <AppShell sidebar={sidebar}>
      <PageHeader
        eyebrow="Ответственность"
        title="Команды и объекты"
        description="Начальники ПТО, их организационные команды, объекты и команды ПТО на объектах. Организационная команда и команда объекта независимы: смена начальника объекта не меняет ни организационную команду, ни состав объекта."
      />
      <div className={styles.messages}>
        {notice ? (
          <div className={[styles.banner, notice.kind === 'error' ? styles.bannerError : styles.bannerSuccess].join(' ')} role={notice.kind === 'error' ? 'alert' : 'status'}>
            <span className={typeClass('body')}>{notice.text}</span>
            <button type="button" className={styles.linkButton} onClick={props.onDismissNotice}>Закрыть</button>
          </div>
        ) : null}
        {load.status === 'Error' ? (
          <div className={[styles.banner, styles.bannerError].join(' ')} role="alert">
            <span className={typeClass('body')}>Не удалось загрузить команды: {load.message}</span>
            <button type="button" className={styles.linkButton} onClick={props.onRetry}>Повторить</button>
          </div>
        ) : null}
      </div>

      {load.status === 'Loading' ? <p className={typeClass('body')} aria-live="polite">Загрузка…</p> : null}
      {load.status === 'Loaded' ? (
        <>
          <section className={styles.section} aria-label="Перераспределение">
            <div className={styles.sectionHead}>
              <span className={typeClass('label')}>{load.overview.heads.length} начальников ПТО · {load.overview.objects.length} объектов</span>
              {canRedistribute && !panelOpen ? <Button disabled={busy} onClick={() => setPanelOpen(true)}>Перераспределить</Button> : null}
            </div>
            {canRedistribute && panelOpen ? <RedistributePanel overview={load.overview} busy={busy} onCancel={() => setPanelOpen(false)} onSubmit={props.onRedistribute} /> : null}
          </section>

          {load.overview.unresolved.length > 0 ? (
            <section className={styles.section} aria-label="Требуют перераспределения">
              <div className={[styles.banner, styles.bannerWarning].join(' ')} role="status">
                <div>
                  <div className={typeClass('body-strong')}>Требуют перераспределения ({load.overview.unresolved.length})</div>
                  <ul className={styles.list}>
                    {load.overview.unresolved.map((u) => (
                      <li key={`${u.kind}-${u.assignmentId}`} className={typeClass('body')}>
                        {u.userName}{u.objectName ? ` · «${u.objectName}»` : ''}{u.managerName ? ` · начальник: ${u.managerName}` : ''} — {UNRESOLVED_LABEL[u.kind]}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>
          ) : null}

          <section className={styles.section}>
            <DataTable columns={headColumns} title="Начальники ПТО и организационные команды" context={`${load.overview.heads.length} начальников`} state={load.overview.heads.length === 0 ? 'Empty' : 'Default'} emptyLabel="Начальников ПТО пока нет">
              {load.overview.heads.map((head) => (
                <tr key={head.userId} className={styles.row}>
                  <td className={styles.cell}>
                    <span className={typeClass('body-strong')}>{head.name}</span>
                    {!head.isActive ? <div><StatusBadge variant="Attention">Доступ отключён</StatusBadge></div> : null}
                  </td>
                  <td className={styles.cell}>
                    {head.orgMembers.length === 0 ? <span className={[typeClass('body'), styles.secondary].join(' ')}>Команда пуста</span> : (
                      <ul className={styles.list}>{head.orgMembers.map((m) => <li key={m.assignmentId} className={typeClass('body')}>{m.name}{!m.isActive ? ' (недоступен)' : ''}</li>)}</ul>
                    )}
                  </td>
                  <td className={styles.cell}>
                    {head.ledObjects.length === 0 ? <span className={[typeClass('body'), styles.secondary].join(' ')}>—</span> : (
                      <ul className={styles.list}>{head.ledObjects.map((o) => <li key={o.objectId} className={typeClass('body')}>{o.name}</li>)}</ul>
                    )}
                  </td>
                </tr>
              ))}
            </DataTable>
          </section>

          <section className={styles.section}>
            <DataTable columns={objectColumns} title="Команды ПТО на объектах" context={`${load.overview.objects.length} объектов`} state={load.overview.objects.length === 0 ? 'Empty' : 'Default'} emptyLabel="Объектов пока нет">
              {load.overview.objects.map((o) => (
                <tr key={o.objectId} className={styles.row}>
                  <td className={styles.cell}><span className={typeClass('body-strong')}>{o.name}</span></td>
                  <td className={styles.cell}>{o.lead ? <span className={typeClass('body')}>{o.lead.name}{!o.lead.isActive ? ' (недоступен)' : ''}</span> : <span className={[typeClass('body'), styles.secondary].join(' ')}>Не назначен</span>}</td>
                  <td className={styles.cell}>
                    {o.members.length === 0 ? <span className={[typeClass('body'), styles.secondary].join(' ')}>Инженеры не назначены</span> : (
                      <ul className={styles.list}>
                        {o.members.map((m) => (
                          <li key={m.assignmentId} className={typeClass('body')}>
                            {m.name}{!m.isActive ? ' (недоступен)' : ''}
                            {m.inherited && m.orgManagerName ? <span className={[typeClass('label'), styles.secondary].join(' ')}> · из команды: {m.orgManagerName}</span> : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </DataTable>
          </section>

          <section className={styles.section}>
            <DataTable columns={handoverColumns} title="Передачи дел" context={`${load.overview.handovers.length} записей`} state={load.overview.handovers.length === 0 ? 'Empty' : 'Default'} emptyLabel="Передач дел пока нет">
              {load.overview.handovers.map((h) => (
                <tr key={h.id} className={styles.row}>
                  <td className={styles.cell}><span className={typeClass('body')}>{h.objectName}</span></td>
                  <td className={styles.cell}><span className={typeClass('body')}>{h.outgoingName} → {h.incomingName}</span></td>
                  <td className={styles.cell}><span className={typeClass('body')}>{h.reason}</span>{h.administrativeCompletionReason ? <div className={[typeClass('label'), styles.secondary].join(' ')}>Админ. завершение: {h.administrativeCompletionReason}</div> : null}</td>
                  <td className={styles.cell}><StatusBadge variant={h.status === 'OPEN' ? 'Attention' : 'OnTrack'}>{HANDOVER_STATUS_LABEL[h.status]}</StatusBadge></td>
                  <td className={styles.cell}>{canRedistribute ? <HandoverActions handover={h} busy={busy} onAdminComplete={props.onAdminComplete} /> : null}</td>
                </tr>
              ))}
            </DataTable>
          </section>
        </>
      ) : null}
    </AppShell>
  );
}
