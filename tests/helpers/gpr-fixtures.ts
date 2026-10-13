import fs from 'node:fs';
import { makeUser, tokenFor } from './pbx3-fixtures';

/**
 * GPR-1 shared fixtures: the pending-migration bridge, an HTTP harness over the REAL backend on PGlite, and the representative pilot scenario.
 * Real routes only — nothing here writes production facts with raw SQL except where a test says so explicitly.
 */
export const PENDING_SCHEDULE_SQL = 'infra/pending/gpr-1_production_schedule.sql';
export const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);

/**
 * The schedule schema is a PENDING migration (no production number is claimed on this branch), so the repository runner does not see it.
 * This applies it on top of the ordinary chain while it still sits in infra/pending/, and is a no-op once the coordinator has promoted it
 * to a numbered migration (the runner then applied it already) — the suites therefore pass unchanged on either side of the rename.
 */
export async function applyPendingScheduleMigration(): Promise<void> {
  if (!fs.existsSync(PENDING_SCHEDULE_SQL)) return;
  const { pool, transaction } = await import('../../apps/backend/src/db');
  if ((await pool.query("SELECT to_regclass('schedule_items') AS t")).rows[0].t) return;
  await transaction(async (c) => { await c.query(fs.readFileSync(PENDING_SCHEDULE_SQL, 'utf8')); });
}

export async function gprHarness(key: string) {
  delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = key;
  process.env.DB_MODE = 'pglite';
  process.env.PGLITE_DIR = 'memory://';
  process.env.RATE_LIMIT_MAX = '100000';
  process.env.AUTH_RATE_LIMIT_MAX = '100000';
  const { migrate } = await import('../../scripts/migrate');
  const { seed } = await import('../../scripts/seed');
  const { createApp } = await import('../../apps/backend/src/main');
  await migrate();
  await applyPendingScheduleMigration();
  await seed();
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  let token = '';
  async function raw(path: string, body?: any) {
    const r = await fetch(base + '/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: (await r.json().catch(() => null)) as any };
  }
  async function req(path: string, body?: any, expected = body === undefined ? 200 : 201) {
    const r = await raw(path, body);
    if (r.status !== expected) throw new Error(`${path}: expected ${expected}, got ${r.status}: ${JSON.stringify(r.data)}`);
    return r.data;
  }
  async function login(role: string) { const d = await req('auth/mock', { role, key }, 201); token = d.token; return d.user; }
  async function as(user: any) { token = await tokenFor(user); return user; }
  return { app, base, raw, req, login, as, close: () => app.close() };
}
export type Harness = Awaited<ReturnType<typeof gprHarness>>;

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString('base64');

/** Internal СК accepts a fully reported portion with its own confirmed quantity (RP fact stays untouched) — the real request/photo/accept flow. */
export async function acceptInternalSc(h: Harness, portionId: string, quantity: number | string) {
  await h.login('PROJECT_MANAGER');
  const snap = await h.req('snapshot');
  const portion = snap.portions.find((p: any) => p.id === portionId);
  const inspection = await h.req(`portions/${portionId}/inspection-request`, { inspectionType: 'INTERNAL_SC', version: portion.version });
  await h.login('CONSTRUCTION_CONTROL');
  const file = await h.req('attachments', { fileName: 'sc.jpg', mimeType: 'image/jpeg', base64: JPEG });
  await h.req(`inspections/${inspection.id}/photos`, { attachmentId: file.id });
  return h.req(`inspections/${inspection.id}/accept`, { version: inspection.version, comment: 'Принято СК', quantity });
}

/**
 * The representative pilot scenario, built through the real API.
 *   Object «Тест после удаления ролей» (РП = the seeded project manager).
 *   Work «Штукатурка стен» — 500 м² as a whole; two execution units = zones: «1 этаж» 500 м² and «2 этаж» 300 м²;
 *   one portion per unit covering it. No fact yet — the tests report RP fact (and Internal СК) as the scenario needs.
 *   A second object «Соседний объект» with its own work / unit — for cross-object isolation.
 */
export async function pilotScenario(h: Harness) {
  const pm = await h.login('PROJECT_MANAGER');
  const dict = await h.req('dictionaries');
  const contractors = await h.req('contractors');
  const plaster = dict.workTypes.find((w: any) => /штукатур/i.test(w.name)) ?? dict.workTypes[0];
  const other = await makeUser('Другой РП', 'PROJECT_MANAGER');
  await h.login('DEPUTY_DIRECTOR');
  const stamp = Date.now() + Math.random().toString(36).slice(2, 6);
  const mkObject = (name: string, projectManagerId: string, contractorIds: string[]) => h.req('objects', { externalCode: 'GPR1-' + stamp + '-' + name.length, name, address: 'г. Тест, ул. Графика, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId, startDate: '2026-01-01', plannedFinishDate: '2026-12-31', contractValue: '1000000', contractorIds });
  const object = await mkObject('Тест после удаления ролей', pm.id, [contractors[0].id, contractors[1].id]);
  const neighbour = await mkObject('Соседний объект', other.id, [contractors[0].id]);
  const mk = async (objectId: string, owner: any, name: string, unit: string, planned: number, zones: { zone: string; planned: number; contractorId: string; label?: string }[]) => {
    await h.as(owner);
    const work = await h.req('works', { objectId, workTypeId: plaster.id, contractorId: contractors[0].id, responsibleUserId: owner.id, name, unit, plannedQuantity: planned, plannedStartDate: '2026-03-01', plannedFinishDate: '2026-04-30', estimatedCost: '100000' });
    const units: any[] = [];
    for (const z of zones) {
      const u = await h.req('execution-units', { objectWorkId: work.id, workTypeId: plaster.id, contractorId: z.contractorId, unit, plannedQuantity: z.planned, location: z.zone });
      const portion = await h.req(`execution-units/${u.id}/portions`, { label: z.label ?? 'Участок ' + z.zone, plannedQuantity: z.planned });
      units.push({ unit: u, portion });
    }
    return { work, units };
  };
  const plasterWork = await mk(object.id, pm, 'Штукатурка стен', 'м²', 800, [
    { zone: '1 этаж', planned: 500, contractorId: contractors[0].id },
    { zone: '2 этаж', planned: 300, contractorId: contractors[1].id },
  ]);
  const neighbourWork = await mk(neighbour.id, other, 'Окраска фасада', 'м²', 200, [{ zone: 'Секция А', planned: 200, contractorId: contractors[0].id }]);
  return { pm, other, dict, contractors, plaster, object, neighbour, plasterWork, neighbourWork, floor1: plasterWork.units[0], floor2: plasterWork.units[1], neighbourUnit: neighbourWork.units[0] };
}
export type Pilot = Awaited<ReturnType<typeof pilotScenario>>;

/** RP reports the portion's fact as the project manager (a fresh read of the portion version each time). */
export async function reportFact(h: Harness, owner: any, portionId: string, quantity: number | string) {
  await h.as(owner);
  const snap = await h.req('snapshot');
  const portion = snap.portions.find((p: any) => p.id === portionId);
  return h.req(`portions/${portionId}/fact`, { quantity, version: portion.version, comment: 'Факт РП' });
}
