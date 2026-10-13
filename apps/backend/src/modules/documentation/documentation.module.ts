import { Module } from '@nestjs/common';
import { DocumentationController } from './documentation.controller';
import { AosrController } from './aosr.controller';
import { DocumentationRegistryController } from './documentation-registry.controller';
import { CoreModule } from '../core.module';
import { PtoWorkAssignmentService } from '../../pto-work-assignment-service';
import { AosrService } from '../../aosr-service';
import { DocumentationRegistryService } from '../../documentation-registry-service';
@Module({ imports: [CoreModule], controllers: [DocumentationController, AosrController, DocumentationRegistryController], providers: [PtoWorkAssignmentService, AosrService, DocumentationRegistryService] })
export class DocumentationModule {}
