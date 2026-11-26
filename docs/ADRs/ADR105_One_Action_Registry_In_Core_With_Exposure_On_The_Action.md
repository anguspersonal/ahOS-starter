# ADR105: One action registry in core, with exposure on the action, and a traceable, chained ledger

- **Status:** Accepted
- **Created:** 2026-10-11
- **Accepted-on-dev:** 2026-10-16
- **Deciders:** Angus Hally (solo maintainer)
- **Tags:** architecture, actions, mcp, web, engine, audit
- **Issue:** #1466. The owner answered the registry and ledger grill on 2026-10-11; the grill was not filed as an issue. The packets are under Follow-up.
- **Amends:** [ADR-100](./ADR100_Unified_Action_Wrapper_And_Co_Editing_Surface.md) §1 (`defineAction` gains `expose`; one registry instance per process), [ADR-101](./ADR101_Two_Packages_Two_Processes_Core_Is_Rulebook_And_Engine.md) §1 and §4 (actions are defined only in core; the front door, the web and the engine project one registry; the worker's routes become actions or listed exemptions), [ADR-104](./ADR104_Every_Action_Call_Is_Ledgered_And_Outward_Agent_Calls_Wait_For_The_Owner.md) §1 (trace and parent ids on every row, a hash chain, client-local actions recorded by batch, non-action routes unrecorded until they migrate)
- **Related:** [ADR-031](./ADR031_Capability_Registry.md), [ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md), [ADR-093](./ADR093_Scheduling_Substrate_Split_By_Job_Class.md), [ADR-102](./ADR102_Operating_Model_Architect_Owner_Executor.md)

## Context and problem

No surface reads one shared registry. Three `ActionRegistry` instances exist: core's (`packages/core/src/actions/registry.ts:92`, never read), mcp-server's (`packages/mcp-server/src/actions/registry.ts:48`, filled by the hand list at `actions/allActions.ts:24-41` and as a side effect of `registerAction` at `server.ts:405-408`) and the web's (`packages/web/src/lib/actionRegistry.ts:235`). Four more lists are kept by hand: the 17 `registerAction` calls in `server.ts`, the web's Gemini declarations (`actionRegistry.ts:40-229`, four of seven drifted, #1442) with a second copy at `chatAction.ts:52`, and the engine's one job type (`core/src/engine/jobs/jobRunner.ts:103`). Sixteen `defineAction` calls live in mcp-server, outside the package ADR-101 §1 gives them. The worker's HTTP API (`packages/worker/app.js:137-156`) is a second front door that no list covers.

ADR-104 records every `executeAction` call, but a nested call cannot be joined to its parent (`core/src/actions/adapters/direct.ts:44` mints a fresh request id per call), the owner has no read path, a postgres-role session can disable the append-only trigger and rewrite rows unseen, and the worker routes and the Notion and Drive webhooks' work write without a row.

## Decision drivers

- **One definition, every surface.** An action is written once, in core, and every surface reads that definition.
- **Exposure is part of the contract**, reviewed where the action is written.
- **Rules as tests** (ADR-102 §3): a new surface entry outside the registry fails CI.
- **Followable ledger.** What an agent did is answerable, including which turn or job did it.
- **Personal only.** Designs from agent-native and example-org/ops are ported as contracts; nothing is shared.

## Considered options

Each answer as the owner gave it on 2026-10-11, then what it ruled out.

### Registry

- **R1 Home.** Every `defineAction` lives in `@ahkms/core`; mcp-server, the web and the engine only project actions. Ruled out: definitions in the package that serves them.
- **R2 Instance.** Core exports one `buildRegistry(adapters)`; every server process calls it once at boot. A build step writes a manifest (ids, input schemas, exposure) that the web and the docs are generated from. Ruled out: per-package registries; a registry service queried over HTTP.
- **R3 Exposure on the action.** `defineAction({ ..., expose: { mcp, http, ui_agent, worker, cli, a2a } })`; #1407's manifest is generated from these flags. Ruled out: a separate hand-kept exposure table.
- **R4 Default.** Every action is on `mcp`, `http`, `ui_agent` and `worker` unless it opts out; an opt-out names a reason from a closed list, checked in tests and listed in `AGENTS.md`. `cli` and `a2a` stay off until #1455 and #1456 reopen. Ruled out: opt-in exposure.
- **R5 Jobs.** A `system_jobs` row stores an action id and its input; the engine runs it through `executeAction` with caller `worker`. Cadences become actions their schedules invoke. Ruled out: job types as engine-private branches.
- **R6 Guard.** CI lists every MCP tool, `/api` route, web declaration and job type, and fails on a new entry outside the registry or an unlisted exemption. Baselines only shrink (extending #1406); the guard is strict once migration ends.
- **R7 Order.** The registry spine first (actions to core, `buildRegistry`, manifest, exposure flags, guard, front doors wired), then the remaining family migrations (#1338) in parallel.
- **R8 Web.** The in-app agent's list and declarations are generated from the manifest, building on #1442. Client-only UI actions (such as `graph_filter`) are registry actions exposed to `ui_agent` only.
- **R9 UI actions are ledgered.** The browser runs a client-only action locally, then batches its records to `/api/actions` as caller `ui_agent`.
- **R10 Manifest committed** at `packages/core/action-manifest.json`; CI fails when it is stale.
- **R11 Naming.** One snake_case id everywhere: MCP tool name, `/api/actions` path, manifest key and ledger `action_id`. No aliases after 2026-10-15 (#1402); a rename carries a dated deprecation window in the manifest.

### Ledger

- **L1 Read.** `ledger_query`, an owner-only read action on MCP and `/api/actions`, with the indexes its filters need, plus a web Ledger view. Ruled out: SQL only.
- **L2 Correlation.** Every row carries `parent_request_id` and `trace_id`. A trace is one chat turn, one job run or one MCP request; a nested `executeAction` inherits it. Core holds an injectable scope, and the front doors install AsyncLocalStorage. Ruled out: ids passed by hand at each call site; the MCP session id alone.
- **L3 Tamper evidence.** A per-row hash chain, a verify function and an `ahos_doctor` check, with no external anchor. Ruled out: the trigger alone; an anchor outside Supabase.
- **L4 Non-action HTTP routes** (the worker API, and the Notion and Drive webhooks' work) are not recorded until each becomes an action. The owner chose to wait, against the recommendation to record them now, so their migration is prioritised. Ruled out: a `legacy_route` recorder seam.
- Browser direct SELECTs (the owner's own RLS-scoped reads) stay outside the ledger.

## Decision

We adopt R1 to R11 and L1 to L4 as stated. This section says how they fit.

### 1. One registry

`buildRegistry(adapters)` in `@ahkms/core/actions` registers every core action factory against the adapters the process passes. A family whose adapter a process does not wire is still registered and rejects with `adapter_unavailable`, so every process holds the same ids. Both front-door entry points and the engine call it once at boot; the web holds no adapters and reads the manifest. An action whose body still lives in mcp-server is defined in core against a port, and mcp-server passes the existing function as the adapter until #1338 moves the body.

### 2. Exposure

`expose` defaults to `mcp`, `http`, `ui_agent` and `worker` on, `cli` and `a2a` off. Turning a surface off needs `expose.reason` from this closed list and a non-empty `expose.note`:

- `client_local`: runs in the browser on view state; offered to the in-app agent only.
- `owner_only`: an owner decision surface, such as the approval inbox; never offered to an agent (ADR-104 G12).
- `app_internal`: called only by ahOS's own code (a schedule, a job, a webhook receiver, the web app), or LLM batch work ADR-101 §4 keeps off the front door.
- `legacy_twin`: an MCP legacy tool holds this id with another contract until #1338 migrates it.
- `owner_decision_pending`: exposure waits on a named open issue.

`defineAction` refuses `cli: true` and `a2a: true` until #1455 or #1456 reopens. A new reason is an ADR change.

### 3. Manifest

`npm run gen:action-manifest -w @ahkms/core` writes one line per action: id, description, domain, annotations, exposure with its reason, the input schema as `z.toJSONSchema(schema, { target: "openapi-3.0", io: "input" })` (the call #1442 uses) and any former ids with their end date. A test fails when the committed file differs from the registry. `/api/actions` serves the ids with `http`, MCP registers those with `mcp` (and each former id until its date), the engine runs those with `worker`, and the in-app agent is offered those with `ui_agent`.

### 4. Jobs and cadences

The job runner resolves `system_jobs.type` as an action id in the engine's registry, refuses an id without `worker`, and runs `payload` as its input. An engine cadence names the action it runs. The in-process cadences in mcp-server and the worker become actions as their families move (ADR-101 §5).

### 5. Ledger additions

Records gain `parent_request_id` and `trace_id`. Rows gain `prev_hash` and `row_hash`, computed by a `BEFORE INSERT` trigger under an advisory lock over the row's non-null columns, so a later nullable column leaves earlier hashes valid. Client-local action records arrive in batches and are written with seam `client_local`, which proves the web app reported a run, not that it happened. Webhook receivers stay exemptions (`inbound_webhook`) but dispatch their work through an action, as `/webhooks/capture` and `/webhooks/slack` already do (`mcp-server/src/webhooks/dispatchCapture.ts:14-24`). Each worker route is deleted, moved onto an action, or kept as a listed exemption.

## Consequences

- **Good:** one id, one schema and one exposure decision per action, readable by every surface and checked in CI.
- **Good:** a nested dispatch, a chat turn or a job run can be followed row by row, and a silent edit of the ledger is detectable.
- **Cost / watch:** exposure defaults open, so outward actions reach `/api/actions` and the in-app agent unless they opt out. #1394 (owner-only `/api/actions`) and ADR-104's gate carry that risk, and the HTTP switch-over waits for #1394.
- **Cost / watch:** actions whose bodies still sit in mcp-server are defined in core against thin ports, a seam #1338 removes family by family.
- **Cost / watch:** the chain is evidence, not prevention; a postgres-role session can recompute it. #871 removes agent SQL access.
- **Cost / watch:** until each migrates, the worker API's writes and the Notion and Drive webhooks' work leave no ledger row; the coverage table in `architecture.md` says so.
- **Cost / watch:** the committed manifest changes in every PR that changes an action contract.
- **Current state:** nothing here is built when this ADR merges.
- **Follow-up (packets, in order):**
  - spine: #1475 (no new action outside core), #1486 (`expose`), #1492 (`buildRegistry`), #1500 (manifest), #1510, #1519, #1528, #1537, #1548, and #1549 (the sixteen mcp-server actions to core), #1550 (one registry per front-door process), #1551 (`/api/actions` from the registry), #1552 (MCP from the registry), #1553 (jobs), #1554 (cadences), #1555 (guard), #1556 (web from the manifest), #1557 (client-local actions), #1558 (client-local records), #1559 (skills name real tools), #1560 (generated action docs);
  - ledger: #1561, #1562 and #1468 (trace and parent ids), #1476 (`ledger_query`), #1485 (Ledger view), #1493 (hash chain), #1502 (coverage table);
  - non-action routes: #1513 (worker route surface), #1524 (Notion and Drive webhook work as actions), #1532 (worker traffic), #1542 (dead worker routes), #1563 (live worker routes as actions).

## Links

- Amends: [ADR-100](./ADR100_Unified_Action_Wrapper_And_Co_Editing_Surface.md), [ADR-101](./ADR101_Two_Packages_Two_Processes_Core_Is_Rulebook_And_Engine.md), [ADR-104](./ADR104_Every_Action_Call_Is_Ledgered_And_Outward_Agent_Calls_Wait_For_The_Owner.md)
- Issues: #1338 (family migration), #1394 (owner-only `/api/actions`), #1406 (legacy-tool ratchet), #1407 (exposure manifest), #1442 (generated declarations), #1455 (CLI), #1456 (A2A), #871 (agent SQL access)
- Designs ported, nothing shared: BuilderIO/agent-native per-action surface flags; example-org/ops registry and ledger (contracts only)
