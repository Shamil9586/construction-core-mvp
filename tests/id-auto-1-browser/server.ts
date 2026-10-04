/**
 * ID-AUTO-1 browser gate — REAL backend (PGlite, mock auth, demo seed) on :3001 with a prepared scenario, plus a
 * tiny "portal" server on :3002 (host `localhost`, i.e. a DIFFERENT origin from the app on 127.0.0.1:5173) that
 *   GET /scenario                       -> ids + a PTO session token
 *   GET /portal?pkg=<id>[&sandbox=...]  -> an HTML page that embeds the app in an iframe, like the Bitrix24 portal does
 * Package A: Core method, one GENERATED AOSR, one file-backed scheme.   Package B: no method declared yet.
 */
process.env.AUTH_MODE = 'mock';
process.env.MOCK_LOGIN_KEY = 'id-auto-1-browser-key';
process.env.DB_MODE = 'pglite';
process.env.PGLITE_DIR = 'memory://';
delete process.env.DATABASE_URL;
process.env.RATE_LIMIT_MAX = '5000';
process.env.AUTH_RATE_LIMIT_MAX = '500';

const dt = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');

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
  const login = async (role: string) => { const d = await req('auth/mock', { role, key: 'id-auto-1-browser-key' }); token = d.token; return d.user; };

  const pm = await login('PROJECT_MANAGER');
  const dict = await req('dictionaries');
  const contractors = await req('contractors');
  await login('DEPUTY_DIRECTOR');
  const o = await req('objects', { externalCode: 'IDA1-BROWSER', name: 'Жилой дом №1', address: 'г. Москва, ул. Тестовая, 1', organizationName: 'ООО СЗ «Гор-Строй»', customerName: 'ООО «Заказчик»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
  await login('PROJECT_MANAGER');
  const plaster = dict.workTypes.find((w: any) => /штукатур/i.test(w.name)) ?? dict.workTypes[0];
  const mkWork = async (name: string) => {
    const work = await req('works', { objectId: o.id, workTypeId: plaster.id, contractorId: contractors[0].id, responsibleUserId: pm.id, name, unit: 'м²', plannedQuantity: 500, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '100000' });
    const unit = await req('execution-units', { objectWorkId: work.id, workTypeId: plaster.id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 500 });
    const portion = await req(`execution-units/${unit.id}/portions`, { label: 'Секция A', plannedQuantity: 500 });
    await req(`portions/${portion.id}/fact`, { quantity: 500, version: portion.version });
    return { work, portion };
  };
  const A = await mkWork('PILOT-W01 Штукатурка стен'), B = await mkWork('PILOT-W02 Штукатурка стен');
  const pto = await login('PTO');
  await fx.handoffWorkToPto(A.work.id);
  await fx.handoffWorkToPto(B.work.id);
  const pkgA = await req('documentation-packages', { objectWorkId: A.work.id, responsibleUserId: pto.id });
  const pkgB = await req('documentation-packages', { objectWorkId: B.work.id, responsibleUserId: pto.id });
  await req(`documentation-packages/${pkgA.id}/portions`, { quantityPortionId: A.portion.id });
  const base = `documentation-packages/${pkgA.id}`;
  await req(`${base}/aosr-method`, { method: 'CORE' });
  for (const p of [{ partyRole: 'DEVELOPER', organizationName: 'ООО «Заказчик»' }, { partyRole: 'CONSTRUCTION_ENTITY', organizationName: 'ООО СЗ «Гор-Строй»' }, { partyRole: 'DESIGNER', organizationName: 'ООО «Проект»' }, { partyRole: 'WORK_EXECUTOR', organizationName: 'ООО «Подрядчик»' }, { partyRole: 'DEVELOPER_SC_REP', personName: 'Петров Пётр Петрович', position: 'Инженер СК', authorityDocument: 'Приказ 1' }, { partyRole: 'CONSTRUCTION_REP', personName: 'Сидоров Сидор Сидорович', position: 'Прораб', authorityDocument: 'Приказ 2' }, { partyRole: 'INTERNAL_SC', personName: 'Иванов Иван Иванович', position: 'Инженер СК', authorityDocument: 'Приказ 3' }]) await req(`${base}/aosr-parties`, p);
  const material = await req(`${base}/aosr-materials`, { name: 'Штукатурная смесь', qualityDocuments: [{ docType: 'CERTIFICATE', number: 'RU-1' }] });
  const scheme = await req(`${base}/executive-schemes`, { title: 'PILOT-W01-ES-001', fileName: 'scheme.pdf', mimeType: 'application/pdf', base64: PDF });
  const a = await req(`${base}/aosr`, { title: 'Устройство штукатурки стен' });
  let d = await req(`aosr/${a.id}`);
  d = await req(`aosr/${a.id}/edit`, { workDescription: 'Устройство штукатурки стен', startDate: dt(-3), endDate: dt(-1), actDate: dt(0), projectDocumentation: 'АР-1', normativeReferences: 'СП 71.13330.2017', subsequentWork: 'Шпатлёвка', version: d.version });
  await req(`aosr/${a.id}/links`, { materialRecordIds: [material.id], schemeDocumentIds: [scheme.id], version: d.version });
  await req(`aosr/${a.id}/generate`, { version: (await req(`aosr/${a.id}`)).version });

  const scenario = JSON.stringify({ token, pkgA: pkgA.id, pkgB: pkgB.id, aosr: a.id, scheme: scheme.id });
  const http = await import('node:http');
  http.createServer((rq, rs) => {
    const u = new URL(rq.url ?? '/', 'http://x');
    if (u.pathname === '/scenario') { rs.setHeader('Content-Type', 'application/json'); return rs.end(scenario); }
    if (u.pathname === '/portal') {
      const sb = u.searchParams.get('sandbox'), pkg = u.searchParams.get('pkg');
      rs.setHeader('Content-Type', 'text/html');
      return rs.end(`<!doctype html><iframe id="app" style="width:1400px;height:950px"${sb ? ` sandbox="${sb}"` : ''} src="${u.searchParams.get('app') ?? 'http://127.0.0.1:5173'}/app.html/pto/package/${pkg}"></iframe>`);
    }
    rs.statusCode = 404; rs.end();
  }).listen(3002, 'localhost');
})().catch((e) => { console.error(e); process.exit(1); });
