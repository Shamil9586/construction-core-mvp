/**
 * ID-AUTO-2 browser gate — REAL backend (PGlite, mock auth, demo seed) on :3001 with a PILOT-W01-shaped Object:
 *   Work 1 «PILOT-W01 Штукатурка стен», zone «1 этаж», RP 500 / Internal SC 498
 *     package A — CORE: one GENERATED AOSR (№ 1, file-backed scheme PILOT-W01-ES-001) + one unfinished draft «Грунтовка основания»
 *     package A-test — a disposable test package on another portion, soft-archived
 *   Work 2 «PILOT-W02 Окраска стен», zone «2 этаж»
 *     package B — EXTERNAL, file-backed scheme -> ready
 *   Work 3 «PILOT-W03 Шпатлёвка», zone «3 этаж»
 *     package C — AOSR method not declared yet
 * Plus an engineer who is NOT an object member and holds the handoff of Work 2 only, and a tiny "scenario" server on :3002.
 * Nothing here touches LIVE data.
 */
export {}; // a module, so its top-level names do not collide with the other browser servers' globals
process.env.AUTH_MODE = 'mock';
process.env.MOCK_LOGIN_KEY = 'id-auto-2-browser-key';
process.env.DB_MODE = 'pglite';
process.env.PGLITE_DIR = 'memory://';
delete process.env.DATABASE_URL;
process.env.RATE_LIMIT_MAX = '5000';
process.env.AUTH_RATE_LIMIT_MAX = '500';

const dt = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=';

