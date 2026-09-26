ARG APP_TARGET=web
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
FROM node:24-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=test BIND_HOST=0.0.0.0
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3001
# Migrations run on every API boot. The demo seed runs only for AUTH_MODE=mock:
# it is what populates the demo tenant/users that /auth/mock depends on, and it
# is idempotent (returns immediately if the demo tenant already exists), so
# running it on every mock boot is safe. scripts/seed.ts is deliberately
# fail-closed for AUTH_MODE=bitrix, so calling it unconditionally aborted API
# startup the moment this deployment switched to bitrix auth. Gating it here
# means it is never invoked in that mode; the guard inside scripts/seed.ts stays
# as defence in depth. Any unset/unknown AUTH_MODE also skips the seed, and
# main.ts then rejects it explicitly. A seed failure in mock mode still aborts
# startup, because the chain remains &&-linked.
CMD ["/bin/sh", "-c", "node --import tsx scripts/migrate.ts && if [ \"$AUTH_MODE\" = mock ]; then node --import tsx scripts/seed.ts; fi && node --import tsx apps/backend/src/main.ts"]
FROM caddy:2-alpine AS web
# Render's sandboxed runtime rejects exec of binaries carrying Linux file
# capabilities (cap_net_bind_service), which the official caddy image sets
# so it can bind ports <1024 as non-root. We never bind a privileged port
# here (PORT is always >=1024 on Render), so it's safe to strip them.
RUN apk add --no-cache libcap-utils && setcap -r /usr/bin/caddy && apk del libcap-utils
COPY --from=build /app/dist/frontend /srv
COPY infra/Caddyfile /etc/caddy/Caddyfile
CMD ["sh", "-c", "export APP_HOST=\"${APP_HOST:-:${PORT:-8080}}\"; exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile"]

# Select the existing api/web stage with a standard Docker build argument.
FROM ${APP_TARGET} AS runtime
