/**
 * ID-AUTO-1 — pure AOSR domain rules (no database, no DOCX library).
 *
 * An AOSR is a documented operation inside a Documentation Package, not a production
 * Work/WEU. Nothing here reads or produces an AOSR quantity: Quantity Portions are
 * provenance links only, and the printed act never carries a quantity.
 */
import Decimal from 'decimal.js';

export type AosrOrganizationRole = 'DEVELOPER' | 'CONSTRUCTION_ENTITY' | 'DESIGNER' | 'WORK_EXECUTOR';
export type AosrSignatoryRole = 'DEVELOPER_SC_REP' | 'CONSTRUCTION_REP' | 'INTERNAL_SC' | 'DESIGNER_REP' | 'EXECUTOR_REP';
export type AosrPartyRole = AosrOrganizationRole | AosrSignatoryRole;

export const AOSR_PARTY_ROLES: AosrPartyRole[] = ['DEVELOPER', 'CONSTRUCTION_ENTITY', 'DESIGNER', 'WORK_EXECUTOR', 'DEVELOPER_SC_REP', 'CONSTRUCTION_REP', 'INTERNAL_SC', 'DESIGNER_REP', 'EXECUTOR_REP'];

/** Locked: Construction Core INTERNAL_SC is the construction entity's own SC representative, never the customer's. */
export const AOSR_PARTY_ROLE_LABELS: Record<AosrPartyRole, string> = {
    DEVELOPER: 'Застройщик, технический заказчик',
    CONSTRUCTION_ENTITY: 'Лицо, осуществляющее строительство',
    DESIGNER: 'Лицо, осуществляющее подготовку проектной документации',
    WORK_EXECUTOR: 'Лицо, выполнившее работы, подлежащие освидетельствованию',
    DEVELOPER_SC_REP: 'Представитель застройщика, технического заказчика по вопросам строительного контроля',
    CONSTRUCTION_REP: 'Представитель лица, осуществляющего строительство',
    INTERNAL_SC: 'Представитель лица, осуществляющего строительство, по вопросам строительного контроля',
    DESIGNER_REP: 'Представитель лица, осуществляющего подготовку проектной документации',
    EXECUTOR_REP: 'Представитель лица, выполнившего работы',
};

export interface AosrPartyRecord {
    partyRole: AosrPartyRole;
    organizationName?: string | null;
    organizationDetails?: string | null;
    personName?: string | null;
    position?: string | null;
    registryNumber?: string | null;
    authorityDocument?: string | null;
}

export type AosrQualityDocType = 'PASSPORT' | 'CERTIFICATE' | 'DECLARATION' | 'OTHER';
export const AOSR_QUALITY_DOC_LABELS: Record<AosrQualityDocType, string> = { PASSPORT: 'паспорт', CERTIFICATE: 'сертификат', DECLARATION: 'декларация', OTHER: 'документ о качестве' };

export interface AosrMaterialInput { name: string; qualityDocuments: { docType: AosrQualityDocType; number: string; docDate?: string | null; issuer?: string | null }[] }
export interface AosrSchemeInput { id: string; title: string }

export interface AosrContentInput {
    workDescription?: string | null;
    startDate?: string | null;
    endDate?: string | null;
    actDate?: string | null;
    projectDocumentation?: string | null;
    normativeReferences?: string | null;
    subsequentWork?: string | null;
    additionalInfo?: string | null;
    copiesCount?: number | null;
}

const blank = (v: string | null | undefined) => !v || !v.trim();
const filled = (p: AosrPartyRecord | undefined, ...fields: (keyof AosrPartyRecord)[]) => !!p && fields.every(f => !blank(p[f] as any));

export interface AosrReadinessIssue { code: string; message: string }
export interface AosrReadiness { ready: boolean; issues: AosrReadinessIssue[] }

