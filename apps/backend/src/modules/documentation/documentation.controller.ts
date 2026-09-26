import { Controller, Post, Get, Param, Body, Query, Req, Inject, ForbiddenException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ProductionService } from '../../service';
import { ReadService } from '../../read-service';
import { authenticate } from '../../security';
import { canAccessDocumentation } from '../../../../../packages/domain';
import * as V from '../../validation';

/**
 * F8.2 PTO / Executive Documentation Foundation.
 *
 * Creation posts flat with the parent id in the body (documentation-packages,
 * objectWorkId in the body) — the same shape execution-units already uses.
 * An action on an existing resource nests under that resource's own id
 * (documentation-packages/:id/edit, /portions, /documents, /status), and
 * documentation-documents/:id/versions nests a version under its own
 * document — execution-units.controller.ts's own precedent throughout.
 *
 * `documentation-packages` (GET) is a thin read of ReadService.snapshot()'s
 * own documentationPackages, the same shape pto.controller.ts's pre-existing
 * `GET executive-packages` already takes — except SDO and CONTRACTOR_VIEWER
 * are refused outright here (canAccessDocumentation()), not merely served an
 * omitted field, since a role hitting this endpoint directly deserves an
 * explicit answer.
 */
@Controller()
@ApiTags('Documentation')
@ApiBearerAuth()
export class DocumentationController {
    constructor(@Inject(ProductionService) private service: ProductionService, @Inject(ReadService) private read: ReadService) {}

    @Post('documentation-packages')
    async createPackage(@Req() r: any, @Body() b: any) {
        return this.service.createDocumentationPackage(await authenticate(r), V.documentationPackageDto.parse(b));
    }

    @Get('documentation-packages')
    async packages(@Req() r: any, @Query('objectId') objectId?: string) {
        const a = await authenticate(r);
        if (!canAccessDocumentation(a.role))
            throw new ForbiddenException('Недостаточно прав: доступ к исполнительной документации');
        const list = (await this.read.snapshot(a)).documentationPackages ?? [];
        return objectId ? list.filter((p: any) => p.objectId === V.uuid.parse(objectId)) : list;
    }

    @Post('documentation-packages/:id/edit')
    async editPackage(@Req() r: any, @Param('id') id: string, @Body() b: any) {
        const d = V.documentationPackageEditDto.parse(b);
        return this.service.editDocumentationPackage(await authenticate(r), V.uuid.parse(id), d);
    }

    @Post('documentation-packages/:id/portions')
    async linkPortion(@Req() r: any, @Param('id') id: string, @Body() b: any) {
        const d = V.documentationPackagePortionDto.parse(b);
        return this.service.linkDocumentationPackagePortion(await authenticate(r), V.uuid.parse(id), d);
    }

    @Post('documentation-packages/:id/documents')
    async createDocument(@Req() r: any, @Param('id') id: string, @Body() b: any) {
        const d = V.documentationDocumentDto.parse(b);
        return this.service.createDocumentationDocument(await authenticate(r), V.uuid.parse(id), d);
    }

    @Post('documentation-documents/:id/versions')
    async createVersion(@Req() r: any, @Param('id') id: string, @Body() b: any) {
        const d = V.documentationVersionDto.parse(b);
        return this.service.createDocumentationVersion(await authenticate(r), V.uuid.parse(id), d);
    }

    @Post('documentation-packages/:id/status')
    async changeStatus(@Req() r: any, @Param('id') id: string, @Body() b: any) {
        const d = V.documentationPackageStatusDto.parse(b);
        return this.service.changeDocumentationPackageStatus(await authenticate(r), V.uuid.parse(id), d);
    }

    /**
     * F8.3 SDO / Closing. Both routes stay nested under documentation-packages
     * (the same "action on an existing resource nests under that resource's
     * own id" precedent /status above already follows) — customer-acceptance
     * registration and the handoff to SDO are both PTO-side actions on a
     * Documentation Package, never on the legacy executive-packages pipeline
     * (pto.controller.ts's own /transfer-sdo, untouched by this file).
     */
    @Post('documentation-packages/:id/customer-acceptance')
    async registerCustomerAcceptance(@Req() r: any, @Param('id') id: string, @Body() b: any) {
        const d = V.sdoCustomerAcceptanceDto.parse(b);
        return this.service.registerDocumentationCustomerAcceptance(await authenticate(r), V.uuid.parse(id), d);
    }

    @Post('documentation-packages/:id/handoff-to-sdo')
    async handoffToSdo(@Req() r: any, @Param('id') id: string, @Body() b: any) {
        const d = V.sdoHandoffDto.parse(b);
        return this.service.handoffDocumentationPackageToSdo(await authenticate(r), V.uuid.parse(id), d);
    }
}
