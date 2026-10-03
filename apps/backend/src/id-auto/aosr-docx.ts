/**
 * ID-AUTO-1 — fills the supplied official order-344 annex-3 AOSR form.
 *
 * The template is immutable: it is pinned by SHA-256 and only its blank fill-in paragraphs
 * (the non-breaking-space runs the form itself provides) receive text. No label, numbering,
 * table or signature block is added, removed or reworded. The output is an editable .docx.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { splitRuDate } from '../../../../packages/domain/aosr';
import type { AosrRenderModel } from './aosr';

export const AOSR_TEMPLATE_SHA256 = 'd69c4da35be470e1cbbc2125a7ce8ba5063d9e1a6a288c74dcc6b9e7ebe33019';
export const AOSR_DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TEMPLATE_PATH = path.resolve(process.cwd(), 'apps/backend/assets/aosr/aosr-order-344-annex-3.docx');
const TEMPLATE_PARAGRAPHS = 165;

export function readAosrTemplate(): Buffer | null {
    try {
        const bytes = fs.readFileSync(TEMPLATE_PATH);
        return crypto.createHash('sha256').update(bytes).digest('hex') === AOSR_TEMPLATE_SHA256 ? bytes : null;
    } catch { return null; }
}
export const aosrTemplateAvailable = () => readAosrTemplate() !== null;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const NBSP = ' ';

/** Paragraph index (document order) of each fill-in blank of the official form. */
const SLOT = {
    objectName: 5, objectAddress: 6, developer: 10, constructionEntity: 17, designer: 24,
    actNumber: 36, actDay: 39, actMonth: 41, actYear: 43,
    developerScRep: 50, constructionRep: 55, internalScRep: 58, designerRep: 61, executorRep: 64, executorName: 69,
    point1: 73, point2: 76, point3: 79, point4: 86,
    startDay: 94, startMonth: 96, startYear: 98, endDay: 102, endMonth: 104, endYear: 106,
    point6: 110, point7: 115, additionalInfo: 118, copies: 121, appendices: 125,
    signDeveloperScRep: 130, signConstructionRep: 137, signInternalSc: 145, signDesignerRep: 152, signExecutorRep: 159,
} as const;

function fillParagraph(p: string, value: string): string {
    const text = value.split('\n').map(esc).join('</w:t><w:br/><w:t xml:space="preserve">');
    const blankRun = /<w:t(?: [^>]*)?>[  ]<\/w:t>/;
    if (!blankRun.test(p)) throw new Error('AOSR template: expected blank fill-in run');
    return p.replace(blankRun, `<w:t xml:space="preserve">${text}</w:t>`);
}

export async function renderAosrDocx(model: AosrRenderModel): Promise<Buffer> {
    const template = readAosrTemplate();
    if (!template) throw new Error('Официальный шаблон АОСР недоступен или изменён');
    const zip = await JSZip.loadAsync(template, { createFolders: false });
    const xml = await zip.file('word/document.xml')!.async('string');
    const bodyStart = xml.indexOf('<w:body>');
    const head = xml.slice(0, bodyStart), body = xml.slice(bodyStart);
    const matches = [...body.matchAll(/<w:p[ >].*?<\/w:p>/gs)];
    if (matches.length !== TEMPLATE_PARAGRAPHS) throw new Error('AOSR template structure changed');
    const values = new Map<number, string>();
    const set = (slot: number, v: string | null | undefined) => { if (v && v.trim()) values.set(slot, v.trim()); };
    set(SLOT.objectName, model.objectName); set(SLOT.objectAddress, model.objectAddress);
    set(SLOT.developer, model.developer); set(SLOT.constructionEntity, model.constructionEntity); set(SLOT.designer, model.designer);
    set(SLOT.actNumber, model.actNumber);
    const act = splitRuDate(model.actDate);
    if (act) { set(SLOT.actDay, act.day); set(SLOT.actMonth, act.month); set(SLOT.actYear, act.year); }
    set(SLOT.developerScRep, model.developerScRep); set(SLOT.constructionRep, model.constructionRep); set(SLOT.internalScRep, model.internalScRep);
    set(SLOT.designerRep, model.designerRep); set(SLOT.executorRep, model.executorRep); set(SLOT.executorName, model.executorName);
    set(SLOT.point1, model.point1); set(SLOT.point2, model.point2); set(SLOT.point3, model.point3); set(SLOT.point4, model.point4);
    const start = splitRuDate(model.startDate), end = splitRuDate(model.endDate);
    if (start) { set(SLOT.startDay, start.day); set(SLOT.startMonth, start.month); set(SLOT.startYear, start.year); }
    if (end) { set(SLOT.endDay, end.day); set(SLOT.endMonth, end.month); set(SLOT.endYear, end.year); }
    set(SLOT.point6, model.point6); set(SLOT.point7, model.point7); set(SLOT.additionalInfo, model.additionalInfo); set(SLOT.copies, model.copies); set(SLOT.appendices, model.appendices);
    set(SLOT.signDeveloperScRep, model.signers.developerScRep); set(SLOT.signConstructionRep, model.signers.constructionRep); set(SLOT.signInternalSc, model.signers.internalSc);
    set(SLOT.signDesignerRep, model.signers.designerRep); set(SLOT.signExecutorRep, model.signers.executorRep);
    let out = '', cursor = 0;
    matches.forEach((m, i) => {
        out += body.slice(cursor, m.index!);
        out += values.has(i) ? fillParagraph(m[0], values.get(i)!) : m[0];
        cursor = m.index! + m[0].length;
    });
    out += body.slice(cursor);
    zip.file('word/document.xml', head + out, { createFolders: false });
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Visible text of a document.xml — used by tests/readers to compare form text. */
export function docxVisibleText(xml: string): string {
    return [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map(m => m[1]).join('');
}
export { NBSP };
