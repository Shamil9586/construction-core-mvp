import { useEffect, useState, type FormEvent } from 'react';
import { StatusBadge, typeClass } from '../../design-system';
import * as api from '../../data/aosrApi';
import { readSchemeFile, SCHEME_FILE_ACCEPT } from '../../download/readSchemeFile';
import type { AosrDetail, AosrListItem, AosrPackageView, AosrPartyRole, AosrQualityDocType, PackageQuantityView } from '../../data/aosrApi';
import styles from './PackageDetail.module.css';

/**
 * ID-AUTO-1 — the АОСР section of Package Detail. Everything here is a request to the backend, which owns
 * readiness, numbering, the package freeze and PTO authorization; `canEdit` only decides which controls are
 * offered. No quantity is ever part of an AOSR: the current accepted quantity is shown separately, once.
 */
export interface AosrSectionProps {
  packageId: string;
  packageStatus: string;
  view: AosrPackageView | null;
  quantity: PackageQuantityView | null;
  error: string | null;
  /** PTO / ADMIN holding the package's effective assignment. */
  canEdit: boolean;
  /** PTO only — the backend refuses everyone else. */
  canRecordCustomerQuantity: boolean;
  onChanged: () => void;
}

const EDITABLE = ['DRAFT', 'PREPARING', 'READY_FOR_PRESENTATION', 'CORRECTING'];
const PARTY_FIELDS: { role: AosrPartyRole; label: string; kind: 'org' | 'person'; required: boolean }[] = [
  { role: 'DEVELOPER', label: 'Застройщик, технический заказчик', kind: 'org', required: true },
  { role: 'CONSTRUCTION_ENTITY', label: 'Лицо, осуществляющее строительство', kind: 'org', required: true },
  { role: 'DESIGNER', label: 'Лицо, осуществляющее подготовку проектной документации', kind: 'org', required: true },
  { role: 'WORK_EXECUTOR', label: 'Лицо, выполнившее работы', kind: 'org', required: true },
  { role: 'DEVELOPER_SC_REP', label: 'Представитель застройщика по строительному контролю', kind: 'person', required: true },
  { role: 'CONSTRUCTION_REP', label: 'Представитель лица, осуществляющего строительство', kind: 'person', required: true },
  { role: 'INTERNAL_SC', label: 'Представитель лица, осуществляющего строительство, по вопросам строительного контроля', kind: 'person', required: true },
  { role: 'DESIGNER_REP', label: 'Представитель проектировщика', kind: 'person', required: false },
  { role: 'EXECUTOR_REP', label: 'Представитель лица, выполнившего работы', kind: 'person', required: false },
];
const DOC_TYPES: { value: AosrQualityDocType; label: string }[] = [
  { value: 'PASSPORT', label: 'Паспорт' },
  { value: 'CERTIFICATE', label: 'Сертификат' },
  { value: 'DECLARATION', label: 'Декларация' },
  { value: 'OTHER', label: 'Другой' },
];
const STATUS_LABEL: Record<AosrListItem['status'], string> = { DRAFT: 'Черновик', GENERATED: 'DOCX сформирован', NEEDS_REGENERATION: 'Есть изменения — пересоздать DOCX' };
const SOURCE_LABEL = { CUSTOMER_ACCEPTED: 'принято заказчиком', INTERNAL_SC: 'принято строительным контролем', RP_FACT: 'по факту РП' } as const;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Не удалось выполнить действие');
const formatQty = (value: string) => Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 4 });

function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  };
  return { pending, error, run };
}

