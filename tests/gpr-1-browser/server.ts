/**
 * GPR-1 browser gate — REAL backend (PGlite, mock auth, demo seed, the pending schedule migration) on :3001, with a prepared scenario
 * built through the real API and relative dates, so "today" in the browser is "today" for the plan:
 *
 *   Object «Тест после удаления ролей» (the seeded РП)
 *     Штукатурка стен, 800 м² — «1 этаж» 500 м² (RP fact 500, Internal СК 498: Выполнено)
 *                             — «2 этаж» 300 м² (RP fact 60 on day 8 of 14: Есть отставание, 5 дней)
 *                             — «3 этаж» 200 м² (starts in 3 days: Не начато)
 *     Окраска потолков, 100 м², the whole work (50% on day 2 of 12: В работе)
 *   Object «Соседний объект» (another РП) with its own approved schedule — for isolation.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where the scenario hands the spec the session of a work-handoff-only PTO engineer (see tests/gpr-1-browser/schedule.spec.ts). */
const HANDOFF_FILE = path.join(os.tmpdir(), 'gpr-1-browser-handoff.json');
process.env.RATE_LIMIT_MAX = '5000';
process.env.AUTH_RATE_LIMIT_MAX = '500';

const dayFromToday = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

(async () => {
  const { gprHarness, acceptInternalSc, reportFact } = await import('../helpers/gpr-fixtures');
  const { makeUser } = await import('../helpers/pbx3-fixtures');
  const h = await gprHarness('gpr-1-browser-key', { port: 3001 });

  const pm = await h.login('PROJECT_MANAGER');
  const dict = await h.req('dictionaries');
  const contractors = await h.req('contractors');
  const plaster = dict.workTypes.find((w: any) => /штукатур/i.test(w.name)) ?? dict.workTypes[0];
  const other = await makeUser('Другой РП', 'PROJECT_MANAGER');
  await h.login('DEPUTY_DIRECTOR');
  const mkObject = (code: string, name: string, projectManagerId: string, contractorIds: string[]) =>
    h.req('objects', { externalCode: code, name, address: 'г. Тест, ул. Графика, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId, startDate: dayFromToday(-60), plannedFinishDate: dayFromToday(120), contractValue: '1000000', contractorIds });
  const object = await mkObject('GPR1-BROWSER-1', 'Тест после удаления ролей', pm.id, [contractors[0].id, contractors[1].id]);
  const neighbour = await mkObject('GPR1-BROWSER-2', 'Соседний объект', other.id, [contractors[0].id]);

  await h.as(pm);
  const plasterWork = await h.req('works', { objectId: object.id, workTypeId: plaster.id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Штукатурка стен', unit: 'м²', plannedQuantity: 800, plannedStartDate: dayFromToday(-20), plannedFinishDate: dayFromToday(13), estimatedCost: '100000' });
  const unit = async (zone: string, qty: number, contractorId: string) => {
    const u = await h.req('execution-units', { objectWorkId: plasterWork.id, workTypeId: plaster.id, contractorId, unit: 'м²', plannedQuantity: qty, location: zone });
    const portion = await h.req(`execution-units/${u.id}/portions`, { label: 'Участок ' + zone, plannedQuantity: qty });
    return { unit: u, portion };
  };
  const f1 = await unit('1 этаж', 500, contractors[0].id), f2 = await unit('2 этаж', 300, contractors[1].id), f3 = await unit('3 этаж', 200, contractors[0].id);
  const ceiling = await h.req('works', { objectId: object.id, workTypeId: plaster.id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Окраска потолков', unit: 'м²', plannedQuantity: 100, plannedStartDate: dayFromToday(-2), plannedFinishDate: dayFromToday(10), estimatedCost: '20000' });
  await reportFact(h, pm, f1.portion.id, 500);
  await acceptInternalSc(h, f1.portion.id, 498);
  await reportFact(h, pm, f2.portion.id, 60);
  await h.as(pm);
  await h.req(`works/${ceiling.id}/progress`, { totalQuantity: 50, version: ceiling.version, comment: 'Факт РП' });

  const draft = (path: string, body: any) => h.req(`objects/${object.id}/schedule/${path}`, body);
  await draft('draft', {});
  const add = (workId: string, unitId: string | null, start: string, finish: string) => draft('draft/entries', { objectWorkId: workId, executionUnitId: unitId, plannedStart: start, plannedFinish: finish });
  await add(plasterWork.id, f1.unit.id, dayFromToday(-20), dayFromToday(-10));
  await add(plasterWork.id, f2.unit.id, dayFromToday(-8), dayFromToday(6));
  await add(plasterWork.id, f3.unit.id, dayFromToday(3), dayFromToday(13));
  await add(ceiling.id, null, dayFromToday(-2), dayFromToday(10));
  await h.login('DEPUTY_DIRECTOR');
  const version = (await h.req(`objects/${object.id}/schedule`)).draft.version;
  await h.req(`objects/${object.id}/schedule/draft/approve`, { version, comment: 'Базовый график' });

  // the neighbour object's own approved schedule
  await h.as(other);
  const nWork = await h.req('works', { objectId: neighbour.id, workTypeId: plaster.id, contractorId: contractors[0].id, responsibleUserId: other.id, name: 'Окраска фасада', unit: 'м²', plannedQuantity: 200, plannedStartDate: dayFromToday(-5), plannedFinishDate: dayFromToday(5), estimatedCost: '1000' });
  const nUnit = await h.req('execution-units', { objectWorkId: nWork.id, workTypeId: plaster.id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 200, location: 'Секция А' });
  await h.req(`objects/${neighbour.id}/schedule/draft`, {});
  await h.req(`objects/${neighbour.id}/schedule/draft/entries`, { objectWorkId: nWork.id, executionUnitId: nUnit.id, plannedStart: dayFromToday(-5), plannedFinish: dayFromToday(5) });
  await h.login('DEPUTY_DIRECTOR');
  await h.req(`objects/${neighbour.id}/schedule/draft/approve`, { version: (await h.req(`objects/${neighbour.id}/schedule`)).draft.version });

  // a PTO engineer who holds ONLY the handoff of «Окраска потолков»: object shell access, no membership of the object's PTO team. The browser
  // spec reads the session token from this file (the engineer is not a role the mock login can pick).
  const { ObjectTeamService } = await import('../../apps/backend/src/team-service');
  const { actorByRole, handoffWorkToPto, tokenFor } = await import('../helpers/pbx3-fixtures');
  const teams = new ObjectTeamService();
  const deputyActor = await actorByRole('DEPUTY_DIRECTOR');
  const ptoHead = await makeUser('Начальник ПТО (график)', 'PTO_HEAD'), engineer = await makeUser('Инженер ПТО (график)', 'PTO');
  await teams.assignObjectLead(deputyActor, object.id, { leadUserId: ptoHead.id });
  await teams.assignOrgMember(deputyActor, { memberUserId: engineer.id, managerUserId: ptoHead.id });
  await handoffWorkToPto(ceiling.id, engineer);
  fs.writeFileSync(HANDOFF_FILE, JSON.stringify({ token: await tokenFor(engineer), objectId: object.id, workId: ceiling.id }));
  console.log('GPR-1 browser scenario ready');
})().catch((e) => { console.error(e); process.exit(1); });
