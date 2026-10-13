# BITRIX-DISK-1 — file storage foundation (Bitrix24 Disk as a storage provider)

Status: IMPLEMENTED, mock-verified. **REQUIRES BITRIX24 TEST PORTAL VERIFICATION** before `FILE_STORAGE_PROVIDER=BITRIX_DISK` is enabled anywhere real
(the official Bitrix documentation was not reachable from the build sandbox; the assumptions that need a real portal are listed in §7).
No LIVE file is migrated; the default provider stays `LOCAL`.

## 1. Principle

Construction Core stays authoritative for **what** a file is (Object / Package / Document / version / type / creator / permissions / audit).
Bitrix24 Disk only decides **where the bytes live**. Disk possession of a file id authorizes nothing: every read and write is authorized by Core first,
and the bytes reach the browser only through a Core route. No public/external Disk link is ever created or stored. A future subcontractor user with
no Bitrix24 account is served by exactly the same path, because Core talks to Disk with the tenant's installed-application OAuth, never with a user token.

## 2. Model

```
documentation_documents (AOSR / EXECUTIVE_SCHEME)         Core identity, unchanged
  └─ documentation_document_versions                       Core immutable version, storage_provider = 'CORE_FILE' (unchanged)
       └─ storage_reference = attachments.id               Core FILE RECORD
            attachments: id (Core uuid), file_provider ('LOCAL' | 'BITRIX_DISK'), external_file_id, external_folder_id,
                         file_name, mime_type, size_bytes, checksum_sha256, uploaded_by, content (LOCAL only)
```

* `CORE_FILE` means "a file Core manages". The physical provider is infrastructure and lives on the file record (`attachments.file_provider`, a column that already
  existed with default `LOCAL`), so the immutable version table, its CHECK and its trigger are untouched.
* A Core version never takes a Bitrix id as its identity (`attachments.id` is a Core uuid; `external_file_id` is a pointer next to it).
* **Versions:** every upload is a new Core file record and a new Core version; every regenerated AOSR DOCX is a new Disk file named `<name> [<id8>].docx`.
  Bitrix's own file-versioning (`disk.file.uploadversion`) is deliberately not used, so Core's history never depends on it and no earlier DOCX is overwritten.
* **Integrity:** Core records `size_bytes` and `checksum_sha256` at upload. Every read from Disk is checked against them (size from metadata *before* the bytes are pulled,
  SHA-256 after); bytes that do not match (someone replaced the file in Disk) are refused, not served.
* **Compatibility:** records created before this change are `LOCAL` with no size/checksum. They stay readable whatever is configured and are never rewritten. A `BITRIX_DISK` record
  stays readable after the deployment is switched back to `LOCAL` (reads follow the record's own provider). An unknown provider value is refused (`STORAGE_PROVIDER_UNSUPPORTED`).

## 3. Code map (`apps/backend/src/file-storage/`)

| File | Role |
|---|---|
| `types.ts` | `StorageProvider` (put / get / stat / delete), `StorageError` codes, placement + log-context types |
| `config.ts` | env reader + startup assertion (fail closed) |
| `local-provider.ts` | the pre-existing store (bytes in `attachments.content`) |
| `bitrix-disk-client.ts` | typed wrapper over the documented Disk REST methods + failure classification; goes through `RealBitrixAdapter.installedCall` (same OAuth/refresh path as every Bitrix call) |
| `bitrix-disk-folders.ts` | deterministic folder tree + `storage_folder_mappings` |
| `bitrix-disk-provider.ts` | upload / verify / reconcile-by-name / guarded download / delete |
| `file-store.ts` | `FileStore` (domain-facing), `FileUnitOfWork` (compensation), bounded concurrency, test seam |
| `attachment-access.ts` | Core authorization for a file that backs a documentation version |
| `sql.ts` | `attachmentHasContentSql` — provider-neutral "non-empty, file-backed" predicate |
| `log.ts` | allow-listed structured logging |

The domain (`aosr-service.ts`) calls `getFileStore().put(...)` / `.read(...)` and never sees a Bitrix call.

## 4. Authorization and download

1. Core authenticates the session and authorizes the actor against the Core document/package (unchanged `readContext` / `writeContext` / `packageMutationAccess`).
2. The attachment id is taken from the authorized Core version row — never from the client, and a Bitrix file id is not accepted anywhere (it is not a valid Core uuid → 400, and no Bitrix call is made).
3. `FileStore.read` follows the record's provider: for Disk, `disk.file.get` → size check → server-side fetch of the tokenised `DOWNLOAD_URL` (https only, same host as `BITRIX_PORTAL`,
   ≤3 same-host redirects, 25 MB cap, 30 s) → checksum check → the existing `sendFile` response (`Content-Disposition` with ASCII `filename` + RFC 5987 `filename*`, `Content-Length`,
   `Cache-Control: private, no-store`). The tokenised URL is never logged and never leaves the backend.
