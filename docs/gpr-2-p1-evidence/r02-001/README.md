# R02-001 corrective — evidence

Base: `7e1fb397bec6365a9a9d70ff22daf7ddcaf4eb1f`. Scope: `apps/backend/src/read-service.ts`, four frontend files (types, status, one form default), one new test file.

| File | What |
|---|---|
| `affected-suites.tsv` / `.total.txt` | the new test + every existing suite that reads the snapshot / read model / work status (37 files, exit code per file) on the isolated PostgreSQL cluster |
| `f12-suites.tsv` / `.total.txt` | every `f12*` suite (customer-SC grouping, SDO retry safety, F12.1) — 8 files |
| `unknown-fact.tap.txt` | TAP log of `tests/gpr2-r02-unknown-fact.test.ts` (11 tests) |

Red/green: tests #1–#9 of the new file all fail on the code at `7e1fb39` (read-service stashed) and pass on the corrective (#10, the frontend test, was added after that red run). `npx tsc --noEmit`, `npm run typecheck:strict` and `npm run build` exit 0. The full 124-file regression was deliberately not repeated.
