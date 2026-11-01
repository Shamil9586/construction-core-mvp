import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AppShell, Breadcrumb, Button, PageHeader, StatusBadge, typeClass } from '../../design-system';
import { AREA_SCOPE_KINDS, AREA_SCOPE_UNITS } from '../../types/areaScope';
import type { AreaScopeCreatePayload, AreaScopeKind, AreaScopeUnit } from '../../types/areaScope';
import { KIND_LABELS, parentOptions } from '../../view-models/areaScope';
import type { AreaNode, AreaTreeViewModel, ErrorView } from '../../view-models/areaScope';
import styles from './AreaScope.module.css';

/**
 * GPR-2 R05 S2 — «Зоны объекта»: the flexible parent/child AreaScope tree of ONE object, plus a create form for a root or child node.
 *
 * Presentation only. The server owns identity, measurement pairing and parent/child compatibility; the form restates none of it and shows
 * the server's answer. There is deliberately no edit, delete or retire control: identity and measure of a node are immutable.
 */
export type AreaScopeScreenState =
  | { status: 'Loading' }
  | { status: 'Error'; error: ErrorView }
  | { status: 'Unavailable'; message: string; reference: string | null }
  | { status: 'Ready'; tree: AreaTreeViewModel };

export type AreaScopeCreateState =
  | { status: 'Idle' }
  | { status: 'Submitting' }
  | { status: 'Error'; error: ErrorView }
  | { status: 'Saved'; code: string };

export interface AreaScopesProps {
  state: AreaScopeScreenState;
  create: AreaScopeCreateState;
  /** Resolves true when the node was saved (the form then clears). */
  onCreate: (payload: AreaScopeCreatePayload) => Promise<boolean>;
  onDismissCreateResult: () => void;
  onRetry: () => void;
  sidebar: ReactNode;
  topbar?: ReactNode;
  objectName: string;
  onNavigateHome: () => void;
  onOpenObject: () => void;
  className?: string;
}

interface Draft {
  parentId: string;
  kind: AreaScopeKind;
  code: string;
  name: string;
  quantity: string;
  unit: '' | AreaScopeUnit;
}

const EMPTY_DRAFT: Draft = { parentId: '', kind: 'BUILDING', code: '', name: '', quantity: '', unit: '' };

function payloadOf(draft: Draft): AreaScopeCreatePayload {
  const quantity = draft.quantity.trim().replace(',', '.');
  return {
    ...(draft.parentId ? { parentId: draft.parentId } : {}),
    kind: draft.kind,
    code: draft.code.trim(),
    name: draft.name.trim(),
    ...(quantity ? { measureQuantity: quantity } : {}),
    ...(draft.unit ? { measureUnit: draft.unit } : {}),
  };
}

function ErrorBlock({ error }: { error: ErrorView }) {
  return (
    <div role="alert" className={styles.alert}>
      <p className={typeClass('body-strong')}>{error.message}</p>
      {error.lines.length > 0 ? (
        <ul className={styles.plainList}>
          {error.lines.map((line) => (
            <li key={line} className={typeClass('body')}>{line}</li>
          ))}
        </ul>
      ) : null}
      {error.reference ? <p className={[styles.secondary, typeClass('meta')].join(' ')}>{error.reference}</p> : null}
    </div>
  );
}

