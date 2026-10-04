import assert from 'node:assert/strict';
import { handoffWorkToPto } from './pbx3-fixtures';

/**
 * ID-AUTO-1 test harness shared by the AOSR HTTP suites: ONE real backend on PGlite per test file, mock auth,
 * and a builder for object -> plastering Work -> Quantity Portion (RP 500.1234 / Internal SC 498.1234) -> Documentation Package.
 */
/** A minimal valid PDF, standing in for a scanned executive scheme. */
export const PDF_BASE64 = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
export const SCHEME_FILE = { fileName: 'scheme.pdf', mimeType: 'application/pdf', base64: PDF_BASE64 };
/** Uploads a FILE-BACKED executive scheme (the only kind that is documentary evidence). */
export async function uploadScheme(req: any, pkgId: string, title: string) {
  return req(`documentation-packages/${pkgId}/executive-schemes`, { title, ...SCHEME_FILE });
}
export const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=';
export const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);
export const RP = '500.1234', INTERNAL = '498.1234', CUSTOMER = '496.1234';

let shared: Promise<any> | null = null;
export function harness() {
  return (shared ??= (async () => {
    if (!process.env.E2E_DATABASE_URL) delete process.env.DATABASE_URL;
    process.env.AUTH_MODE = 'mock';
    process.env.MOCK_LOGIN_KEY = 'aosr-key';
    process.env.AUTH_RATE_LIMIT_MAX = '100000';
    process.env.RATE_LIMIT_MAX = '1000000';
    process.env.DB_MODE = process.env.E2E_DATABASE_URL ? 'postgres' : 'pglite';
    process.env.PGLITE_DIR = 'memory://';
    if (process.env.E2E_DATABASE_URL) process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
    const { migrate } = await import('../../scripts/migrate');
    const { seed } = await import('../../scripts/seed');
    const { createApp } = await import('../../apps/backend/src/main');
    await migrate();
    await seed();
    const app = await createApp();
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
    let token = '';
    async function raw(path: string, body?: any) {
      return fetch(base + '/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) });
    }
    async function req(path: string, body?: any, expected = body === undefined ? 200 : 201) {
      const r = await raw(path, body);
      const data: any = await r.json();
      if (path === 'objects' && body !== undefined && r.status === 201) await (await import('./pbx3-fixtures')).assignPtoToObject(data.id);
      assert.equal(r.status, expected, path + ': ' + JSON.stringify(data));
      return data;
    }
    async function login(role: string) { const d = await req('auth/mock', { role, key: 'aosr-key' }); token = d.token; return d.user; }
    return { app, req, raw, login, base };
  })());
}
export async function closeHarness() { if (shared) await (await shared).app.close(); }

let counter = 0;
/** Object + plastering Work + one Quantity Portion (RP 500.1234, Internal SC 498.1234) + a package covering it. Ends logged in as PTO. */
export async function setUp(opts: { method?: 'CORE' | 'EXTERNAL' | null } = {}) {
  const { req, login } = await harness();
  const pm = await login('PROJECT_MANAGER');
  const dict = await req('dictionaries');
  const contractors = await req('contractors');
  await login('DEPUTY_DIRECTOR');
  const o = await req('objects', { externalCode: 'AOSR-' + Date.now() + '-' + ++counter, name: 'Жилой дом №1', address: 'г. Москва, ул. Тестовая, 1', organizationName: 'ООО СЗ «Гор-Строй»', customerName: 'ООО «Заказчик»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
  await login('PROJECT_MANAGER');
  const plaster = dict.workTypes.find((w: any) => /штукатур/i.test(w.name)) ?? dict.workTypes[0];
  const work = await req('works', { objectId: o.id, workTypeId: plaster.id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Устройство штукатурки стен', unit: 'м²', plannedQuantity: 500, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '100000' });
  const unit = await req('execution-units', { objectWorkId: work.id, workTypeId: plaster.id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: RP, location: 'санузлы' });
  const portion = await req(`execution-units/${unit.id}/portions`, { label: 'Секция A', plannedQuantity: RP });
  await req(`portions/${portion.id}/fact`, { quantity: RP, version: portion.version });
  const internal = await req(`portions/${portion.id}/inspection-request`, { inspectionType: 'INTERNAL_SC', version: portion.version + 1 });
  await login('CONSTRUCTION_CONTROL');
  const attachment = await req('attachments', { fileName: 'sc.png', mimeType: 'image/png', base64: PNG_BASE64 });
  await req(`inspections/${internal.id}/photos`, { attachmentId: attachment.id });
  await req(`inspections/${internal.id}/accept`, { version: internal.version, comment: 'Принято СК', quantity: INTERNAL });
  const pto = await login('PTO');
  await handoffWorkToPto(work.id);
  const pkg = await req('documentation-packages', { objectWorkId: work.id, responsibleUserId: pto.id });
  await req(`documentation-packages/${pkg.id}/portions`, { quantityPortionId: portion.id });
  // The Core generator is optional: tests declare the method explicitly (default Core); `method: null` leaves it undeclared.
  const method = opts.method === undefined ? 'CORE' : opts.method;
  if (method) await req(`documentation-packages/${pkg.id}/aosr-method`, { method });
  return { object: o, work, unit, portion, pkg, pto };
}

export const PARTIES = [
  { partyRole: 'DEVELOPER', organizationName: 'ООО «Заказчик»', organizationDetails: 'ОГРН 1, ИНН 2' },
  { partyRole: 'CONSTRUCTION_ENTITY', organizationName: 'ООО СЗ «Гор-Строй»', organizationDetails: 'ОГРН 3, ИНН 4' },
  { partyRole: 'DESIGNER', organizationName: 'ООО «Проект»', organizationDetails: 'ОГРН 5, ИНН 6' },
  { partyRole: 'WORK_EXECUTOR', organizationName: 'ООО «Подрядчик»' },
  { partyRole: 'DEVELOPER_SC_REP', personName: 'Петров Пётр Петрович', position: 'Инженер СК', authorityDocument: 'Приказ № 1' },
  { partyRole: 'CONSTRUCTION_REP', personName: 'Сидоров Сидор Сидорович', position: 'Прораб', authorityDocument: 'Приказ № 2' },
  { partyRole: 'INTERNAL_SC', personName: 'Иванов Иван Иванович', position: 'Инженер СК', registryNumber: 'С-123', authorityDocument: 'Приказ № 3' },
];
export async function fillParties(req: any, pkgId: string) { for (const p of PARTIES) await req(`documentation-packages/${pkgId}/aosr-parties`, p); }

/** Fills one AOSR so it is ready (materials with a quality document, dates, texts). */
export async function fillAosr(req: any, ctx: any, aosrId: string, material: any, opts: { point1?: string; schemeId?: string } = {}) {
  let a = await req(`aosr/${aosrId}`);
  a = (await req(`aosr/${aosrId}/edit`, { workDescription: opts.point1 ?? 'Устройство штукатурки стен в помещении санузлов по типу №1', startDate: dt(-3), endDate: dt(-1), actDate: dt(0), projectDocumentation: 'Рабочая документация, шифр АР-1, лист 5', normativeReferences: 'СП 71.13330.2017', subsequentWork: 'Шпатлёвка стен', version: a.version }, 201));
  const linked = await req(`aosr/${aosrId}/links`, { materialRecordIds: [material.id], quantityPortionIds: [ctx.portion.id], ...(opts.schemeId ? { schemeDocumentIds: [opts.schemeId] } : {}), version: a.version });
  return linked;
}

