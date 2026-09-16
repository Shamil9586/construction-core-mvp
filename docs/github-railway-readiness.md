# Private GitHub package / Railway TEST

Source preparation only. Railway deployment, Docker image build and browser acceptance are NOT VERIFIED.

## Ready to commit

apps/, packages/, infra/, scripts/, tests/*.test.ts, tests/browser/, docs/, package.json, package-lock.json, tsconfig.json, playwright.config.ts, docker-compose*.yml, .gitignore, .dockerignore, .env.example, README.md.

Commit from the root of the extracted source package, not its enclosing directory. No Git repository existed at inspection; no historical commits to scan. A new local Git initialization is optional and was not performed. Create an EMPTY PRIVATE remote repository when GitHub access becomes available; do not paste credentials into git remote URLs. Before the first commit run `python scripts/repository-audit.py` and inspect `git diff --cached` after staging. The supplied source archive already omits excluded files.

## Excluded

.env and .env.* except .env.example; node_modules; dist; logs; tests/acceptance and generated result text; test-results and playwright-report; uploads; backups and dumps; local databases/runtime directories; archives; private key files; Python caches; workbook source and docs/excel-source-report.json. Existing working-directory artifacts are retained locally, excluded from the source package, not deleted.

No real .env was found at project root. Scanned candidate text for private key headers, GitHub/AWS tokens, JWTs, credential-bearing URLs; reviewed env references, Dockerfile, README and fixtures. No real secret detected. Tests contain intentional fake access/refresh strings, AES test keys and isolated mock login keys; these are not account credentials. Seed is synthetic; seed refuses production and AUTH_MODE=bitrix. Source Excel is not packaged. Run secret scanning again before future pushes; the provided heuristic is not exhaustive.

## Service configuration

Both Root Directories are `/` (repository root). Do not use apps/backend or apps/frontend: builds need package-lock, packages/, scripts/ and infra/.

| Setting | Backend | Frontend |
|---|---|---|
| Dockerfile | infra/Dockerfile | infra/Dockerfile |
| RAILWAY_DOCKERFILE_PATH | infra/Dockerfile | infra/Dockerfile |
| APP_TARGET (Docker build ARG) | api | web |
| Build | Existing Dockerfile npm ci + npm run build | Same multi-stage build |
| Start override | None; inherit Node CMD | None; inherit Caddy CMD |
| Port | Runtime PORT; set 8080 explicitly if desired | Runtime PORT; default 8080 |
| Bind | BIND_HOST=0.0.0.0 | Caddy :PORT when APP_HOST is unset |
| Healthcheck | /ready | / |
| Pre-deploy | npm run db:migrate | None |
| Initial replicas | 1 | 1 |

The api and web stages and Compose target selection remain intact. Final `FROM ${APP_TARGET}` uses a standard build argument, not a proprietary runtime. APP_TARGET must be declared separately for each Railway service before building; wrong value would select the wrong image. Confirm the selected stage in first build logs. No unsupported Railway Docker target setting is assumed.

Backend env:
- DATABASE_URL=${{Postgres.DATABASE_URL}} (replace Postgres with actual database service name).
- DB_MODE=postgres, NODE_ENV=test, AUTH_MODE=mock, BIND_HOST=0.0.0.0, PORT=8080.
- APP_ORIGIN=https://<frontend-generated-domain>, without trailing slash.
- MOCK_LOGIN_KEY: freshly generated test-only secret set in Railway variables.
- TOKEN_ENCRYPTION_KEY: independent 32 random bytes encoded as 64 hex characters, set in Railway variables.
- APP_TARGET=api; RAILWAY_DOCKERFILE_PATH=infra/Dockerfile.
- BITRIX_* unset; TRUST_PROXY_HOPS unset unless proxy topology has been verified. Do not expose a secret in a build ARG.

Frontend env:
- APP_TARGET=web; RAILWAY_DOCKERFILE_PATH=infra/Dockerfile; PORT=8080.
- BACKEND_UPSTREAM=https://<backend-generated-domain>, without a path or trailing slash.
- APP_HOST UNSET in Railway: ingress terminates TLS, Caddy serves HTTP on runtime PORT. Do not copy the Compose domain value here.
- BITRIX_FRAME_ORIGIN=https://invalid.example until an exact test portal is selected.
- No database URL, mock key, OAuth tokens or encryption secret in frontend variables.

Frontend remains a Vite static build served by existing Caddy. Browser calls same-origin /api; Caddy strips /api and forwards to BACKEND_UPSTREAM with the upstream Host header. It therefore needs no VITE_API_URL/build-time secret or new JS runtime config. SPA try_files fallback handles direct /objects/:id refresh. Browser connect-src remains 'self'; iframe frame-ancestors remains restricted. Backend CORS allows only APP_ORIGIN, with no wildcard credentials. HTTPS routing/CSP behavior must still be checked on actual Railway URLs.

## Migration / seed / tests

Pre-deploy command `npm run db:migrate` belongs ONLY to Backend. Do not invoke migrations from every API startup or frontend. Existing pg_advisory_xact_lock serializes concurrent migration jobs on the same DB; schema_migrations records each applied version in the same transaction. Seed is a separate ONE-TIME command after migration: `npm run db:seed`, in the backend environment. Do not add seed to every deploy. Repeat migration and seed on disposable test DB during acceptance.

PGlite local mode requires DB_MODE=pglite with DATABASE_URL unset. With DATABASE_URL present, pg is selected regardless of DB_MODE. For native HTTP tests use E2E_DATABASE_URL pointing to a NEW disposable database ending in _test, never the seeded application database. Unit crypto/adapter tests use their own memory databases.

Browser test: `E2E_BASE_URL=https://<frontend-domain> MOCK_LOGIN_KEY=<test-key> npm run test:browser`. BROWSER_BASE_URL is retained as a compatibility alias. No external URL means do not run browser acceptance yet.

## Deployment order

1. Create private GitHub repo from this source package. No credentials or build artifacts.
2. Create Railway project named construction-core-acceptance with TEST environment only; confirm any required paid action with owner before purchase/upgrade.
3. Add native PostgreSQL and persistent storage. Keep its credentials server-side.
4. Create Backend from repo root, configure Docker path/APP_TARGET/env and migration pre-deploy; obtain backend HTTPS domain; verify /health and /ready.
5. Execute demo seed once in backend environment.
6. Create Frontend from same root, configure Docker path/APP_TARGET/PORT/BACKEND_UPSTREAM; obtain frontend HTTPS domain.
7. Set Backend APP_ORIGIN to exact frontend HTTPS origin and redeploy backend if needed.
8. Run native PG tests on separate _test DB, HTTP/HTTPS smoke, then complete browser scenario and visual QA. Record actual build image/runtime evidence. Compose remains NOT VERIFIED unless docker compose is executed separately.

## Verified preparation / blockers

TypeScript + Vite build and 24 local tests passed after runtime configuration edits. Source scan passed; no Git history present. Docker/Caddy container runtime, Railway deployment, native PG and browser gates are not claimed. GitHub publishing tools are unavailable in this session; no remote repository or cloud resources were created. For publication need private GitHub repository access; for acceptance need actual Railway service variables and generated domains. Bitrix credentials are not required now.

Official references consulted for path/build ARG and pre-deploy behavior:
- https://docs.railway.com/builds/dockerfiles
- https://docs.railway.com/deployments/pre-deploy-command
- https://docs.railway.com/deployments/monorepo
