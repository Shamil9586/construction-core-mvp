import { Controller, Post, Param, Body, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { previewImport, commitImport } from '../../importer';
import { authenticate } from '../../security';
import * as V from '../../validation';
@Controller()
@ApiTags('Imports')
@ApiBearerAuth()
export class ImportsController {
    @Post('imports/preview')
    async importPreview(
    @Req()
    r: any,
    @Body()
    b: any) { return previewImport(await authenticate(r), z.object({ fileName: V.text, base64: z.string().max(10000000), multiplier: z.number().refine(v => [1, 1000, 1000000].includes(v)) }).strict().parse(b)); }
    @Post('imports/:id/commit')
    async importCommit(
    @Req()
    r: any,
    @Param('id')
    id: string,
    @Body()
    b: any) { return commitImport(await authenticate(r), V.uuid.parse(id), z.object({ sourceRows: z.array(z.string()).min(1), projectManagerId: V.uuid, contractorId: V.uuid, startDate: V.date, plannedFinishDate: V.date, period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).strict().parse(b)); }
}
