# ADR100: Unified Action Wrapper and Agent-Native Co-Editing Surface

- **Status:** Accepted
- **Created:** 2026-10-02
- **Accepted-on-dev:** 2026-10-02
- **Deciders:** Angus (solo maintainer)
- **Tags:** architecture, actions, mcp, web, security
- **Issue:** #1257
- **Amends:** [ADR-012](./ADR012_Assemble_MCP_Tool_Layer.md), [ADR-096](./ADR096_Retire_The_Web_Surface.md)
- **Amended by:** [ADR-104](./ADR104_Every_Action_Call_Is_Ledgered_And_Outward_Agent_Calls_Wait_For_The_Owner.md) (§1: every call is recorded, the `auditLog` flag is removed, `needsApproval` joins the action contract), [ADR-105](./ADR105_One_Action_Registry_In_Core_With_Exposure_On_The_Action.md) (exposure flags on defineAction; one registry instance per process)
- **Related:** [ADR-019](./ADR019_Capability_Hosting_And_Binding_Layer.md), [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md)

## Context and problem

ahOS operates primarily through its Model Context Protocol (MCP) server (`packages/mcp-server`), exposing ~90 tools directly to Claude and Antigravity agents. Currently, each tool is coupled directly to the MCP transport protocol: input validation uses Zod schemas, but handlers return MCP-specific wire envelopes (`{ content: [{ type: "text", text: string }] }`) with ad hoc string formatting, unnormalized error responses, and manual audit logging. Programmatic TypeScript callers, workers, and tests cannot invoke tool business logic directly without string-parsing or bypassing the MCP response envelope.

