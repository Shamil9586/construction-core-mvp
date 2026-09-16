import fs from 'node:fs';
import { parseWorkbook } from '../apps/backend/src/importer';
(async () => { const report = await parseWorkbook(fs.readFileSync(process.argv[2]), 1000000); fs.writeFileSync('docs/excel-source-report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify({ validRows: report.rows.length, errors: report.errors.length, warnings: report.warnings.length, moneyMultiplier: report.moneyMultiplier })); })().catch(e => { console.error(e); process.exit(1); });
