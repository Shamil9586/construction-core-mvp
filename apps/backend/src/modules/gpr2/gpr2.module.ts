import { Module } from '@nestjs/common';
import { Gpr2ContractController } from './gpr2.controller';
import { GPR2_ASSIGNMENTS, GPR2_HOOKS } from './gpr2.tokens';
import { DISABLED_HOOKS } from '../../gpr2-command-guard';
import { NO_CAPABILITY_ASSIGNMENTS } from '../../../../../packages/domain/gpr2';

// GPR-2 R01. Behaviour hooks default to "command not enabled" and the N01 capability source defaults to "nobody holds it"; the stages that
// implement a command (and the owner's N01 decision) replace the respective provider. Imported by AppModule only when GPR2_CONTRACT_ROUTES=enabled.
@Module({
    controllers: [Gpr2ContractController],
    providers: [{ provide: GPR2_HOOKS, useValue: DISABLED_HOOKS }, { provide: GPR2_ASSIGNMENTS, useValue: NO_CAPABILITY_ASSIGNMENTS }]
})
export class Gpr2ContractModule {}
