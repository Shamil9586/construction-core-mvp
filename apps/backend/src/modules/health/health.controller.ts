import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { pool } from '../../db';
@Controller()
@ApiTags('Health')
export class HealthController {
    @Get('health')
    health() { return { status: 'ok', authMode: process.env.AUTH_MODE ?? 'mock', databaseMode: process.env.DATABASE_URL ? 'postgres' : process.env.DB_MODE ?? 'postgres' }; }
    @Get('ready')
    async ready() { await pool.query('SELECT 1 FROM schema_migrations'); return { status: 'ready' }; }
}
