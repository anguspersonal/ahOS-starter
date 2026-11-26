# ADR101: Two packages, two processes: core is the rulebook and the engine, mcp-server is the front door

- **Status:** Accepted
- **Created:** 2026-10-04
- **Accepted-on-dev:** 2026-10-04
- **Deciders:** Angus Hally (solo maintainer)
- **Tags:** architecture, packages, scheduling, mcp, actions
- **Issue:** #1321
- **Amends:** [ADR-100](./ADR100_Unified_Action_Wrapper_And_Co_Editing_Surface.md) (where the action registry and its `run` bodies live), [ADR-093](./ADR093_Scheduling_Substrate_Split_By_Job_Class.md) (names the third substrate it left implicit)
- **Amended by:** [ADR-104](./ADR104_Every_Action_Call_Is_Ledgered_And_Outward_Agent_Calls_Wait_For_The_Owner.md) (§4: the front door records, gates and parks legacy tool calls until each family migrates), [ADR-105](./ADR105_One_Action_Registry_In_Core_With_Exposure_On_The_Action.md) (§1 and §4: actions are defined only in core and projected by the front door, the web and the engine)
- **Related:** [ADR-012](./ADR012_Assemble_MCP_Tool_Layer.md), [ADR-016](./ADR016_Discover_And_Index_Axis.md), [ADR-079](./ADR079_Per_Class_Handling_Is_A_Capability_And_Write_Out_Is_Earned.md), [ADR-087](./ADR087_The_Orchestrator_Runs_On_Agent_Platform_Not_A_Custom_Daemon.md), [ADR-096](./ADR096_Retire_The_Web_Surface.md)

## Context and problem

