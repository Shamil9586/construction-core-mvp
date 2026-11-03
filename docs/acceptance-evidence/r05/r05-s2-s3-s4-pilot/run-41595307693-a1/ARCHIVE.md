# Tier-2 acceptance evidence index — R05 / r05-s2-s3-s4-pilot / run 41595307693 attempt 1

- Run: https://github.com/Shamil9586/construction-core-mvp/actions/runs/41595307693/attempts/1 (`workflow_dispatch`, completed `success`).
- Workflow source: `768543f51f8555fcf4d81a1da29eb7757e04d60b` on `main`; profile `r05-s2-s3-s4-pilot`, SHA-256 `e5b99300ca89241a068bcace4a05201cacfd71b46da1c730150a7cec70c95e01`.
- Candidate: `4e1f533eb924c229726e7110be5787141522fd88`, tree `db8578cfe35e90fe275e6ab6492631cc36d369c2`; stage baseline `e054234c360c04bf9553c60e5fd21b528b7d4d46`.
- Sealed Actions artifact: `gpr2-acceptance-r05-r05-s2-s3-s4-pilot-4e1f533eb924-run41595307693-a1` (artifact id `13212057139`). The downloaded ZIP SHA-256 is `5a4a4beb240e2c44325b22ab0f42776e7b1a7a8e534c0b67dcd131a930c359`, matching GitHub artifact metadata readback. ZIP bytes may differ if repackaged; the sealed `manifest.json` and `SHA256SUMS` enumerate and bind the individual evidence files.
- Sealed technical gate: `TECHNICAL_GATES_PASSED`. This is a bounded technical gate, not independent project acceptance, product merge, deployment or LIVE verification.
- Local verification on 2026-11-03 used `verify-evidence.mjs` and the profile **from the workflow SHA** against the downloaded sealed ZIP extracted unchanged. Result: `EVIDENCE INTEGRITY: VERIFIED — technical gate TECHNICAL_GATES_PASSED`; all 88 listed checksums matched; eight mandatory checks and PostgreSQL cleanup reported PASS. The independent runtime review separately reports PASS for this bounded run.
- Tier-3 durable full-package release remains an owner decision. Proposed release tag: `acceptance-evidence/r05/r05-s2-s3-s4-pilot/run-41595307693-a1`, targeted at workflow SHA `768543f51f8555fcf4d81a1da29eb7757e04d60b`. This Tier-2 index contains text only; the full ZIP is not committed here.

Verification from the workflow source tree with the full sealed package extracted to `<sealed-dir>`:

```sh
node .github/acceptance/lib/verify-evidence.mjs <sealed-dir> --profile .github/acceptance/profiles/r05-s2-s3-s4-pilot.json --expect-run 41595307693
```

The four copied files in this directory are byte-identical to the sealed package. `SHA256SUMS` references the full sealed package, including `raw/` files retained in the Actions artifact, so its complete check requires the downloaded artifact.
