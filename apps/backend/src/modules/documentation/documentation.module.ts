import { Module } from '@nestjs/common';
import { DocumentationController } from './documentation.controller';
import { AosrController } from './aosr.controller';
import { CoreModule } from '../core.module';
import { PtoWorkAssignmentService } from '../../pto-work-assignment-service';
import { AosrService } from '../../aosr-service';
@Module({ imports: [CoreModule], controllers: [DocumentationController, AosrController], providers: [PtoWorkAssignmentService, AosrService] })
export class DocumentationModule {}