function QuantityBlock({ packageId, packageStatus, quantity, canRecord, onChanged }: { packageId: string; packageStatus: string; quantity: PackageQuantityView; canRecord: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [reference, setReference] = useState('');
  const [attempt, setAttempt] = useState(() => crypto.randomUUID());
  const action = useAction();
  const mayRecord = canRecord && ['PRESENTED', 'ACCEPTED_BY_CUSTOMER'].includes(packageStatus);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const items = quantity.portions.filter((p) => values[p.portionId]?.trim()).map((p) => ({ quantityPortionId: p.portionId, quantity: values[p.portionId].trim().replace(',', '.') }));
    if (!items.length) return;
    void action.run(async () => {
      await api.recordCustomerAcceptedQuantity(packageId, items, reference.trim() || undefined, attempt);
      setAttempt(crypto.randomUUID());
      setValues({});
      setReference('');
      setOpen(false);
      onChanged();
    });
  };
  return (
    <section className={styles.section}>
      <span className={[styles.sectionLabel, typeClass('label')].join(' ')}>Принятый объём</span>
      {quantity.current ? (
        <span className={typeClass('body-strong')}>
          {formatQty(quantity.current.quantity)} {quantity.current.unit}{' '}
          <span className={[styles.secondary, typeClass('body')].join(' ')}>— {SOURCE_LABEL[quantity.current.source]}</span>
        </span>
      ) : (
        <span className={[styles.empty, typeClass('body')].join(' ')}>Объём ещё не подтверждён</span>
      )}
      <div className={styles.inlineForm}>
        <button type="button" className={styles.actionButton} onClick={() => setShowHistory(!showHistory)}>
          {showHistory ? 'Скрыть историю' : 'История объёмов'}
        </button>
        {mayRecord ? (
          <button type="button" className={styles.actionButton} onClick={() => setOpen(!open)}>
            Зафиксировать объём, принятый заказчиком
          </button>
        ) : null}
      </div>
      {open ? (
        <form className={styles.inlineForm} onSubmit={submit}>
          {quantity.portions.map((p) => (
            <label key={p.portionId} className={typeClass('body')}>
              {p.label}, {p.unit}{' '}
              <input className={styles.input} inputMode="decimal" value={values[p.portionId] ?? ''} onChange={(e) => setValues({ ...values, [p.portionId]: e.target.value })} aria-label={`Принято заказчиком: ${p.label}`} />
            </label>
          ))}
          <input className={styles.input} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Реквизит подтверждения (необязательно)" aria-label="Реквизит подтверждения" />
          <button type="submit" className={styles.actionButton} disabled={action.pending}>Зафиксировать</button>
          {action.error ? <span className={styles.errorText}>{action.error}</span> : null}
        </form>
      ) : null}
      {showHistory ? (
        quantity.history.length ? (
          <ul className={styles.plainList}>
            {quantity.history.map((h) => (
              <li key={h.id} className={typeClass('body')}>
                <span className={styles.secondary}>{h.recordedAt.slice(0, 10)}</span> · {h.source === 'RP_FACT' ? 'Факт РП' : h.source === 'INTERNAL_SC' ? 'Внутренний СК' : 'Принято заказчиком'}: {formatQty(h.quantity)} · {h.recordedBy}
              </li>
            ))}
          </ul>
        ) : (
          <span className={[styles.empty, typeClass('body')].join(' ')}>История пуста</span>
        )
      ) : null}
    </section>
  );
}

