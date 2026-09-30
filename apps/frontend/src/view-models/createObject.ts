import type { ObjectCreateInput, ObjectCreateOptions } from '../data/objectCreateApi';

/**
 * OBJ-1 — pure state of the «Добавить объект» form: field validation, the
 * options state (loading / no active РП / no contractors) and the mapping of a
 * failed submit to a user-facing state. No React, no fetch.
 */
export interface CreateObjectDraft {
  externalCode: string;
  name: string;
  address: string;
  organizationName: string;
  customerName: string;
  projectManagerId: string;
  startDate: string;
  plannedFinishDate: string;
  contractValue: string;
  contractorIds: string[];
}

export const EMPTY_DRAFT: CreateObjectDraft = {
  externalCode: '',
  name: '',
  address: '',
  organizationName: '',
  customerName: '',
  projectManagerId: '',
  startDate: '',
  plannedFinishDate: '',
  contractValue: '',
  contractorIds: [],
};

export const NO_ACTIVE_PM_LABEL = 'Нет активного РП для назначения.';
export const NO_CONTRACTORS_LABEL = 'Подрядчики пока не заведены. Их можно назначить позже.';
export const DUPLICATE_CODE_LABEL = 'Объект с таким кодом уже существует. Укажите другой код объекта / УКО.';

export type CreateOptionsState =
  | { kind: 'Loading' }
  | { kind: 'Error'; message: string }
  | { kind: 'NoProjectManager' }
  | { kind: 'Ready'; options: ObjectCreateOptions; hasContractors: boolean };

export function optionsState(options: ObjectCreateOptions): CreateOptionsState {
  if (options.projectManagers.length === 0) return { kind: 'NoProjectManager' };
  return { kind: 'Ready', options, hasContractors: options.contractors.length > 0 };
}

export type DraftErrors = Partial<Record<keyof CreateObjectDraft, string>>;

const REQUIRED = 'Обязательное поле';
const MONEY = /^\d{1,16}(\.\d{1,2})?$/;

export function validateDraft(d: CreateObjectDraft): DraftErrors {
  const errors: DraftErrors = {};
  (['externalCode', 'name', 'address', 'organizationName'] as const).forEach((key) => {
    if (d[key].trim() === '') errors[key] = REQUIRED;
    else if (d[key].trim().length > 500) errors[key] = 'Не более 500 символов';
  });
  if (d.customerName.trim().length > 500) errors.customerName = 'Не более 500 символов';
  if (d.projectManagerId === '') errors.projectManagerId = 'Выберите РП';
  if (d.startDate === '') errors.startDate = REQUIRED;
  if (d.plannedFinishDate === '') errors.plannedFinishDate = REQUIRED;
  else if (d.startDate !== '' && d.plannedFinishDate < d.startDate) {
    errors.plannedFinishDate = 'Плановая дата завершения не может быть раньше даты начала';
  }
  if (d.contractValue.trim() === '') errors.contractValue = REQUIRED;
  else if (!MONEY.test(d.contractValue.trim().replace(',', '.'))) {
    errors.contractValue = 'Неотрицательное число, не более двух знаков после точки';
  }
  return errors;
}

/** Normalises a decimal comma; the backend takes a dot-decimal string. */
export function toInput(d: CreateObjectDraft): ObjectCreateInput {
  const customerName = d.customerName.trim();
  return {
    externalCode: d.externalCode.trim(),
    name: d.name.trim(),
    address: d.address.trim(),
    organizationName: d.organizationName.trim(),
    ...(customerName ? { customerName } : {}),
    projectManagerId: d.projectManagerId,
    startDate: d.startDate,
    plannedFinishDate: d.plannedFinishDate,
    contractValue: d.contractValue.trim().replace(',', '.'),
    contractorIds: d.contractorIds,
  };
}

export type SubmitFailure =
  | { kind: 'DuplicateCode'; message: string }
  | { kind: 'Api'; message: string };

export function classifySubmitFailure(status: number, message: string): SubmitFailure {
  if (status === 409) return { kind: 'DuplicateCode', message: DUPLICATE_CODE_LABEL };
  return { kind: 'Api', message: message || 'Не удалось создать объект' };
}