4. **Hardening found on the way:** the snapshot exposes a version's `storageReference` (the attachment uuid) and `GET /attachments/:id` only checked `PTO_VIEW` + tenant, so any such role could fetch a
   documentation file by id, bypassing package/object access (both providers). `GET /attachments/:id` now additionally applies the document rule (documentation role + access to the package's Work/Object)
   when the attachment backs a documentation version. Ordinary files (inspection photos) are unaffected.

## 5. Upload integrity and compensation

* `FileStore.put` uploads and **verifies** (id present, stored size == bytes sent; a missing `SIZE` is re-read via `disk.file.get`) and only then inserts the Core `attachments` row. A DB row never points at a failed upload.
  The DB also enforces it: a non-`LOCAL` record must have an external id, `size_bytes > 0`, a 64-hex checksum and no inline bytes (`attachments_external_provider_complete`).
* The upload happens inside the business transaction (`FileStore.transaction`). If anything fails afterwards — a later statement, a constraint, COMMIT — the uploaded file is deleted again.
  If that delete itself fails the event `storage.orphan_possible` is logged at `error` with tenant, Core file id, Bitrix file/folder id and document context.
  Reconcile: every Disk file name ends in `[<first 8 hex of the Core attachment id>]`; a Disk file under `Construction Core/` whose id8 matches no `attachments.id` is an orphan.
* An *ambiguous* upload failure (timeout / 5xx / unknown code) is reconciled by the deterministic name before giving up: a file with that exact name and size is adopted, so a lost answer never produces a duplicate.
  Permanent refusals (`insufficient_scope`, `ACCESS_DENIED`, …) are not retried.
* A failed upload rolls back the whole business operation (no scheme shell, no version; for AOSR generation no official number is consumed).
* Zero-byte or type-mismatching files are refused before any storage call (existing validation) and again in `FileStore.put`.
* A scheme is documentary evidence only when its latest `CORE_FILE` version's record satisfies `attachmentHasContentSql`: non-empty `content` (LOCAL) or a verified external id with `size_bytes > 0`.
* Disk-writing transactions are limited to 4 in flight (`EXTERNAL_WRITE_CONCURRENCY`): such a transaction holds a connection and `installedCall` needs a second one.
* An identical file submitted twice is two Core versions and two Disk files by design (as before); nothing is overwritten.

## 6. Folder strategy

```
<storage root>                                        disk.storage.getforapp (default) or BITRIX_DISK_STORAGE_ID
  Construction Core                                   BITRIX_DISK_ROOT_FOLDER_NAME            scope ROOT
    <Object name> [<id8>]                                                                      scope OBJECT:<uuid>
      ПТО                                                                                      scope OBJECT:<uuid>/PTO
        Исполнительная документация                                                            scope OBJECT:<uuid>/PTO/ID
          АОСР                  <АОСР_1_… [id8]>.docx                                          scope …/ID/AOSR
          Исполнительные схемы  <scheme [id8]>.pdf                                             scope …/ID/EXECUTIVE_SCHEME
```

* Uploads address a folder by **Core scope → Disk folder id** (`storage_folder_mappings`), not by name. Renaming an Object never orphans files: the same folder is reused and its label is refreshed in place
  (`disk.folder.rename`, best effort). Two Objects with the same name are distinct folders (`[id8]` = first 8 hex of the Object uuid).
* Repeated uploads take the fast path (one DB lookup, no listing). Creation of a missing level is serialized per (tenant, scope) with an advisory lock and is find-before-create (exact name, then the `[id8]` token), so repeated or concurrent first uploads converge on one tree. A lost mapping is re-discovered from the tree, not duplicated.
* A mapped folder that a human deleted in Disk is detected on upload failure, its mapping dropped, and the folder recreated.
* Later document types (PTO other sections, SDO, …) add their own `category` segments below `…/PTO/ID` or a sibling of `PTO`; no existing path changes.

## 7. Deployment configuration checklist

**Bitrix24 side (manual, on the test portal first)**

1. Local application → *Access permissions (scope)*: add **Disk (`disk`)**. Existing scopes stay as they are (user for login; im/department/task only if those providers are enabled).
2. Re-run the application installation / re-authorize so the stored tokens carry the new scope (existing refresh tokens do not gain scopes by themselves). Until then Disk calls fail with `insufficient_scope` → `STORAGE_REJECTED` (nothing is lost, uploads simply refuse).
3. The user behind the stored installation token (`BITRIX_ADMIN_USER_ID`) needs add/edit/delete rights on the target storage. The default application storage (`disk.storage.getforapp`) is owned by the app; for a common-drive storage give that user Full access and set `BITRIX_DISK_STORAGE_ID`.
4. Decide who may *see* the `Construction Core` folder inside Bitrix. Core does not rely on Disk rights for authorization; prefer the app storage (not browsable by ordinary employees) or restrict the folder, so Disk is not a side door to the files.

**Server environment** (secrets are never in the repository; nothing new is secret)

| Variable | Required | Notes |
|---|---|---|
| `FILE_STORAGE_PROVIDER` | no | `LOCAL` (default) or `BITRIX_DISK`. Selects the provider for **new** files only. Any other value stops startup. |
| `BITRIX_DISK_STORAGE_ID` | no | positive integer; unset ⇒ the application's own storage |
| `BITRIX_DISK_ROOT_FOLDER_NAME` | no | default `Construction Core` |
| `AUTH_MODE=bitrix`, `BITRIX_PORTAL`, `BITRIX_CLIENT_ID`, `BITRIX_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `BITRIX_ADMIN_USER_ID` | already required | no new credential is introduced |

`BITRIX_DISK` is refused at startup unless `AUTH_MODE=bitrix` and `BITRIX_PORTAL` are set, and on the local PGlite mode (needs PostgreSQL).

**Database:** one additive, idempotent migration — `infra/pending/bitrix-disk-1-file-storage.sql` (see §9). `scripts/migrate.ts` applies it automatically at container start (before the API starts), which is required because the code reads the new columns even with `LOCAL`.

**Rollout:** deploy code + migration with `FILE_STORAGE_PROVIDER` unset → verify nothing changed (LOCAL) → on the test portal set `BITRIX_DISK` and run §8 → production. **Rollback:** unset the variable; Disk-backed records remain readable while Bitrix is reachable.

## 8. Test-portal verification checklist (assumptions the sandbox could not prove)

1. `disk.storage.getforapp` exists for the app and returns `ROOT_OBJECT_ID` (and `disk.storage.get` with an id).
2. `disk.folder.getchildren`: `filter: {NAME}` is honoured (Core still matches exactly client-side), page size 50 with `start`, `TYPE` is `folder` / `file`.
3. `disk.folder.addsubfolder` on an existing name: error code (Core treats any failure by re-finding the folder first).
4. `disk.folder.uploadfile`: `fileContent: [name, base64]` accepted for ≥5 MB (≈7 MB JSON body); answer contains `ID` and `SIZE`; behaviour/code on a name clash with `generateUniqueName: false`.
5. `disk.file.get`: `DOWNLOAD_URL` is **self-authorizing for the app token** (carries `auth=`), how long it stays valid, whether it redirects (Core follows ≤3 same-host redirects only).
6. `disk.folder.rename` and `disk.file.delete` exist with the used parameter names (`newName`; `id`) and that delete is permanent for a file the app created.
7. Error codes seen for a missing file/folder (Core recognises `ERROR_NOT_FOUND`, `NOT_FOUND`, HTTP 404), scope/rights (`insufficient_scope`, `ACCESS_DENIED`, `user_access_error`) and rate limits (`QUERY_LIMIT_EXCEEDED`). Unknown codes degrade safely to `STORAGE_REJECTED` plus a name reconcile.
8. Per-upload REST cost on the first upload of an Object is ~15 calls (tree creation) and 1 on repeats — check against the portal's REST rate limit.
9. Out-of-band edit in Disk ⇒ Core refuses to serve (`STORAGE_INTEGRITY`); a trashed file ⇒ `STORAGE_NOT_FOUND`.

## 9. Migration (FINAL NUMBER REQUIRED AT INTEGRATION)

No production migration number is claimed. The SQL is `infra/pending/bitrix-disk-1-file-storage.sql`; `scripts/migrate.ts` applies `infra/pending/*.sql` once each, **after** the numbered chain,
tracked by file name in `schema_pending_migrations` (see `infra/pending/README.md`). The numbered chain (`001`–`023`) and every test that checks it (no gaps, head version) are unchanged.
**The coordinator `git mv`s the file to the next free number** (`infra/0NN_bitrix_disk_1_file_storage.sql`) after all parallel migrations are placed; the SQL is idempotent, so a database that applied it from `pending/` simply re-confirms it. Intent:

* `attachments` + `size_bytes bigint`, `checksum_sha256 text`, `external_folder_id text`;
* `attachments_size_nonnegative` and `attachments_external_provider_complete` CHECKs (LOCAL rows pass trivially — nothing legacy can be rejected);
* new table `storage_folder_mappings(tenant_id, provider, scope_key, object_id, external_folder_id, folder_name, …)` with `UNIQUE(tenant_id, provider, scope_key)` and FK to `objects`.

No backfill, no existing row rewritten, `documentation_document_versions` untouched. Once a real number is assigned, `tests/role-cleanup-migration-postgres.test.ts` (native PostgreSQL only) needs its pinned head bumped from `23`, as with any new migration.

## 10. Observability

One JSON line per event (`component: "file-storage"`), fields from an allow-list only: `event`, `provider`, `operation`, `tenantId`, `fileId` (Core), `externalFileId` / `externalFolderId` (Bitrix),
`documentId`, `packageId`, `aosrId`, `versionNumber`, `sizeBytes`, `code` (storage code), `causeCode` (structured Bitrix code), `httpStatus`, `retryable`.
Events: `storage.put.ok|failed|integrity|adopted`, `storage.get.failed|integrity`, `storage.stat.failed`, `storage.compensated`, **`storage.orphan_possible`** (compensation failed, or an upload's outcome is unknown: `operation` = `compensate` / `verify-delete` / `put-outcome-unknown`), `storage.folder.mapped|renamed|rename_failed|mapping_dropped`.
Tokens, tokenised URLs, request/response bodies, Bitrix error descriptions and file bytes are never logged. HTTP errors carry a safe Russian message plus the existing `requestId`.

## 11. Out of scope for this slice

Photos / generic `POST /attachments` (stay LOCAL), other document types, migrating existing LOCAL files to Disk (a separate, non-destructive backfill task), a reconciliation job (the log + name convention make it possible),
retention/retirement of committed files (Core versions are immutable history; physical delete is used only to compensate an uncommitted upload), frontend changes (none needed — the browser never sees the provider).
