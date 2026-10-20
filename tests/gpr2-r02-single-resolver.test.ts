import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * GPR-2 R02 / C15 — "один resolver": the readers and the guards of the backend obtain the latest RP_FACT / INTERNAL_SC / CUSTOMER_SC figure and the
 * Work's actual quantity ONLY from apps/backend/src/fact-resolver.ts (which delegates every decision to packages/domain/gpr2/fact-resolver.ts).
 * A second, private "latest" query is exactly how the readers drifted apart before (array order here, `recorded_at DESC` there, MAX() somewhere
 * else). This is a source-level guard so one cannot be added again without this test saying so.
 */
const ROOT = 'apps/backend/src';
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
const files = walk(ROOT).filter(f => !f.endsWith('fact-resolver.ts'));
const text = (f: string) => fs.readFileSync(f, 'utf8');

test('C15 no backend file other than the resolver decides "latest" over portion_quantity_confirmations', () => {
  const offenders: string[] = [];
  for (const f of files) {
    const src = text(f);
    // a "latest" decision is a DISTINCT ON / MAX(recorded_at) / ORDER BY recorded_at DESC in a statement that reads the confirmations
    for (const m of src.matchAll(/(["'`])((?:(?!\1)[\s\S])*?portion_quantity_confirmations(?:(?!\1)[\s\S])*?)\1/g)) {
      const sql = m[2];
      if (/DISTINCT\s+ON\s*\(\s*portion_id|MAX\s*\(\s*recorded_at|ORDER\s+BY[^"'`]*recorded_at\s+DESC/i.test(sql))
        offenders.push(f + ': ' + sql.slice(0, 90).replace(/\s+/g, ' '));
    }
  }
  assert.deepEqual(offenders, [], 'route these through apps/backend/src/fact-resolver.ts (loadPortionFigures / loadWorkFacts)');
});

test('C13/C15 no backend file reads the Work\'s actual quantity with the retired "units exist → portions" rule', () => {
  const users = files.filter(f => /resolveActualQuantity\s*\(/.test(text(f).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')));
  assert.deepEqual(users, [], 'resolveActualQuantity() is kept in packages/domain only for its own unit tests; production reads go through loadWorkFacts()');
});

test('the retired rule is still exported unchanged, so the old behaviour stays documented and testable', async () => {
  const { resolveActualQuantity } = await import('../packages/domain');
  assert.equal(resolveActualQuantity('300', 'м2', [{ unit: 'м2', actualQuantity: '0' }]), '0.0000', 'this is the 300 -> 0 defect; nothing in production calls it any more');
});

test('the loader selects the latest group inside PostgreSQL on the native timestamp (never in JS on a millisecond Date)', () => {
  const src = text(path.join(ROOT, 'fact-resolver.ts'));
  assert.match(src, /MAX\(recorded_at\) AS max_at/);
  assert.match(src, /YYYY-MM-DD"T"HH24:MI:SS\.US"Z"/, 'instants leave PostgreSQL as microsecond text');
  assert.doesNotMatch(src, /new Date\(/, 'no Date arithmetic in the loader');
});
