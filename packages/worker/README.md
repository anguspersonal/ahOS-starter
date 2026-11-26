# Worker Package

Background workflow processor for the Knowledge Management System. Processes PDFs, executes AI analysis, and manages workflow steps.

## Recommended Docker flow (build once, two terminals)

Use this when developing against the worker: build the worker image once, run the worker in one terminal and your client in another. When you change worker code, stop the container, rebuild, and start again.

### 1. Build once (from repo root)

```powershell
# From project root (NOT from packages/worker/)
docker build --no-cache -f packages/worker/Dockerfile -t worker .
```

Use `--no-cache` so code changes are included. You only need to rebuild when you change worker (or shared) code.

### 2. Run in two terminals

**Terminal 1 – Worker** (must publish port so the host can reach it):

```powershell
# From project root. -p 3001:3001 is required (without it host clients get connection refused)
docker run --rm -p 3001:3001 --env-file packages/worker/.env --name worker-dev worker
```

Leave this running. You should see `Server running at http://localhost:3001/`.

**Terminal 2:** call the worker at `http://localhost:3001` (curl, the mobile app, or a script). There is no web app to run against it — `packages/web` was retired (ADR096).

### 3. Stop and update when worker code changes

When you change code in `packages/worker/` (or `packages/shared/` used by the worker):

1. In Terminal 1: stop the container (`Ctrl+C` if you used `docker run --rm ...`, or `docker stop worker-dev`).
2. Rebuild the image:  
   `docker build --no-cache -f packages/worker/Dockerfile -t worker .`  
   (from repo root)
3. Start the worker again (same as step 2 above).

**Check that the host can reach the worker:**  
From PowerShell: `(Invoke-WebRequest -Uri http://localhost:3001/health -UseBasicParsing).Content`  
You should see JSON like `{"status":"healthy"}`. If you get "Unable to connect", the container was likely started without `-p 3001:3001`; stop it and run again with that flag.

---

## Quick Start (one-off / detached)

**⚠️ CRITICAL: Always build from project root; use `-p 3001:3001` when running so host clients can reach the worker.**

```powershell
# From project root (NOT from packages/worker/)
docker build --no-cache -f packages/worker/Dockerfile -t worker .

# Stop and remove old container first (prevents port conflicts)
docker stop worker-dev; docker rm worker-dev

# Start new container (must publish port 3001)
docker run -d -p 3001:3001 --env-file packages/worker/.env --name worker-dev worker

# Check logs
docker logs worker-dev --follow
```

**Key Points:**
- ✅ **MUST build from project root** - Dockerfile needs access to `packages/shared/`
- ✅ **MUST use `-p 3001:3001`** - Without it the host gets connection refused
- ✅ **Use `--no-cache` during development** - Ensures code changes are included
- ✅ **Stop and remove old container** - Prevents port conflicts

## Documentation

- **Full Setup Guide:** See [`docs/Worker.md`](../../docs/design/systems/Worker.md)
- **Docker Setup:** See Docker section in [`docs/Worker.md`](../../docs/design/systems/Worker.md)
- **Troubleshooting:** See [`docs/TROUBLESHOOTING.md`](../../docs/guides/TROUBLESHOOTING.md) for common issues
- **Development Workflow:** See [`docs/guides/DEVELOPMENT_WORKFLOW.md`](../../docs/guides/DEVELOPMENT_WORKFLOW.md) for standard patterns

## Local Development

For local development (requires poppler-utils installed on Windows):

```powershell
cd packages\worker
npm install
npm run dev
```

**Note:** PDF processing requires `pdftoppm` from poppler-utils. Use Docker for consistent environment.

## Other ways to run


`npm run docker:worker` builds the image and `npm run docker:worker:start` runs it.

## Supabase (same project as the MCP server)

The worker **must** use the **same** Supabase project and service role key as the MCP server. Otherwise the worker will not see the same artifacts/workflows and the status API can return 404.

- Set **`SUPABASE_URL`** and **`SUPABASE_SERVICE_ROLE_KEY`** in `packages/worker/.env` to the ahOS Supabase project's values.
- If you only have the web env (e.g. root `.env` with `NEXT_PUBLIC_SUPABASE_URL`), the worker will fall back to **`NEXT_PUBLIC_SUPABASE_URL`** when `SUPABASE_URL` is not set. Ensure that env is available when starting the worker (e.g. turbo or `dotenv` from root).
