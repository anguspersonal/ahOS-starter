# Dockerfile for the @ahkms/web Vite + React SPA.
# Build context is the repo ROOT (same convention as packages/mcp-server/Dockerfile).
# Two-stage build:
#   1. builder  -- Node 22 compiles @ahkms/shared and runs `vite build` to emit dist/.
#   2. runtime  -- nginx:alpine serves the static bundle.
#
#   Railway service config (if deployed):
#     Root Directory:  (repo root)
#     Dockerfile Path: packages/web/Dockerfile
#     Start Command:   (none -- uses CMD below)
#   Runtime env injected at startup via /env-config.js (Cache-Control: no-store):
#     VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_ACTION_API_URL
#   -- NO-ARCH-UPDATE: runtime env-config injection for action API URL; architecture.md belongs to #1454

# -- Stage 1: build ------------------------------------------------------------
# node:22 (not 20): matches packages/mcp-server/Dockerfile and packages/worker/Dockerfile
# for consistency across the monorepo (issue #164).
FROM node:22-slim AS builder

WORKDIR /usr/src/app

# Build @ahkms/shared first -- web depends on it via the workspace "*" reference.
# Mirrors the mcp-server Dockerfile pattern exactly.
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src
WORKDIR /usr/src/app/packages/shared
RUN npm install --no-audit --no-fund && npm run build

WORKDIR /usr/src/app

# Build @ahkms/core (canonical domain kernel).
# -- ALLOW-ARCH-DRIFT: copy exported action-manifest.json into builder stage; no topology change.
COPY packages/core/package.json packages/core/tsconfig.json packages/core/action-manifest.json ./packages/core/
COPY packages/core/src ./packages/core/src
WORKDIR /usr/src/app/packages/core
RUN sed -i 's|"@ahkms/shared": "\*"|"@ahkms/shared": "file:../shared"|' package.json
# -- ALLOW-ARCH-DRIFT: build-time dependency pinning only; no service, port, process or topology change.
# Core has no lockfile of its own, so pin its registry deps to the versions this service's
# lock resolves before installing. Otherwise core floats ahead (e.g. zod 4.6.7 vs the
# lock's 4.6.6), the image holds two copies, and tsc rejects the mismatched types.
COPY packages/web/package-lock.json /tmp/service-lock.json
COPY scripts/pin-core-to-service-lock.js /tmp/pin-core-to-service-lock.js
RUN node /tmp/pin-core-to-service-lock.js /tmp/service-lock.json package.json
RUN npm install --no-audit --no-fund && npm run build

WORKDIR /usr/src/app/packages/web

# Install dependencies first for better layer caching. A standalone package-lock.json is
# committed for this package (#164, #803) so dependencies are pinned and do not float.
# `npm install` (not `npm ci`) stays because the sed rewrite below mutates package.json
# after the copy -- same reason as the mcp-server Dockerfile.
COPY packages/web/package.json packages/web/package-lock.json ./
# Rewrite the workspace "*" to file: references so this standalone install can
# resolve @ahkms/shared and @ahkms/core from the image (same trick as mcp-server / worker Dockerfiles).
RUN sed -i 's|"@ahkms/shared": "\*"|"@ahkms/shared": "file:../shared"|' package.json
RUN sed -i 's|"@ahkms/core": "\*"|"@ahkms/core": "file:../core"|' package.json
RUN npm install --no-audit --no-fund

# Declare build arguments so Railway injects service variables into the build stage
ARG VITE_SUPABASE_URL
ARG SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG SUPABASE_ANON_KEY
ARG SUPABASE_PUBLISHABLE_KEY
ARG VITE_SUPABASE_PUBLISHABLE_KEY

