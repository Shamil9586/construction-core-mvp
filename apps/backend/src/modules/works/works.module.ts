import { Module } from '@nestjs/common';
import { WorksController } from './works.controller';
import { CoreModule } from '../core.module';
@Module({ imports: [CoreModule], controllers: [WorksController] })
export class WorksModule {}
