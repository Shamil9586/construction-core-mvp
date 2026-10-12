import { rows } from './db';
import { ensure } from './security';
import { archiveViolation, PACKAGE_ARCHIVED_MESSAGE, type PackageArchiveFacts } from '../../../packages/domain/package-archive';

/**
 * Documentation Package soft archive — the database-facing half. The rules themselves are pure (packages/domain/package-archive.ts); this
 * file only gathers the facts they judge, from the real tables, and exposes the one guard every forward package mutation calls.
 */

/** Every forward PTO/AOSR mutation calls this right after authorizing the actor: an archived package takes no new action. */
export function ensurePackageNotArchived(pkg: { archivedAt?: unknown | null }): void {
    ensure(!pkg.archivedAt, PACKAGE_ARCHIVED_MESSAGE);
}

/** The facts the archive rule judges, for several packages in a handful of batched queries. */
export async function packageArchiveFacts(c: any, tenantId: string, packages: { id: string; status: string; archivedAt?: unknown | null }[]): Promise<Map<string, PackageArchiveFacts>> {
    const ids = packages.map(p => p.id);
    const count = async (sql: string) => new Map<string, number>((await rows(c, sql, [tenantId, ids])).map((r: any) => [r.documentationPackageId, Number(r.n)]));
    const acceptances = await count('SELECT documentation_package_id,count(*)::int AS n FROM documentation_customer_acceptances WHERE tenant_id=$1 AND documentation_package_id=ANY($2::uuid[]) GROUP BY documentation_package_id');
    const acceptedQuantities = await count('SELECT documentation_package_id,count(*)::int AS n FROM documentation_customer_accepted_quantities WHERE tenant_id=$1 AND documentation_package_id=ANY($2::uuid[]) GROUP BY documentation_package_id');
    const sdoCases = await count('SELECT documentation_package_id,count(*)::int AS n FROM sdo_closing_cases WHERE tenant_id=$1 AND documentation_package_id=ANY($2::uuid[]) GROUP BY documentation_package_id');
    const presented = await count("SELECT documentation_package_id,count(*)::int AS n FROM documentation_package_status_history WHERE tenant_id=$1 AND documentation_package_id=ANY($2::uuid[]) AND (to_status IN ('PRESENTED','ACCEPTED_BY_CUSTOMER') OR from_status IN ('PRESENTED','ACCEPTED_BY_CUSTOMER')) GROUP BY documentation_package_id");
    const generated = await count('SELECT documentation_package_id,count(*)::int AS n FROM aosr_documents WHERE tenant_id=$1 AND documentation_package_id=ANY($2::uuid[]) AND (official_number IS NOT NULL OR documentation_document_id IS NOT NULL) GROUP BY documentation_package_id');
    return new Map(packages.map(p => [p.id, {
        status: p.status,
        archivedAt: p.archivedAt ?? null,
        everPresented: (presented.get(p.id) ?? 0) > 0,
        customerAcceptances: acceptances.get(p.id) ?? 0,
        customerAcceptedQuantities: acceptedQuantities.get(p.id) ?? 0,
        hasSdoCase: (sdoCases.get(p.id) ?? 0) > 0,
        generatedAosrs: generated.get(p.id) ?? 0,
    }]));
}

/** Null when the package may be archived now, otherwise the business reason it may not. */
export async function packageArchiveBlocker(c: any, tenantId: string, pkg: { id: string; status: string; archivedAt?: unknown | null }): Promise<string | null> {
    return archiveViolation((await packageArchiveFacts(c, tenantId, [pkg])).get(pkg.id)!);
}
