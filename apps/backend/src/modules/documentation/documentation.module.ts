import { Module } from '@nestjs/common';
import { DocumentationController } from './documentation.controller';
import { CoreModule } from '../core.module';
import { PtoWorkAssignmentService } from '../../pto-work-assignment-service';
@Module({ imports: [CoreModule], controllers: [DocumentationController], providers: [PtoWorkAssignmentService] })
export class DocumentationModule {}
