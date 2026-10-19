/**
 * GPR-2 R01 — extracts the NORMATIVE expectations of the decision-to-test matrix straight from the approved documents (finding R01-B06).
 *
 *   node --import tsx scripts/gpr2-extract-normative.ts <Technical_Design.md> <Implementation_Roadmap.md>           prints JSON
 *   node --import tsx scripts/gpr2-extract-normative.ts <Technical_Design.md> <Implementation_Roadmap.md> --write    rewrites tests/fixtures/gpr2-normative-expectations.json
 *
 * The documents are NOT in the repository (a separate decision is needed to add them), so the result is committed as a fixture together with the sha256 of
 * the two files it was read from; tests/gpr2-r01-normative-expectations.test.ts holds the decision index to that fixture. The extractor shares NO code
 * with the index or with the matrix generator — that is the point: a range such as `A04–A06` is expanded HERE, from the document text, to A04, A05, A06.
 *
 *   TD §2 row  |D04| … | §5–6; A04–A06 |      → acceptance  A04 A05 A06            (D / K rows: the stages are the Roadmap stages whose Acceptance line names any of them)
 *   TD §3 row  |C14| … | R10, R14, R18; A08–A10, A14 |  → stages R10 R14 R18, acceptance A08 A09 A10 A14   ("Каждый этап" = every stage R00–R22)
 *   Roadmap    ### R17. … **Acceptance:** A20/A26–A28/A21 …   → stage R17 names A20 A21 A26 A27 A28
 *
 * Reads two files and prints; touches no database, no network.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const pad = (n: number) => String(n).padStart(2, '0');

/** `A04–A06, A23` → ['A04','A05','A06','A23']; a range is inclusive and ascending; hyphen, en dash and em dash all mean "to". */
export function expandRefs(prefix: 'A' | 'R', text: string): string[] {
  const out = new Set<string>();
  const re = new RegExp(`${prefix}(\\d{2})(?:\\s*[–—-]\\s*(?:${prefix})?(\\d{2}))?`, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const from = Number(m[1]), to = m[2] === undefined ? from : Number(m[2]);
    if (to < from) throw new Error(`descending range in «${text}»`);
    for (let i = from; i <= to; i++) out.add(prefix + pad(i));
  }
  return [...out].sort();
}
const ALL_STAGES = Array.from({ length: 23 }, (_, i) => 'R' + pad(i));

export interface Extracted {
  tdSha256: string; roadmapSha256: string;
  stageAcceptance: Record<string, string[]>;
  decisions: Record<string, { tdRaw: string; acceptance: string[]; stages: string[]; stagesFrom: 'ROADMAP_ACCEPTANCE' | 'TD_ROW' | 'TD_ROW_EVERY_STAGE' }>;
}

export function extract(td: string, roadmap: string): Extracted {
  const stageAcceptance: Record<string, string[]> = {};
  let stage: string | null = null;
  for (const line of roadmap.split('\n')) {
    const heading = /^### (R\d{2})\./.exec(line);
    if (heading) { stage = heading[1]; continue; }
    if (/^## /.test(line)) stage = null;
    if (stage && /^\*\*Acceptance:\*\*/.test(line)) stageAcceptance[stage] = expandRefs('A', line);
  }
  const decisions: Extracted['decisions'] = {};
  const lines = td.split('\n');
  const cells = (line: string) => line.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
  let section = '';
  for (const line of lines) {
    if (/^## /.test(line)) section = line;
    const id = /^\|\s*([DKC]\d{2})\s*\|/.exec(line)?.[1];
    if (!id) continue;
    const row = cells(line);
    if (id.startsWith('C')) {
      if (!section.startsWith('## 3.')) continue;
      const tail = row[row.length - 1];                                  // «Реализация / критерий»: stages; acceptance
      const [stagesText, acceptanceText = ''] = tail.split(';').map(s => s.trim());
      const every = /Каждый этап/.test(stagesText);
      decisions[id] = { tdRaw: tail, acceptance: expandRefs('A', acceptanceText), stages: every ? ALL_STAGES : expandRefs('R', stagesText), stagesFrom: every ? 'TD_ROW_EVERY_STAGE' : 'TD_ROW' };
    } else {
      if (!section.startsWith('## 2.')) continue;
      const tail = row[row.length - 1];                                  // «Разделы / независимая приёмка»: §…; A…
      const acceptance = expandRefs('A', tail.slice(tail.indexOf(';') + 1));
      const stages = Object.keys(stageAcceptance).filter(r => stageAcceptance[r].some(a => acceptance.includes(a))).sort();
      decisions[id] = { tdRaw: tail, acceptance, stages, stagesFrom: 'ROADMAP_ACCEPTANCE' };
    }
  }
  return { tdSha256: sha256(td), roadmapSha256: sha256(roadmap), stageAcceptance, decisions };
}

if (require.main === module) {
  const [tdPath, roadmapPath] = process.argv.slice(2).filter(a => !a.startsWith('--'));
  if (!tdPath || !roadmapPath) { console.error('usage: gpr2-extract-normative.ts <Technical_Design.md> <Implementation_Roadmap.md> [--write]'); process.exit(2); }
  const result = extract(fs.readFileSync(tdPath, 'utf8'), fs.readFileSync(roadmapPath, 'utf8'));
  const text = JSON.stringify(result, null, 1) + '\n';
  if (process.argv.includes('--write')) fs.writeFileSync('tests/fixtures/gpr2-normative-expectations.json', text); else process.stdout.write(text);
}
