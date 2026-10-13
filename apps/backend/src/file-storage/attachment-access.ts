import { ForbiddenException } from '@nestjs/common';
import { one } from '../db';
import { Actor, scoped, workAccess } from '../security';
import { canAccessDocumentation } from '../../../../packages/domain';

/**
 * Core authorization for a file that backs a documentation version.
 *
 * `GET /attachments/:id` historically checked only PTO_VIEW + tenant, which was enough for ordinary photos but not for
 * executive documentation: the snapshot exposes a version's `storageReference` (the attachment id), so any PTO_VIEW role of the
 * tenant could fetch a package's scheme / AOSR DOCX by id, bypassing package and object access. For an attachment that is a
 * documentation file, the generic route now applies the same rule as the document routes (documentation role + access to the
 * package's Work/Object). Attachments that back no documentation version are unaffected. Provider-independent.
 */
export async function authorizeDocumentationAttachment(db: any, a: Actor, attachmentId: string): Promise<void> {
    const ref = await one(db, `SELECT d.documentation_package_id FROM documentation_document_versions v
        JOIN documentation_documents d ON d.tenant_id=v.tenant_id AND d.id=v.documentation_document_id
        WHERE v.tenant_id=$1 AND v.storage_provider='CORE_FILE' AND v.storage_reference=$2 LIMIT 1`, [a.tenantId, attachmentId]);
    if (!ref) return;
    if (!canAccessDocumentation(a.role as any)) throw new ForbiddenException('Недостаточно прав: доступ к исполнительной документации');
    const pkg = await scoped(db, 'documentation_packages', ref.documentationPackageId, a);
    const work = await scoped(db, 'works', pkg.objectWorkId, a);
    await workAccess(db, a, work);
}
