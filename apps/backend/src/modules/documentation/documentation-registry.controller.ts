import { Controller, Get, Param, Query, Req, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { DocumentationRegistryService } from '../../documentation-registry-service';
import { authenticate } from '../../security';
import type { RegistryFilters } from '../../../../../packages/domain/documentation-registry';
import * as V from '../../validation';

/**
 * ID-AUTO-2 — the Object documentation registry («Реестр ИД»). One read-only route, scoped to ONE object; it lives beside the Documentation
 * Package surface and uses the same authentication and access rules (see DocumentationRegistryService). Filters are query parameters and only
 * narrow the rows.
 */
@Controller()
@ApiTags('Documentation')
@ApiBearerAuth()
export class DocumentationRegistryController {
    constructor(@Inject(DocumentationRegistryService) private registry: DocumentationRegistryService) {}

    @Get('objects/:id/documentation-registry')
    async objectRegistry(@Req() r: any, @Param('id') id: string, @Query() query: Record<string, unknown>) {
        const a = await authenticate(r);
        const q = V.documentationRegistryQuery.parse(query);
        const filters: RegistryFilters = {
            ...(q.responsibleUserId ? { responsibleUserId: q.responsibleUserId } : {}),
            ...(q.status ? { status: q.status } : {}),
            ...(q.ready ? { ready: q.ready === 'true' } : {}),
            ...(q.method ? { method: q.method } : {}),
            ...(q.q ? { q: q.q } : {}),
        };
        return this.registry.objectRegistry(a, V.uuid.parse(id), filters, q.archived === 'true');
    }
}
