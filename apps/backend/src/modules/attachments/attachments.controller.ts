import { Controller, Post, Get, Param, Body, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { pool, insert } from '../../db';
import { authenticate, requirePermission, scoped, ensure } from '../../security';
import { Permission as P } from '../../../../../packages/domain';
import * as V from '../../validation';
@Controller()
@ApiTags('Attachments')
@ApiBearerAuth()
export class AttachmentsController {
    @Post('attachments')
    async upload(
    @Req()
    r: any,
    @Body()
    b: any) { const a = await authenticate(r); ensure(['ADMIN', 'PTO', 'CONSTRUCTION_CONTROL', 'PROJECT_MANAGER'].includes(a.role), 'Нет прав загрузки'); const d = z.object({ fileName: V.text, mimeType: z.enum(['image/png', 'image/jpeg', 'application/pdf']), base64: z.string().max(7000000) }).strict().parse(b); const bytes = Buffer.from(d.base64, 'base64'); ensure(bytes.length > 0 && bytes.length <= 5 * 1024 * 1024, 'Максимум 5 МБ'); const signature = d.mimeType === 'application/pdf' ? bytes.subarray(0, 5).toString() === '%PDF-' : d.mimeType === 'image/png' ? bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255; ensure(signature, 'Содержимое не соответствует типу файла'); const file = await insert(pool, 'attachments', a.tenantId, { fileName: d.fileName.replace(/[^\p{L}\p{N}_. -]/gu, '_'), mimeType: d.mimeType, content: bytes, uploadedBy: a.id }); return { id: file.id, fileName: file.fileName, mimeType: file.mimeType }; }
    @Get('attachments/:id')
    async download(
    @Req()
    r: any,
    @Res()
    res: any,
    @Param('id')
    id: string) { const a = await authenticate(r); requirePermission(a, P.PTO_VIEW); const f = await scoped(pool, 'attachments', V.uuid.parse(id), a); if (a.role === 'PROJECT_MANAGER')
        ensure(f.uploadedBy === a.id, 'РП может скачивать только собственные вложения'); res.setHeader('Content-Type', f.mimeType); res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(f.fileName)); res.send(f.content); }
}
