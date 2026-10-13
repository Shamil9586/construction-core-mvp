import { one, rows } from './db';
import {
    METHOD_REQUIRED_MESSAGE, SCHEME_FILE_REQUIRED_MESSAGE, forwardGateMessage, resolvePackageReadiness,
    type AosrDocumentFacts, type AosrMethod, type PackageReadinessFacts,
} from '../../../packages/domain/documentation-readiness';

/**
 * ID-AUTO-1 final corrective — documentary evidence of a Documentation Package.
 *
 * An executive scheme is a documentation_documents row (type EXECUTIVE_SCHEME). It is documentary EVIDENCE only when
 * a real file backs it: a CORE_FILE version whose attachment holds content. A scheme without one is metadata only.
 * Shared by the AOSR service, the package status transition and the Object registry so all of them read the same definition.
 */
export interface PackageScheme { id: string; title: string; hasFile: boolean; fileName: string | null; mimeType: string | null; fileVersion: number | null }

export { METHOD_REQUIRED_MESSAGE, SCHEME_FILE_REQUIRED_MESSAGE };

/** Executive schemes of several packages in ONE query (creation order within each package). `onlyIds` narrows to given scheme documents. */
export async function schemesByPackage(c: any, tenantId: string, packageIds: string[], onlyIds?: string[]): Promise<Map<string, PackageScheme[]>> {
    const out = new Map<string, PackageScheme[]>(packageIds.map(id => [id, []]));
    if (!packageIds.length) return out;
    const list = await rows(c, `SELECT d.id,d.documentation_package_id,coalesce(d.title,'Исполнительная схема') AS title,f.version_number AS file_version,f.file_name,f.mime_type
        FROM documentation_documents d
        LEFT JOIN LATERAL (SELECT v.version_number,a.file_name,a.mime_type FROM documentation_document_versions v
            JOIN attachments a ON a.tenant_id=v.tenant_id AND a.id::text=v.storage_reference AND a.content IS NOT NULL
            WHERE v.tenant_id=d.tenant_id AND v.documentation_document_id=d.id AND v.storage_provider='CORE_FILE'
            ORDER BY v.version_number DESC LIMIT 1) f ON true
        WHERE d.tenant_id=$1 AND d.documentation_package_id=ANY($2::uuid[]) AND d.type='EXECUTIVE_SCHEME' ${onlyIds ? 'AND d.id=ANY($3::uuid[])' : ''}
        ORDER BY d.created_at,d.id`, onlyIds ? [tenantId, packageIds, onlyIds] : [tenantId, packageIds]);
    for (const s of list) out.get(s.documentationPackageId)?.push({ id: s.id, title: s.title, hasFile: s.fileVersion !== null, fileName: s.fileName ?? null, mimeType: s.mimeType ?? null, fileVersion: s.fileVersion ?? null });
    return out;
}

export async function packageSchemes(c: any, tenantId: string, packageId: string, onlyIds?: string[]): Promise<PackageScheme[]> {
    return (await schemesByPackage(c, tenantId, [packageId], onlyIds)).get(packageId) ?? [];
}

/** The package's current AOSR preparation method (latest declaration), or undefined while none has been declared. */
export async function currentAosrMethod(c: any, tenantId: string, packageId: string): Promise<{ id: string; method: 'CORE' | 'EXTERNAL'; chosenBy: string; chosenAt: string; comment: string | null } | undefined> {
    return one(c, 'SELECT * FROM documentation_package_aosr_methods WHERE tenant_id=$1 AND documentation_package_id=$2 ORDER BY chosen_at DESC,created_at DESC LIMIT 1', [tenantId, packageId]);
}

/** Latest declared method of several packages in ONE query. A package with no declaration is simply absent from the map. */
export async function currentAosrMethods(c: any, tenantId: string, packageIds: string[]): Promise<Map<string, AosrMethod>> {
    if (!packageIds.length) return new Map();
    const list = await rows(c, 'SELECT DISTINCT ON (documentation_package_id) documentation_package_id,method FROM documentation_package_aosr_methods WHERE tenant_id=$1 AND documentation_package_id=ANY($2::uuid[]) ORDER BY documentation_package_id,chosen_at DESC,created_at DESC', [tenantId, packageIds]);
    return new Map(list.map((r: any) => [r.documentationPackageId, r.method as AosrMethod]));
}