ADR-100 introduced `defineAction` and a Centralised Action Registry (CAR) so that one
capability definition serves every surface. #1311 then created `packages/core` and moved the
registry primitives and the first domain schemas into it. It did not say where the rest of
the system goes, and the review of that work (2026-10-04, #1321) found the old shape intact
underneath the new names:

- `packages/mcp-server` still holds the business logic of roughly 80 of its 90 tools, and
  runs seven in-process scheduled cadences (`src/schedule/`: discover, Drive discover,
  enrich, Gmail, Gmail attachments, Notion automations, Notion discover; about 4,000 lines)
  inside the same Node event loop that answers every `tools/call`. A batch LLM pass and a
  live tool call compete for one thread.
- `packages/worker` runs three more cadences (dedup sweep, alert evaluator, learning
  analysis) with its own copy of the lock and run-log primitives, plus legacy upload and
  PDF endpoints. `architecture.md` describes it as transitional and slated for retirement.
- `packages/shared` holds types, constants and utilities, some of them Node-only
  (`node:dns`, `node:net`), and `packages/core` re-exports all of it, so the "isomorphic
  kernel" the web imports is not isomorphic.
- Two open PRs (#1306 derive, #1307 synthesise) add an eighth cadence and about 1,300 lines
  of Gemini batch logic to `mcp-server`.

So "thinking" (LLM calls, routing, derivation, synthesis) happens in two processes and
three packages, and the process that must stay fast is the one that also does the batch
work. The owner's requirements, stated in the review: the MCP server must not slow down
under background load; the mental model must be simple; and there must be one place where
intelligent decisions are made, so there is one place to query.

## Decision drivers

- **One place that thinks.** A single process owns every cadence, batch job and
  unattended LLM call, and every machine decision lands in one ledger (`system_decisions`,
  ADR-079), so "what did the system decide and why" has one answer.
- **The front door stays fast.** Protocol translation never shares an event loop with
  batch work.
- **One rulebook.** Schemas, action contracts, selection policy and domain rules are
  defined once and imported everywhere, including by the browser (ADR-100).
- **Simple model.** As few boxes as the above allows, and a name for each that says what
  it does.
- **Incremental.** Every existing tool, cadence and endpoint keeps working while it moves;
  nothing is rewritten in place inside a feature PR.
- **Honour prior decisions.** ADR-087 (orchestration is not a hand-rolled daemon), ADR-093
  (scheduling substrate per job class), ADR-096 (cost and blast-radius control).

## Considered options

### Option A: three packages, three roles (core rulebook, mcp-server ingress, worker host)

The hexagonal reading of ADR-100: core holds contracts and rules, mcp-server is the
ingress adapter, and the worker is the execution host that runs cadences and batch work.

- **Pros:** Matches textbook ports-and-adapters. Keeps the kernel small.
- **Cons:** Three packages for one owner's system is one more than the mental model
  wants. The worker is in poor shape and would be rebuilt in place. "Rules in core, loop
  bodies in the worker" splits the thinking across two packages, which is the drift the
  owner objected to. Shared stays a fourth package.

### Option B: two packages, one process (core absorbs shared and worker; mcp-server runs core's engine in-process)

- **Pros:** Fewest moving parts. One deployable.
- **Cons:** Puts the batch Gemini loop back on the thread that answers `tools/call`. This
  is the Franken-server that prompted the review, renamed. Rejected on the first decision
  driver's twin: the front door must stay fast.

### Option C: two packages, two processes (chosen)

`@ahkms/core` is the rulebook **and** the engine. `@ahkms/mcp-server` is the front door.
Two processes run: the front door, and an engine runner that is a second entrypoint of
core. `shared` and `worker` fold into core and are deleted.

- **Pros:** One package that thinks, one process that runs it unattended, one ledger. The
  front door is protocol code plus a composition root. The browser still imports core,
  because the isomorphic contracts are the package root and the Node parts are subpaths.
  Every move is a file move with a guard behind it, not a rewrite.
- **Cons:** Core becomes large. Without an enforced internal boundary it is the old
  monorepo in one folder. Two guards (exports boundary, import direction) are therefore
  part of the decision, not a follow-up. Migration touches ten cadences and the worker's
  endpoints, so it must be sequenced over several PRs.

## Decision

We chose **Option C**.

### 1. Two packages

**`@ahkms/core` (`packages/core`)** holds everything that thinks:

- **contracts** (package root, isomorphic): Zod schemas, types, domain constants, pure
  rules (what qualifies, in what order, how many per run, what "already done" means),
  prompt builders and LLM output parsers as pure functions. Imported by web, mobile,
  mcp-server and the engine.
- **actions** (`@ahkms/core/actions`, Node): `defineAction` bodies. A `run` is written
  against ports defined in core (for example a repository port and an LLM port), never
  against a concrete client.
- **engine** (`@ahkms/core/engine`, Node): the scheduler tick, `scheduler_locks` /
  `scheduler_runs`, every cadence, the batch orchestrators and the `system_jobs` runner.
- **adapters** (`@ahkms/core/adapters`, Node): Supabase, Gemini, Claude, Drive, Gmail,
  Notion and the other concrete clients that satisfy the ports.

`@ahkms/shared` folds into core: isomorphic utilities to the root, Node-only utilities to
a Node subpath. The worker's schedule primitives, dedup sweep, alert evaluator and learning
analysis fold into `core/engine`. `packages/shared` and `packages/worker` are deleted when
empty.

**`@ahkms/mcp-server` (`packages/mcp-server`)** is the front door: the MCP transport
(stdio and Streamable HTTP), the authenticated action endpoint from #1317, inbound
webhooks, owner OAuth, and the upload and PDF endpoints inherited from the worker. It
imports core, wires the adapters at startup, and registers actions as tools. It owns no
timers, no cadences, no batch loops and no unattended LLM calls.

### 2. Two processes

- **The front door:** `packages/mcp-server`, the existing Railway `ahkms/mcp-server`
  service.
- **The engine:** `node packages/core/dist/engine/main.js`, deployed on the existing
  Railway service that runs the worker today. It imports the same core, wires the same
  adapters, and runs the scheduler and the job runner. It serves no protocol.

A scheduler tick is a driving adapter, the same kind of thing as an HTTP request or an MCP
`tools/call`: it is how the outside world asks for work. That is why it lives in the engine
process and not in the rulebook, and why the rules it applies (selection, ordering, budget)
live in the rulebook and not in the tick. The test for which side a line of code is on: if
the trigger moved from a Railway interval to Cloud Scheduler or a GitHub Action and the
line would change, it is mechanism and belongs to the engine; if it would not change, it is
a rule and belongs to contracts.

This names the third scheduling substrate ADR-093 left implicit. ADR-093 split repo
engineering jobs (GitHub Actions) from personal-ops jobs with connectors (Claude Routines).
Product cadences that need the system's own adapters and credentials, and that today run
inside Railway processes, are a third class. They run in exactly one place: the engine.

### 3. Two boundaries, enforced

- **Exports boundary.** `@ahkms/core`'s root entry exports contracts only and must bundle
  for the browser. `./actions`, `./engine` and `./adapters` are declared subpath exports
  and are Node-only. A guard fails the build if the root entry transitively imports a Node
  built-in or an adapter.
- **Import direction.** Inside core: contracts → actions → engine, never backwards.
  Adapters are imported only by the two composition roots (the front door's startup and
  the engine's `main.ts`) and by tests. One `no-restricted-imports` rule.

### 4. Rules from today

- New cadences target `core/engine`. None are added to `mcp-server`.
- Heavy on-demand work requested through an MCP tool (derive one artifact, synthesise one
  entity) enqueues a `system_jobs` row that the engine picks up. The front door does not run
  an LLM batch inline to answer a tool call. Cheap synchronous actions (CRUD, search,
  capture) stay synchronous.
- Every machine decision is written to `system_decisions` (ADR-079) by the action that made
  it, wherever that action ran. The front door relays and records nothing on its own.

### 5. Migration order

Nothing is rewritten inside a feature PR; each step is its own PR.

1. This ADR, plus the `architecture.md` corrections it requires.
2. Skeleton: core exports map, the two guards, `core/engine` runner built from the
   worker's `schedule/lock.ts` and `runLog.ts`, deployed on the worker's Railway service.
   No cadences moved yet.
3. #1306 and #1307 retargeted: contracts to core root, derive and synthesise bodies to
   `core/actions`, their cadences to `core/engine`, thin tool registration in mcp-server,
   on-demand path through `system_jobs`.
4. #1317: the authenticated `/api/actions/:id` endpoint on the front door; web mutations
   route through it.
5. mcp-server's seven cadences move to `core/engine`, one PR each.
6. Worker's three cadences move to `core/engine`; upload and PDF endpoints move to
   mcp-server; `packages/worker` is deleted.
7. `packages/shared` folds into core and is deleted.
8. `architecture.md` as-built pass; the "target" labels from #1318 come off.

## Consequences

- **Good:** one answer to "where does the system think" (the engine process) and one answer
  to "what did it decide" (`system_decisions`). Tool-call latency no longer depends on
  background load. The web and mobile keep a browser-safe import of the rulebook. Two
  packages and two processes is a model a person can hold.
- **Good:** no new Railway service. The worker's service becomes the engine; the
  mcp-server's service stays the front door.
- **Cost / watch:** core is large by design. The two guards are what keep it from
  becoming the old monorepo in one folder; if either is removed, this ADR no longer holds.
  Ports have to be designed once (step 2 and the #1317 pilot) before `run` bodies can move;
  until then actions moved into core may still import adapters directly, behind the
  subpath boundary, and that is accepted as a transitional state.
- **Cost / watch:** ten cadences and a set of Express endpoints move. Each move is a
  file move with its env gate preserved, but the sequence takes weeks, not a day, and the
  interim state (some cadences in each process) must be visible in `architecture.md`.
- **Reverses:** `architecture.md`'s "worker slated for retirement under ADR-100". The
  worker *package* is retired; its *process* becomes the engine.
- **Follow-up:** #1321 tracks the sequence above. #1315, #1316, #1317, #1318, #1319 and
  #1320 are the defects from the same review and are prerequisites or siblings of steps
  2 to 4.

## Links

- Tracking issue: [#1321](https://github.com/anguspersonal/ahOS/issues/1321)
- Review defects: [#1315](https://github.com/anguspersonal/ahOS/issues/1315),
  [#1316](https://github.com/anguspersonal/ahOS/issues/1316),
  [#1317](https://github.com/anguspersonal/ahOS/issues/1317),
  [#1318](https://github.com/anguspersonal/ahOS/issues/1318),
  [#1319](https://github.com/anguspersonal/ahOS/issues/1319),
  [#1320](https://github.com/anguspersonal/ahOS/issues/1320)
- In-flight PRs this reshapes: [#1306](https://github.com/anguspersonal/ahOS/pull/1306),
  [#1307](https://github.com/anguspersonal/ahOS/pull/1307),
  [#1309](https://github.com/anguspersonal/ahOS/pull/1309)
- Amends: [ADR-100](./ADR100_Unified_Action_Wrapper_And_Co_Editing_Surface.md),
  [ADR-093](./ADR093_Scheduling_Substrate_Split_By_Job_Class.md)
- Related: [ADR-012](./ADR012_Assemble_MCP_Tool_Layer.md),
  [ADR-016](./ADR016_Discover_And_Index_Axis.md),
  [ADR-079](./ADR079_Per_Class_Handling_Is_A_Capability_And_Write_Out_Is_Earned.md),
  [ADR-087](./ADR087_The_Orchestrator_Runs_On_Agent_Platform_Not_A_Custom_Daemon.md),
  [ADR-096](./ADR096_Retire_The_Web_Surface.md)