export function resolveAosrReadiness(input: {
    content: AosrContentInput;
    parties: AosrPartyRecord[];
    materials: AosrMaterialInput[];
    schemes: AosrSchemeInput[];
    workTypeRequiresMaterials: boolean;
    templateAvailable: boolean;
}): AosrReadiness {
    const issues: AosrReadinessIssue[] = [];
    const add = (code: string, message: string) => issues.push({ code, message });
    const c = input.content;
    const party = (r: AosrPartyRole) => input.parties.find(p => p.partyRole === r);
    if (!input.templateAvailable) add('TEMPLATE_UNAVAILABLE', 'Официальный шаблон АОСР недоступен');
    if (blank(c.workDescription)) add('POINT1_MISSING', 'Не заполнен пункт 1: предъявленные к освидетельствованию работы');
    for (const r of ['DEVELOPER', 'CONSTRUCTION_ENTITY', 'WORK_EXECUTOR'] as AosrOrganizationRole[])
        if (!filled(party(r), 'organizationName')) add('PARTY_' + r, `Не заполнены данные: ${AOSR_PARTY_ROLE_LABELS[r]}`);
    for (const r of ['DEVELOPER_SC_REP', 'CONSTRUCTION_REP', 'INTERNAL_SC'] as AosrSignatoryRole[])
        if (!filled(party(r), 'personName', 'position', 'authorityDocument')) add('PARTY_' + r, `Не заполнен подписант (ФИО, должность, документ о полномочиях): ${AOSR_PARTY_ROLE_LABELS[r]}`);
    // Designer and the third-party executor's representative are conditional on the form itself.
    const designerTouched = !blank(party('DESIGNER')?.organizationName) || !blank(party('DESIGNER_REP')?.personName);
    if (designerTouched) {
        if (!filled(party('DESIGNER'), 'organizationName')) add('PARTY_DESIGNER', `Не заполнены данные: ${AOSR_PARTY_ROLE_LABELS.DESIGNER}`);
        if (!filled(party('DESIGNER_REP'), 'personName', 'position', 'authorityDocument')) add('PARTY_DESIGNER_REP', `Не заполнен подписант (ФИО, должность, документ о полномочиях): ${AOSR_PARTY_ROLE_LABELS.DESIGNER_REP}`);
    }
    if (!blank(party('EXECUTOR_REP')?.personName) && !filled(party('EXECUTOR_REP'), 'position', 'authorityDocument')) add('PARTY_EXECUTOR_REP', `Не заполнены должность и документ о полномочиях: ${AOSR_PARTY_ROLE_LABELS.EXECUTOR_REP}`);
    if (!c.startDate || !c.endDate || !c.actDate) add('DATES_MISSING', 'Не заполнены даты начала, окончания работ и акта');
    else {
        if (c.startDate > c.endDate) add('DATES_ORDER', 'Дата начала работ позже даты окончания');
        if (c.actDate < c.endDate) add('DATES_ACT_BEFORE_END', 'Дата акта раньше даты окончания работ');
    }
    if (blank(c.projectDocumentation)) add('PROJECT_DOCUMENTATION_MISSING', 'Не заполнена проектная/рабочая документация (пункт 2)');
    if (input.workTypeRequiresMaterials && !input.materials.length) add('MATERIALS_MISSING', 'Не выбраны материалы (пункт 3)');
    for (const m of input.materials) if (!m.qualityDocuments.length) add('MATERIAL_DOCS_MISSING', `У материала «${m.name}» нет документа о качестве`);
    // Executive schemes and material quality documents are separate requirements: a passport/certificate never substitutes for a scheme.
    // One scheme may cover several AOSRs, so the rule is "at least one linked scheme", never a unique scheme.
    if (!input.schemes.length) add('EXECUTIVE_SCHEME_MISSING', 'АОСР не покрыт исполнительной схемой (пункт 4)');
    if (blank(c.normativeReferences)) add('NORMATIVE_MISSING', 'Не указаны нормативные документы (пункт 6)');
    if (blank(c.subsequentWork)) add('SUBSEQUENT_WORK_MISSING', 'Не указаны последующие работы (пункт 7)');
    return { ready: issues.length === 0, issues };
}

/* ------------------------- typical suggestions ------------------------- */

export interface AosrTypicalItem { code: string; title: string; workDescription: string; normativeReferences: string; subsequentWork: string }
interface AosrTypicalGroup { key: string; workTypePattern: RegExp; items: AosrTypicalItem[] }

