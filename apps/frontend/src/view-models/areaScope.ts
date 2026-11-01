import type { AreaScopeKind, AreaScopeRead } from '../types/areaScope';

/**
 * GPR-2 R05 S2 — flat AreaScope list → display tree. Pure: no React, no fetching, no business rule. It restates no measurement or
 * parent/child compatibility rule (the server owns those); it only arranges what the server returned and degrades safely on malformed data.
 */
export const KIND_LABELS: Record<AreaScopeKind, string> = {
  BUILDING: 'Корпус',
  SECTION: 'Секция',
  FLOOR: 'Этаж',
  ZONE: 'Захватка',
  ROOM: 'Помещение',
  SURFACE: 'Поверхность',
  OTHER: 'Другое',
};

const LIFECYCLE_LABELS: Record<string, string> = { ACTIVE: 'Действует', RETIRED: 'Выведена из работы' };

export function kindLabel(kind: string): { label: string; known: boolean } {
  return Object.prototype.hasOwnProperty.call(KIND_LABELS, kind)
    ? { label: KIND_LABELS[kind as AreaScopeKind], known: true }
    : { label: `Неизвестный вид (${kind})`, known: false };
}

export function lifecycleLabel(lifecycle: string): string {
  return Object.prototype.hasOwnProperty.call(LIFECYCLE_LABELS, lifecycle) ? LIFECYCLE_LABELS[lifecycle]! : `Статус не распознан (${lifecycle})`;
}

/** Decimal string shown as received (comma separator for Russian display); never parsed into a JavaScript number. */
export function measureText(quantity: string | null, unit: string | null): string {
  if (quantity === null || unit === null) return 'Без объёма';
  return `${quantity.replace('.', ',')} ${unit}`;
}

export type AreaNodeFlag = 'ORPHAN' | 'CYCLE';

export interface AreaNode {
  id: string;
  parentId: string | null;
  depth: number;
  kindRaw: string;
  kindLabel: string;
  kindKnown: boolean;
  code: string;
  name: string;
  measure: string;
  lifecycleRaw: string;
  lifecycle: string;
  active: boolean;
  /** Set when the data did not form a clean tree for this node: its parent is missing, or it sits in a parent cycle. */
  flag: AreaNodeFlag | null;
  children: AreaNode[];
}

export interface AreaTreeViewModel {
  roots: AreaNode[];
  /** Depth-first, display order. */
  rows: AreaNode[];
  total: number;
  orphanCount: number;
  cycleCount: number;
  duplicateIdCount: number;
}

export interface ParentOption {
  id: string;
  label: string;
}

const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