Separately, ADR-096 retired `packages/web` (2026-09-26) because the legacy Next.js 14 dashboard suffered unauthenticated traffic spikes on Vercel (~9 to 11 GB/day) and went largely unused by the owner, who interacted with ahOS exclusively through Claude and MCP tools. However, conversational interfaces alone have structural limits: complex document outlines, visual graph exploration, and synchronous living-document editing require a visual, interactive surface. Furthermore, retiring the web surface orphaned human review workflows, leaving machine-generated proposals in `system_decisions` without an approval interface (#1218). Reintroducing a web surface without repeating the cost and security pitfalls of ADR-096 requires an architectural shift from a passive CRUD dashboard to an Agent-Native Co-Editing surface built on a unified capability model.

## Decision drivers

- **Single Source of Truth for Capabilities:** Application operations must be defined once, with identical business logic, validation, permissions, and audit logging across all transport surfaces (MCP, CLI, background workers, and future UI).
- **Typed Return Payloads:** Action logic must return structured domain data rather than pre-serialized MCP string envelopes, allowing type-safe reuse in TypeScript workflows, tests, and UI state management.
- **Agent-UI Parity:** In the eventual visual surface, anything a user can do via clicks, an agent must be able to do via tools, and vice-versa.
- **Strict Blast-Radius and Cost Controls (honoring ADR-096):** Any reintroduced web surface must eliminate public unauthenticated endpoints, run behind authenticated session gates, and carry hard cost limits.
- **One Derivation Layer, Many Readers (honoring ADR-052 §6):** Shared metrics and views must read the same underlying computation whether rendered as an MCP summary in chat or as a reactive tile in a web workspace.

## Considered options

### Option A: Retain tool-centric MCP handlers and build a separate REST/GraphQL API for the UI later

- **Pros:** Zero changes needed for existing MCP tools today.
- **Cons:** Violates DRY; creates capability drift between what agents can do and what the UI can do; duplicates validation, permissions, and audit logging; repeats the mistake of building an isolated backend that drifts from agent operations.

### Option B: Adopt an external heavy agent framework (e.g. `@agent-native/core` directly)

- **Pros:** Out-of-the-box templates and pre-built primitives.
- **Cons:** Drags external runtime dependencies into a specialized monorepo with custom Supabase migrations, MCP server architecture, and security policies; difficult to reconcile with existing architecture decisions (ADR-029).

### Option C: Introduce a native Unified Action Wrapper (`defineAction`) and stage the Agent-Native Co-Editing Surface (chosen)

- **Pros:**
  - Lightweight, native TypeScript abstraction tailored to ahOS monorepo conventions.
  - Decouples pure domain execution from protocol serialization.
  - Incrementally adoptable alongside existing legacy MCP tools with zero breaking changes.
  - Establishes a rock-solid foundation for an authenticated, co-editing surface that cleanly supersedes ADR-096.
- **Cons:** Requires a migration path for existing tools; introduces an adapter layer between actions and MCP.

## Decision

We chose **Option C**. We adopt a phased architecture:

### 1. Phase 1: The Unified Action Wrapper (`defineAction`)

- **Core abstraction:** Each capability is defined via `defineAction({ id, name, description, schema, outputSchema, annotations, auditLog, run })`.
- **Pure Execution:** The `run(input, context)` function takes validated input and an `ActionContext` (caller, domain, userId, requestId) and returns a typed domain object.
- **Surface Adapters:**
  - `toMcpTool(action)`: Converts the action to McpServer tool configuration and handler, formatting the typed result into standard MCP content (`{ content: [{ type: "text", text: string }] }`) and normalizing domain errors.
  - `executeAction(action, input, contextOverrides)`: Direct typed programmatic invocation for workers, scripts, and unit tests without MCP envelope overhead.
- **Dual-mode Registrar:** `packages/mcp-server/src/server.ts` supports registering both legacy tool handlers and new Action definitions side-by-side (`registerAction`), allowing incremental, non-breaking migration.
- **Unification of Cross-Cutting Concerns:** Centralized handling of audit logging, domain routing (`domain: 'work' | 'angus'`), and error transformations (e.g. Google Docs revision mismatches, Notion rate limits).

### 2. Phase 2: The Agent-Native Co-Editing Surface (Reversing ADR-096 in part)

- **Reverses ADR-096's Permanent Retirement:** ADR-096 permanently retired `packages/web` as an unused, passive CRUD dashboard. ADR-100 reverses this retirement by specifying a fundamentally different product: an active, collaborative workspace for human-agent co-editing (living document editing, planning canvas, real-time memory and decision triage).
- **Strict Security & Blast-Radius Control:** Zero unauthenticated routes. All endpoints, websocket connections, and Supabase subscriptions require authenticated sessions. No unauthenticated public forms or waitlists.
- **Predictable Hosting:** Deployed on an internal or protected surface (e.g. Supabase Auth with strict rate limits, Railway internal network, or Cloudflare Access) rather than unmetered public serverless functions.
- **Realtime Agent-UI Parity:** Built directly on top of the Phase 1 action layer. When an agent executes an action (e.g. updating a Google Doc outline, creating a task, or proposing a merge), the UI updates reactively; when a human clicks an action, it executes the identical underlying action handler.

## Consequences

- **Good:** Complete separation of transport formatting from domain execution.
- **Good:** Programmatic tests and background workers can call actions directly without wrapping or parsing MCP payloads.
- **Good:** Non-breaking incremental rollout. Existing MCP clients observe identical schemas and behaviors.
- **Good:** Solves the orphaned proposal problem (#1218) by allowing `review_list` and `review_resolve` to be defined once, used immediately via MCP, and shared with the future UI.
- **Good:** Paves a clear, secure path for human-agent co-editing without repeating Vercel traffic spike issues.
- **Cost / watch:** Tool authors must define actions with typed inputs and structured outputs rather than formatting strings inline.
- **Follow-up:**
  - Implement core Action Wrapper abstraction and types (#1258).
  - Implement MCP adapter, direct execution helper, and dual-mode registrar (#1259).
  - Pilot migration of representative tools (#1260).
  - Scaffold authenticated Agent-Native Co-Editing web workspace (#1261).

## Amendment (2026-11-21 — #2333, `structuredContent` alongside text)

Supersedes the text-only envelope in Decision §1 (`toMcpTool(action)`: `{ content: [{ type: "text", text: string }] }`):

1. **Additive first version.** Each tool built via `toMcpTool` keeps its `formatMcp` prose as the text block and attaches `structuredContent` carrying the action's result so callers can read fields (such as IDs, ETags, or cursors) without parsing prose. A client-behaviour spike (#2398, #2403) measures what each MCP client actually exposes to the model.
2. **Spike covers every active surface.** Client behaviour is tested on Claude Code (agent, #2398) as well as claude.ai chat, Cowork, and ChatGPT (owner, #2403).
3. **Unchecked first.** `toMcpTool` does not forward `outputSchema` to `registerTool` yet. Existing output schemas are validated against real results (#2400, #2404) before schemas are enabled one domain at a time, starting with `github` (#2405).
4. **Whole result by default with an opt-out/trim hook.** By default, plain-object results become `structuredContent` directly (and non-string primitives/arrays/null wrap as `{ result }`; strings and `undefined` omit `structuredContent`). Actions may provide `mcpStructured(result)` to trim heavy or sensitive fields or return `undefined` to omit `structuredContent` (used first by the three passthrough `call_tool` actions; broader trimming waits for #2406).

## Links

- Tracking issue: [#1256](https://github.com/anguspersonal/ahOS/issues/1256)
- Sub-issues: [#1257](https://github.com/anguspersonal/ahOS/issues/1257) (this ADR), [#1258](https://github.com/anguspersonal/ahOS/issues/1258), [#1259](https://github.com/anguspersonal/ahOS/issues/1259), [#1260](https://github.com/anguspersonal/ahOS/issues/1260), [#1261](https://github.com/anguspersonal/ahOS/issues/1261)
- Related issues: [#1218](https://github.com/anguspersonal/ahOS/issues/1218) (review approval surface), [#495](https://github.com/anguspersonal/ahOS/issues/495) (dashboard shell), [#739](https://github.com/anguspersonal/ahOS/issues/739) (system surface), [#2333](https://github.com/anguspersonal/ahOS/issues/2333) (`structuredContent` slice 1)
- Amends: [ADR-012](./ADR012_Assemble_MCP_Tool_Layer.md), [ADR-096](./ADR096_Retire_The_Web_Surface.md)
- Related: [ADR-019](./ADR019_Capability_Hosting_And_Binding_Layer.md), [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md)
