import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { onAppInstallWebhook } from '../../bitrix';
// Server-to-server ONAPPINSTALL webhook (не browser-flow из auth-модуля) — fail-closed
// за BITRIX_INSTALL_WEBHOOK_ENABLED, см. bitrix.ts.
@Controller()
@ApiTags('Bitrix')
export class BitrixController {
    @Post('bitrix/onappinstall') onAppInstall(@Body() body: any) { return onAppInstallWebhook(body); }
}
