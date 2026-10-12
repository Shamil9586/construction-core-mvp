/**
 * READ-ONLY inspection of the Documentation Packages of one Work (PILOT-W01 verification clean-up).
 *
 *   DATABASE_URL=postgres://… npx tsx scripts/inspect-work-packages.ts --work-id <uuid> [--main <uuid>] [--external <uuid>] [--json]
 *   DATABASE_URL=postgres://… npx tsx scripts/inspect-work-packages.ts --object-code <code> --work-name "Штукатурка стен"
 *   DATABASE_URL=postgres://… npx tsx scripts/inspect-work-packages.ts --empty-documents      (every package of the tenant)
 *   … --assume-pre-023   evaluate as a database that has not been migrated to 023 yet (archive columns are auto-detected anyway)
 *
 * It opens ONE `BEGIN READ ONLY` transaction (the database itself refuses any write), never migrates, never seeds, and prints a
 * classification — it does not decide anything. Nothing is archived or deleted by this script. Clean-up is the supported, audited soft
 * archive (POST /documentation-packages/:id/archive, migration 023): the script only says which packages the archive rule WOULD accept
 * (the very same pure rule the backend enforces) and with which reason. It works on a database that has not been migrated to 023 yet
 * (archive columns absent): then no package is archived and the rule is evaluated from the facts alone.
 *
 * Classes:
 *   A MAIN             the package named by --main (default: the pilot's main package)
 *   B EXTERNAL_VERIFY  the package named by --external, or any package whose recorded AOSR method is EXTERNAL
 *   C UNSCOPED_DRAFT   DRAFT, no Quantity Portion, no method, no document, no AOSR, no acceptance, no SDO case (a click-through leftover)
 *   D UNEXPECTED       everything else — a person must look at it
 */
import { Client } from 'pg';
import { archiveViolation } from '../packages/domain/package-archive';

const MAIN_DEFAULT = 'bebcf645-40ae-4266-92d1-96f04c6f50f8';
const EXTERNAL_DEFAULT = 'bd482e68-5e79-43c8-98eb-df012a7d4e4e';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

type PackageClass = 'A_MAIN' | 'B_EXTERNAL_VERIFICATION' | 'C_UNSCOPED_DRAFT' | 'D_UNEXPECTED';

interface PackageFacts {
  id: string;
  status: string;
  version: number;
  createdAt: string;
  createdBy: string | null;
  responsible: string | null;
  portions: string[];
  aosrMethod: string | null;
  documents: number;
  documentVersions: number;
  aosrRecords: number;
  statusChanges: number;
  customerAcceptances: number;
  customerAcceptedQuantities: number;
  /** A status-history edge touching PRESENTED / ACCEPTED_BY_CUSTOMER: the package was shown to the customer at some point. */
  everPresented: boolean;
  /** Core AOSRs that were generated (an official number consumed and/or a document created). */
  generatedAosrs: number;
  sdoCase: string | null;
  archivedAt: string | null;
  archiveReason: string | null;
  archivedBy: string | null;
}

/** The backend's own archive rule, applied to what the database holds: null = the audited archive action would accept this package. */
export function archiveBlocker(f: PackageFacts): string | null {
  return archiveViolation({
    status: f.status,
    archivedAt: f.archivedAt,
    everPresented: f.everPresented,
    customerAcceptances: f.customerAcceptances,
    customerAcceptedQuantities: f.customerAcceptedQuantities,
    hasSdoCase: !!f.sdoCase,
    generatedAosrs: f.generatedAosrs,
  });
}

const SUGGESTED_REASON: Record<PackageClass, string | null> = {
  A_MAIN: null,
  B_EXTERNAL_VERIFICATION: 'Тестовый пакет EXTERNAL-маршрута',
  C_UNSCOPED_DRAFT: 'Старый тестовый пакет',
  D_UNEXPECTED: null,
};

