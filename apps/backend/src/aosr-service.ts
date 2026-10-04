import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { packageSchemes, currentAosrMethod, schemeEvidenceViolation } from './documentation-evidence';
import Decimal from 'decimal.js';
import { pool, one, rows, insert, transaction } from './db';
import { Actor, requirePermission, checkVersion, scoped, audit, ensure, workAccess, packageMutationAccess, claimIdempotentCommand, completeIdempotentCommand } from './security';
import { Permission as P, isPtoRole, canAccessDocumentation, canMutateDocumentationPackageContent, resolveCustomerScLatestGroup } from '../../../packages/domain';
import { AosrPartyRecord, AosrMaterialInput, AosrQualityDocType, resolveAosrReadiness, suggestTypicalAosr, findTypicalItem, proposeAosrPoint1, resolveCurrentAcceptedQuantity, PortionQuantityFigures } from '../../../packages/domain/aosr';
import { buildAosrRenderModel } from './id-auto/aosr';
import { renderAosrDocx, aosrTemplateAvailable, AOSR_DOCX_MIME } from './id-auto/aosr-docx';

/**
 * ID-AUTO-1 — AOSR documents inside the existing Documentation Package.
 *
 * Every mutation goes through the same gate as every other package mutation
 * (packageMutationAccess: effective PTO work assignment) and, for package CONTENT, the same
 * freeze policy (canMutateDocumentationPackageContent: frozen once PRESENTED/RETURNED/
 * ACCEPTED_BY_CUSTOMER or locked by an SDO Case). Object-level master data (parties,
 * materials) is gated by the access rule only: it is not package content.
 */
const AOSR_FIELDS = ['title', 'workDescription', 'startDate', 'endDate', 'actDate', 'projectDocumentation', 'normativeReferences', 'subsequentWork', 'additionalInfo', 'copiesCount'] as const;

