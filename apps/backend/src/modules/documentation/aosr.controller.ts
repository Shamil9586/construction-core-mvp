import { Controller, Post, Get, Param, Body, Req, Res, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AosrService } from '../../aosr-service';
import { authenticate } from '../../security';
import * as V from '../../validation';

/**
 * Authenticated binary download. Both `filename` (ASCII fallback, for clients that ignore RFC 5987) and `filename*` (the real
 * Unicode name) are sent; the bytes go out as a Buffer with an explicit length, and nothing here is cacheable by a shared proxy.
 */
function sendFile(res: any, f: { fileName: string; mimeType: string; content: Buffer }) {
    const bytes = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content);
    const ascii = f.fileName.replace(/[^\x20-\x7e]+/g, '_').replace(/["\\;]/g, '_') || 'file';
    res.setHeader('Content-Type', f.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.fileName)}`);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(bytes);
}

/**
 * ID-AUTO-1 — AOSR routes. They live inside the existing Documentation Package surface
 * (documentation-packages/:id/...) and use the same authentication and package access rules;
 * there is no separate authorization contour.
 */
@Controller()
@ApiTags('Documentation')
@ApiBearerAuth()
export class AosrController {
    constructor(@Inject(AosrService) private svc: AosrService) {}

    @Get('documentation-packages/:id/aosr')
    async packageView(@Req() r: any, @Param('id') id: string) { return this.svc.packageView(await authenticate(r), V.uuid.parse(id)); }
    @Post('documentation-packages/:id/aosr')
    async create(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.svc.create(await authenticate(r), V.uuid.parse(id), V.aosrCreateDto.parse(b)); }
    @Post('documentation-packages/:id/aosr-suggestions/dismiss')
    async dismiss(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.svc.dismissSuggestion(await authenticate(r), V.uuid.parse(id), V.aosrSuggestionDismissDto.parse(b).suggestionCode); }
    @Post('documentation-packages/:id/aosr-parties')
    async party(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.svc.saveParty(await authenticate(r), V.uuid.parse(id), V.aosrPartyDto.parse(b)); }
    @Post('documentation-packages/:id/aosr-materials')
    async material(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.svc.createMaterial(await authenticate(r), V.uuid.parse(id), V.aosrMaterialDto.parse(b)); }
    @Post('documentation-packages/:id/aosr-materials/:materialId/quality-documents')
    async qualityDocument(@Req() r: any, @Param('id') id: string, @Param('materialId') materialId: string, @Body() b: any) { return this.svc.addQualityDocument(await authenticate(r), V.uuid.parse(id), V.uuid.parse(materialId), V.aosrQualityDocumentDto.parse(b)); }
    @Post('documentation-packages/:id/aosr-method')
    async method(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.svc.setMethod(await authenticate(r), V.uuid.parse(id), V.aosrMethodDto.parse(b)); }
    @Post('documentation-packages/:id/executive-schemes')
    async scheme(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.svc.createScheme(await authenticate(r), V.uuid.parse(id), V.aosrSchemeDto.parse(b)); }
    @Post('documentation-packages/:id/executive-schemes/:schemeId/file')
    async schemeFile(@Req() r: any, @Param('id') id: string, @Param('schemeId') schemeId: string, @Body() b: any) { return this.svc.attachSchemeFile(await authenticate(r), V.uuid.parse(id), V.uuid.parse(schemeId), V.aosrSchemeFileDto.parse(b)); }
    @Get('documentation-packages/:id/executive-schemes/:schemeId/file')
    async schemeFileDownload(@Req() r: any, @Res() res: any, @Param('id') id: string, @Param('schemeId') schemeId: string) {
        const f = await this.svc.downloadSchemeFile(await authenticate(r), V.uuid.parse(id), V.uuid.parse(schemeId));
        sendFile(res, f);
    }
    @Get('documentation-packages/:id/quantity')
    async quantity(@Req() r: any, @Param('id') id: string) { return this.svc.quantityView(await authenticate(r), V.uuid.parse(id)); }
    @Post('documentation-packages/:id/customer-accepted-quantity')
    async customerQuantity(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.svc.recordCustomerAcceptedQuantity(await authenticate(r), V.uuid.parse(id), V.customerAcceptedQuantityDto.parse(b)); }

    @Get('aosr/:id')
    async detail(@Req() r: any, @Param('id') id: string) { return this.svc.detail(await authenticate(r), V.uuid.parse(id)); }
    @Post('aosr/:id/edit')
    async edit(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.svc.edit(await authenticate(r), V.uuid.parse(id), V.aosrEditDto.parse(b)); }
    @Post('aosr/:id/delete')
    async remove(@Req() r: any, @Param('id') id: string) { return this.svc.remove(await authenticate(r), V.uuid.parse(id)); }
    @Post('aosr/:id/links')
    async links(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.svc.setLinks(await authenticate(r), V.uuid.parse(id), V.aosrLinksDto.parse(b)); }
    @Post('aosr/:id/generate')
    async generate(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.svc.generate(await authenticate(r), V.uuid.parse(id), V.aosrGenerateDto.parse(b).version); }
    @Get('aosr/:id/docx')
    async docx(@Req() r: any, @Res() res: any, @Param('id') id: string) {
        const f = await this.svc.download(await authenticate(r), V.uuid.parse(id));
        sendFile(res, f);
    }
}