export interface PackageEvidence {
    facts: PackageReadinessFacts;
    /** The raw Core AOSR rows (creation order) — the registry reads the descriptive columns from here, never from a second query. */
    aosrRows: any[];
    schemes: PackageScheme[];
}

/**
 * Everything documentary readiness judges, for several packages in a fixed number of queries (scope links, method, AOSRs, AOSR↔scheme links,
 * schemes). The forward gate and the registry both build their verdict from this — there is no second place that decides what "ready" means.
 */
export async function loadPackageEvidence(c: any, tenantId: string, packageIds: string[]): Promise<Map<string, PackageEvidence>> {
    const out = new Map<string, PackageEvidence>();
    if (!packageIds.length) return out;
    const scoped = new Set((await rows(c, 'SELECT DISTINCT documentation_package_id FROM documentation_package_portions WHERE tenant_id=$1 AND documentation_package_id=ANY($2::uuid[])', [tenantId, packageIds])).map((r: any) => r.documentationPackageId));
    const methods = await currentAosrMethods(c, tenantId, packageIds);
    const schemes = await schemesByPackage(c, tenantId, packageIds);
    const aosrRows = await rows(c, 'SELECT * FROM aosr_documents WHERE tenant_id=$1 AND documentation_package_id=ANY($2::uuid[]) ORDER BY created_at,id', [tenantId, packageIds]);
    const links = aosrRows.length ? await rows(c, 'SELECT aosr_id,scheme_document_id FROM aosr_scheme_links WHERE tenant_id=$1 AND aosr_id=ANY($2::uuid[])', [tenantId, aosrRows.map((a: any) => a.id)]) : [];
    for (const packageId of packageIds) {
        const own = schemes.get(packageId) ?? [];
        const aosrs = aosrRows.filter((a: any) => a.documentationPackageId === packageId);
        const aosrFacts: AosrDocumentFacts[] = aosrs.map((a: any) => ({
            id: a.id, title: a.title, officialNumber: a.officialNumber, revisionCount: a.revisionCount, generatedAtVersion: a.generatedAtVersion, version: a.version,
            // only a scheme that really belongs to THIS package counts as linked
            linkedSchemes: links.filter((l: any) => l.aosrId === a.id).flatMap((l: any) => { const s = own.find(x => x.id === l.schemeDocumentId); return s ? [{ id: s.id, hasFile: s.hasFile }] : []; }),
        }));
        out.set(packageId, { facts: { hasScope: scoped.has(packageId), method: methods.get(packageId) ?? null, aosrs: aosrFacts, schemes: own.map(s => ({ hasFile: s.hasFile })) }, aosrRows: aosrs, schemes: own });
    }
    return out;
}

/**
 * The forward gate for the two PTO actions that depend on the documentation route — moving a package to PRESENTED and recording the
 * customer-accepted quantity. One process, an optional tool; the rules live in packages/domain/documentation-readiness.ts:
 *   - no explicit scope   -> blocked;
 *   - no declared method  -> blocked (never inferred: "no AOSR" does not mean "outside Core"); the package stays readable;
 *   - CORE                -> at least one Core AOSR, and EVERY Core AOSR has a successfully generated CURRENT DOCX;
 *   - EXTERNAL            -> zero Core AOSRs / DOCX are fine;
 *   - both                -> at least one FILE-BACKED executive scheme (a Core AOSR also needs a file-backed scheme linked to it).
 * Returns the first failing stage as a business message, or null when the action may proceed.
 */
export async function forwardGateViolation(c: any, tenantId: string, packageId: string): Promise<string | null> {
    const evidence = (await loadPackageEvidence(c, tenantId, [packageId])).get(packageId)!;
    return forwardGateMessage(resolvePackageReadiness(evidence.facts));
}
