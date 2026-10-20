# R02-001-R1 + GPR1-UNKNOWN-01 corrective — evidence

Base: `f9dfc42dad879d2647f1bd83a261220346d29c1c`.

| File | What |
|---|---|
| `affected-suites.tsv` / `.total.txt` | the new test file + every suite that reads the snapshot / read model, every GPR-1 (`gpr-*`), GPR-2 R02 (`gpr2-r02*`), F8 and F12 suite, `view-models` — 56 files, an exit code each, on the isolated PostgreSQL cluster (`gpr2-p1-isolated`) |
| `unknown-gpr1.tap.txt` | TAP log of `tests/gpr2-r02-r1-unknown-gpr1.test.ts` (T01–T15) |

Red/green: with the product code of `f9dfc42` (tests kept) T01–T14 fail, T15 (the protected-semantics control) passes. `npx tsc --noEmit`, `npm run typecheck:strict`, `npm run build` exit 0. The 124-file regression was deliberately not repeated; R03a–d files are not in the diff.
