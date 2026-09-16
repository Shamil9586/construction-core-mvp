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
CMD ["/bin/sh", "-c", "node --import tsx scripts/migrate.ts && node --import tsx apps/backend/src/main.ts"]
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
