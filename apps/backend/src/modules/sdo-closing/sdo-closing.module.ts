import { Module } from '@nestjs/common';
import { SdoClosingController } from './sdo-closing.controller';
import { CoreModule } from '../core.module';
@Module({ imports: [CoreModule], controllers: [SdoClosingController] })
export class SdoClosingModule {}
