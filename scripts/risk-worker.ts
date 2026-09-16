import { scanRisks } from '../apps/backend/src/risk-worker';
async function tick() { try {
    await scanRisks();
}
catch (e: any) {
    console.error(JSON.stringify({ level: 'error', event: 'risk_scan_failed', code: e.code }));
} setTimeout(tick, 60000); }
tick();
