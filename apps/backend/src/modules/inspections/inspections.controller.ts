import { Controller, Post, Get, Param, Body, Req, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { transaction, insert } from '../../db';
import { ProductionService } from '../../service';
import { ReadService } from '../../read-service';
import { authenticate, requirePermission, scoped, audit, ensure } from '../../security';
import { Permission as P } from '../../../../../packages/domain';
import * as V from '../../validation';
@Controller()
@ApiTags('Inspections')
@ApiBearerAuth()
export class InspectionsController {
    constructor(@Inject(ProductionService) private service: ProductionService, @Inject(ReadService) private read: ReadService) {}
    @Get('inspections')
    async inspections(
    @Req()
    r: any) { const a = await authenticate(r); requirePermission(a, P.PTO_VIEW); return (await this.read.snapshot(a)).inspections; }
    @Post('inspections/:id/issues')
    async issue(
    @Req()
    r: any,
    @Param('id')
    id: string,
    @Body()
    b: any) { return this.service.addIssue(await authenticate(r), V.uuid.parse(id), V.issueDto.parse(b)); }
    @Post('issues/:id/resolve')
    async resolve(
    @Req()
    r: any,
    @Param('id')
    id: string,
    @Body()
    b: any) { return this.service.issueAction(await authenticate(r), V.uuid.parse(id), V.version.parse(b.version), 'resolve'); }
    @Post('issues/:id/verify')
    async verify(
    @Req()
    r: any,
    @Param('id')
    id: string,
    @Body()
    b: any) { return this.service.issueAction(await authenticate(r), V.uuid.parse(id), V.version.parse(b.version), 'verify'); }
    @Post('inspections/:id/accept')
    async accept(
    @Req()
    r: any,
    @Param('id')
    id: string,
    @Body()
    b: any) { return this.service.inspectionAction(await authenticate(r), V.uuid.parse(id), V.version.parse(b.version), 'accept', V.text.parse(b.comment)); }
    @Post('inspections/:id/reject')
    async reject(
    @Req()
    r: any,
    @Param('id')
    id: string,
    @Body()
    b: any) { return this.service.inspectionAction(await authenticate(r), V.uuid.parse(id), V.version.parse(b.version), 'reject', V.text.parse(b.comment)); }
    @Post('inspections/:id/photos')
    async photo(
    @Req()
    r: any,
    @Param('id')
    id: string,
    @Body()
    b: any) { const a = await authenticate(r); requirePermission(a, P.ISSUE_CREATE); const d = z.object({ attachmentId: V.uuid, issueId: V.uuid.optional() }).strict().parse(b); return transaction(async (c) => { const i = await scoped(c, 'inspections', V.uuid.parse(id), a, true); ensure(i.status !== 'ACCEPTED', 'Проверка завершена'); const f = await scoped(c, 'attachments', d.attachmentId, a); ensure(f.mimeType.startsWith('image/'), 'Требуется фото'); if (d.issueId) {
        const issue = await scoped(c, 'issues', d.issueId, a);
        ensure(issue.inspectionId === id, 'Замечание другой проверки');
    } const photo = await insert(c, 'inspection_photos', a.tenantId, { inspectionId: id, ...d, uploadedBy: a.id }); await audit(c, a, 'Inspection', id, 'PHOTO', null, { photoId: photo.id }); return photo; }); }
}
