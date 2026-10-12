/**
 * Documentation Package soft archive — pure rules (no database).
 *
 * Archive is NOT a lifecycle status. The PTO workflow (DRAFT … ACCEPTED_BY_CUSTOMER) is unchanged; a package is additionally "archived" or
 * not, with who/when/why. An archived package is retained and auditable but is no longer part of the working set: it is hidden from the
 * normal lists, no longer reserves its Quantity Portions, and cannot take new forward actions.
 *
 * It exists for obsolete / test packages. It must never be a way to hide a documentary process that is actually running, so the rule is
 * deliberately conservative and fails closed.
 */

/** Statuses from which a package may be archived. Anything later has entered (or finished) the customer / SDO route. */
export const ARCHIVABLE_STATUSES = ['DRAFT', 'PREPARING'] as const;

export const PACKAGE_ALREADY_ARCHIVED_MESSAGE = 'Пакет уже архивирован.';
export const PACKAGE_ARCHIVED_MESSAGE = 'Пакет архивирован: новые действия по нему недоступны.';
export const ARCHIVE_REASON_REQUIRED_MESSAGE = 'Укажите причину архивирования пакета.';

/** What exists around a package that archiving could hide. All of it is read from the real tables — nothing is inferred. */
export interface PackageArchiveFacts {
    status: string;
    archivedAt: unknown | null;
    /** The package has been PRESENTED to the customer at least once (any status-history edge touching PRESENTED / ACCEPTED_BY_CUSTOMER). */
    everPresented: boolean;
    customerAcceptances: number;
    /** Rows of the customer-accepted quantity history (what SDO later reads). */
    customerAcceptedQuantities: number;
    hasSdoCase: boolean;
    /** Core AOSRs that were generated: an official number was consumed and/or a DOCX document exists. */
    generatedAosrs: number;
}

/**
 * Null when the package may be archived, otherwise the business reason it may not. Method declarations, a file-backed scheme, a draft
 * (unnumbered) AOSR record and external references do NOT block: a disposable test package legitimately carries them, and archiving
 * keeps every one of them.
 */
export function archiveViolation(f: PackageArchiveFacts): string | null {
    if (f.archivedAt) return PACKAGE_ALREADY_ARCHIVED_MESSAGE;
    if (!(ARCHIVABLE_STATUSES as readonly string[]).includes(f.status))
        return 'Архивировать можно только пакет в статусе «Черновик» или «Подготовка». Этот пакет уже в документообороте — его нельзя скрыть архивом.';
    if (f.hasSdoCase) return 'Пакет передан в СДО (есть дело закрытия) — архивирование недоступно.';
    if (f.customerAcceptances > 0) return 'По пакету зарегистрировано согласие заказчика — архивирование недоступно.';
    if (f.customerAcceptedQuantities > 0) return 'По пакету записан принятый заказчиком объём — архивирование недоступно.';
    if (f.everPresented) return 'Пакет предъявлялся заказчику — архивирование недоступно.';
    if (f.generatedAosrs > 0) return 'В пакете сформированы АОСР (присвоен номер или создан документ) — архивирование недоступно.';
    return null;
}

/** Documents that have a dedicated, file-backed flow and therefore must never be created as a bare shell by the generic document form. */
export const DEDICATED_FLOW_DOCUMENT_TYPES = ['AOSR', 'EXECUTIVE_SCHEME'] as const;
export const BARE_DOCUMENT_REFUSED_MESSAGE: Record<(typeof DEDICATED_FLOW_DOCUMENT_TYPES)[number], string> = {
    AOSR: 'Пустой документ АОСР не создаётся: АОСР формируется в блоке «Акты освидетельствования скрытых работ» (способ «в Core») или ведётся вне Core.',
    EXECUTIVE_SCHEME: 'Пустая исполнительная схема не создаётся: загрузите файл схемы в блоке «Исполнительные схемы».',
};