(async () => {
  const { migrate } = await import('../../scripts/migrate');
  const { seed } = await import('../../scripts/seed');
  const { createApp } = await import('../../apps/backend/src/main');
  const fx = await import('../helpers/pbx3-fixtures');
  await migrate();
  await seed();
  const app = await createApp();
  await app.listen(3001, '127.0.0.1');

  let token = '';
  const req = async (path: string, body?: any) => {
    const r = await fetch('http://127.0.0.1:3001/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j: any = await r.json();
    if (!r.ok) throw Error(path + ' ' + JSON.stringify(j));
    if (path === 'objects' && body) await fx.assignPtoToObject(j.id);
    return j;
  };
  const login = async (role: string) => { const d = await req('auth/mock', { role, key: 'id-auto-2-browser-key' }); token = d.token; return d.user; };

  const pm = await login('PROJECT_MANAGER');
  const dict = await req('dictionaries');
  const contractors = await req('contractors');
  await login('DEPUTY_DIRECTOR');
  const o = await req('objects', { externalCode: 'IDA2-BROWSER', name: 'Тест после удаления ролей', address: 'г. Москва, ул. Тестовая, 1', organizationName: 'ООО СЗ «Гор-Строй»', customerName: 'ООО «Заказчик»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
  await login('PROJECT_MANAGER');
  const plaster = dict.workTypes.find((w: any) => /штукатур/i.test(w.name)) ?? dict.workTypes[0];
  const portionsOf = async (workName: string, labels: string[], internal: string | null) => {
    const work = await req('works', { objectId: o.id, workTypeId: plaster.id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: workName, unit: 'м²', plannedQuantity: 500, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '100000' });
    const unit = await req('execution-units', { objectWorkId: work.id, workTypeId: plaster.id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 1000 });
    const portions: any[] = [];
    for (const label of labels) portions.push(await req(`execution-units/${unit.id}/portions`, { label, plannedQuantity: 500 }));
    const first = portions[0];
    await req(`portions/${first.id}/fact`, { quantity: 500, version: first.version });
    if (internal) {
      const insp = await req(`portions/${first.id}/inspection-request`, { inspectionType: 'INTERNAL_SC', version: first.version + 1 });
      await login('CONSTRUCTION_CONTROL');
      const att = await req('attachments', { fileName: 'sc.png', mimeType: 'image/png', base64: PNG });
      await req(`inspections/${insp.id}/photos`, { attachmentId: att.id });
      await req(`inspections/${insp.id}/accept`, { version: insp.version, comment: 'Принято СК', quantity: internal });
      await login('PROJECT_MANAGER');
    }
    return { work, portions };
  };
  const W1 = await portionsOf('PILOT-W01 Штукатурка стен', ['1 этаж', 'Тестовый участок'], '498');
  const W2 = await portionsOf('PILOT-W02 Окраска стен', ['2 этаж'], '300');
  const W3 = await portionsOf('PILOT-W03 Шпатлёвка', ['3 этаж'], null);

  // an engineer on the head's team, NOT an object member, holding the handoff of Work 2 only
  const engineer = await fx.makeUser('Инженер Е. (только W02)', 'PTO');
  await login('DEPUTY_DIRECTOR');
  const head = await fx.actorByRole('PTO_HEAD');
  await req('function-teams/pto/org-members', { memberUserId: engineer.id, managerUserId: head.id });

  const pto = await login('PTO');
  await fx.handoffWorkToPto(W1.work.id);
  await fx.handoffWorkToPto(W3.work.id);
  await fx.handoffWorkToPto(W2.work.id, engineer);
  const pkgA = await req('documentation-packages', { objectWorkId: W1.work.id, quantityPortionIds: [W1.portions[0].id] });
  const pkgTest = await req('documentation-packages', { objectWorkId: W1.work.id, quantityPortionIds: [W1.portions[1].id] });
  const pkgC = await req('documentation-packages', { objectWorkId: W3.work.id, quantityPortionIds: [W3.portions[0].id] });
  const baseA = `documentation-packages/${pkgA.id}`;
  await req(`${baseA}/aosr-method`, { method: 'CORE' });
  for (const p of [{ partyRole: 'DEVELOPER', organizationName: 'ООО «Заказчик»' }, { partyRole: 'CONSTRUCTION_ENTITY', organizationName: 'ООО СЗ «Гор-Строй»' }, { partyRole: 'DESIGNER', organizationName: 'ООО «Проект»' }, { partyRole: 'WORK_EXECUTOR', organizationName: 'ООО «Подрядчик»' }, { partyRole: 'DEVELOPER_SC_REP', personName: 'Петров Пётр Петрович', position: 'Инженер СК', authorityDocument: 'Приказ 1' }, { partyRole: 'CONSTRUCTION_REP', personName: 'Сидоров Сидор Сидорович', position: 'Прораб', authorityDocument: 'Приказ 2' }, { partyRole: 'INTERNAL_SC', personName: 'Иванов Иван Иванович', position: 'Инженер СК', authorityDocument: 'Приказ 3' }]) await req(`${baseA}/aosr-parties`, p);
  const material = await req(`${baseA}/aosr-materials`, { name: 'Штукатурная смесь', qualityDocuments: [{ docType: 'CERTIFICATE', number: 'RU-1' }] });
  const scheme = await req(`${baseA}/executive-schemes`, { title: 'PILOT-W01-ES-001', fileName: 'scheme.pdf', mimeType: 'application/pdf', base64: PDF });
  const done = await req(`${baseA}/aosr`, { title: 'Устройство штукатурки стен' });
  let d = await req(`aosr/${done.id}`);
  d = await req(`aosr/${done.id}/edit`, { workDescription: 'Устройство штукатурки стен', startDate: dt(-3), endDate: dt(-1), actDate: dt(0), projectDocumentation: 'АР-1', normativeReferences: 'СП 71.13330.2017', subsequentWork: 'Шпатлёвка', version: d.version });
  await req(`aosr/${done.id}/links`, { materialRecordIds: [material.id], schemeDocumentIds: [scheme.id], quantityPortionIds: [W1.portions[0].id], version: d.version });
  await req(`aosr/${done.id}/generate`, { version: (await req(`aosr/${done.id}`)).version });
  const draft = await req(`${baseA}/aosr`, { title: 'Грунтовка основания' });
  // the disposable test package is archived with a reason
  await req(`documentation-packages/${pkgTest.id}/archive`, { reason: 'Тестовый пакет после проверки', version: pkgTest.version });

  // Work 2 package: EXTERNAL + a file-backed scheme (ready) — created by the engineer who holds that handoff
  token = await fx.tokenFor(engineer);
  const engineerToken = token;
  const pkgB = await req('documentation-packages', { objectWorkId: W2.work.id, quantityPortionIds: [W2.portions[0].id] });
  await req(`documentation-packages/${pkgB.id}/aosr-method`, { method: 'EXTERNAL' });
  await req(`documentation-packages/${pkgB.id}/executive-schemes`, { title: 'ES-W02', fileName: 'es.pdf', mimeType: 'application/pdf', base64: PDF });

  const tokens: Record<string, string> = { engineer: engineerToken };
  for (const [key, role] of [['pto', 'PTO'], ['head', 'PTO_HEAD'], ['deputy', 'DEPUTY_DIRECTOR']] as const) { await login(role); tokens[key] = token; }
  const scenario = JSON.stringify({ tokens, objectId: o.id, objectName: 'Тест после удаления ролей', pkgA: pkgA.id, pkgB: pkgB.id, pkgC: pkgC.id, pkgTest: pkgTest.id, workA: W1.work.id, aosrDone: done.id, aosrDraft: draft.id, ptoName: pto.name });
  const http = await import('node:http');
  http.createServer((rq, rs) => {
    const u = new URL(rq.url ?? '/', 'http://x');
    if (u.pathname === '/scenario') { rs.setHeader('Content-Type', 'application/json'); return rs.end(scenario); }
    rs.statusCode = 404; rs.end();
  }).listen(3002, 'localhost');
})().catch((e) => { console.error(e); process.exit(1); });
