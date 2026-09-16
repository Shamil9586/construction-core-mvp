import { Module } from '@nestjs/common';
import { MaterialsController } from './materials.controller';
import { CoreModule } from '../core.module';
@Module({ imports: [CoreModule], controllers: [MaterialsController] })
export class MaterialsModule {}
