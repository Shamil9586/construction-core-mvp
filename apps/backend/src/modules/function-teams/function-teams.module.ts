import { Module } from '@nestjs/common';
import { FunctionTeamsController } from './function-teams.controller';
import { ObjectTeamService } from '../../team-service';
@Module({ controllers: [FunctionTeamsController], providers: [ObjectTeamService] })
export class FunctionTeamsModule {}
