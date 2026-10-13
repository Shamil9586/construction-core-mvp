import { Injectable, ForbiddenException } from '@nestjs/common';
import { pool, rows } from './db';
import { Actor, objectAccess, isCurrentPtoMember, effectivePtoAssignedWork } from './security';
import { canAccessDocumentation } from '../../../packages/domain';
import { buildPackageScope, isPackageActive, zoneName } from '../../../packages/domain/package-scope';
import { resolveAosrReadiness, type AosrMaterialInput, type AosrQualityDocType, type AosrPartyRecord } from '../../../packages/domain/aosr';
import { aosrDocxState, resolveAosrDocumentaryReadiness, resolvePackageReadiness } from '../../../packages/domain/documentation-readiness';
import {
    awaitsEngineerAction, filterRegistryRows, pickLastUpdate, sortRegistryRows, summarizeRegistry,
    type RegistryAosrRow, type RegistryArchivedRow, type RegistryFilters, type RegistryLastUpdateKind, type RegistryPackageRow, type RegistrySummary,
} from '../../../packages/domain/documentation-registry';
import { scopePortionInputs } from './documentation-scope';
import { currentAosrMethods, loadPackageEvidence } from './documentation-evidence';
import { aosrTemplateAvailable } from './id-auto/aosr-docx';

/**
 * ID-AUTO-2 — Object documentation registry («Реестр ИД»): the PTO engineer's / PTO head's overview of ONE Object's documentary state.
 *
 * A READ MODEL over the existing production and documentation tables — it owns no data, creates no register entity and writes nothing (not even
 * an audit row: viewing and filtering are not mutations). Readiness is not decided here: it comes from packages/domain/documentation-readiness.ts,
 * the very rules the forward gate uses, over facts loaded by documentation-evidence.ts. Quantity follows the accepted provenance through
 * documentation-scope.ts. A fixed number of batched queries serves the whole object, however many packages or AOSRs it holds.
 *
 * Authorization is the existing one, not a new contour: documentation access by role (canAccessDocumentation), the object gate (objectAccess:
 * PTO head = current lead, PTO engineer = object member or holder of an effective handoff on a work of the object, project manager = own object),
 * and, for an engineer who is not an object member, only the works they are the EFFECTIVE assignee of — the same predicates workAccess() and the
 * snapshot apply. Filters narrow rows; they never widen access.
 */
export interface DocumentationRegistryView {
    objectId: string;
    objectName: string;
    objectAddress: string | null;
    /** ALL_WORKS: every work of the object is readable. ASSIGNED_WORKS: a PTO engineer who is not an object member sees only works they hold an effective handoff on. */
    worksScope: 'ALL_WORKS' | 'ASSIGNED_WORKS';
    /** Counts over the whole authorized working set (the same rows as `allRowsCount`), independent of the filters. */
    summary: RegistrySummary;
    filters: RegistryFilters;
    matchedCount: number;
    filterOptions: { responsible: { id: string; name: string }[] };
    rows: RegistryPackageRow[];
    archivedCount: number;
    /** Present only on request (`archived=true`); archived packages never feed the summary, readiness or workload. */
    archivedRows?: RegistryArchivedRow[];
}

const iso = (v: unknown): string => new Date(v as any).toISOString();

