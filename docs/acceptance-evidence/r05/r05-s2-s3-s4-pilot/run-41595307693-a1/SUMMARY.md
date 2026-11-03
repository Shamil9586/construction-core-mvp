# GPR-2 acceptance evidence — R05 / r05-s2-s3-s4-pilot

**Technical gate: `TECHNICAL_GATES_PASSED`** — this is not an acceptance verdict; independent review and the owner decision remain separate steps.

| Identity | Value |
|---|---|
| Repository | Shamil9586/construction-core-mvp |
| Candidate SHA | 4e1f533eb924c229726e7110be5787141522fd88 |
| Candidate tree | db8578cfe35e90fe275e6ab6492631cc36d369c2 |
| Stage baseline | e054234c360c04bf9553c60e5fd21b528b7d4d46 |
| Workflow SHA | 768543f51f8555fcf4d81a1da29eb7757e04d60b |
| Run | [41595307693 attempt 1](https://github.com/Shamil9586/construction-core-mvp/actions/runs/41595307693/attempts/1) |
| Dispatched by | Shamil9586 |
| Profile sha256 | e5b99300ca89241a068bcace4a05201cacfd71b46da1c730150a7cec70c95e01 |
| Sealed at (UTC) | 2026-11-03T07:21:18.845Z |

| Check | Class | Mandatory | Status | Tests (pass/fail/skip) | Notes |
|---|---|---|---|---|---|
| r05-real-backend-pilot | NATIVE_POSTGRESQL | yes | **PASS** | 1/0/0 of 1 |  |
| r05-native-pg | NATIVE_POSTGRESQL | yes | **PASS** | 3/0/0 of 3 |  |
| r02-r04-native-pg | NATIVE_POSTGRESQL | yes | **PASS** | 27/0/0 of 27 |  |
| r05-pglite-contract | PURE_PGLITE | yes | **PASS** | 24/0/0 of 24 |  |
| r05-ui-source | UNIT | yes | **PASS** | 10/0/0 of 10 |  |
| r03d-pglite-migration | PURE_PGLITE | yes | **PASS** | 16/0/0 of 16 |  |
| gpr1-browser-regression | BROWSER_CHROMIUM | yes | **PASS** | 22/0/0 of 22 |  |
| typecheck-build | TYPECHECK_BUILD | yes | **PASS** | — |  |
| postgres-cleanup | INFRASTRUCTURE | yes | **PASS** | — | verified postmaster pid 2992 was signalled directly (SIGINT) after its cwd, -D argument, binary and recorded start time matched /var/tmp/gpr2-accept-41595307693-1/data |

| Class | Tests passed | Tests failed | Tests skipped |
|---|---|---|---|
| NATIVE_POSTGRESQL | 31 | 0 | 0 |
| PURE_PGLITE | 40 | 0 | 0 |
| UNIT | 10 | 0 | 0 |
| BROWSER_CHROMIUM | 22 | 0 | 0 |
| TYPECHECK_BUILD | 0 | 0 | 0 |
| INFRASTRUCTURE | 0 | 0 | 0 |

Environment: Ubuntu 24.04.5 LTS (20261026.354.1), Node v22.22.0, PostgreSQL 16.15 (Ubuntu 16.15-1.pgdg24.04+2), Version 1.63.0, Google Chrome for Testing 153.0.8010.12.

Verify: `node .github/acceptance/lib/verify-evidence.mjs <unzipped dir> --profile .github/acceptance/profiles/<profile>.json` at the workflow SHA.
