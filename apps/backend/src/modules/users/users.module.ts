import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { AdminUsersController } from './admin-users.controller';
@Module({ controllers: [UsersController, AdminUsersController] })
export class UsersModule {}
