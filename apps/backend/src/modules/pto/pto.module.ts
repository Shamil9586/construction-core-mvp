import { Module } from '@nestjs/common';
import { PtoController } from './pto.controller';
import { CoreModule } from '../core.module';
@Module({ imports: [CoreModule], controllers: [PtoController] })
export class PtoModule {}
