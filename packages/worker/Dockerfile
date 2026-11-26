# Railway service config (managed via .railway/railway.ts — migrated from packages/worker/railway.json, issue #207):
#     Root Directory:    (repo root — empty; the COPY packages/shared below needs it)
#     Config file:       .railway/railway.ts (replaces legacy packages/worker/railway.json)
#                        dashboard; without it Railway reads the shared root
#                        railway.json (no dockerfilePath) and defaults to a
#                        root-level `Dockerfile`, which doesn't exist → build fails
#                        with "couldn't locate a dockerfile at path Dockerfile".
#     Dockerfile Path:   pinned to packages/worker/Dockerfile via that config file.
#     Start Command:     pinned to `node ../core/dist/engine/main.js` via .railway/railway.ts
#                        deploy.startCommand. The final WORKDIR stays
#                        /usr/src/app/packages/worker, so the engine finds ./app.js and
#                        hosts the worker routes in the same process. The image contains
#                        no monorepo root package.json, so pinning startCommand in the
#                        config file overrides any workspace-style dashboard value.
#
# -- ALLOW-ARCH-DRIFT: Restoring worker process to host core engine per ADR-101 §2 / #1327
#
# node:22 (not 20): the worker's lockfile pins @supabase/supabase-js 2.89.0, whose
# realtime-js requires a native global WebSocket — present from Node 22, absent on
# Node 20. On node:20 the websocket-factory throws "Node.js 20 detected without
# native WebSocket support" inside createClient() at boot, so the deployment
# crash-loops and Railway reports "Deployment failed". Same rationale as
# packages/mcp-server/Dockerfile.
FROM node:22-slim

# Install poppler-utils (required for PDF processing)
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Copy and build shared package first (required dependency)
# Note: Build context should be from project root, not packages/worker
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src
WORKDIR /usr/src/app/packages/shared
RUN npm install && npm run build

WORKDIR /usr/src/app

# Copy and build core package (engine runner and canonical domain kernel; ADR-101)
# -- ALLOW-ARCH-DRIFT: copy exported action-manifest.json into builder stage; no topology change.
COPY packages/core/package.json packages/core/tsconfig.json packages/core/action-manifest.json ./packages/core/
COPY packages/core/src ./packages/core/src
WORKDIR /usr/src/app/packages/core
# -- ALLOW-ARCH-DRIFT: build-time dependency pinning only; no service, port, process or topology change.
# Pin core's registry deps to the worker lock's versions so the image holds one copy of each
# shared package (see scripts/pin-core-to-service-lock.js and the mcp-server Dockerfile).
COPY packages/worker/package-lock.json /tmp/service-lock.json
COPY scripts/pin-core-to-service-lock.js /tmp/pin-core-to-service-lock.js
RUN node /tmp/pin-core-to-service-lock.js /tmp/service-lock.json package.json
RUN npm install --no-audit --no-fund && npm run build

# Switch back to worker directory
WORKDIR /usr/src/app/packages/worker

# Copy worker package files
COPY packages/worker/package*.json ./

# Modify package.json to use file: references for local shared and core packages
RUN sed -i 's|"@ahkms/shared": "\*"|"@ahkms/shared": "file:../shared"|; s|"@ahkms/core": "\*"|"@ahkms/core": "file:../core"|' package.json

# Install worker dependencies (including dev dependencies for TypeScript compilation)
RUN npm install --no-audit --no-fund

# Copy TypeScript config and source files for compilation
COPY packages/worker/tsconfig.json ./
COPY packages/worker/src ./src

# Compile TypeScript to JavaScript
# Use --noEmitOnError to ensure build fails on TypeScript errors
RUN npm run build || (echo "ERROR: TypeScript compilation failed" && exit 1)

# Debug: List what was actually built
RUN echo "=== Checking build output ===" && \
    (ls -la dist/ 2>/dev/null || echo "dist/ does not exist") && \
    (find dist -type d 2>/dev/null | head -20 || echo "No dist directories found") && \
    (find dist -type f 2>/dev/null | head -20 || echo "No dist files found") && \
    echo "=== End build output check ==="

# Verify build output exists (check for dist directory first)
RUN test -d dist || (echo "ERROR: dist directory not found after build" && exit 1)
RUN test -d dist/workflows || (echo "ERROR: dist/workflows directory not found after build" && exit 1)
RUN test -d dist/workflows/steps || (echo "ERROR: dist/workflows/steps directory not found after build" && exit 1)

# Remove dev dependencies after build (keep only production dependencies)
RUN npm prune --production --no-audit --no-fund

# Copy remaining worker application files (dist/ is already built, so this won't overwrite it)
COPY packages/worker/ .

# Verify dist directory still exists after copy
RUN test -d dist/workflows/steps || (echo "ERROR: dist directory missing after copy" && exit 1)

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "../core/dist/engine/main.js"]