@Injectable()
export class DocumentationRegistryService {
    async objectRegistry(a: Actor, objectId: string, filters: RegistryFilters, includeArchived: boolean): Promise<DocumentationRegistryView> {
        if (!canAccessDocumentation(a.role as any)) throw new ForbiddenException('Недостаточно прав: доступ к исполнительной документации');
        const object = await objectAccess(pool, a, objectId); // 404 / 403 exactly as every other object read
        const t = a.tenantId;

        // Works this actor may read (same predicates as workAccess(): object member OR effective assignee of the exact work).
        let works: any[] = await rows(pool, 'SELECT id,name,work_type_id FROM works WHERE tenant_id=$1 AND object_id=$2', [t, objectId]);
        let worksScope: DocumentationRegistryView['worksScope'] = 'ALL_WORKS';
        if (a.role === 'PTO' && !(await isCurrentPtoMember(pool, t, objectId, a.id))) {
            const assigned = new Set((await effectivePtoAssignedWork(pool, t, a.id)).filter((w: any) => w.objectId === objectId).map((w: any) => w.objectWorkId));
            works = works.filter(w => assigned.has(w.id));
            worksScope = 'ASSIGNED_WORKS';
        }
        const workById = new Map(works.map(w => [w.id as string, w]));

        const packages: any[] = works.length
            ? await rows(pool, 'SELECT dp.*,u.name AS responsible_name FROM documentation_packages dp JOIN users u ON u.tenant_id=dp.tenant_id AND u.id=dp.responsible_user_id WHERE dp.tenant_id=$1 AND dp.object_id=$2 AND dp.object_work_id=ANY($3::uuid[]) ORDER BY dp.created_at,dp.id', [t, objectId, works.map(w => w.id)])
            : [];
        const active = packages.filter(p => isPackageActive(p));
        const archived = packages.filter(p => !isPackageActive(p));
        const activeIds = active.map(p => p.id as string);

        // ---- scope + current quantity (existing provenance), AOSR portions for the zone of each act
        const links: any[] = packages.length ? await rows(pool, 'SELECT documentation_package_id,quantity_portion_id FROM documentation_package_portions WHERE tenant_id=$1 AND documentation_package_id=ANY($2::uuid[])', [t, packages.map(p => p.id)]) : [];
        const evidence = await loadPackageEvidence(pool, t, activeIds);
        const aosrIds = [...evidence.values()].flatMap(e => e.aosrRows.map((x: any) => x.id as string));
        const aosrPortionLinks: any[] = aosrIds.length ? await rows(pool, 'SELECT aosr_id,quantity_portion_id FROM aosr_portion_links WHERE tenant_id=$1 AND aosr_id=ANY($2::uuid[])', [t, aosrIds]) : [];
        const portionIds = [...new Set([...links.map(l => l.quantityPortionId as string), ...aosrPortionLinks.map(l => l.quantityPortionId as string)])];
        const portionInputs = await scopePortionInputs(pool, t, portionIds);
        const scopeOf = (packageId: string) => buildPackageScope(links.filter(l => l.documentationPackageId === packageId).flatMap(l => portionInputs.filter(i => i.id === l.quantityPortionId)));
        const zoneOfPortion = (portionId: string) => { const i = portionInputs.find(x => x.id === portionId); return i ? zoneName(i.label, i.location) : null; };

        // ---- what still prevents (re)generating each act: the existing AOSR content readiness, batched
        const coreAosrRows = [...evidence.values()].flatMap(e => e.aosrRows);
        const parties: AosrPartyRecord[] = coreAosrRows.length ? await rows(pool, 'SELECT * FROM aosr_party_records WHERE tenant_id=$1 AND object_id=$2', [t, objectId]) : [];
        const materialLinks: any[] = aosrIds.length ? await rows(pool, 'SELECT l.aosr_id,m.id,m.name FROM aosr_material_links l JOIN aosr_material_records m ON m.tenant_id=l.tenant_id AND m.id=l.material_record_id WHERE l.tenant_id=$1 AND l.aosr_id=ANY($2::uuid[]) ORDER BY m.name', [t, aosrIds]) : [];
        const qualityDocs: any[] = materialLinks.length ? await rows(pool, 'SELECT * FROM aosr_quality_documents WHERE tenant_id=$1 AND material_record_id=ANY($2::uuid[]) ORDER BY created_at', [t, [...new Set(materialLinks.map(m => m.id as string))]]) : [];
        const workTypeIds = [...new Set(works.map(w => w.workTypeId as string))];
        const workTypes: any[] = coreAosrRows.length ? await rows(pool, 'SELECT id,requires_materials FROM work_types WHERE tenant_id=$1 AND id=ANY($2::uuid[])', [t, workTypeIds]) : [];
        const templateAvailable = aosrTemplateAvailable();

        // ---- last meaningful documentary update, one query
        const events: any[] = activeIds.length ? await rows(pool, `
            SELECT documentation_package_id AS package_id,'STATUS_CHANGED' AS kind,max(changed_at) AS at FROM documentation_package_status_history WHERE tenant_id=$1 AND documentation_package_id=ANY($2::uuid[]) GROUP BY 1
            UNION ALL SELECT a.documentation_package_id,'AOSR_GENERATED',max(r.generated_at) FROM aosr_revisions r JOIN aosr_documents a ON a.tenant_id=r.tenant_id AND a.id=r.aosr_id WHERE r.tenant_id=$1 AND a.documentation_package_id=ANY($2::uuid[]) GROUP BY 1
            UNION ALL SELECT documentation_package_id,'METHOD_CHOSEN',max(chosen_at) FROM documentation_package_aosr_methods WHERE tenant_id=$1 AND documentation_package_id=ANY($2::uuid[]) GROUP BY 1
            UNION ALL SELECT d.documentation_package_id,'SCHEME_UPLOADED',max(v.created_at) FROM documentation_document_versions v JOIN documentation_documents d ON d.tenant_id=v.tenant_id AND d.id=v.documentation_document_id WHERE v.tenant_id=$1 AND d.documentation_package_id=ANY($2::uuid[]) AND d.type='EXECUTIVE_SCHEME' GROUP BY 1
            UNION ALL SELECT documentation_package_id,'AOSR_CHANGED',max(updated_at) FROM aosr_documents WHERE tenant_id=$1 AND documentation_package_id=ANY($2::uuid[]) GROUP BY 1
            UNION ALL SELECT d.documentation_package_id,'DOCUMENT_CHANGED',max(greatest(d.updated_at,coalesce(v.created_at,d.updated_at))) FROM documentation_documents d LEFT JOIN documentation_document_versions v ON v.tenant_id=d.tenant_id AND v.documentation_document_id=d.id WHERE d.tenant_id=$1 AND d.documentation_package_id=ANY($2::uuid[]) AND d.type='ACT_CERTIFICATE' GROUP BY 1
            UNION ALL SELECT documentation_package_id,'CUSTOMER_QUANTITY_RECORDED',max(recorded_at) FROM documentation_customer_accepted_quantities WHERE tenant_id=$1 AND documentation_package_id=ANY($2::uuid[]) GROUP BY 1`, [t, activeIds]) : [];

        const allRows: RegistryPackageRow[] = active.map(p => {
            const ev = evidence.get(p.id)!;
            const scope = scopeOf(p.id);
            const schemeById = new Map(ev.schemes.map(s => [s.id, s]));
            const aosrs: RegistryAosrRow[] = ev.aosrRows.map((x: any, i: number) => {
                const facts = ev.facts.aosrs[i]!;
                const state = aosrDocxState(facts);
                const linkedSchemes = facts.linkedSchemes.map(s => ({ id: s.id, title: schemeById.get(s.id)?.title ?? '', hasFile: s.hasFile }));
                const materials: AosrMaterialInput[] = materialLinks.filter(m => m.aosrId === x.id).map(m => ({ name: m.name, qualityDocuments: qualityDocs.filter(d => d.materialRecordId === m.id).map(d => ({ docType: d.docType as AosrQualityDocType, number: d.number, docDate: d.docDate, issuer: d.issuer })) }));
                const generation = resolveAosrReadiness({ content: x, parties, materials, schemes: linkedSchemes, workTypeRequiresMaterials: !!workTypes.find(w => w.id === workById.get(p.objectWorkId)?.workTypeId)?.requiresMaterials, templateAvailable });
                const zones = [...new Set(aosrPortionLinks.filter(l => l.aosrId === x.id).map(l => zoneOfPortion(l.quantityPortionId)).filter((z): z is string => !!z))].sort((m, n) => m.localeCompare(n, 'ru', { numeric: true }));
                return {
                    id: x.id, number: x.officialNumber, title: x.title, workDescription: x.workDescription, zones,
                    startDate: x.startDate, endDate: x.endDate, actDate: x.actDate,
                    docx: { state, revisionCount: x.revisionCount },
                    schemeCoverage: { covered: linkedSchemes.some(s => s.hasFile), schemes: linkedSchemes },
                    readiness: resolveAosrDocumentaryReadiness(facts),
                    // a current act is not asked to be re-generated: object-level master data edited later does not make it a blocker
                    generationIssues: state === 'CURRENT' ? [] : generation.issues,
                    projectDocumentation: x.projectDocumentation, normativeReferences: x.normativeReferences, subsequentWork: x.subsequentWork,
                    lastUpdateAt: iso(x.updatedAt), version: x.version,
                };
            });
            const readiness = resolvePackageReadiness(ev.facts);
            const lastUpdate = pickLastUpdate([
                ...(['STATUS_CHANGED', 'AOSR_GENERATED', 'METHOD_CHOSEN', 'SCHEME_UPLOADED', 'AOSR_CHANGED', 'DOCUMENT_CHANGED', 'CUSTOMER_QUANTITY_RECORDED'] as RegistryLastUpdateKind[])
                    .map(kind => ({ kind, at: events.find(e => e.packageId === p.id && e.kind === kind)?.at })),
                { kind: 'PACKAGE_CHANGED', at: p.updatedAt }, { kind: 'PACKAGE_CREATED', at: p.createdAt },
            ])!;
            return {
                packageId: p.id, workId: p.objectWorkId, workName: workById.get(p.objectWorkId)?.name ?? '',
                scope: { hasScope: scope.hasScope, zoneSummary: scope.zoneSummary, zones: [...new Set(scope.portions.map(x => x.zone).filter(Boolean))], currentQuantity: scope.currentQuantity },
                responsible: { id: p.responsibleUserId, name: p.responsibleName },
                status: p.status, aosrMethod: ev.facts.method,
                aosrCount: aosrs.length, aosrGeneratedCount: aosrs.filter(x => x.docx.state === 'CURRENT').length,
                schemeCount: ev.schemes.length, schemeFileBackedCount: ev.schemes.filter(s => s.hasFile).length,
                readiness, awaitingEngineerAction: awaitsEngineerAction(p.status), lastUpdate, aosrs,
            };
        });

        const matched = sortRegistryRows(filterRegistryRows(allRows, filters));
        const responsible = new Map<string, string>(allRows.map(r => [r.responsible.id, r.responsible.name]));

        let archivedRows: RegistryArchivedRow[] | undefined;
        if (includeArchived) {
            const people: any[] = archived.length ? await rows(pool, 'SELECT id,name FROM users WHERE tenant_id=$1 AND id=ANY($2::uuid[])', [t, [...new Set(archived.map(p => p.archivedBy as string).filter(Boolean))]]) : [];
            const methods = await currentAosrMethods(pool, t, archived.map(p => p.id)); // the declaration only: archived packages are not judged for readiness
            archivedRows = [...archived].sort((m, n) => +new Date(n.archivedAt) - +new Date(m.archivedAt)).map(p => {
                const scope = scopeOf(p.id);
                return {
                    packageId: p.id, workId: p.objectWorkId, workName: workById.get(p.objectWorkId)?.name ?? '',
                    scope: { hasScope: scope.hasScope, zoneSummary: scope.zoneSummary, zones: [...new Set(scope.portions.map(x => x.zone).filter(Boolean))], currentQuantity: scope.currentQuantity },
                    responsible: { id: p.responsibleUserId, name: p.responsibleName }, status: p.status, aosrMethod: methods.get(p.id) ?? null,
                    archivedAt: iso(p.archivedAt), archivedByName: people.find(u => u.id === p.archivedBy)?.name ?? null, archiveReason: p.archiveReason ?? null,
                };
            });
        }

        return {
            objectId, objectName: object.name, objectAddress: object.address ?? null, worksScope,
            summary: summarizeRegistry(allRows), filters, matchedCount: matched.length,
            filterOptions: { responsible: [...responsible].map(([id, name]) => ({ id, name })).sort((m, n) => m.name.localeCompare(n.name, 'ru')) },
            rows: matched, archivedCount: archived.length, ...(archivedRows ? { archivedRows } : {}),
        };
    }
}
