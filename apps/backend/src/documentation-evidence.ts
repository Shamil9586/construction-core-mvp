import { one, rows } from './db';

/**
 * ID-AUTO-1 final corrective — documentary evidence of a Documentation Package.
 *
 * An executive scheme is a documentation_documents row (type EXECUTIVE_SCHEME). It is documentary EVIDENCE only when
 * a real file backs it: a CORE_FILE version whose attachment holds content. A scheme without one is metadata only.
 * Shared by the AOSR service and the package status transition so both read the same definition.
 */
export interface PackageScheme { id: string; title: string; hasFile: boolean; fileName: string | null; mimeType: string | null; fileVersion: number | null }

export async function packageSchemes(c: any, tenantId: string, packageId: string, onlyIds?: string[]): Promise<PackageScheme[]> {
    const list = await rows(c, `SELECT d.id,coalesce(d.title,'Исполнительная схема') AS title,f.version_number AS file_version,f.file_name,f.mime_type
        FROM documentation_documents d
        LEFT JOIN LATERAL (SELECT v.version_number,a.file_name,a.mime_type FROM documentation_document_versions v
            JOIN attachments a ON a.tenant_id=v.tenant_id AND a.id::text=v.storage_reference AND a.content IS NOT NULL
            WHERE v.tenant_id=d.tenant_id AND v.documentation_document_id=d.id AND v.storage_provider='CORE_FILE'
            ORDER BY v.version_number DESC LIMIT 1) f ON true
        WHERE d.tenant_id=$1 AND d.documentation_package_id=$2 AND d.type='EXECUTIVE_SCHEME' ${onlyIds ? 'AND d.id=ANY($3::uuid[])' : ''}
        ORDER BY d.created_at,d.id`, onlyIds ? [tenantId, packageId, onlyIds] : [tenantId, packageId]);
    return list.map((s: any) => ({ id: s.id, title: s.title, hasFile: s.fileVersion !== null, fileName: s.fileName ?? null, mimeType: s.mimeType ?? null, fileVersion: s.fileVersion ?? null }));
}

/** The package's current AOSR preparation method (latest declaration), or undefined while none has been declared. */
export async function currentAosrMethod(c: any, tenantId: string, packageId: string): Promise<{ id: string; method: 'CORE' | 'EXTERNAL'; chosenBy: string; chosenAt: string; comment: string | null } | undefined> {
    return one(c, 'SELECT * FROM documentation_package_aosr_methods WHERE tenant_id=$1 AND documentation_package_id=$2 ORDER BY chosen_at DESC,created_at DESC LIMIT 1', [tenantId, packageId]);
}

export const SCHEME_FILE_REQUIRED_MESSAGE = 'Для предъявления заказчику нужна хотя бы одна исполнительная схема с загруженным файлом';

/**
 * The one evidence rule, identical for both AOSR methods: once a package has declared how its AOSRs are prepared,
 * presenting it to the customer (and recording the customer-accepted quantity) needs at least one FILE-BACKED
 * executive scheme. Packages that never declared a method keep their earlier behaviour.
 */
export async function schemeEvidenceViolation(c: any, tenantId: string, packageId: string): Promise<string | null> {
    if (!(await currentAosrMethod(c, tenantId, packageId))) return null;
    return (await packageSchemes(c, tenantId, packageId)).some(s => s.hasFile) ? null : SCHEME_FILE_REQUIRED_MESSAGE;
}
