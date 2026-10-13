# ID-AUTO-2 — PTO registry + documentary readiness

A PTO engineer or head must not open every Work and every AOSR to learn what documentary work exists, what blocks it and who is responsible.
This slice adds the **Object «Реестр ИД»** (`Object → Исполнительная документация → Реестр ИД`) and one **server-authoritative definition of
documentary readiness**. It is a read/control surface: no register table, no mutation, no new quantity or storage model, no schema change.

## What it is not

Not another AOSR generator, not a Work replacement, not a file-storage change (it reads only stable document/file facts: a scheme "has a file",
a generated DOCX is current), not SDO / Customer SC / AOK, and not ID-AUTO-3 (no title pages, no printable/exported register). No bulk action of
any kind: "batch readiness" means *seeing* the readiness of many packages at once.

## Architecture

```
packages/domain/documentation-readiness.ts   pure rules: package + AOSR readiness, structured reasons, forward-gate message
packages/domain/documentation-registry.ts    pure shapes, filters, summary counts, last-update picker
apps/backend/src/documentation-evidence.ts   batched fact loading (schemes, method, AOSRs, AOSR↔scheme links); forwardGateViolation
apps/backend/src/documentation-registry-service.ts   the read model  GET /objects/:id/documentation-registry
apps/frontend  data/documentationRegistryApi · app/useDocumentationRegistry · view-models/documentationRegistry
               screens/DocumentationRegistry · app/routes/DocumentationRegistryRoute   /object/:objectId/documentation
```

* **One definition of readiness.** `forwardGateViolation` (guards «Предъявить заказчику» and the customer-accepted quantity) was rebuilt on the
  same pure resolver the registry uses; its messages and its first-failing-stage order are unchanged (the ID-AUTO-1 gate tests pass untouched).
  The registry therefore cannot say "ready" for a package the gate would refuse, or the reverse (`registry readiness IS the forward gate` test).
* **The frontend restates no rule.** It renders `readiness.ready` and the server's reasons; a test feeds it payloads whose readiness contradicts
  the surrounding data and requires the server's word to win, and another asserts these layers neither import the domain nor test the facts
  that decide readiness.
* **No N+1.** The read model issues a fixed number of queries (23 for one package or for five packages with ten AOSRs — pinned by a test).
* **Pure read.** No audit row and no domain write on viewing or filtering (pinned by a test).

## Readiness rules (unchanged ID-AUTO-1 rules, now structured)

| Method | Package is ready when |
|---|---|
| any | the package has an explicit scope; the AOSR method is declared (**never inferred from "no AOSR"**); ≥ 1 executive scheme **backed by a real file** (metadata-only is not evidence) |
| `CORE` | additionally ≥ 1 Core AOSR, **every** Core AOSR has a successfully generated **current** DOCX (a draft, or an act edited/relinked after generation, blocks), and every Core AOSR is covered by a file-backed linked scheme |
| `EXTERNAL` | zero Core AOSRs / DOCX / numbers are valid — only the evidence rules above apply; no placeholder AOSR is ever created |
| `METHOD_UNSET` | an explicit blocker (`METHOD_UNSET`), never treated as external |

`readiness = { ready, reasons[{ code, message, target, aosrId? }] }`. `target` names where the blocker is fixed
(`SCOPE | METHOD | AOSR_SECTION | AOSR{aosrId} | SCHEMES`); the registry links to the existing package screen at that section
(`/pto/package/:id?focus=scope|method|aosr|schemes[&aosr=<id>]`). Per-AOSR readiness uses the same helper; `generationIssues` additionally
exposes what still blocks (re)generating a draft (the existing AOSR content readiness).

One deliberate consistency point: *per-AOSR scheme coverage* ("a Core AOSR is covered by a linked file-backed scheme") is part of the shared
resolver, so the gate now enforces it too. Through the current services it cannot be violated for an act with a current DOCX (generation requires
it and any relink bumps the version), so for reachable states the gate's behaviour is unchanged; it only closes the anomalous-legacy-data gap
that would otherwise make the registry and the gate disagree.

## The registry

* **One Object.** Never a cross-object table. Rows = ACTIVE packages (`archived_at IS NULL`); archived packages are a separate opt-in list
  (`archived=true`), read-only, with who/when/why, and never enter readiness, workload, attention or counts.
* **Row identity** is business scope: Work · zone · **current quantity** (customer-accepted → Internal SC → RP, single figure, no history; the same
  `scopePortionInputs`/`buildPackageScope` code path as the snapshot) · responsible PTO · AOSR method · lifecycle status · AOSR count ·
  readiness with concise blockers · last meaningful documentary update (newest of status change / AOSR generated / method chosen / scheme
  uploaded / AOSR changed / document changed / customer quantity recorded / package changed).
* **AOSR register** (CORE): one row = one AOSR — number or «номер не присвоен», hidden work, zone, work start/finish, DOCX state
  (`NOT_GENERATED | CURRENT | OUTDATED`), scheme coverage, readiness, with project documentation / normative references / subsequent works behind
  «Подробнее».
* **Filters** (server-side, in the URL): responsible PTO, package status, ready/not ready, method (Core / external / not selected), search over
  Work / zone / AOSR title or number. Filters only narrow rows; counts (`summary`) always describe the whole authorized working set:
  active packages, ready, not ready, awaiting engineer action (= the existing PTO attention classifier `resolveDocumentationAttention`).
* **Navigation.** `/pto` object cell, the object page and W01 («Открыть в реестре ИД») lead to the registry; a row, a blocker or an act opens the
  existing package detail; the package detail links back. W01 keeps its package cards; `/pto` keeps its assignment queue.

## Authorization (the existing contour, nothing new)

`canAccessDocumentation(role)` (SDO / contractors refused) → `objectAccess` (PTO head: current lead of the object; PTO engineer: object member or
holder of an effective handoff on some work of it; project manager: own object; admin/management as today) → for an engineer who is **not** an
object member, only the works they are the **effective assignee** of (`worksScope: ASSIGNED_WORKS`) — the same predicates `workAccess` and the
snapshot apply, asserted equal to the snapshot's visibility in tests. No tenant-wide widening, no portal-wide engineer fallback. Read-only roles
(e.g. deputy director) see the same register without package links (the package route stays PTO/ADMIN).

## Database

No schema change; **no migration number is claimed** (production migration head stays 023 for this slice).

## Tests

`tests/id-auto-2-registry-domain.test.ts` (pure rules), `tests/id-auto-2-registry.test.ts` (real backend: pilot-shaped acceptance, CORE/EXTERNAL/
METHOD_UNSET matrix, gate parity, authorization, isolation, archive, quantity provenance, counts, pure-read, no-N+1),
`tests/id-auto-2-registry-viewmodel.test.ts` (data chain), and the browser gate `npm run test:id-auto-2-browser`
(`tests/id-auto-2-browser`, real backend: registry, AOSR register, blocker deep links, filters/URL, archive view, per-role scoping,
entry points, desktop/phone layout).
