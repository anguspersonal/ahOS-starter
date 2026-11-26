# Dockerfile for the ahkms MCP server's remote serving surface (issue #84).
# Deployed as a SECOND Railway service in the same project as the worker (see the hosting
# decision on issue #84). Mirrors the worker's setup: build context is the repo ROOT so the
# monorepo layout resolves; @ahkms/shared is built from source below (same pattern as the
# worker Dockerfile) because relate_entities consumes the ADR-021 relationship vocabulary.
#
#   Railway service config:
#     Root Directory:  (repo root)
#     Dockerfile Path: packages/mcp-server/Dockerfile
#     Start Command:   (none — uses CMD below)

# node:22 (not 20): the committed lockfile pins @supabase/supabase-js 2.110.x, whose
# realtime-js requires a native global WebSocket — present from Node 22, absent on Node 20
# (createClient() throws "Node.js 20 detected without native WebSocket support" at boot).
# Matches packages/worker/Dockerfile — both services are on the same Node major (issue #164).
FROM node:22-slim

WORKDIR /usr/src/app

# Build @ahkms/shared first (required dependency — ADR-021 relationship vocabulary).
# Mirrors the worker Dockerfile's pattern.
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
# lock resolves before installing. Otherwise core floats ahead (e.g. @supabase/supabase-js
# 2.117.3 vs the lock's 2.117.2), the image holds two copies, and tsc rejects the mismatched
# types where mcp-server passes its Supabase client into a core adapter.
COPY packages/mcp-server/package-lock.json /tmp/service-lock.json
COPY scripts/pin-core-to-service-lock.js /tmp/pin-core-to-service-lock.js
RUN node /tmp/pin-core-to-service-lock.js /tmp/service-lock.json package.json
RUN npm install --no-audit --no-fund && npm run build

WORKDIR /usr/src/app/packages/mcp-server

# Install dependencies first (better layer caching). A standalone package-lock.json is
# committed for this package (mirrors packages/worker) so the full transitive tree is pinned
# and the build is reproducible — no more latest-floating deps (issue #164). The co-located
# .npmrc carries legacy-peer-deps=true (mirrors the repo-root .npmrc, which is absent from
# this standalone build context): without it, openai@4's optional zod@^3 peer clashes with
# this package's zod@^4 (ERESOLVE). Keeping it in .npmrc means no per-command flags.
#
# `npm install` (not `npm ci`): the sed rewrite below edits package.json AFTER the lockfile
# is copied (workspace "*" -> file: for @ahkms/shared and @ahkms/core), which npm ci's strict lock<->manifest
# sync check would reject. npm install honours the committed lock for every registry dep and
# only reconciles the local @ahkms/shared and @ahkms/core links — same proven pattern as the worker Dockerfile.
COPY packages/mcp-server/package.json packages/mcp-server/package-lock.json packages/mcp-server/.npmrc ./
# Rewrite the workspace "*" to file: references so this standalone npm install can
# resolve @ahkms/shared and @ahkms/core from the image (same trick as the worker Dockerfile).
RUN sed -i 's|"@ahkms/shared": "\*"|"@ahkms/shared": "file:../shared"|' package.json
RUN sed -i 's|"@ahkms/core": "\*"|"@ahkms/core": "file:../core"|' package.json
RUN npm install --no-audit --no-fund

# Copy TypeScript config + source and compile to dist/.
COPY packages/mcp-server/tsconfig.json ./
COPY packages/mcp-server/src ./src
RUN npm run build || (echo "ERROR: TypeScript compilation failed" && exit 1)

# -- ALLOW-ARCH-DRIFT: copies migration files into the image as read-only data; no service, port, process or topology change.
# ahos_doctor's "migrations applied" outcome check (#2269) compares the migrations this
# build was made from with the versions the database reports as applied. The server
# never executes these files; it only reads their filenames.
COPY supabase/migrations /usr/src/app/supabase/migrations

# Fail fast if the HTTP entry point did not build.
RUN test -f dist/http.js || (echo "ERROR: dist/http.js not found after build" && exit 1)

# Drop dev dependencies (TypeScript, tsx, vitest, @types/*) from the runtime image.
# (legacy-peer-deps now comes from the .npmrc copied above — no per-command flag needed.)
RUN npm prune --production --no-audit --no-fund

# Verify that the pruned production container boots and initializes cleanly under Node ESM (#1723).
RUN CHECK_SMOKE=1 SUPABASE_URL=http://localhost:54321 SUPABASE_SERVICE_ROLE_KEY=test KMS_USER_ID=00000000-0000-0000-0000-000000000000 node dist/http.js

ENV NODE_ENV=production
# Railway injects PORT at runtime; 8080 is only the local-run default (see src/env.ts).
ENV PORT=8080
EXPOSE 8080

# Run the compiled HTTP server (not the stdio entry point).
CMD ["node", "dist/http.js"]
