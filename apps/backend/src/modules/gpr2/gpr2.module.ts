import { Module } from '@nestjs/common';
import { Gpr2ContractController } from './gpr2.controller';
import { GPR2_ASSIGNMENTS, GPR2_HOOKS } from './gpr2.tokens';
import { R05_HOOKS } from '../../gpr2-r05-hooks';
import { NO_CAPABILITY_ASSIGNMENTS } from '../../../../../packages/domain/gpr2';

// GPR-2 R01. The N01 capability source defaults to "nobody holds it". Behaviour hooks: R05 implements its own rows (gpr2-r05-hooks.ts); every other
// command still answers "command not enabled" exactly as with R01's DISABLED_HOOKS. Imported by AppModule only when GPR2_CONTRACT_ROUTES=enabled.
@Module({
    controllers: [Gpr2ContractController],
    providers: [{ provide: GPR2_HOOKS, useValue: R05_HOOKS }, { provide: GPR2_ASSIGNMENTS, useValue: NO_CAPABILITY_ASSIGNMENTS }]
})
export class Gpr2ContractModule {}
