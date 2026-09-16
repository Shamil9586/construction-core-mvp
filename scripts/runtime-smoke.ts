import { createApp } from '../apps/backend/src/main';
import { pool, transaction } from '../apps/backend/src/db';
import { seed } from './seed';
import fs from 'node:fs';
(async () => { const { migrate } = await import('./migrate'); await migrate(); await migrate(); await seed(); const app = await createApp(); await app.listen(3001, '127.0.0.1'); const { createServer } = await import('vite'); const vite = await createServer({ configFile: 'apps/frontend/vite.config.ts' }); await vite.listen(); const origin = 'http://127.0.0.1:5173'; for (const route of ['/', '/objects', '/api/health', '/api/ready']) {
    const r = await fetch(origin + route);
    if (!r.ok)
        throw Error(`${route}: ${r.status}`);
    console.log('HTTP PASS', route, r.status);
} const login = await fetch(origin + '/api/auth/mock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'GENERAL_DIRECTOR', key: process.env.MOCK_LOGIN_KEY }) }); const auth: any = await login.json(); const r = await fetch(origin + '/api/dashboard/executive', { headers: { Authorization: 'Bearer ' + auth.token } }); const d: any = await r.json(); if (d.activeObjects !== 10)
    throw Error(JSON.stringify(d)); console.log('Frontend proxy -> NestJS -> PostgreSQL engine PASS; dashboard activeObjects=10'); await vite.close(); await app.close(); await pool.end(); })().catch(e => { console.error(e); process.exit(1); });