/** Smallest extensible structure: a list of work-type patterns, each with its typical documented operations. Suggestions only — never mandatory production stages. */
export const AOSR_TYPICAL_GROUPS: AosrTypicalGroup[] = [
    { key: 'PLASTER', workTypePattern: /штукатур/i, items: [
        { code: 'PRIMER', title: 'Грунтовка основания', workDescription: 'Грунтовка основания перед штукатуркой', normativeReferences: 'СП 71.13330.2017 «Изоляционные и отделочные покрытия»', subsequentWork: 'Устройство штукатурки стен' },
        { code: 'PLASTER', title: 'Устройство штукатурки стен', workDescription: 'Устройство штукатурки стен', normativeReferences: 'СП 71.13330.2017 «Изоляционные и отделочные покрытия»', subsequentWork: 'Выполнение отделочных работ' },
    ] },
    { key: 'FOUNDATION', workTypePattern: /фундамент|армиров|бетонир/i, items: [
        { code: 'REBAR', title: 'Армирование', workDescription: 'Армирование конструкций фундамента', normativeReferences: 'СП 70.13330.2012 «Несущие и ограждающие конструкции»; СП 63.13330.2018 «Бетонные и железобетонные конструкции»', subsequentWork: 'Бетонирование конструкций фундамента' },
        { code: 'CONCRETE', title: 'Бетонирование', workDescription: 'Бетонирование конструкций фундамента', normativeReferences: 'СП 70.13330.2012 «Несущие и ограждающие конструкции»', subsequentWork: 'Устройство гидроизоляции фундамента' },
    ] },
    { key: 'ROOF', workTypePattern: /кровл/i, items: [
        { code: 'WATERPROOF_L1', title: 'Гидроизоляция кровли (1-й слой)', workDescription: 'Устройство 1-го слоя гидроизоляции кровли', normativeReferences: 'СП 17.13330.2017 «Кровли»', subsequentWork: 'Устройство 2-го слоя гидроизоляции кровли' },
    ] },
    { key: 'WINDOWS', workTypePattern: /окон|окна|остеклен/i, items: [
        { code: 'PVC_WINDOWS', title: 'Монтаж ПВХ окон', workDescription: 'Монтаж ПВХ окон', normativeReferences: 'ГОСТ 30971-2012; СП 70.13330.2012', subsequentWork: 'Выполнение отделочных работ откосов' },
    ] },
];

export interface AosrSuggestion extends AosrTypicalItem { suggestionCode: string }

/** Typical items for a work type, minus those already accepted into an AOSR and those the engineer removed. */
export function suggestTypicalAosr(workTypeName: string, taken: { acceptedCodes: string[]; dismissedCodes: string[] }): AosrSuggestion[] {
    const hide = new Set([...taken.acceptedCodes, ...taken.dismissedCodes]);
    return AOSR_TYPICAL_GROUPS.filter(g => g.workTypePattern.test(workTypeName)).flatMap(g => g.items.map(i => ({ ...i, suggestionCode: `${g.key}.${i.code}` }))).filter(s => !hide.has(s.suggestionCode));
}
export function findTypicalItem(suggestionCode: string): AosrSuggestion | undefined {
    return AOSR_TYPICAL_GROUPS.flatMap(g => g.items.map(i => ({ ...i, suggestionCode: `${g.key}.${i.code}` }))).find(s => s.suggestionCode === suggestionCode);
}

/** A proposal only — the engineer's own wording always wins. */
export function proposeAosrPoint1(input: { title: string; locations: string[]; finishType?: string | null }): string {
    const where = input.locations.filter(Boolean).join(', ');
    return [input.title, where ? `в ${where}` : '', input.finishType ? `по типу «${input.finishType}»` : ''].filter(Boolean).join(' ');
}

/* ------------------------- quantity (never printed in the act) ------------------------- */

export type CurrentQuantitySource = 'CUSTOMER_ACCEPTED' | 'INTERNAL_SC' | 'RP_FACT';
export interface PortionQuantityFigures { portionId: string; rpFact: string | null; internalSc: string | null; customerAccepted: string | null; unit: string }
/** Current relevant accepted quantity: customer-accepted, else Internal SC, else RP fact. The weakest source across portions labels the total. */
export function resolveCurrentAcceptedQuantity(portions: PortionQuantityFigures[]): { quantity: string; unit: string; source: CurrentQuantitySource } | null {
    if (!portions.length) return null;
    const rank: Record<CurrentQuantitySource, number> = { CUSTOMER_ACCEPTED: 3, INTERNAL_SC: 2, RP_FACT: 1 };
    let total = new Decimal(0), weakest: CurrentQuantitySource | null = null;
    for (const p of portions) {
        const pick: [string, CurrentQuantitySource] | null = p.customerAccepted !== null ? [p.customerAccepted, 'CUSTOMER_ACCEPTED'] : p.internalSc !== null ? [p.internalSc, 'INTERNAL_SC'] : p.rpFact !== null ? [p.rpFact, 'RP_FACT'] : null;
        if (!pick) continue;
        total = total.add(pick[0]);
        if (!weakest || rank[pick[1]] < rank[weakest]) weakest = pick[1];
    }
    return weakest ? { quantity: total.toFixed(4), unit: portions[0].unit, source: weakest } : null;
}

/* ------------------------- dates ------------------------- */

const MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export function splitRuDate(iso: string | null | undefined): { day: string; month: string; year: string } | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
    return m ? { day: m[3], month: MONTHS_GENITIVE[Number(m[2]) - 1], year: m[1] } : null;
}
export function formatRuShortDate(iso: string | null | undefined): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
    return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}
