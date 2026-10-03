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
    constructionEntity: string;
    designer: string;
    developerScRep: string;
    constructionRep: string;
    internalScRep: string;
    designerRep: string;
    executorRep: string;
    executorName: string;
    point1: string;
    point2: string;
    point3: string;
    point4: string;
    startDate: string | null;
    endDate: string | null;
    point6: string;
    point7: string;
    additionalInfo: string;
    copies: string;
    appendices: string;
    signers: { developerScRep: string; constructionRep: string; internalSc: string; designerRep: string; executorRep: string };
}

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
    const org = (r: AosrPartyRole) => join([party(r)?.organizationName, party(r)?.organizationDetails]);
    const rep = (r: AosrPartyRole, orgRole?: AosrPartyRole) => {
        const p = party(r);
        if (!p || !clean(p.personName)) return '';
        return join([p.position, p.personName, clean(p.registryNumber) ? `НРС ${clean(p.registryNumber)}` : '', p.authorityDocument, orgRole ? party(orgRole)?.organizationName : '']);
    };
    const materialLines = s.materials.map(m => {
        const docs = m.qualityDocuments.map(d => join([`${AOSR_QUALITY_DOC_LABELS[d.docType]} № ${clean(d.number)}`, d.docDate ? `от ${formatRuShortDate(d.docDate)}` : '', d.issuer], ' '));
        return docs.length ? `${clean(m.name)} (${docs.join('; ')})` : clean(m.name);
    });
    const schemeTitles = s.schemes.map(x => clean(x.title)).filter(Boolean);
    const c = s.content;
    return {
        actNumber: String(s.officialNumber),
        actDate: c.actDate ?? null,
        objectName: clean(s.objectName),
        objectAddress: clean(s.objectAddress),
        developer: org('DEVELOPER'),
        constructionEntity: org('CONSTRUCTION_ENTITY'),
        designer: org('DESIGNER'),
        developerScRep: rep('DEVELOPER_SC_REP', 'DEVELOPER'),
        constructionRep: rep('CONSTRUCTION_REP', 'CONSTRUCTION_ENTITY'),
        internalScRep: rep('INTERNAL_SC', 'CONSTRUCTION_ENTITY'),
        designerRep: rep('DESIGNER_REP', 'DESIGNER'),
        executorRep: rep('EXECUTOR_REP', 'WORK_EXECUTOR'),
        executorName: clean(party('WORK_EXECUTOR')?.organizationName),
        point1: clean(c.workDescription),
        point2: clean(c.projectDocumentation),
        point3: materialLines.join('; '),
        point4: schemeTitles.join('; '),
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