function byCodeThenNameThenId(a: AreaScopeRead, b: AreaScopeRead): number {
  return collator.compare(a.code, b.code) || collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function buildAreaTree(items: readonly AreaScopeRead[]): AreaTreeViewModel {
  // First occurrence of an id wins; later ones are dropped and counted rather than rendered twice.
  const byId = new Map<string, AreaScopeRead>();
  let duplicateIdCount = 0;
  for (const item of items) {
    if (byId.has(item.id)) duplicateIdCount += 1;
    else byId.set(item.id, item);
  }
  const unique = [...byId.values()].sort(byCodeThenNameThenId);

  const childrenOf = new Map<string, AreaScopeRead[]>();
  const rootItems: AreaScopeRead[] = [];
  const orphanIds = new Set<string>();
  for (const item of unique) {
    if (item.parentId === null) rootItems.push(item);
    else if (item.parentId === item.id || !byId.has(item.parentId)) {
      // Missing parent (or a node that names itself): shown at the top level, flagged — never silently dropped.
      rootItems.push(item);
      orphanIds.add(item.id);
    } else {
      const list = childrenOf.get(item.parentId);
      if (list) list.push(item);
      else childrenOf.set(item.parentId, [item]);
    }
  }

  const visited = new Set<string>();
  const cycleIds = new Set<string>();
  const rows: AreaNode[] = [];

  const toNode = (item: AreaScopeRead, depth: number, flag: AreaNodeFlag | null): AreaNode => {
    const kind = kindLabel(item.kind);
    return {
      id: item.id,
      parentId: item.parentId,
      depth,
      kindRaw: item.kind,
      kindLabel: kind.label,
      kindKnown: kind.known,
      code: item.code,
      name: item.name,
      measure: measureText(item.measureQuantity, item.measureUnit),
      lifecycleRaw: item.lifecycle,
      lifecycle: lifecycleLabel(item.lifecycle),
      active: item.lifecycle === 'ACTIVE',
      flag,
      children: [],
    };
  };

  const build = (item: AreaScopeRead, depth: number, flag: AreaNodeFlag | null): AreaNode => {
    visited.add(item.id);
    const node = toNode(item, depth, flag);
    rows.push(node);
    for (const child of childrenOf.get(item.id) ?? []) {
      if (!visited.has(child.id)) node.children.push(build(child, depth + 1, null));
    }
    return node;
  };

  const roots: AreaNode[] = [];
  for (const item of rootItems) roots.push(build(item, 0, orphanIds.has(item.id) ? 'ORPHAN' : null));

  // Anything still unvisited is only reachable through a parent cycle: surface each as a flagged top-level node, break the loop there.
  for (const item of unique) {
    if (visited.has(item.id)) continue;
    cycleIds.add(item.id);
    roots.push(build(item, 0, 'CYCLE'));
  }

  return { roots, rows, total: rows.length, orphanCount: orphanIds.size, cycleCount: cycleIds.size, duplicateIdCount };
}

/** Active nodes a new child may be created under, in display order. Whether the SERVER accepts a given parent is the server's call. */
export function parentOptions(tree: AreaTreeViewModel): ParentOption[] {
  return tree.rows
    .filter((node) => node.active)
    .map((node) => ({ id: node.id, label: `${'— '.repeat(node.depth)}${node.code} · ${node.name} (${node.kindLabel})` }));
}

const RULE_MESSAGES: Record<string, string> = {
  FIELD_REQUIRED: 'обязательное поле не заполнено',
  FIELD_NOT_ALLOWED: 'поле недопустимо',
  FIELD_TYPE: 'неверный тип значения',
  ENUM_VALUE: 'недопустимое значение',
  OUT_OF_RANGE: 'значение вне допустимого диапазона',
  ID_MALFORMED: 'неверный формат идентификатора',
  DECIMAL_NOT_A_STRING: 'количество должно быть числом',
  DECIMAL_MALFORMED: 'неверный формат количества',
  DECIMAL_SCALE_EXCEEDED: 'слишком много знаков после запятой',
  DECIMAL_OUT_OF_RANGE: 'количество вне допустимого диапазона',
  DECIMAL_NEGATIVE_NOT_ALLOWED: 'количество не может быть отрицательным',
  DECIMAL_NEGATIVE_ZERO: 'количество должно быть больше нуля',
  QUANTITY_MISSING: 'укажите количество вместе с единицей',
  UNIT_MISSING: 'укажите единицу вместе с количеством',
  UNIT_UNKNOWN: 'неизвестная единица измерения',
  UNIT_MISMATCH: 'единица не соответствует родительской зоне',
  DUPLICATE_VALUE: 'такое значение уже есть',
  IDEMPOTENCY_KEY_REQUIRED: 'не передан ключ идемпотентности',
  IDEMPOTENCY_KEY_MALFORMED: 'неверный ключ идемпотентности',
};

const FIELD_NAMES: Record<string, string> = {
  parentId: 'Родитель',
  kind: 'Вид',
  code: 'Код',
  name: 'Название',
  measureQuantity: 'Количество',
  measureUnit: 'Единица',
};

export interface ErrorView {
  /** `unavailable` hides the cause (403/404): it must not disclose whether the object or the feature exists. */
  kind: 'unavailable' | 'validation' | 'conflict' | 'other';
  message: string;
  lines: string[];
  reference: string | null;
}

export function describeApiError(
  error: { status: number; message: string; code?: string | undefined; requestId?: string | undefined },
  violations: readonly { path: string; rule: string }[],
): ErrorView {
  const reference = error.requestId ? `Код обращения: ${error.requestId}` : null;
  if (error.status === 401) return { kind: 'other', message: 'Сеанс завершён. Войдите снова.', lines: [], reference };
  if (error.status === 403 || error.status === 404) {
    return { kind: 'unavailable', message: 'Раздел «Зоны объекта» недоступен.', lines: [], reference };
  }
  if (error.status === 429) return { kind: 'other', message: 'Слишком много запросов. Повторите позже.', lines: [], reference };
  const lines = violations.map((violation) => {
    const field = FIELD_NAMES[violation.path] ?? violation.path;
    const rule = Object.prototype.hasOwnProperty.call(RULE_MESSAGES, violation.rule) ? RULE_MESSAGES[violation.rule]! : 'не принято сервером';
    return `${field}: ${rule}`;
  });
  if (error.status === 400 || error.status === 422) return { kind: 'validation', message: error.message, lines, reference };
  if (error.status === 409) return { kind: 'conflict', message: error.message, lines, reference };
  if (error.status >= 500) return { kind: 'other', message: 'Сервер временно недоступен. Повторите позже.', lines: [], reference };
  return { kind: 'other', message: error.message, lines, reference };
}
