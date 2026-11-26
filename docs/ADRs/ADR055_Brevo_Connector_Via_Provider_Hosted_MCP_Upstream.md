# ADR-055: Brevo connector via Brevo's provider-hosted MCP server, exposed as a dynamic tool passthrough

- **Status:** Accepted
- **Created:** 2026-08-10
- **Accepted-on-dev:** 2026-08-11
- **Deciders:** Angus (solo maintainer)
- **Builds on:** [ADR-032](./ADR032_Native_First_Connector_Sourcing.md),
  [ADR-045](./ADR045_Integration_Credential_Boundary_And_Multi_Tenancy_Seams.md)

## Context and problem

Brevo is the Work customer-comms stack: `example-org/mvp`'s Firebase functions
already mirror every user into Brevo as a contact and send transactional email
through it (`functions/typescript/src/utils/brevo.ts`). What's missing is the
*operator* surface — managing campaigns, lists, contacts, and sends from any
Claude surface — which is exactly what the ahkms gateway exists to provide.

Brevo now ships an **official, provider-hosted MCP server**
(`https://mcp.brevo.com/v1/brevo/mcp`, early access, ~27 tools spanning
campaigns / contacts / lists / transactional email / account), authenticated
with a dedicated MCP-enabled API key. ADR-032's routing registry already has an
`mcp` routing value, but no connector uses it yet, and ADR-032's coverage matrix
rejected the MCP-server option for its original 8 providers ("redundant
MCP-in-MCP … or worse: archived / sunset / single-maintainer"). Brevo was not in
that matrix, so its sourcing needs its own call.

## Decision drivers

- **Zero-third-party-egress** is ADR-032's sole in-regime disqualifier. Brevo's
  MCP server is hosted **by Brevo** — token and payload go only to the provider
  we already trust with that exact data. The disqualifier does not apply.
- The upstream catalog is ~27 tools, **early-access and churning**. Hand-building
  native REST adapters for that surface is the one cost class ADR-032 warns
  native accepts (forced migrations) multiplied by breadth we don't control.
- The Dex precedent: `dexClient.ts` already talks to a provider-hosted MCP
  server (`mcp.getdex.com`) — the pattern is proven in this codebase.
- Secrets stay in env, never `user_integrations` (ADR-045).

## Considered options

### Option A — Native REST adapters (`@getbrevo/brevo` or raw fetch), ADR-032's default

- **Pros:** consistent with the 8-provider decision; per-tool Zod schemas typed
  in-repo; no dependency on an early-access surface.
- **Cons:** ~27 endpoints to build and maintain by hand for a catalog Brevo is
  actively evolving; duplicates work Brevo now maintains for us; native's win in
  ADR-032 rested on egress + static tokens, and the egress argument is moot here
  (same first party either way).

### Option B — Brevo's provider-hosted MCP server as the upstream, dynamic passthrough (chosen)

- Two gateway tools: `brevo_list_tools` (proxies `tools/list`, returns the live
  catalog with input schemas) and `brevo_call_tool` (proxies `tools/call`).
- **Pros:** full catalog for the cost of one ~200-LOC client; catalog churn is
  absorbed upstream — discovery at call time can't go stale; no third-party
  egress; swap to native later is the standard ADR-032 one-row + adapter move.
- **Cons:** "MCP-in-MCP" indirection ADR-032 called redundant — accepted here
  because the redundancy critique assumed native was otherwise winning, and (per
  Option A) it isn't; no in-repo schemas, so argument validation happens
  upstream; early-access endpoint may move (mitigated: `BREVO_MCP_URL` override).

### Option C — Static per-tool mirror of the MCP catalog (the `tools/dex/*` pattern)

- **Pros:** first-class tool names/descriptions per action; per-tool Zod input
  validation at the gateway.
- **Cons:** requires pinning ~27 schemas we can only obtain by live discovery
  against an early-access catalog — every upstream change is a silent drift until
  someone notices. Dex could afford the static mirror because its catalog is
  stable and documented; Brevo's isn't yet. Revisit once the catalog stabilises
  (the mirror can be generated from `brevo_list_tools` output).

### Option D — Aggregator (Composio)

- **Cons:** third-party egress of the Brevo token + customer PII payloads —
  ADR-032's binding disqualifier, squarely applicable. Rejected.

## Decision

We chose **Option B**. The `user_integrations` row for `provider='brevo'` is the
first `routing='mcp'` connector; `credential_ref` names the env var
(`BREVO_MCP_API_KEY` — an MCP-enabled key, a distinct Brevo key type from the
REST key the mvp Firebase functions hold). The client
(`packages/mcp-server/src/brevoClient.ts`) runs the real streamable-HTTP
handshake (initialize → `Mcp-Session-Id` → `notifications/initialized`,
re-handshake on session-expiry 404), unlike `dexClient.ts`'s bare `tools/call`
shortcut, because Brevo's server is session-aware.

This does **not** reopen ADR-032's per-provider calls: the 8-provider native
recommendation stands. It narrows ADR-032's "MCP-server option is never chosen"
from a portfolio rule to what its own logic supports: the MCP-server option
loses *unless* the server is provider-hosted (egress moot) **and** native would
mean hand-maintaining a broad, churning catalog. Brevo is the first provider to
meet both conditions.

## Consequences

- **Good:** every ahkms surface can operate Work's email/CRM stack; zero
  catalog maintenance; the `mcp` routing path gets its first real exerciser.
- **Cost / bad:** two-step UX (list, then call) instead of first-class named
  tools; gateway-side input validation is limited to `{name, arguments}`;
  dependence on an early-access endpoint (URL overridable without a code
  change). Sends are outward-facing — the `brevo_call_tool` description tells
  agents to confirm with the user before invoking a sending tool.
- **Follow-up:** one-time setup — mint the MCP-enabled key in Brevo, set
  `BREVO_MCP_API_KEY`, and create the `provider='brevo'` row
  (`set_integration_config`). If/when Brevo's catalog stabilises, consider
  generating an Option-C static mirror for the handful of highest-traffic tools.

## Links

- Related: [ADR-032](./ADR032_Native_First_Connector_Sourcing.md),
  [ADR-045](./ADR045_Integration_Credential_Boundary_And_Multi_Tenancy_Seams.md)
- Precedent: `packages/mcp-server/src/dexClient.ts`
- Native Brevo usage in the product repo: `example-org/mvp`
  `functions/typescript/src/utils/brevo.ts`
