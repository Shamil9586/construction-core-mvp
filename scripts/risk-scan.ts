import { scanRisks } from '../apps/backend/src/risk-worker';
import { pool } from '../apps/backend/src/db';
scanRisks().then(() => pool.end()).catch(e => { console.error(e); process.exit(1); });