@Injectable()
export class AosrService {
    private async readContext(c: any, a: Actor, packageId: string) {
        if (!canAccessDocumentation(a.role as any)) throw new ForbiddenException('Недостаточно прав: доступ к исполнительной документации');
        const pkg = await scoped(c, 'documentation_packages', packageId, a);
        const work = await scoped(c, 'works', pkg.objectWorkId, a);
        await workAccess(c, a, work);
        return { pkg, work };
    }
    private async writeContext(c: any, a: Actor, packageId: string, opts: { content: boolean }) {
        requirePermission(a, P.DOCUMENTATION_MANAGE);
        const pkg = await scoped(c, 'documentation_packages', packageId, a, true);
        const work = await scoped(c, 'works', pkg.objectWorkId, a);
        await packageMutationAccess(c, a, work);
        if (opts.content) {
            const sdoCase = await one(c, 'SELECT package_locked FROM sdo_closing_cases WHERE tenant_id=$1 AND documentation_package_id=$2', [a.tenantId, packageId]);
            const policy = canMutateDocumentationPackageContent({ packageStatus: pkg.status, sdoCaseExists: !!sdoCase, sdoCasePackageLocked: !!sdoCase?.packageLocked });
            ensure(policy.allowed, policy.reason!);
        }
        return { pkg, work };
    }
    private async aosrOf(c: any, a: Actor, id: string, lock = false) {
        const aosr = await one(c, `SELECT * FROM aosr_documents WHERE tenant_id=$1 AND id=$2`, [a.tenantId, id]);
        if (!aosr) throw new NotFoundException('АОСР не найден');
        if (lock) await c.query('SELECT 1 FROM aosr_documents WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id]);
        return aosr;
    }

    private async bundle(c: any, tenantId: string, aosr: any) {
        const aosrId = aosr.id;
        const portionLinks = await rows(c, 'SELECT quantity_portion_id FROM aosr_portion_links WHERE tenant_id=$1 AND aosr_id=$2', [tenantId, aosrId]);
        const materialLinks = await rows(c, 'SELECT m.id,m.name,m.material_id FROM aosr_material_links l JOIN aosr_material_records m ON m.tenant_id=l.tenant_id AND m.id=l.material_record_id WHERE l.tenant_id=$1 AND l.aosr_id=$2 ORDER BY m.name', [tenantId, aosrId]);
        const docs = materialLinks.length ? await rows(c, 'SELECT * FROM aosr_quality_documents WHERE tenant_id=$1 AND material_record_id=ANY($2::uuid[]) ORDER BY created_at', [tenantId, materialLinks.map((m: any) => m.id)]) : [];
        const materials: (AosrMaterialInput & { id: string })[] = materialLinks.map((m: any) => ({ id: m.id, name: m.name, qualityDocuments: docs.filter((d: any) => d.materialRecordId === m.id).map((d: any) => ({ docType: d.docType as AosrQualityDocType, number: d.number, docDate: d.docDate, issuer: d.issuer })) }));
        const schemeIds = (await rows(c, 'SELECT scheme_document_id FROM aosr_scheme_links WHERE tenant_id=$1 AND aosr_id=$2', [tenantId, aosrId])).map((r: any) => r.schemeDocumentId);
        const schemes = schemeIds.length ? await packageSchemes(c, tenantId, aosr.documentationPackageId, schemeIds) : [];
        return { portionIds: portionLinks.map((p: any) => p.quantityPortionId) as string[], materials, schemes };
    }
    private async parties(c: any, tenantId: string, objectId: string): Promise<(AosrPartyRecord & { id: string; version: number })[]> {
        return rows(c, 'SELECT * FROM aosr_party_records WHERE tenant_id=$1 AND object_id=$2', [tenantId, objectId]);
    }
    private async readinessOf(c: any, a: Actor, aosr: any, work: any) {
        const b = await this.bundle(c, a.tenantId, aosr);
        const wt = await one(c, 'SELECT name,requires_materials FROM work_types WHERE tenant_id=$1 AND id=$2', [a.tenantId, work.workTypeId]);
        const parties = await this.parties(c, a.tenantId, aosr.objectId);
        const readiness = resolveAosrReadiness({ content: aosr, parties, materials: b.materials, schemes: b.schemes, workTypeRequiresMaterials: !!wt?.requiresMaterials, templateAvailable: aosrTemplateAvailable() });
        return { readiness, bundle: b, parties };
    }
    private summary(aosr: any, readiness: { ready: boolean; issues: any[] }) {
        return { id: aosr.id, title: aosr.title, suggestionCode: aosr.suggestionCode, officialNumber: aosr.officialNumber, status: aosr.officialNumber === null ? 'DRAFT' : aosr.generatedAtVersion === aosr.version ? 'GENERATED' : 'NEEDS_REGENERATION', hasDocx: aosr.revisionCount > 0, revisionCount: aosr.revisionCount, version: aosr.version, ready: readiness.ready, issueCount: readiness.issues.length };
    }

    /** The package's AOSR section: list + typical suggestions + object parties + package schemes + material catalog. */
    async packageView(a: Actor, packageId: string) {
        const { pkg, work } = await this.readContext(pool, a, packageId);
        const list = await rows(pool, 'SELECT * FROM aosr_documents WHERE tenant_id=$1 AND documentation_package_id=$2 ORDER BY created_at', [a.tenantId, packageId]);
        const items = [];
        for (const aosr of list) items.push(this.summary(aosr, (await this.readinessOf(pool, a, aosr, work)).readiness));
        const wt = await one(pool, 'SELECT name FROM work_types WHERE tenant_id=$1 AND id=$2', [a.tenantId, work.workTypeId]);
        const dismissed = (await rows(pool, 'SELECT suggestion_code FROM aosr_suggestion_dismissals WHERE tenant_id=$1 AND documentation_package_id=$2', [a.tenantId, packageId])).map((r: any) => r.suggestionCode);
        const method = await currentAosrMethod(pool, a.tenantId, packageId);
        const suggestions = method?.method !== 'CORE' ? [] : suggestTypicalAosr(`${wt?.name ?? ''} ${work.name}`, { acceptedCodes: list.map((x: any) => x.suggestionCode).filter(Boolean), dismissedCodes: dismissed });
        const parties = await this.parties(pool, a.tenantId, pkg.objectId);
        const obj = await one(pool, 'SELECT name,address,customer_name,organization_name FROM objects WHERE tenant_id=$1 AND id=$2', [a.tenantId, pkg.objectId]);
        const contractor = await one(pool, 'SELECT name FROM contractors WHERE tenant_id=$1 AND id=$2', [a.tenantId, work.contractorId]);
        const schemes = await packageSchemes(pool, a.tenantId, packageId);
        const methodHistory = await rows(pool, 'SELECT m.id,m.method,m.chosen_at,m.comment,u.name AS chosen_by FROM documentation_package_aosr_methods m JOIN users u ON u.tenant_id=m.tenant_id AND u.id=m.chosen_by WHERE m.tenant_id=$1 AND m.documentation_package_id=$2 ORDER BY m.chosen_at', [a.tenantId, packageId]);
        const materialRecords = await rows(pool, 'SELECT id,name FROM aosr_material_records WHERE tenant_id=$1 AND object_id=$2 ORDER BY name', [a.tenantId, pkg.objectId]);
        const qualityDocs = materialRecords.length ? await rows(pool, 'SELECT * FROM aosr_quality_documents WHERE tenant_id=$1 AND material_record_id=ANY($2::uuid[]) ORDER BY created_at', [a.tenantId, materialRecords.map((m: any) => m.id)]) : [];
        return {
            packageId, objectId: pkg.objectId, templateAvailable: aosrTemplateAvailable(), method: method?.method ?? null, methodHistory, hasFileBackedScheme: schemes.some(x => x.hasFile), items, suggestions,
            parties, partySuggestions: { DEVELOPER: obj?.customerName ?? null, CONSTRUCTION_ENTITY: obj?.organizationName ?? null, WORK_EXECUTOR: contractor?.name ?? null },
            objectName: obj?.name, objectAddress: obj?.address, schemes,
            materials: materialRecords.map((m: any) => ({ id: m.id, name: m.name, qualityDocuments: qualityDocs.filter((d: any) => d.materialRecordId === m.id).map((d: any) => ({ id: d.id, docType: d.docType, number: d.number, docDate: d.docDate, issuer: d.issuer })) })),
            workPortions: await rows(pool, 'SELECT p.id,p.label,u.location,u.unit FROM quantity_portions p JOIN work_execution_units u ON u.tenant_id=p.tenant_id AND u.id=p.execution_unit_id WHERE p.tenant_id=$1 AND u.object_work_id=$2 ORDER BY p.created_at', [a.tenantId, work.id]),
        };
    }

    async detail(a: Actor, id: string) {
        const aosr = await this.aosrOf(pool, a, id);
        const { pkg, work } = await this.readContext(pool, a, aosr.documentationPackageId);
        const { readiness, bundle } = await this.readinessOf(pool, a, aosr, work);
        const units = await rows(pool, 'SELECT u.location,f.name AS finish_type FROM work_execution_units u LEFT JOIN finish_types f ON f.tenant_id=u.tenant_id AND f.id=u.finish_type_id WHERE u.tenant_id=$1 AND u.object_work_id=$2', [a.tenantId, work.id]);
        const revisions = await rows(pool, 'SELECT revision_number,official_number,generated_at FROM aosr_revisions WHERE tenant_id=$1 AND aosr_id=$2 ORDER BY revision_number', [a.tenantId, id]);
        return { ...this.summary(aosr, readiness), aosr, packageId: pkg.id, readiness, portionIds: bundle.portionIds, materials: bundle.materials, schemes: bundle.schemes, revisions, point1Proposal: proposeAosrPoint1({ title: aosr.title, locations: [...new Set(units.map((u: any) => u.location).filter(Boolean))] as string[], finishType: units.find((u: any) => u.finishType)?.finishType }), packageStatus: pkg.status };
    }

    /** The Core generator is an optional tool: its operations exist only for a package that explicitly chose «АОСР формируются в Core». */
    private async requireCoreMethod(c: any, a: Actor, packageId: string) {
        const m = await currentAosrMethod(c, a.tenantId, packageId);
        ensure(!!m, 'Сначала выберите способ подготовки АОСР: «АОСР формируются в Core» или «АОСР формируются вне Core»');
        ensure(m!.method === 'CORE', 'Для пакета выбрано «АОСР формируются вне Core»: АОСР в Core не создаются');
    }

    /**
     * «АОСР формируются в Core» / «АОСР формируются вне Core» — an explicit, append-only declaration for the package.
     * Choosing EXTERNAL creates nothing: no AOSR record, no document shell, no number. Leaving Core for EXTERNAL is refused while
     * any Core AOSR exists (no silent data loss); EXTERNAL -> CORE is always safe. Same access gate as every package mutation.
     */
    async setMethod(a: Actor, packageId: string, d: { method: 'CORE' | 'EXTERNAL'; comment?: string }) {
        return transaction(async (c) => {
            const { pkg } = await this.writeContext(c, a, packageId, { content: false });
            const sdoCase = await one(c, 'SELECT package_locked FROM sdo_closing_cases WHERE tenant_id=$1 AND documentation_package_id=$2', [a.tenantId, packageId]);
            ensure(!sdoCase?.packageLocked, 'Пакет передан в СДО: способ подготовки АОСР изменить нельзя');
            const current = await currentAosrMethod(c, a.tenantId, packageId);
            if (current?.method === d.method) return current;
            if (d.method === 'EXTERNAL') {
                const existing = await one(c, 'SELECT count(*)::int AS n FROM aosr_documents WHERE tenant_id=$1 AND documentation_package_id=$2', [a.tenantId, packageId]);
                ensure(existing.n === 0, 'В пакете уже есть АОСР, созданные в Core: удалите черновики или продолжайте формировать АОСР в Core');
            }
            const row = await insert(c, 'documentation_package_aosr_methods', a.tenantId, { documentationPackageId: pkg.id, method: d.method, chosenBy: a.id, comment: d.comment ?? null });
            await audit(c, a, 'DocumentationPackageAosrMethod', row.id, 'CHOOSE', current ?? null, row);
            return row;
        });
    }

    async create(a: Actor, packageId: string, d: any) {
        return transaction(async (c) => {
            const { pkg, work } = await this.writeContext(c, a, packageId, { content: true });
            await this.requireCoreMethod(c, a, packageId);
            let title: string = d.title, point1: string | null = d.workDescription ?? null, normative: string | null = null, subsequent: string | null = null, code: string | null = null;
            if (d.suggestionCode) {
                const wt = await one(c, 'SELECT name FROM work_types WHERE tenant_id=$1 AND id=$2', [a.tenantId, work.workTypeId]);
                const item = findTypicalItem(d.suggestionCode);
                const open = suggestTypicalAosr(`${wt?.name ?? ''} ${work.name}`, { acceptedCodes: [], dismissedCodes: [] });
                ensure(!!item && open.some(s => s.suggestionCode === d.suggestionCode), 'Типовая позиция не относится к виду работ');
                ensure(!await one(c, 'SELECT id FROM aosr_documents WHERE tenant_id=$1 AND documentation_package_id=$2 AND suggestion_code=$3', [a.tenantId, packageId, d.suggestionCode]), 'Типовая позиция уже принята');
                title = d.title ?? item!.title; point1 = d.workDescription ?? item!.workDescription; normative = item!.normativeReferences; subsequent = item!.subsequentWork; code = d.suggestionCode;
            }
            ensure(!!title, 'Укажите наименование АОСР');
            const aosr = await insert(c, 'aosr_documents', a.tenantId, { objectId: pkg.objectId, objectWorkId: work.id, documentationPackageId: packageId, suggestionCode: code, title, workDescription: point1, normativeReferences: normative, subsequentWork: subsequent, createdBy: a.id });
            for (const pid of d.quantityPortionIds ?? []) await this.linkPortion(c, a, aosr, work, pid);
            await audit(c, a, 'Aosr', aosr.id, 'CREATE', null, aosr);
            return aosr;
        });
    }

    async dismissSuggestion(a: Actor, packageId: string, suggestionCode: string) {
        return transaction(async (c) => {
            await this.writeContext(c, a, packageId, { content: true });
            await this.requireCoreMethod(c, a, packageId);
            ensure(!!findTypicalItem(suggestionCode), 'Неизвестная типовая позиция');
            const existing = await one(c, 'SELECT * FROM aosr_suggestion_dismissals WHERE tenant_id=$1 AND documentation_package_id=$2 AND suggestion_code=$3', [a.tenantId, packageId, suggestionCode]);
            return existing ?? insert(c, 'aosr_suggestion_dismissals', a.tenantId, { documentationPackageId: packageId, suggestionCode, dismissedBy: a.id });
        });
    }

    async edit(a: Actor, id: string, d: any) {
        return transaction(async (c) => {
            const aosr = await this.aosrOf(c, a, id);
            await this.writeContext(c, a, aosr.documentationPackageId, { content: true });
            await c.query('SELECT 1 FROM aosr_documents WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id]);
            const fresh = await this.aosrOf(c, a, id);
            checkVersion(fresh, d.version);
            const sets: string[] = [], args: any[] = [a.tenantId, id];
            for (const f of AOSR_FIELDS) if (d[f] !== undefined) { args.push(d[f]); sets.push(`${f.replace(/[A-Z]/g, x => '_' + x.toLowerCase())}=$${args.length}`); }
            ensure(sets.length > 0, 'Нет изменений');
            const n = await one(c, `UPDATE aosr_documents SET ${sets.join(',')},version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`, args);
            await audit(c, a, 'Aosr', id, 'EDIT', fresh, n);
            return n;
        });
    }

    /** Only a draft that never consumed an official number can be removed. */
    async remove(a: Actor, id: string) {
        return transaction(async (c) => {
            const aosr = await this.aosrOf(c, a, id);
            await this.writeContext(c, a, aosr.documentationPackageId, { content: true });
            ensure(aosr.officialNumber === null && !aosr.documentationDocumentId, 'АОСР с присвоенным номером удалить нельзя');
            for (const t of ['aosr_portion_links', 'aosr_material_links', 'aosr_scheme_links']) await c.query(`DELETE FROM ${t} WHERE tenant_id=$1 AND aosr_id=$2`, [a.tenantId, id]);
            await c.query('DELETE FROM aosr_documents WHERE tenant_id=$1 AND id=$2', [a.tenantId, id]);
            await audit(c, a, 'Aosr', id, 'DELETE', aosr, null);
            return { id };
        });
    }

    private async linkPortion(c: any, a: Actor, aosr: any, work: any, portionId: string) {
        const portion = await scoped(c, 'quantity_portions', portionId, a);
        const unit = await scoped(c, 'work_execution_units', portion.executionUnitId, a);
        ensure(unit.objectWorkId === work.id, 'Участок относится к другой работе');
        // Deliberately no uniqueness across AOSRs: a Quantity Portion is provenance, never consumed.
        await c.query('INSERT INTO aosr_portion_links(tenant_id,aosr_id,quantity_portion_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [a.tenantId, aosr.id, portionId]);
    }

    /** Replaces the given link sets (each optional). Provenance / materials / schemes — many-to-many on every side. */
    async setLinks(a: Actor, id: string, d: any) {
        return transaction(async (c) => {
            const aosr0 = await this.aosrOf(c, a, id);
            const { pkg, work } = await this.writeContext(c, a, aosr0.documentationPackageId, { content: true });
            await c.query('SELECT 1 FROM aosr_documents WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id]);
            const aosr = await this.aosrOf(c, a, id);
            checkVersion(aosr, d.version);
            if (d.quantityPortionIds) {
                await c.query('DELETE FROM aosr_portion_links WHERE tenant_id=$1 AND aosr_id=$2', [a.tenantId, id]);
                for (const pid of new Set<string>(d.quantityPortionIds)) await this.linkPortion(c, a, aosr, work, pid);
            }
            if (d.materialRecordIds) {
                await c.query('DELETE FROM aosr_material_links WHERE tenant_id=$1 AND aosr_id=$2', [a.tenantId, id]);
                for (const mid of new Set<string>(d.materialRecordIds)) {
                    const m = await scoped(c, 'aosr_material_records', mid, a);
                    ensure(m.objectId === pkg.objectId, 'Материал относится к другому объекту');
                    await insert(c, 'aosr_material_links', a.tenantId, { aosrId: id, materialRecordId: mid });
                }
            }
            if (d.schemeDocumentIds) {
                await c.query('DELETE FROM aosr_scheme_links WHERE tenant_id=$1 AND aosr_id=$2', [a.tenantId, id]);
                for (const sid of new Set<string>(d.schemeDocumentIds)) {
                    const s = await scoped(c, 'documentation_documents', sid, a);
                    ensure(s.type === 'EXECUTIVE_SCHEME' && s.documentationPackageId === pkg.id, 'Исполнительная схема не относится к пакету');
                    await insert(c, 'aosr_scheme_links', a.tenantId, { aosrId: id, schemeDocumentId: sid });
                }
            }
            const n = await one(c, 'UPDATE aosr_documents SET version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *', [a.tenantId, id]);
            await audit(c, a, 'Aosr', id, 'LINKS', aosr, n);
            return n;
        });
    }

    /**
     * Executive schemes — shared by BOTH AOSR methods. A scheme is one EXECUTIVE_SCHEME documentation document of the package; it may
     * back many AOSRs (Core) or simply belong to the package's documentary scope (outside Core). It counts as evidence only with a
     * real file: the upload creates the document and its CORE_FILE version in one transaction, so no empty shell is ever left behind.
     */
    private decodeSchemeFile(d: { fileName: string; mimeType: 'application/pdf' | 'image/png' | 'image/jpeg'; base64: string }) {
        const bytes = Buffer.from(d.base64, 'base64');
        ensure(bytes.length > 0 && bytes.length <= 5 * 1024 * 1024, 'Файл схемы: максимум 5 МБ');
        const ok = d.mimeType === 'application/pdf' ? bytes.subarray(0, 5).toString() === '%PDF-' : d.mimeType === 'image/png' ? bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        ensure(ok, 'Содержимое файла не соответствует типу');
        return { bytes, fileName: d.fileName.replace(/[^\p{L}\p{N}_. -]/gu, '_') };
    }
    private async storeSchemeFile(c: any, a: Actor, documentId: string, d: any) {
        const { bytes, fileName } = this.decodeSchemeFile(d);
        const file = await insert(c, 'attachments', a.tenantId, { fileProvider: 'LOCAL', fileName, mimeType: d.mimeType, content: bytes, uploadedBy: a.id });
        const max = await one(c, 'SELECT coalesce(max(version_number),0) AS n FROM documentation_document_versions WHERE tenant_id=$1 AND documentation_document_id=$2', [a.tenantId, documentId]);
        const version = await insert(c, 'documentation_document_versions', a.tenantId, { documentationDocumentId: documentId, versionNumber: Number(max.n) + 1, storageProvider: 'CORE_FILE', storageReference: file.id, comment: fileName, createdBy: a.id });
        await audit(c, a, 'DocumentationDocumentVersion', version.id, 'CREATE', null, version);
        return version;
    }
    async createScheme(a: Actor, packageId: string, d: any) {
        return transaction(async (c) => {
            await this.writeContext(c, a, packageId, { content: true });
            const doc = await insert(c, 'documentation_documents', a.tenantId, { documentationPackageId: packageId, type: 'EXECUTIVE_SCHEME', title: d.title, createdBy: a.id });
            await audit(c, a, 'DocumentationDocument', doc.id, 'CREATE', null, doc);
            await this.storeSchemeFile(c, a, doc.id, d);
            return (await packageSchemes(c, a.tenantId, packageId, [doc.id]))[0];
        });
    }
    /** Attaches (or replaces — a new version) the file of an existing scheme, e.g. one that so far had metadata only. */
    async attachSchemeFile(a: Actor, packageId: string, schemeId: string, d: any) {
        return transaction(async (c) => {
            await this.writeContext(c, a, packageId, { content: true });
            const doc = await scoped(c, 'documentation_documents', schemeId, a, true);
            ensure(doc.type === 'EXECUTIVE_SCHEME' && doc.documentationPackageId === packageId, 'Исполнительная схема не относится к пакету');
            if (d.title) await c.query('UPDATE documentation_documents SET title=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2', [a.tenantId, schemeId, d.title]);
            await this.storeSchemeFile(c, a, schemeId, d);
            return (await packageSchemes(c, a.tenantId, packageId, [schemeId]))[0];
        });
    }
    /** Authenticated binary download of a scheme's current file (same read gate as the AOSR section). */
    async downloadSchemeFile(a: Actor, packageId: string, schemeId: string) {
        await this.readContext(pool, a, packageId);
        const doc = await scoped(pool, 'documentation_documents', schemeId, a);
        if (doc.type !== 'EXECUTIVE_SCHEME' || doc.documentationPackageId !== packageId) throw new NotFoundException('Исполнительная схема не найдена');
        const v = await one(pool, "SELECT storage_reference FROM documentation_document_versions WHERE tenant_id=$1 AND documentation_document_id=$2 AND storage_provider='CORE_FILE' ORDER BY version_number DESC LIMIT 1", [a.tenantId, schemeId]);
        if (!v) throw new NotFoundException('Файл схемы не загружен');
        const f = await scoped(pool, 'attachments', v.storageReference, a);
        return { fileName: f.fileName as string, mimeType: f.mimeType as string, content: f.content as Buffer };
    }

    async saveParty(a: Actor, packageId: string, d: any) {
        return transaction(async (c) => {
            const { pkg } = await this.writeContext(c, a, packageId, { content: false });
            const existing = await one(c, 'SELECT * FROM aosr_party_records WHERE tenant_id=$1 AND object_id=$2 AND party_role=$3 FOR UPDATE', [a.tenantId, pkg.objectId, d.partyRole]);
            if (existing) checkVersion(existing, d.version ?? -1);
            const fields = { organizationName: d.organizationName ?? null, organizationDetails: d.organizationDetails ?? null, personName: d.personName ?? null, position: d.position ?? null, registryNumber: d.registryNumber ?? null, authorityDocument: d.authorityDocument ?? null };
            const row = existing
                ? await one(c, 'UPDATE aosr_party_records SET organization_name=$3,organization_details=$4,person_name=$5,position=$6,registry_number=$7,authority_document=$8,updated_by=$9,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *', [a.tenantId, existing.id, fields.organizationName, fields.organizationDetails, fields.personName, fields.position, fields.registryNumber, fields.authorityDocument, a.id])
                : await insert(c, 'aosr_party_records', a.tenantId, { objectId: pkg.objectId, partyRole: d.partyRole, ...fields, updatedBy: a.id });
            await insert(c, 'aosr_party_record_history', a.tenantId, { objectId: pkg.objectId, partyRole: d.partyRole, snapshot: JSON.stringify(row), changedBy: a.id });
            await audit(c, a, 'AosrPartyRecord', row.id, existing ? 'EDIT' : 'CREATE', existing, row);
            return row;
        });
    }

    async createMaterial(a: Actor, packageId: string, d: any) {
        return transaction(async (c) => {
            const { pkg } = await this.writeContext(c, a, packageId, { content: false });
            if (d.materialId) await scoped(c, 'materials', d.materialId, a);
            const m = await insert(c, 'aosr_material_records', a.tenantId, { objectId: pkg.objectId, materialId: d.materialId ?? null, name: d.name, createdBy: a.id });
            for (const q of d.qualityDocuments ?? []) await insert(c, 'aosr_quality_documents', a.tenantId, { materialRecordId: m.id, docType: q.docType, number: q.number, docDate: q.docDate ?? null, issuer: q.issuer ?? null, createdBy: a.id });
            await audit(c, a, 'AosrMaterialRecord', m.id, 'CREATE', null, m);
            return m;
        });
    }
    async addQualityDocument(a: Actor, packageId: string, materialRecordId: string, q: any) {
        return transaction(async (c) => {
            const { pkg } = await this.writeContext(c, a, packageId, { content: false });
            const m = await scoped(c, 'aosr_material_records', materialRecordId, a);
            ensure(m.objectId === pkg.objectId, 'Материал относится к другому объекту');
            const doc = await insert(c, 'aosr_quality_documents', a.tenantId, { materialRecordId, docType: q.docType, number: q.number, docDate: q.docDate ?? null, issuer: q.issuer ?? null, createdBy: a.id });
            await audit(c, a, 'AosrQualityDocument', doc.id, 'CREATE', null, doc);
            return doc;
        });
    }

    /**
     * Generates (or regenerates) the AOSR's one current DOCX. The official number is taken from the
     * object's sequence on the FIRST successful generation only; a failed render rolls the whole
     * transaction back, so a draft/failed attempt consumes no number. A correction appends a
     * technical revision and a new documentation version under the same number.
     */
    async generate(a: Actor, id: string, version: number) {
        return transaction(async (c) => {
            const aosr0 = await this.aosrOf(c, a, id);
            const { pkg, work } = await this.writeContext(c, a, aosr0.documentationPackageId, { content: true });
            await this.requireCoreMethod(c, a, pkg.id);
            await c.query('SELECT 1 FROM aosr_documents WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, id]);
            const aosr = await this.aosrOf(c, a, id);
            checkVersion(aosr, version);
            const { readiness, bundle, parties } = await this.readinessOf(c, a, aosr, work);
            ensure(readiness.ready, 'АОСР не готов к формированию: ' + readiness.issues.map(i => i.message).join('; '));
            let number: number = aosr.officialNumber;
            if (number === null) number = (await one(c, 'INSERT INTO aosr_number_counters(tenant_id,object_id,last_number) VALUES($1,$2,1) ON CONFLICT (tenant_id,object_id) DO UPDATE SET last_number=aosr_number_counters.last_number+1 RETURNING last_number', [a.tenantId, aosr.objectId])).lastNumber;
            const obj = await scoped(c, 'objects', aosr.objectId, a);
            const model = buildAosrRenderModel({ officialNumber: number, objectName: obj.name, objectAddress: obj.address, content: aosr, parties, materials: bundle.materials, schemes: bundle.schemes.filter(x => x.hasFile) });
            const bytes = await renderAosrDocx(model);
            let documentId: string = aosr.documentationDocumentId;
            if (!documentId) documentId = (await insert(c, 'documentation_documents', a.tenantId, { documentationPackageId: pkg.id, type: 'AOSR', title: aosr.title, createdBy: a.id })).id;
            const fileName = `АОСР_${number}_${aosr.title.replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 60)}.docx`;
            const file = await insert(c, 'attachments', a.tenantId, { fileProvider: 'LOCAL', fileName, mimeType: AOSR_DOCX_MIME, content: bytes, uploadedBy: a.id });
            const max = await one(c, 'SELECT coalesce(max(version_number),0) AS n FROM documentation_document_versions WHERE tenant_id=$1 AND documentation_document_id=$2', [a.tenantId, documentId]);
            const revision = aosr.revisionCount + 1;
            const dv = await insert(c, 'documentation_document_versions', a.tenantId, { documentationDocumentId: documentId, versionNumber: Number(max.n) + 1, storageProvider: 'CORE_FILE', storageReference: file.id, comment: `АОСР № ${number}, ревизия ${revision}`, createdBy: a.id });
            await insert(c, 'aosr_revisions', a.tenantId, { aosrId: id, revisionNumber: revision, officialNumber: number, renderModel: JSON.stringify(model), documentationVersionId: dv.id, generatedBy: a.id });
            const n = await one(c, 'UPDATE aosr_documents SET official_number=$3,documentation_document_id=$4,revision_count=$5,generated_at_version=version+1,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *', [a.tenantId, id, number, documentId, revision]);
            await audit(c, a, 'Aosr', id, 'GENERATE', aosr, n);
            return n;
        });
    }

    async download(a: Actor, id: string) {
        const aosr = await this.aosrOf(pool, a, id);
        await this.readContext(pool, a, aosr.documentationPackageId);
        const dv = aosr.documentationDocumentId ? await one(pool, "SELECT storage_reference FROM documentation_document_versions WHERE tenant_id=$1 AND documentation_document_id=$2 AND storage_provider='CORE_FILE' ORDER BY version_number DESC LIMIT 1", [a.tenantId, aosr.documentationDocumentId]) : null;
        if (!dv) throw new NotFoundException('DOCX ещё не сформирован');
        const f = await scoped(pool, 'attachments', dv.storageReference, a);
        return { fileName: f.fileName as string, mimeType: f.mimeType as string, content: f.content as Buffer };
    }

    /* ---------------------------- quantity ---------------------------- */

    private async portionFigures(c: any, tenantId: string, packageId: string): Promise<(PortionQuantityFigures & { label: string })[]> {
        const portions = await rows(c, 'SELECT p.id,p.label,u.unit FROM documentation_package_portions l JOIN quantity_portions p ON p.tenant_id=l.tenant_id AND p.id=l.quantity_portion_id JOIN work_execution_units u ON u.tenant_id=p.tenant_id AND u.id=p.execution_unit_id WHERE l.tenant_id=$1 AND l.documentation_package_id=$2 ORDER BY p.created_at', [tenantId, packageId]);
        if (!portions.length) return [];
        const ids = portions.map((p: any) => p.id);
        const latest = async (source: string) => rows(c, 'SELECT DISTINCT ON (portion_id) portion_id,quantity FROM portion_quantity_confirmations WHERE tenant_id=$1 AND portion_id=ANY($2::uuid[]) AND source=$3 ORDER BY portion_id,recorded_at DESC', [tenantId, ids, source]);
        const rp = await latest('RP_FACT'), internal = await latest('INTERNAL_SC');
        const customerRows = await rows(c, "SELECT c.portion_id,c.quantity FROM portion_quantity_confirmations c JOIN (SELECT portion_id,MAX(recorded_at) AS max_at FROM portion_quantity_confirmations WHERE tenant_id=$1 AND portion_id=ANY($2::uuid[]) AND source='CUSTOMER_SC' GROUP BY portion_id) m ON m.portion_id=c.portion_id AND m.max_at=c.recorded_at WHERE c.tenant_id=$1 AND c.source='CUSTOMER_SC'", [tenantId, ids]);
        return portions.map((p: any) => ({ portionId: p.id, label: p.label, unit: p.unit, rpFact: rp.find((r: any) => r.portionId === p.id)?.quantity ?? null, internalSc: internal.find((r: any) => r.portionId === p.id)?.quantity ?? null, customerAccepted: resolveCustomerScLatestGroup(customerRows.filter((r: any) => r.portionId === p.id).map((r: any) => r.quantity)).quantity ?? null }));
    }

    /** Current relevant accepted quantity (for the PTO UI / SDO) and, separately, the full immutable history. */
    async quantityView(a: Actor, packageId: string) {
        await this.readContext(pool, a, packageId);
        const figures = await this.portionFigures(pool, a.tenantId, packageId);
        const ids = figures.map(f => f.portionId);
        const history = ids.length ? await rows(pool, "SELECT c.id,c.portion_id,c.source,c.quantity,c.recorded_at,c.comment,u.name AS recorded_by FROM portion_quantity_confirmations c JOIN users u ON u.tenant_id=c.tenant_id AND u.id=c.recorded_by WHERE c.tenant_id=$1 AND c.portion_id=ANY($2::uuid[]) ORDER BY c.recorded_at,c.created_at", [a.tenantId, ids]) : [];
        const acceptances = await rows(pool, 'SELECT id,quantity_portion_id,quantity,reference,comment,recorded_at FROM documentation_customer_accepted_quantities WHERE tenant_id=$1 AND documentation_package_id=$2 ORDER BY recorded_at', [a.tenantId, packageId]);
        return { portions: figures, current: resolveCurrentAcceptedQuantity(figures), history, customerAcceptances: acceptances };
    }

    /** «Зафиксировать объём, принятый заказчиком» — append-only; never rewrites RP_FACT / INTERNAL_SC. */
    async recordCustomerAcceptedQuantity(a: Actor, packageId: string, d: any) {
        requirePermission(a, P.DOCUMENTATION_MANAGE);
        if (!isPtoRole(a.role)) throw new ForbiddenException('Объём, принятый заказчиком, фиксирует только ПТО');
        return transaction(async (c) => {
            const { pkg } = await this.writeContext(c, a, packageId, { content: false });
            const sdoCase = await one(c, 'SELECT package_locked FROM sdo_closing_cases WHERE tenant_id=$1 AND documentation_package_id=$2', [a.tenantId, packageId]);
            ensure(!sdoCase?.packageLocked, 'Пакет передан в СДО: объём изменить нельзя');
            ensure(['PRESENTED', 'ACCEPTED_BY_CUSTOMER'].includes(pkg.status), 'Объём, принятый заказчиком, фиксируется после предъявления документации заказчику');
            // Same evidence rule for both AOSR methods; nothing here depends on a Core-generated AOSR existing.
            const missing = await schemeEvidenceViolation(c, a.tenantId, packageId);
            ensure(!missing, missing!);
            const claim = await claimIdempotentCommand(c, a, 'CUSTOMER_ACCEPTED_QUANTITY', d.idempotencyKey, packageId, { items: d.items.map((i: any) => [i.quantityPortionId, new Decimal(i.quantity).toFixed(4)]), reference: d.reference ?? null, comment: d.comment ?? null });
            if (claim.replay) return claim.response;
            const out = [];
            for (const item of d.items) {
                const link = await one(c, 'SELECT id FROM documentation_package_portions WHERE tenant_id=$1 AND documentation_package_id=$2 AND quantity_portion_id=$3', [a.tenantId, packageId, item.quantityPortionId]);
                ensure(!!link, 'Участок не входит в пакет');
                const q = new Decimal(item.quantity).toFixed(4);
                const confirmation = await insert(c, 'portion_quantity_confirmations', a.tenantId, { portionId: item.quantityPortionId, source: 'CUSTOMER_SC', quantity: q, recordedBy: a.id, comment: d.comment ?? 'Принято заказчиком' });
                const rec = await insert(c, 'documentation_customer_accepted_quantities', a.tenantId, { documentationPackageId: packageId, quantityPortionId: item.quantityPortionId, quantity: q, confirmationId: confirmation.id, reference: d.reference ?? null, comment: d.comment ?? null, recordedBy: a.id });
                await c.query('UPDATE quantity_portions SET version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2', [a.tenantId, item.quantityPortionId]);
                await audit(c, a, 'DocumentationCustomerAcceptedQuantity', rec.id, 'CREATE', null, rec);
                out.push(rec);
            }
            await completeIdempotentCommand(c, a, 'CUSTOMER_ACCEPTED_QUANTITY', d.idempotencyKey, out);
            return out;
        });
    }
}