function PartiesBlock({ packageId, view, onChanged }: { packageId: string; view: AosrPackageView; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const action = useAction();
  const current = (role: AosrPartyRole) => view.parties.find((p) => p.partyRole === role);
  const value = (role: AosrPartyRole, field: string): string => drafts[role]?.[field] ?? ((current(role) as unknown as Record<string, string | null> | undefined)?.[field] ?? (field === 'organizationName' ? view.partySuggestions[role] ?? '' : ''));
  const set = (role: AosrPartyRole, field: string, v: string) => setDrafts({ ...drafts, [role]: { ...drafts[role], [field]: v } });
  const save = (role: AosrPartyRole, fields: string[]) =>
    action.run(async () => {
      const body: Record<string, unknown> = { partyRole: role, version: current(role)?.version };
      for (const f of fields) body[f] = value(role, f);
      await api.saveAosrParty(packageId, body as never);
      setDrafts({ ...drafts, [role]: {} });
      onChanged();
    });
  return (
    <div className={styles.documentCard}>
      <button type="button" className={styles.actionButton} onClick={() => setOpen(!open)}>
        {open ? 'Скрыть стороны и подписантов' : 'Стороны и подписанты объекта'}
      </button>
      {open ? (
        <>
          <span className={[styles.secondary, typeClass('body')].join(' ')}>Данные общие для всех АОСР объекта; изменения применяются к новым формированиям.</span>
          {PARTY_FIELDS.map((f) => {
            const fields = f.kind === 'org' ? ['organizationName', 'organizationDetails'] : ['personName', 'position', 'registryNumber', 'authorityDocument'];
            const labels: Record<string, string> = { organizationName: 'Наименование', organizationDetails: 'Реквизиты (ОГРН, ИНН, адрес); СРО — со следующей строки', personName: 'ФИО', position: 'Должность', registryNumber: 'Номер в НРС', authorityDocument: 'Приказ / документ о полномочиях' };
            return (
              <div key={f.role} className={styles.inlineForm}>
                <span className={typeClass('body-strong')}>{f.label}{f.required ? ' *' : ''}</span>
                {fields.map((field) => field === 'organizationDetails' ? (
                  <textarea key={field} rows={2} className={styles.input} value={value(f.role, field)} onChange={(e) => set(f.role, field, e.target.value)} placeholder={labels[field]} aria-label={`${f.label}: ${labels[field]}`} />
                ) : (
                  <input key={field} className={styles.input} value={value(f.role, field)} onChange={(e) => set(f.role, field, e.target.value)} placeholder={labels[field]} aria-label={`${f.label}: ${labels[field]}`} />
                ))}
                <button type="button" className={styles.actionButton} disabled={action.pending} onClick={() => void save(f.role, fields)}>Сохранить</button>
              </div>
            );
          })}
          {action.error ? <span className={styles.errorText}>{action.error}</span> : null}
        </>
      ) : null}
    </div>
  );
}

/** «АОСР формируются в Core» / «АОСР формируются вне Core» — an explicit, audited choice; the Core generator is an optional tool. */
function MethodBlock({ packageId, view, canEdit, onChanged }: { packageId: string; view: api.AosrPackageView; canEdit: boolean; onChanged: () => void }) {
  const action = useAction();
  const choose = (method: api.AosrMethod) => void action.run(async () => { await api.setAosrMethod(packageId, method); onChanged(); });
  const last = view.methodHistory[view.methodHistory.length - 1];
  return (
    <div className={styles.documentCard}>
      <span className={typeClass('label')}>Как готовятся АОСР по этому пакету</span>
      {view.method === null ? (
        <span className={typeClass('body')}>Генератор АОСР в Core — необязательный инструмент: можно готовить АОСР у себя на компьютере. Выберите способ — это фиксируется в истории пакета; без выбора пакет нельзя предъявить заказчику.</span>
      ) : view.method === 'CORE' ? (
        <span className={typeClass('body-strong')}>АОСР формируются в Core</span>
      ) : (
        <>
          <span className={typeClass('body-strong')}>АОСР формируются вне Core</span>
          <span className={[styles.secondary, typeClass('body')].join(' ')}>Core не требует ни записей АОСР, ни номера, ни DOCX. Загрузите исполнительную схему, предъявите документацию заказчику и после его приёмки зафиксируйте принятый объём.</span>
        </>
      )}
      {canEdit && (view.method !== 'CORE' || view.items.length === 0) ? (
        <div className={styles.inlineForm}>
          {view.method !== 'CORE' ? <button type="button" className={styles.actionButton} disabled={action.pending} onClick={() => choose('CORE')}>{view.method === null ? 'АОСР формируются в Core' : 'Перейти к формированию АОСР в Core'}</button> : null}
          {view.method !== 'EXTERNAL' ? <button type="button" className={styles.actionButton} disabled={action.pending} onClick={() => choose('EXTERNAL')}>АОСР формируются вне Core</button> : null}
        </div>
      ) : null}
      {view.method === 'CORE' && view.items.length > 0 && canEdit ? <span className={[styles.secondary, typeClass('body')].join(' ')}>Переход на «вне Core» недоступен, пока в пакете есть АОСР, созданные в Core.</span> : null}
      {last ? <span className={[styles.secondary, typeClass('body')].join(' ')}>Выбрано: {last.chosenAt.slice(0, 10)} · {last.chosenBy}</span> : null}
      {action.error ? <span className={styles.errorText}>{action.error}</span> : null}
    </div>
  );
}

/** Title + file in one step: a scheme is created together with its file, never as an empty record. */
function SchemeUploadForm({ packageId, onCreated }: { packageId: string; onCreated: (schemeId: string) => void | Promise<void> }) {
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const action = useAction();
  return (
    <form className={styles.inlineForm} onSubmit={(e) => { e.preventDefault(); if (!title.trim() || !file) return; void action.run(async () => { const payload = await readSchemeFile(file); const created = await api.createExecutiveScheme(packageId, title.trim(), payload); setTitle(''); setFile(null); setInputKey(inputKey + 1); await onCreated(created.id); }); }}>
      <input className={styles.input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Название схемы (например, ES-001)" aria-label="Название исполнительной схемы" />
      <input key={inputKey} type="file" accept={SCHEME_FILE_ACCEPT} className={styles.input} aria-label="Файл исполнительной схемы" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <button type="submit" className={styles.actionButton} disabled={action.pending || !title.trim() || !file}>Загрузить схему</button>
      {action.error ? <span className={styles.errorText}>{action.error}</span> : null}
    </form>
  );
}

/** Executive schemes — the same for both methods. Only a scheme with an uploaded file counts as documentary evidence. */
function SchemesBlock({ packageId, view, editable, onChanged }: { packageId: string; view: api.AosrPackageView; editable: boolean; onChanged: () => void }) {
  const action = useAction();
  return (
    <section className={styles.section}>
      <span className={[styles.sectionLabel, typeClass('label')].join(' ')}>Исполнительные схемы</span>
      {view.schemes.length ? (
        <ul className={styles.plainList}>
          {view.schemes.map((s) => (
            <li key={s.id} className={typeClass('body')}>
              <span className={typeClass('body-strong')}>{s.title}</span>{' '}
              {s.hasFile ? <span className={styles.secondary}>— файл загружен: {s.fileName}</span> : <span className={styles.errorText}>— файл не загружен: схема без файла не считается подтверждающим документом</span>}{' '}
              {s.hasFile ? <button type="button" className={styles.actionButton} disabled={action.pending} onClick={() => void action.run(() => api.downloadExecutiveSchemeFile(packageId, s.id, s.fileName ?? 'scheme'))}>Скачать</button> : null}
              {editable ? (
                <label className={typeClass('body')}>
                  {' '}{s.hasFile ? 'Заменить файл: ' : 'Загрузить файл: '}
                  <input type="file" accept={SCHEME_FILE_ACCEPT} aria-label={`Файл схемы «${s.title}»`} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; void action.run(async () => { await api.attachExecutiveSchemeFile(packageId, s.id, await readSchemeFile(f)); onChanged(); }); }} />
                </label>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <span className={[styles.empty, typeClass('body')].join(' ')}>Исполнительных схем ещё нет. Для предъявления документации заказчику нужна хотя бы одна схема с загруженным файлом.</span>
      )}
      {editable ? <SchemeUploadForm packageId={packageId} onCreated={onChanged} /> : null}
      <span className={[styles.secondary, typeClass('body')].join(' ')}>Одна схема может относиться к нескольким АОСР. Паспорт, сертификат или декларация на материал схему не заменяют.</span>
      {action.error ? <span className={styles.errorText}>{action.error}</span> : null}
    </section>
  );
}

/**
 * The DOCX is fetched (authenticated) as soon as the card shows a generated act, and the button is a REAL anchor to that Blob:
 * saving is then a native user click, not a programmatic click after an await — the form that works in embedded frames and WebViews
 * (see download/saveBlobAsFile.ts). A fetch failure is shown instead of leaving a button that silently does nothing.
 */
function DocxDownload({ aosrId, version, fallbackName }: { aosrId: string; version: number; fallbackName: string }) {
  const [file, setFile] = useState<{ url: string; name: string } | { error: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    setFile(null);
    api.fetchAosrDocx(aosrId, fallbackName).then(({ blob, name }) => {
      if (cancelled) return;
      url = URL.createObjectURL(blob);
      setFile({ url, name });
    }, (e: unknown) => { if (!cancelled) setFile({ error: errorMessage(e) }); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [aosrId, version, fallbackName]);
  if (!file) return <span className={[styles.secondary, typeClass('body')].join(' ')}>Подготовка файла…</span>;
  if ('error' in file) return <span className={styles.errorText}>{file.error}</span>;
  return <a className={styles.linkButton} href={file.url} download={file.name}>Скачать DOCX</a>;
}

function AosrCard({ item, packageId, view, canEdit, frozen, onChanged }: { item: AosrListItem; packageId: string; view: AosrPackageView; canEdit: boolean; frozen: boolean; onChanged: () => void }) {
  const [detail, setDetail] = useState<AosrDetail | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [newMaterial, setNewMaterial] = useState({ name: '', docType: 'CERTIFICATE' as AosrQualityDocType, number: '', docDate: '' });
  const action = useAction();
  const reload = () => api.getAosr(item.id).then((d) => { setDetail(d); setDraft({}); });
  useEffect(() => { void reload(); }, [item.id, item.version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!detail) return <div className={styles.documentCard}><span className={typeClass('body')}>Загрузка…</span></div>;
  const a = detail.aosr;
  const editable = canEdit && !frozen;
  const field = (name: keyof typeof a): string => draft[name as string] ?? ((a[name] as string | number | null) ?? '').toString();
  const dirtyBody = () => {
    const body: Record<string, unknown> = { version: a.version };
    for (const [k, v] of Object.entries(draft)) body[k] = k === 'title' ? v : k === 'copiesCount' ? (v ? Number(v) : null) : v.trim() === '' ? null : v;
    return body as Record<string, unknown> & { version: number };
  };
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const link = (kind: 'quantityPortionIds' | 'materialRecordIds' | 'schemeDocumentIds', ids: string[]) => action.run(async () => { await api.setAosrLinks(item.id, { [kind]: ids, version: a.version }); onChanged(); await reload(); });
  const text = (name: keyof typeof a, label: string, multiline = true) => (
    <label className={typeClass('body')} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {label}
      {multiline ? <textarea className={styles.input} rows={2} value={field(name)} disabled={!editable} onChange={(e) => setDraft({ ...draft, [name]: e.target.value })} /> : <input className={styles.input} value={field(name)} disabled={!editable} onChange={(e) => setDraft({ ...draft, [name]: e.target.value })} />}
    </label>
  );
  const date = (name: 'startDate' | 'endDate' | 'actDate', label: string) => (
    <label className={typeClass('body')}>
      {label} <input type="date" className={styles.input} value={field(name)} disabled={!editable} onChange={(e) => setDraft({ ...draft, [name]: e.target.value })} />
    </label>
  );
  return (
    <div className={styles.documentCard}>
      <span className={typeClass('body-strong')}>{detail.title}{detail.officialNumber !== null ? ` — № ${detail.officialNumber}` : ''}</span>
      {text('title', 'Наименование в списке', false)}
      {text('workDescription', 'Пункт 1. К освидетельствованию предъявлены работы')}
      {editable && detail.point1Proposal && field('workDescription') !== detail.point1Proposal ? (
        <button type="button" className={styles.actionButton} onClick={() => setDraft({ ...draft, workDescription: detail.point1Proposal })}>Подставить предложение: «{detail.point1Proposal}»</button>
      ) : null}
      <div className={styles.inlineForm}>
        {date('startDate', 'Начало работ')}
        {date('endDate', 'Окончание работ')}
        {date('actDate', 'Дата акта')}
      </div>
      {text('projectDocumentation', 'Пункт 2. Проектная / рабочая документация')}
      {text('normativeReferences', 'Пункт 6. Нормативные документы')}
      {text('subsequentWork', 'Пункт 7. Разрешено производство последующих работ')}
      {text('additionalInfo', 'Дополнительные сведения (необязательно)')}
      {editable && Object.keys(draft).length ? (
        <div className={styles.inlineForm}>
          <button type="button" className={styles.actionButton} disabled={action.pending} onClick={() => void action.run(async () => { await api.editAosr(item.id, dirtyBody()); onChanged(); await reload(); })}>Сохранить изменения</button>
        </div>
      ) : null}

      <span className={typeClass('label')}>Материалы и документы о качестве</span>
      {view.materials.length ? view.materials.map((m) => (
        <label key={m.id} className={typeClass('body')}>
          <input type="checkbox" disabled={!editable} checked={detail.materials.some((x) => x.id === m.id)} onChange={() => void link('materialRecordIds', toggle(detail.materials.map((x) => x.id), m.id))} /> {m.name}
          <span className={styles.secondary}> — {m.qualityDocuments.length ? m.qualityDocuments.map((d) => `${DOC_TYPES.find((t) => t.value === d.docType)?.label} № ${d.number}`).join('; ') : 'нет документов о качестве'}</span>
        </label>
      )) : <span className={[styles.empty, typeClass('body')].join(' ')}>Материалов ещё нет</span>}
      {editable ? (
        <div className={styles.inlineForm}>
          <input className={styles.input} placeholder="Новый материал" aria-label="Новый материал" value={newMaterial.name} onChange={(e) => setNewMaterial({ ...newMaterial, name: e.target.value })} />
          <select className={styles.input} aria-label="Тип документа о качестве" value={newMaterial.docType} onChange={(e) => setNewMaterial({ ...newMaterial, docType: e.target.value as AosrQualityDocType })}>{DOC_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
          <input className={styles.input} placeholder="№ документа" aria-label="Номер документа о качестве" value={newMaterial.number} onChange={(e) => setNewMaterial({ ...newMaterial, number: e.target.value })} />
          <input type="date" className={styles.input} aria-label="Дата документа о качестве" value={newMaterial.docDate} onChange={(e) => setNewMaterial({ ...newMaterial, docDate: e.target.value })} />
          <button type="button" className={styles.actionButton} disabled={action.pending || !newMaterial.name.trim()} onClick={() => void action.run(async () => {
            const created = await api.createAosrMaterial(packageId, { name: newMaterial.name.trim(), qualityDocuments: newMaterial.number.trim() ? [{ docType: newMaterial.docType, number: newMaterial.number.trim(), ...(newMaterial.docDate ? { docDate: newMaterial.docDate } : {}) }] : [] });
            await api.setAosrLinks(item.id, { materialRecordIds: [...detail.materials.map((x) => x.id), created.id], version: a.version });
            setNewMaterial({ name: '', docType: 'CERTIFICATE', number: '', docDate: '' });
            onChanged();
            await reload();
          })}>Добавить материал</button>
        </div>
      ) : null}

      <span className={typeClass('label')}>Исполнительные схемы (одна схема с файлом может относиться к нескольким АОСР)</span>
      {view.schemes.length ? view.schemes.map((s) => (
        <label key={s.id} className={typeClass('body')}>
          <input type="checkbox" disabled={!editable} checked={detail.schemes.some((x) => x.id === s.id)} onChange={() => void link('schemeDocumentIds', toggle(detail.schemes.map((x) => x.id), s.id))} /> {s.title}
          <span className={s.hasFile ? styles.secondary : styles.errorText}> — {s.hasFile ? 'файл загружен' : 'нет файла'}</span>
        </label>
      )) : <span className={[styles.empty, typeClass('body')].join(' ')}>Схем ещё нет</span>}
      {editable ? <SchemeUploadForm packageId={packageId} onCreated={async (schemeId) => { await api.setAosrLinks(item.id, { schemeDocumentIds: [...detail.schemes.map((x) => x.id), schemeId], version: a.version }); onChanged(); await reload(); }} /> : null}

      {view.workPortions.length ? (
        <>
          <span className={typeClass('label')}>Производственный участок (необязательно, не расходуется)</span>
          {view.workPortions.map((p) => (
            <label key={p.id} className={typeClass('body')}>
              <input type="checkbox" disabled={!editable} checked={detail.portionIds.includes(p.id)} onChange={() => void link('quantityPortionIds', toggle(detail.portionIds, p.id))} /> {p.label}{p.location ? ` · ${p.location}` : ''}
            </label>
          ))}
        </>
      ) : null}

      <span className={typeClass('label')}>Готовность</span>
      {detail.readiness.ready ? (
        <span className={typeClass('body')}>Все обязательные поля официальной формы заполнены</span>
      ) : (
        <ul className={styles.plainList}>{detail.readiness.issues.map((i, idx) => <li key={i.code + idx} className={typeClass('body')}>{i.message}</li>)}</ul>
      )}
      <div className={styles.inlineForm}>
        {editable ? (
          <button type="button" className={styles.actionButton} disabled={action.pending || !detail.readiness.ready || Object.keys(draft).length > 0} onClick={() => void action.run(async () => { await api.generateAosr(item.id, a.version); onChanged(); await reload(); })}>
            {detail.officialNumber === null ? 'Сформировать DOCX' : 'Пересоздать DOCX'}
          </button>
        ) : null}
        {detail.hasDocx ? <DocxDownload aosrId={item.id} version={a.version} fallbackName={`AOSR_${detail.officialNumber}.docx`} /> : null}
        {editable && detail.officialNumber === null ? <button type="button" className={styles.actionButton} disabled={action.pending} onClick={() => void action.run(async () => { await api.deleteAosr(item.id); onChanged(); })}>Удалить черновик</button> : null}
        {action.error ? <span className={styles.errorText}>{action.error}</span> : null}
      </div>
    </div>
  );
}

export function AosrSection({ packageId, packageStatus, view, quantity, error, canEdit, canRecordCustomerQuantity, onChanged }: AosrSectionProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const action = useAction();
  const frozen = !EDITABLE.includes(packageStatus);
  if (error && !view) return <section className={styles.section}><span className={styles.errorText}>{error}</span></section>;
  if (!view) return null;
  const editable = canEdit && !frozen;
  return (
    <>
      {quantity ? <QuantityBlock packageId={packageId} packageStatus={packageStatus} quantity={quantity} canRecord={canRecordCustomerQuantity} onChanged={onChanged} /> : null}
      <section className={styles.section}>
        <span className={[styles.sectionLabel, typeClass('label')].join(' ')}>АОСР</span>
        <MethodBlock packageId={packageId} view={view} canEdit={canEdit} onChanged={onChanged} />
        {view.method === 'CORE' && view.items.some((i) => i.status !== 'GENERATED') ? <span className={[styles.secondary, typeClass('body')].join(' ')}>Перед предъявлением заказчику у каждого АОСР должен быть сформирован актуальный DOCX; ненужные черновики можно удалить.</span> : null}
        {view.method === 'CORE' && view.items.length === 0 ? <span className={[styles.secondary, typeClass('body')].join(' ')}>При выборе «в Core» перед предъявлением нужно сформировать хотя бы один АОСР.</span> : null}
        {view.method === 'CORE' && !view.templateAvailable ? <span className={styles.errorText}>Официальный шаблон АОСР недоступен</span> : null}
        {view.method !== 'CORE' ? null : view.items.length ? (
          <div className={styles.documentList}>
            {view.items.map((item) => (
              <div key={item.id} className={styles.documentCard}>
                <div className={styles.inlineForm}>
                  <span className={typeClass('body-strong')}>{item.title}{item.officialNumber !== null ? ` — № ${item.officialNumber}` : ''}</span>
                  <StatusBadge variant={item.status === 'GENERATED' ? 'OnTrack' : item.status === 'NEEDS_REGENERATION' ? 'Attention' : 'Neutral'}>{STATUS_LABEL[item.status]}</StatusBadge>
                  <span className={[styles.secondary, typeClass('body')].join(' ')}>{item.ready ? 'Готов к формированию' : `Не заполнено: ${item.issueCount}`}</span>
                  <button type="button" className={styles.actionButton} onClick={() => setOpenId(openId === item.id ? null : item.id)}>{openId === item.id ? 'Свернуть' : 'Открыть'}</button>
                </div>
                {openId === item.id ? <AosrCard item={item} packageId={packageId} view={view} canEdit={canEdit} frozen={frozen} onChanged={onChanged} /> : null}
              </div>
            ))}
          </div>
        ) : (
          <span className={[styles.empty, typeClass('body')].join(' ')}>АОСР ещё не созданы</span>
        )}
        {view.method === 'CORE' && editable ? (
          <>
            {view.suggestions.length ? (
              <div className={styles.documentCard}>
                <span className={typeClass('label')}>Типовые АОСР по виду работ (предложения, не обязательные этапы)</span>
                {view.suggestions.map((s) => (
                  <div key={s.suggestionCode} className={styles.inlineForm}>
                    <span className={typeClass('body')}>{s.title}</span>
                    <button type="button" className={styles.actionButton} disabled={action.pending} onClick={() => void action.run(async () => { await api.createAosr(packageId, { suggestionCode: s.suggestionCode }); onChanged(); })}>Принять</button>
                    <button type="button" className={styles.actionButton} disabled={action.pending} onClick={() => void action.run(async () => { await api.dismissAosrSuggestion(packageId, s.suggestionCode); onChanged(); })}>Убрать</button>
                  </div>
                ))}
              </div>
            ) : null}
            <form className={styles.inlineForm} onSubmit={(e) => { e.preventDefault(); if (!title.trim()) return; void action.run(async () => { const created = await api.createAosr(packageId, { title: title.trim() }); setTitle(''); setOpenId(created.id); onChanged(); }); }}>
              <input className={styles.input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Наименование нового АОСР" aria-label="Наименование нового АОСР" />
              <button type="submit" className={styles.actionButton} disabled={action.pending || !title.trim()}>+ Создать АОСР</button>
            </form>
            {action.error ? <span className={styles.errorText}>{action.error}</span> : null}
          </>
        ) : view.method === 'CORE' && frozen && canEdit ? (
          <span className={[styles.secondary, typeClass('body')].join(' ')}>Состав пакета заблокирован в текущем статусе — АОСР изменить нельзя.</span>
        ) : null}
        {view.method === 'CORE' && canEdit ? <PartiesBlock packageId={packageId} view={view} onChanged={onChanged} /> : null}
      </section>
      <SchemesBlock packageId={packageId} view={view} editable={editable} onChanged={onChanged} />
    </>
  );
}