/** What a person should do next with the package — a recommendation only; the script never changes anything. */
export function recommendation(f: PackageFacts, cls: PackageClass): { action: string; suggestedReason: string | null; blocker: string | null } {
  const blocker = archiveBlocker(f);
  if (cls === 'A_MAIN') return { action: 'KEEP_ACTIVE', suggestedReason: null, blocker };
  if (f.archivedAt) return { action: 'ALREADY_ARCHIVED', suggestedReason: null, blocker };
  if (blocker) return { action: 'KEEP_AS_HISTORY', suggestedReason: null, blocker };
  return cls === 'D_UNEXPECTED'
    ? { action: 'REVIEW_THEN_ARCHIVE', suggestedReason: null, blocker }
    : { action: 'ARCHIVE', suggestedReason: SUGGESTED_REASON[cls], blocker };
}

/** A package is "unused" when nothing downstream was ever built on it — the only kind a soft archive could safely retire. */
function isUnused(f: PackageFacts): boolean {
  return (
    ['DRAFT', 'PREPARING'].includes(f.status) &&
    f.documents === 0 && f.documentVersions === 0 && f.aosrRecords === 0 &&
    f.customerAcceptances === 0 && !f.sdoCase && f.aosrMethod === null
  );
}

export function classify(f: PackageFacts, mainId: string, externalId: string): PackageClass {
  if (f.id === mainId) return 'A_MAIN';
  if (f.id === externalId || f.aosrMethod === 'EXTERNAL') return 'B_EXTERNAL_VERIFICATION';
  if (f.status === 'DRAFT' && f.portions.length === 0 && isUnused(f)) return 'C_UNSCOPED_DRAFT';
  return 'D_UNEXPECTED';
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const mainId = arg('main') ?? MAIN_DEFAULT;
    const externalId = arg('external') ?? EXTERNAL_DEFAULT;

    let workIds: string[] = [];
    if (flag('empty-documents')) workIds = [];
    else if (arg('work-id')) workIds = [arg('work-id')!];
    else if (arg('object-code') && arg('work-name')) {
      workIds = (await client.query(
        'SELECT w.id FROM works w JOIN objects o ON o.tenant_id=w.tenant_id AND o.id=w.object_id WHERE o.external_code=$1 AND w.name=$2',
        [arg('object-code'), arg('work-name')],
      )).rows.map((r) => r.id);
    } else {
      workIds = (await client.query('SELECT object_work_id AS id FROM documentation_packages WHERE id=ANY($1::uuid[])', [[mainId, externalId]])).rows.map((r) => r.id);
    }
    workIds = [...new Set(workIds)];

    // Auto-detected; `--assume-pre-023` forces the legacy path (archive columns ignored) so it can be rehearsed on a migrated copy.
    const hasArchive = !flag('assume-pre-023') && (await client.query("SELECT 1 FROM information_schema.columns WHERE table_name='documentation_packages' AND column_name='archived_at'")).rows.length > 0;
    const report: Record<string, unknown> = { readOnly: true, archiveColumns: hasArchive, generatedAt: new Date().toISOString(), works: [] as unknown[] };

    for (const workId of workIds) {
      const work = (await client.query(
        'SELECT w.id,w.name,w.unit,o.name AS object_name,o.external_code FROM works w JOIN objects o ON o.tenant_id=w.tenant_id AND o.id=w.object_id WHERE w.id=$1',
        [workId],
      )).rows[0];
      const portions = (await client.query(
        `SELECT p.id,p.label,u.location,
                (SELECT l.documentation_package_id FROM documentation_package_portions l JOIN documentation_packages dp ON dp.tenant_id=l.tenant_id AND dp.id=l.documentation_package_id WHERE l.tenant_id=p.tenant_id AND l.quantity_portion_id=p.id ${hasArchive ? 'AND dp.archived_at IS NULL' : ''} LIMIT 1) AS held_by,
                (SELECT count(*)::int FROM documentation_package_portions l JOIN documentation_packages dp ON dp.tenant_id=l.tenant_id AND dp.id=l.documentation_package_id WHERE l.tenant_id=p.tenant_id AND l.quantity_portion_id=p.id ${hasArchive ? 'AND dp.archived_at IS NULL' : ''}) AS holders
           FROM quantity_portions p JOIN work_execution_units u ON u.tenant_id=p.tenant_id AND u.id=p.execution_unit_id
          WHERE u.object_work_id=$1 ORDER BY u.location, p.label`,
        [workId],
      )).rows;
      const packages = (await client.query('SELECT id FROM documentation_packages WHERE object_work_id=$1 ORDER BY created_at', [workId])).rows;

      const facts: PackageFacts[] = [];
      for (const { id } of packages) {
        const p = (await client.query(
          `SELECT p.id,p.status,p.version,p.created_at,cu.name AS created_by,ru.name AS responsible,
                  ${hasArchive ? 'p.archived_at,p.archive_reason,au.name AS archived_by' : 'NULL::timestamptz AS archived_at,NULL::text AS archive_reason,NULL::text AS archived_by'}
             FROM documentation_packages p
             LEFT JOIN users cu ON cu.tenant_id=p.tenant_id AND cu.id=p.created_by
             LEFT JOIN users ru ON ru.tenant_id=p.tenant_id AND ru.id=p.responsible_user_id
             ${hasArchive ? 'LEFT JOIN users au ON au.tenant_id=p.tenant_id AND au.id=p.archived_by' : ''}
            WHERE p.id=$1`, [id])).rows[0];
        const scalar = async (sql: string) => Number((await client.query(sql, [id])).rows[0].n);
        facts.push({
          id,
          status: p.status,
          version: p.version,
          createdAt: new Date(p.created_at).toISOString(),
          createdBy: p.created_by ?? null,
          responsible: p.responsible ?? null,
          portions: (await client.query(
            `SELECT COALESCE(NULLIF(trim(u.location),'')||' · ','')||qp.label AS zone FROM documentation_package_portions l
               JOIN quantity_portions qp ON qp.tenant_id=l.tenant_id AND qp.id=l.quantity_portion_id
               JOIN work_execution_units u ON u.tenant_id=qp.tenant_id AND u.id=qp.execution_unit_id
              WHERE l.documentation_package_id=$1 ORDER BY 1`, [id])).rows.map((r) => r.zone),
          aosrMethod: (await client.query('SELECT method FROM documentation_package_aosr_methods WHERE documentation_package_id=$1 ORDER BY chosen_at DESC LIMIT 1', [id])).rows[0]?.method ?? null,
          documents: await scalar('SELECT count(*) AS n FROM documentation_documents WHERE documentation_package_id=$1'),
          documentVersions: await scalar('SELECT count(*) AS n FROM documentation_document_versions v JOIN documentation_documents d ON d.tenant_id=v.tenant_id AND d.id=v.documentation_document_id WHERE d.documentation_package_id=$1'),
          aosrRecords: await scalar('SELECT count(*) AS n FROM aosr_documents WHERE documentation_package_id=$1'),
          statusChanges: await scalar('SELECT count(*) AS n FROM documentation_package_status_history WHERE documentation_package_id=$1'),
          customerAcceptances: await scalar('SELECT count(*) AS n FROM documentation_customer_acceptances WHERE documentation_package_id=$1'),
          customerAcceptedQuantities: await scalar('SELECT count(*) AS n FROM documentation_customer_accepted_quantities WHERE documentation_package_id=$1'),
          everPresented: (await scalar("SELECT count(*) AS n FROM documentation_package_status_history WHERE documentation_package_id=$1 AND (to_status IN ('PRESENTED','ACCEPTED_BY_CUSTOMER') OR from_status IN ('PRESENTED','ACCEPTED_BY_CUSTOMER'))")) > 0,
          generatedAosrs: await scalar('SELECT count(*) AS n FROM aosr_documents WHERE documentation_package_id=$1 AND (official_number IS NOT NULL OR documentation_document_id IS NOT NULL)'),
          archivedAt: p.archived_at ? new Date(p.archived_at).toISOString() : null,
          archiveReason: p.archive_reason ?? null,
          archivedBy: p.archived_by ?? null,
          sdoCase: (await client.query('SELECT status FROM sdo_closing_cases WHERE documentation_package_id=$1', [id])).rows[0]?.status ?? null,
        });
      }

      (report.works as unknown[]).push({
        work,
        portions,
        packages: facts.map((f) => {
          const cls = classify(f, mainId, externalId);
          return { ...f, class: cls, unused: isUnused(f), ...recommendation(f, cls) };
        }),
        overlappingPortions: portions.filter((p) => p.holders > 1).map((p) => ({ id: p.id, label: p.label, holders: p.holders })),
      });
    }

    // Documents that are only a shell: no title and no version at all (the shape of the pilot's bd32c863… document).
    report.emptyDocuments = (await client.query(
      `SELECT d.id,d.documentation_package_id,d.type,d.title,d.created_at,u.name AS created_by,
              (SELECT method FROM documentation_package_aosr_methods m WHERE m.documentation_package_id=d.documentation_package_id ORDER BY chosen_at DESC LIMIT 1) AS package_method
         FROM documentation_documents d LEFT JOIN users u ON u.tenant_id=d.tenant_id AND u.id=d.created_by
        WHERE d.title IS NULL
          AND NOT EXISTS (SELECT 1 FROM documentation_document_versions v WHERE v.tenant_id=d.tenant_id AND v.documentation_document_id=d.id)
          AND NOT EXISTS (SELECT 1 FROM aosr_documents a WHERE a.tenant_id=d.tenant_id AND a.documentation_document_id=d.id)
        ORDER BY d.created_at`,
    )).rows;

    await client.query('ROLLBACK');

    if (flag('json')) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    for (const w of report.works as any[]) {
      console.log(`\n== ${w.work?.external_code ?? ''} / ${w.work?.object_name ?? ''} / ${w.work?.name ?? w.work?.id}`);
      console.log(`   portions: ${w.portions.map((p: any) => `${p.location ? `${p.location} · ` : ''}${p.label} (held by ${p.holders})`).join('; ') || '—'}`);
      if (w.overlappingPortions.length) console.log(`   !! portions held by more than one package (historical overlap): ${JSON.stringify(w.overlappingPortions)}`);
      for (const p of w.packages) {
        console.log(`-- ${p.class}  ${p.id}  ${p.status} v${p.version}${p.archivedAt ? '  [ARCHIVED ' + p.archivedAt + ': ' + p.archiveReason + ']' : ''}  created ${p.createdAt} by ${p.createdBy ?? '—'}  responsible ${p.responsible ?? '—'}`);
        console.log(`     scope: ${p.portions.join(', ') || 'Участок не выбран'}  method: ${p.aosrMethod ?? 'METHOD_UNSET'}  docs ${p.documents}/versions ${p.documentVersions}/AOSR ${p.aosrRecords} (generated ${p.generatedAosrs})  status changes ${p.statusChanges}  acceptances ${p.customerAcceptances}  SDO ${p.sdoCase ?? '—'}`);
        console.log(`     => ${p.action}${p.suggestedReason ? '  reason: «' + p.suggestedReason + '»' : ''}${p.blocker && p.action !== 'ALREADY_ARCHIVED' && p.action !== 'KEEP_ACTIVE' ? '  (cannot archive: ' + p.blocker + ')' : ''}`);
      }
    }
    console.log(`\n== empty document shells (no title, no version, no AOSR record): ${(report.emptyDocuments as any[]).length}`);
    for (const d of report.emptyDocuments as any[]) console.log(`   ${d.id}  package ${d.documentation_package_id}  ${d.type}  ${d.created_at.toISOString?.() ?? d.created_at}  by ${d.created_by ?? '—'}  package method ${d.package_method ?? 'METHOD_UNSET'}`);
  } finally {
    await client.end();
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
