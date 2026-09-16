import { Controller, Post, Get, Body, Req, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { pool, rows, transaction, insert } from '../../db';
import { ReadService } from '../../read-service';
import { authenticate, requirePermission, scoped, objectAccess, audit } from '../../security';
import { Permission as P } from '../../../../../packages/domain';
import * as V from '../../validation';
@Controller()
@ApiTags('Materials')
@ApiBearerAuth()
export class MaterialsController {
    constructor(@Inject(ReadService) private read: ReadService) {}
    @Get('materials')
    async materials(
    @Req()
    r: any) { const a = await authenticate(r); requirePermission(a, P.PTO_VIEW); const ids = (await this.read.snapshot(a)).objects.map(o => o.id); const batches = await rows(pool, 'SELECT * FROM material_batches WHERE tenant_id=$1 AND object_id=ANY($2::uuid[])', [a.tenantId, ids]); return { materials: await rows(pool, 'SELECT * FROM materials WHERE tenant_id=$1 AND id=ANY($2::uuid[])', [a.tenantId, batches.map(b => b.materialId)]), batches, documents: await rows(pool, 'SELECT * FROM material_documents WHERE tenant_id=$1 AND material_batch_id=ANY($2::uuid[])', [a.tenantId, batches.map(b => b.id)]), links: await rows(pool, 'SELECT * FROM work_materials WHERE tenant_id=$1 AND material_batch_id=ANY($2::uuid[])', [a.tenantId, batches.map(b => b.id)]) }; }
    @Post('materials/bind')
    async bindMaterial(
    @Req()
    r: any,
    @Body()
    b: any) { const a = await authenticate(r); requirePermission(a, P.PTO_EDIT); const d = z.object({ objectWorkId: V.uuid, name: V.text, manufacturer: V.text, batchNumber: V.text, quantity: V.qty.refine(v => Number(v) > 0), documentNumber: V.text, fileId: V.uuid, validUntil: V.date }).strict().parse(b); return transaction(async (c) => { const w = await scoped(c, 'works', d.objectWorkId, a); await objectAccess(c, a, w.objectId); await scoped(c, 'attachments', d.fileId, a); const material = await insert(c, 'materials', a.tenantId, { name: d.name, manufacturer: d.manufacturer }); const batch = await insert(c, 'material_batches', a.tenantId, { materialId: material.id, objectId: w.objectId, batchNumber: d.batchNumber }); await insert(c, 'material_documents', a.tenantId, { materialBatchId: batch.id, type: 'PASSPORT', number: d.documentNumber, fileId: d.fileId, validUntil: d.validUntil }); const link = await insert(c, 'work_materials', a.tenantId, { objectWorkId: w.id, materialBatchId: batch.id, quantity: d.quantity }); await audit(c, a, 'Work', w.id, 'MATERIAL', null, { material, batch, link }); return link; }); }
}
