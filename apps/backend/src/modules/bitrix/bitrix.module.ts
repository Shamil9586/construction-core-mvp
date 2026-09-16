import { Module } from '@nestjs/common';
import { BitrixController } from './bitrix.controller';
@Module({ controllers: [BitrixController] })
export class BitrixModule {}
