import { Module } from '@nestjs/common';
import { SdoController } from './sdo.controller';
import { CoreModule } from '../core.module';
@Module({ imports: [CoreModule], controllers: [SdoController] })
export class SdoModule {}
