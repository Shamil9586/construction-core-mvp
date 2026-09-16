import { Controller, Post, Get, Body, Req, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { transaction, insert } from '../../db';
import { ReadService } from '../../read-service';
import { authenticate, requirePermission, audit } from '../../security';
import { Permission as P } from '../../../../../packages/domain';
import * as V from '../../validation';
@Controller()
@ApiTags('Contractors')
@ApiBearerAuth()
export class ContractorsController {
    constructor(@Inject(ReadService) private read: ReadService) {}
    @Get('contractors')
    async contractors(
    @Req()
    r: any) { return (await this.read.snapshot(await authenticate(r))).contractors; }
    @Post('contractors')
    async addContractor(
    @Req()
    r: any,
    @Body()
    b: any) { const a = await authenticate(r); requirePermission(a, P.ADMIN_DICTIONARIES); return transaction(async (c) => { const d = z.object({ name: V.text, inn: z.string().regex(/^(\d{10}|\d{12})$/).optional() }).strict().parse(b); const n = await insert(c, 'contractors', a.tenantId, d); await audit(c, a, 'Contractor', n.id, 'CREATE', null, n); return n; }); }
}