function TreeNode({ node, onAddChild }: { node: AreaNode; onAddChild: (node: AreaNode) => void }) {
  const flagText = node.flag === 'ORPHAN' ? 'Родительская зона не найдена' : node.flag === 'CYCLE' ? 'Циклическая связь с родителем' : null;
  return (
    <li className={styles.node}>
      <div className={styles.nodeRow}>
        <div className={styles.nodeMain}>
          <span className={typeClass('body-strong')}>{node.code}</span>
          <span className={typeClass('body')}>{node.name}</span>
          {flagText ? <span className={[styles.flag, typeClass('meta')].join(' ')}>{flagText}</span> : null}
        </div>
        <dl className={styles.facts}>
          <div>
            <dt className={[styles.secondary, typeClass('meta')].join(' ')}>Вид</dt>
            <dd className={typeClass('body')}>{node.kindLabel}</dd>
          </div>
          <div>
            <dt className={[styles.secondary, typeClass('meta')].join(' ')}>Объём</dt>
            <dd className={typeClass('body')}>{node.measure}</dd>
          </div>
          <div>
            <dt className={[styles.secondary, typeClass('meta')].join(' ')}>Статус</dt>
            <dd>
              <StatusBadge variant={node.active ? 'OnTrack' : 'Attention'}>{node.lifecycle}</StatusBadge>
            </dd>
          </div>
        </dl>
        {node.active ? (
          <button type="button" className={styles.linkButton} onClick={() => onAddChild(node)} aria-label={`Добавить зону внутрь: ${node.code} ${node.name}`}>
            Добавить внутрь
          </button>
        ) : null}
      </div>
      {node.children.length > 0 ? (
        <ul className={styles.tree} aria-label={`Вложенные зоны: ${node.code}`}>
          {node.children.map((child) => (
            <TreeNode key={child.id} node={child} onAddChild={onAddChild} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function AreaScopes({
  state,
  create,
  onCreate,
  onDismissCreateResult,
  onRetry,
  sidebar,
  topbar,
  objectName,
  onNavigateHome,
  onOpenObject,
  className,
}: AreaScopesProps) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const codeRef = useRef<HTMLInputElement>(null);
  const ids = { parent: useId(), kind: useId(), code: useId(), name: useId(), quantity: useId(), unit: useId() };
  const submitting = create.status === 'Submitting';
  const tree = state.status === 'Ready' ? state.tree : null;
  const parents = tree ? parentOptions(tree) : [];

  // A parent that vanished from the tree (after a reload) must not stay selected.
  useEffect(() => {
    if (tree && draft.parentId && !tree.rows.some((row) => row.id === draft.parentId)) setDraft((previous) => ({ ...previous, parentId: '' }));
  }, [tree, draft.parentId]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    if (create.status === 'Saved' || create.status === 'Error') onDismissCreateResult();
    setDraft((previous) => ({ ...previous, [key]: value }));
  };

  const addChild = (node: AreaNode) => {
    set('parentId', node.id);
    codeRef.current?.focus();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    if (await onCreate(payloadOf(draft))) setDraft((previous) => ({ ...EMPTY_DRAFT, parentId: previous.parentId, kind: previous.kind }));
  };

  let body: ReactNode;
  if (state.status === 'Loading') {
    body = <p aria-live="polite" className={typeClass('body')}>Загрузка зон объекта…</p>;
  } else if (state.status === 'Unavailable') {
    body = (
      <div role="alert" className={styles.alert}>
        <p className={typeClass('body-strong')}>{state.message}</p>
        {state.reference ? <p className={[styles.secondary, typeClass('meta')].join(' ')}>{state.reference}</p> : null}
      </div>
    );
  } else if (state.status === 'Error') {
    body = (
      <>
        <ErrorBlock error={state.error} />
        <Button variant="Secondary" onClick={onRetry}>Повторить загрузку</Button>
      </>
    );
  } else {
    body = (
      <>
        <section aria-labelledby={`${ids.parent}-title`} className={styles.panel}>
          <h2 id={`${ids.parent}-title`} className={typeClass('heading-section')}>Дерево зон</h2>
          {state.tree.total === 0 ? (
            <p className={[styles.secondary, typeClass('body')].join(' ')}>Зон пока нет. Добавьте первую зону ниже.</p>
          ) : (
            <>
              <p className={[styles.secondary, typeClass('meta')].join(' ')}>Всего зон: {state.tree.total}</p>
              {state.tree.orphanCount + state.tree.cycleCount + state.tree.duplicateIdCount > 0 ? (
                <p role="status" className={[styles.flag, typeClass('meta')].join(' ')}>
                  Часть данных не образует корректное дерево: без родителя — {state.tree.orphanCount}, циклов — {state.tree.cycleCount}, повторов — {state.tree.duplicateIdCount}.
                </p>
              ) : null}
              <ul className={styles.tree} aria-label="Зоны объекта">
                {state.tree.roots.map((node) => (
                  <TreeNode key={node.id} node={node} onAddChild={addChild} />
                ))}
              </ul>
            </>
          )}
        </section>

        <section aria-labelledby={`${ids.kind}-title`} className={styles.panel}>
          <h2 id={`${ids.kind}-title`} className={typeClass('heading-section')}>Новая зона</h2>
          <form onSubmit={submit} className={styles.form} aria-busy={submitting}>
            <div className={styles.field}>
              <label htmlFor={ids.parent} className={[styles.fieldLabel, typeClass('label')].join(' ')}>Родительская зона</label>
              <select id={ids.parent} className={styles.control} value={draft.parentId} onChange={(event) => set('parentId', event.target.value)} disabled={submitting}>
                <option value="">Без родителя (корневая зона)</option>
                {parents.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor={ids.kind} className={[styles.fieldLabel, typeClass('label')].join(' ')}>Вид</label>
              <select id={ids.kind} className={styles.control} value={draft.kind} onChange={(event) => set('kind', event.target.value as AreaScopeKind)} disabled={submitting}>
                {AREA_SCOPE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor={ids.code} className={[styles.fieldLabel, typeClass('label')].join(' ')}>Код</label>
              <input id={ids.code} ref={codeRef} className={styles.control} value={draft.code} onChange={(event) => set('code', event.target.value)} disabled={submitting} autoComplete="off" />
            </div>
            <div className={styles.field}>
              <label htmlFor={ids.name} className={[styles.fieldLabel, typeClass('label')].join(' ')}>Название</label>
              <input id={ids.name} className={styles.control} value={draft.name} onChange={(event) => set('name', event.target.value)} disabled={submitting} autoComplete="off" />
            </div>
            <div className={styles.field}>
              <label htmlFor={ids.quantity} className={[styles.fieldLabel, typeClass('label')].join(' ')}>Количество (необязательно)</label>
              <input id={ids.quantity} className={styles.control} inputMode="decimal" value={draft.quantity} onChange={(event) => set('quantity', event.target.value)} disabled={submitting} autoComplete="off" />
            </div>
            <div className={styles.field}>
              <label htmlFor={ids.unit} className={[styles.fieldLabel, typeClass('label')].join(' ')}>Единица (необязательно)</label>
              <select id={ids.unit} className={styles.control} value={draft.unit} onChange={(event) => set('unit', event.target.value as Draft['unit'])} disabled={submitting}>
                <option value="">Без единицы</option>
                {AREA_SCOPE_UNITS.map((unit) => (
                  <option key={unit} value={unit}>{unit}</option>
                ))}
              </select>
            </div>
            <div className={styles.actions}>
              <Button type="submit" loading={submitting} disabled={submitting}>
                {submitting ? 'Создание…' : 'Создать зону'}
              </Button>
            </div>
          </form>
          {create.status === 'Error' ? <ErrorBlock error={create.error} /> : null}
          {create.status === 'Saved' ? (
            <p role="status" className={[styles.success, typeClass('body-strong')].join(' ')}>Зона «{create.code}» создана.</p>
          ) : null}
        </section>
      </>
    );
  }

  return (
    <AppShell sidebar={sidebar} topbar={topbar} className={className}>
      <Breadcrumb
        items={[
          { label: 'Портфель', onSelect: onNavigateHome },
          { label: objectName, onSelect: onOpenObject },
          { label: 'Зоны объекта' },
        ]}
      />
      <PageHeader eyebrow="ОБЪЕКТ" title="Зоны объекта" description={objectName} />
      {body}
    </AppShell>
  );
}
