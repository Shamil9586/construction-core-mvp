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
export const METHOD_REQUIRED_MESSAGE = 'Сначала выберите способ подготовки АОСР по пакету: «АОСР формируются в Core» или «АОСР формируются вне Core»';

/**
 * The forward gate for the two PTO actions that depend on the documentation route — moving a package to PRESENTED and recording the
 * customer-accepted quantity. One process, an optional tool:
 *   - no declared method  -> blocked (never inferred: "no AOSR" does not mean "outside Core"); the package stays readable;
 *   - CORE                -> at least one Core AOSR, and EVERY Core AOSR has a successfully generated CURRENT DOCX;
 *   - EXTERNAL            -> zero Core AOSRs / DOCX are fine;
 *   - both                -> at least one FILE-BACKED executive scheme.
 * Returns a business message, or null when the action may proceed.
 */
export async function forwardGateViolation(c: any, tenantId: string, packageId: string): Promise<string | null> {
    const declared = await currentAosrMethod(c, tenantId, packageId);
    if (!declared) return METHOD_REQUIRED_MESSAGE;
    if (declared.method === 'CORE') {
        const list = await rows(c, 'SELECT title,official_number,revision_count,generated_at_version,version FROM aosr_documents WHERE tenant_id=$1 AND documentation_package_id=$2 ORDER BY created_at', [tenantId, packageId]);
        if (!list.length) return 'Выбрано «АОСР формируются в Core»: сформируйте хотя бы один АОСР в Core';
        const unfinished = list.filter((x: any) => x.officialNumber === null || x.revisionCount < 1 || x.generatedAtVersion !== x.version);
        if (unfinished.length) return `Не сформирован актуальный DOCX у АОСР: ${unfinished.map((x: any) => `«${x.title}»`).join(', ')}. Сформируйте его (или удалите черновик, если АОСР в Core не нужен)`;
    }
    return (await packageSchemes(c, tenantId, packageId)).some(x => x.hasFile) ? null : SCHEME_FILE_REQUIRED_MESSAGE;
}