ENV VITE_SUPABASE_URL=${VITE_SUPABASE_URL:-$SUPABASE_URL}
ENV SUPABASE_URL=${SUPABASE_URL:-$VITE_SUPABASE_URL}
ENV VITE_SUPABASE_ANON_KEY=${VITE_SUPABASE_ANON_KEY:-${SUPABASE_PUBLISHABLE_KEY:-${SUPABASE_ANON_KEY:-$VITE_SUPABASE_PUBLISHABLE_KEY}}}
ENV SUPABASE_PUBLISHABLE_KEY=${SUPABASE_PUBLISHABLE_KEY:-${VITE_SUPABASE_ANON_KEY:-$SUPABASE_ANON_KEY}}

# Copy source and build the static bundle.
COPY packages/web/tsconfig.json packages/web/vite.config.ts ./
COPY packages/web/postcss.config.js packages/web/tailwind.config.js ./
COPY packages/web/index.html ./
COPY packages/web/public ./public
COPY packages/web/src ./src
RUN npm run build || (echo "ERROR: Vite build failed" && exit 1)

# Fail fast if the expected output directory is empty.
RUN test -d dist && test -n "$(ls -A dist)" || (echo "ERROR: dist/ is empty after build" && exit 1)

# -- Stage 2: runtime ----------------------------------------------------------
FROM nginx:alpine AS runtime

# Remove the default nginx static content.
RUN rm -rf /usr/share/nginx/html/*

# Copy the compiled bundle from the builder stage.
COPY --from=builder /usr/src/app/packages/web/dist /usr/share/nginx/html

# Override nginx.conf to cap worker processes at 1.
# The default `worker_processes auto;` spawns one worker per host CPU core,
# which on cloud hosts (e.g. Railway) means ~48 processes for a static SPA.
# 1 worker is ample for serving pre-compressed static files.
RUN printf 'worker_processes  1;\n\
events { worker_connections 1024; }\n\
http {\n\
    include       /etc/nginx/mime.types;\n\
    default_type  application/octet-stream;\n\
    sendfile      on;\n\
    keepalive_timeout 65;\n\
    include /etc/nginx/conf.d/*.conf;\n\
}\n' > /etc/nginx/nginx.conf

# Configure default server block.
# Listens on 8080 by default; at startup CMD dynamically binds to ${PORT:-8080}
# so Railway or any other host injecting a dynamic PORT is honored,
# while preserving nginx variables ($uri) without envsubst mangling.
RUN printf 'server {\n\
    listen       8080;\n\
    server_name  _;\n\
    root         /usr/share/nginx/html;\n\
    index        index.html;\n\
\n\
    # Runtime configuration: never cache env-config.js so runtime values update immediately.\n\
    location = /env-config.js {\n\
        add_header Cache-Control "no-store";\n\
    }\n\
\n\
    # Cache hashed static assets long-term; never cache the entry HTML.\n\
    location ~* \\.(?:js|css|png|jpg|jpeg|gif|svg|ico|woff2?)$ {\n\
        expires 1y;\n\
        add_header Cache-Control "public, immutable";\n\
    }\n\
\n\
    # SPA fallback (all unmatched routes serve index.html for client-side routing).\n\
    location / {\n\
        try_files $uri $uri/ /index.html;\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf

# Railway injects PORT at runtime; 8080 is the local-run default.
ENV PORT=8080
EXPOSE 8080

CMD ["/bin/sh", "-c", "sed -i \"s/listen\\s\\+[0-9]\\+;/listen ${PORT:-8080};/g\" /etc/nginx/conf.d/default.conf && printf 'window.__ENV__ = { VITE_SUPABASE_URL: \"%s\", VITE_SUPABASE_ANON_KEY: \"%s\", VITE_ACTION_API_URL: \"%s\" };\\n' \"${VITE_SUPABASE_URL:-$SUPABASE_URL}\" \"${VITE_SUPABASE_ANON_KEY:-${SUPABASE_PUBLISHABLE_KEY:-${SUPABASE_ANON_KEY:-$VITE_SUPABASE_PUBLISHABLE_KEY}}}\" \"${VITE_ACTION_API_URL:-}\" > /usr/share/nginx/html/env-config.js && exec nginx -g 'daemon off;'"]