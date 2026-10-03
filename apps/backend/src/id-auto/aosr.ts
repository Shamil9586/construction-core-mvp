/**
 * ID-AUTO-1 — AOSR render contract.
 *
 * Pure: no DOCX library, no database. The renderer (aosr-docx.ts) fills the official
 * order-344 annex-3 form from this snapshot and nothing else. There is deliberately no
 * quantity anywhere in it: accepted quantity is internal provenance and is never printed
 * in the act, and a Quantity Portion is not owned or consumed by an AOSR.
 */
import { AosrContentInput, AosrMaterialInput, AosrPartyRecord, AosrPartyRole, AosrSchemeInput, AOSR_QUALITY_DOC_LABELS, formatRuShortDate } from '../../../../packages/domain/aosr';

export interface AosrRenderSource {
    officialNumber: number;
    objectName: string;
    objectAddress: string;
    content: AosrContentInput;
    parties: AosrPartyRecord[];
    materials: AosrMaterialInput[];
    schemes: AosrSchemeInput[];
}

export interface AosrRenderModel {
    actNumber: string;
    actDate: string | null;
    objectName: string;
    objectAddress: string;
    developer: string;
    developerSro: string;
    constructionEntity: string;
    constructionEntitySro: string;
    designer: string;
    designerSro: string;
    developerScRep: string;
    constructionRep: string;
    internalScRep: string;
    designerRep: string;
    executorRep: string;
    executorName: string;
    point1: string;
    point2: string;
    /** Point 3 / 4 each have a narrow first blank and a full-width continuation row in the official form. */
    point3Line1: string;
    point3Line2: string;
    point4Line1: string;
    point4Line2: string;
    startDate: string | null;
    endDate: string | null;
    point6: string;
    point7: string;
    additionalInfo: string;
    copies: string;
    appendices: string;
    signers: { developerScRep: string; constructionRep: string; internalSc: string; designerRep: string; executorRep: string };
}

/** About how many characters of bold-italic form text fit on one line of the narrow right-hand blanks of points 3 and 4. */
export const NARROW_CHARS = 38;
const clean = (v: string | null | undefined) => (v ?? '').trim();
const join = (parts: (string | null | undefined)[], sep = ', ') => parts.map(clean).filter(Boolean).join(sep);

/** «Иванов Иван Иванович» -> «Иванов И.И.»; an already-abbreviated value is kept as typed. */
export function surnameInitials(fullName: string | null | undefined): string {
    const parts = clean(fullName).split(/\s+/).filter(Boolean);
    if (parts.length < 2) return parts.join(' ');
    if (parts.slice(1).every(p => /^[А-ЯЁA-Z]\.?$/.test(p))) return parts.join(' ');
    return `${parts[0]} ${parts.slice(1).map(p => p[0].toUpperCase() + '.').join('')}`;
}

export function buildAosrRenderModel(s: AosrRenderSource): AosrRenderModel {
    const party = (r: AosrPartyRole) => s.parties.find(p => p.partyRole === r);
    // organizationDetails: first line = requisites (printed with the name); an optional second line = SRO membership (the form's own SRO row).
    const detailLines = (r: AosrPartyRole) => clean(party(r)?.organizationDetails).split(/\r?\n/).map(clean).filter(Boolean);
    const org = (r: AosrPartyRole) => join([party(r)?.organizationName, detailLines(r)[0]]);
    const sro = (r: AosrPartyRole) => detailLines(r).slice(1).join('; ');
    const rep = (r: AosrPartyRole, orgRole?: AosrPartyRole) => {
        const p = party(r);
        if (!p || !clean(p.personName)) return '';
        return join([p.position, p.personName, clean(p.registryNumber) ? `НРС ${clean(p.registryNumber)}` : '', p.authorityDocument, orgRole ? party(orgRole)?.organizationName : '']);
    };
    const docsOf = (m: AosrMaterialInput) => m.qualityDocuments.map(d => join([`${AOSR_QUALITY_DOC_LABELS[d.docType]} № ${clean(d.number)}`, d.docDate ? `от ${formatRuShortDate(d.docDate)}` : '', d.issuer], ' '));
    // One short material keeps its name in the narrow first blank and its requisites in the continuation row; anything longer
    // flows entirely through the full-width continuation row instead of being squeezed into the narrow field.
    const single = s.materials.length === 1 && clean(s.materials[0].name).length <= NARROW_CHARS ? s.materials[0] : null;
    const materialLines = s.materials.map(m => { const docs = docsOf(m); return docs.length ? `${clean(m.name)} (${docs.join('; ')})` : clean(m.name); });
    const schemeTitles = s.schemes.map(x => clean(x.title)).filter(Boolean);
    const schemesJoined = schemeTitles.join('; ');
    const schemesNarrow = schemesJoined.length <= NARROW_CHARS;
    const c = s.content;
    return {
        actNumber: String(s.officialNumber),
        actDate: c.actDate ?? null,
        objectName: clean(s.objectName),
        objectAddress: clean(s.objectAddress),
        developer: org('DEVELOPER'),
        developerSro: sro('DEVELOPER'),
        constructionEntity: org('CONSTRUCTION_ENTITY'),
        constructionEntitySro: sro('CONSTRUCTION_ENTITY'),
        designer: org('DESIGNER'),
        designerSro: sro('DESIGNER'),
        developerScRep: rep('DEVELOPER_SC_REP', 'DEVELOPER'),
        // The form asks for the organization only for the developer's, designer's and executor's representatives.
        constructionRep: rep('CONSTRUCTION_REP'),
        internalScRep: rep('INTERNAL_SC'),
        designerRep: rep('DESIGNER_REP', 'DESIGNER'),
        executorRep: rep('EXECUTOR_REP', 'WORK_EXECUTOR'),
        executorName: clean(party('WORK_EXECUTOR')?.organizationName),
        point1: clean(c.workDescription),
        point2: clean(c.projectDocumentation),
        point3Line1: single ? clean(single.name) : '',
        point3Line2: single ? docsOf(single).join('; ') : materialLines.join('; '),
        point4Line1: schemesNarrow ? schemesJoined : '',
        point4Line2: schemesNarrow ? '' : schemesJoined,
        startDate: c.startDate ?? null,
        endDate: c.endDate ?? null,
        point6: clean(c.normativeReferences),
        point7: clean(c.subsequentWork),
        additionalInfo: clean(c.additionalInfo),
        copies: c.copiesCount ? String(c.copiesCount) : '',
        appendices: schemeTitles.join('; '),
        signers: {
            developerScRep: surnameInitials(party('DEVELOPER_SC_REP')?.personName),
            constructionRep: surnameInitials(party('CONSTRUCTION_REP')?.personName),
            internalSc: surnameInitials(party('INTERNAL_SC')?.personName),
            designerRep: surnameInitials(party('DESIGNER_REP')?.personName),
            executorRep: surnameInitials(party('EXECUTOR_REP')?.personName),
        },
    };
}
