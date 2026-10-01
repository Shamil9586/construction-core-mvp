import { Module } from '@nestjs/common';
import { OrgStructureController } from './org-structure.controller';
import { OrgStructureService } from '../../org-structure-service';
@Module({ controllers: [OrgStructureController], providers: [OrgStructureService] })
export class OrgStructureModule {}
