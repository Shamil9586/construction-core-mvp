import { Module } from '@nestjs/common';
import { DocumentationController } from './documentation.controller';
import { CoreModule } from '../core.module';
@Module({ imports: [CoreModule], controllers: [DocumentationController] })
export class DocumentationModule {}
