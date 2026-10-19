/**
 * GPR-2 R01 — prints (or writes) the decision-to-test matrix.
 *
 *   node --import tsx scripts/gpr2-r01-matrix.ts                      static matrix to stdout (what docs/gpr-2-r01-decision-test-matrix.md contains)
 *   node --import tsx scripts/gpr2-r01-matrix.ts --write              rewrite docs/gpr-2-r01-decision-test-matrix.md
 *   node --import tsx scripts/gpr2-r01-matrix.ts --tap run.tap        the same matrix with ✔ / ✘ / ? per referenced test, from a `node --test` report
 *
 * Reads files only; touches no database and no network.
 */
import fs from 'node:fs';
import { renderMatrix } from '../tests/helpers/gpr2-matrix';

const args = process.argv.slice(2);
const tapIndex = args.indexOf('--tap');
const text = renderMatrix(tapIndex >= 0 ? fs.readFileSync(args[tapIndex + 1], 'utf8') : undefined);
if (args.includes('--write')) fs.writeFileSync('docs/gpr-2-r01-decision-test-matrix.md', text);
else process.stdout.write(text);
