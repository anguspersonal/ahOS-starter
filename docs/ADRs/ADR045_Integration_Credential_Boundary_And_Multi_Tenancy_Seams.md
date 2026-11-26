# ADR045: Integration credential boundary, and the seams that keep multi-tenancy reachable

- **Status:** Accepted
- **Created:** 2026-08-04
- **Accepted-on-dev:** 2026-08-04
- **Deciders:** Angus Hally

## Context and problem

ahOS integrations are split across two stores: non-secret wiring (database ids,
`calendar_id`, routing, feature-flag rows) lives in `user_integrations` in the
shared KMS DB, while the secret half (`GOOGLE_REFRESH_TOKEN`,
`NOTION_WORK_ACCESS_TOKEN`, `DEX_API_KEY`, …) lives in environment variables on
the server. That boundary has held since migration 046 but was recorded only in
a code comment ([`env.ts:31-32`](../../packages/mcp-server/src/env.ts):
*"The non-secret database id lives in user_integrations; this is the secret token
and stays in env"*), never as a decision.

The question surfaced while activating the Google Calendar facet (#478): is an
integration credential device-scoped, workspace-scoped, or lasting — and does
this shape commit the project to single-tenancy? ahOS is **single-user by
intent**, but multi-tenancy must not be sealed off (cf. the "kms as capability
home" direction, and #100). This ADR records the boundary and, more importantly,
names the seams that decide the retrofit cost.

## Decision drivers

- **Single-owner today, multi-tenant reachable later** — without a rewrite.
- **Config-reading tools must not be able to leak secrets.** `get_notion_config`
  and `get_capture_config` are user-facing MCP tools that print config values
  verbatim to whatever surface asked.
- **Cross-surface by construction.** Every surface (Claude Code, Cowork,
  Desktop, mobile) calls the *same* remote MCP server and authenticates with an
  OAuth token; credentials must therefore be server-side and are never held by a
  surface or a device.
- **Blast radius.** The server holds the Supabase **service-role key**, which
  bypasses RLS.
- **Bounded, measurable retrofit cost** rather than speculative generality.

## Considered options

### Option A — Secrets in `user_integrations` alongside config

- **Pros:** one store; per-user by construction from day one; no env/DB drift;
  rotation is a row update.
- **Cons:** fatal as built — `loadIntegrationConfig` feeds tools that print
  config, so a secret column is one `get_*_config` call from being echoed to an
  agent surface. `listIntegrations` deliberately returns `config_keys` only, but
  that discipline is per-tool and unenforced. Multi-tenant it is worse, not
  better: every user's secrets in one service-role-readable table, with RLS
  bypassed, makes a single missing `user_id` filter a cross-tenant secret leak.

### Option B — Secrets in env, non-secret wiring in `user_integrations` (status quo)

- **Pros:** secrets are structurally unreachable by config-reading tools; one
  config row covers local + prod; server-side so every surface benefits from a
  single mint; trivially auditable (`env.ts` is the whole inventory).
- **Cons:** one global credential per provider — no per-user dimension; two
  copies to keep in sync (local `.env` and the Railway var), which is the drift
  class already seen in #355 and #424; rotation is manual; refresh tokens are
  scope-bound at mint time, so re-minting for a new scope replaces the old token.

### Option C — Secret in an external vault, non-secret pointer in `credential_ref`

- **Pros:** per-user by construction (the pointer is a row column); secrets never
  enter the KMS DB *or* the server env; already **proven in-tree** — the LinkedIn
  integration routes via Composio with `user_integrations.credential_ref` holding
  *"a pointer, not a secret"* ([`integrations.ts:87-88`](../../packages/mcp-server/src/integrations.ts)).
- **Cons:** requires a vault (Composio today; 1Password per #100) and a
  per-provider adapter; overkill for a single owner with six providers.

## Decision

**Keep Option B as the single-tenant default. Option C is the designated
multi-tenant path. Option A is rejected permanently — secrets never enter
`user_integrations`.**

Counter-intuitively, going multi-tenant makes the "secrets out of the DB" rule
*more* important, not less; the multi-tenant answer is C (per-user pointer,
secret in a vault), which extends the existing boundary rather than reversing it.

Multi-tenancy is **not built now**. Three seams are preserved so it stays a
swap rather than a rewrite:

1. **`credential_ref` remains the credential path.** New integrations resolve
   secrets through an accessor that *could* consult `credential_ref`, even while
   it falls through to env. Today six client modules construct authenticated
   clients directly from env (`drive.ts`, `notion.ts`, `dexClient.ts`,
   `composio.ts`, `embeddings.ts`, `anthropic.ts`) — each already a single
   chokepoint per provider, so this is a signature change, not a redesign.
2. **User identity is read through one accessor, not 125.** `user_integrations`
   is already keyed by `user_id` and all four access functions
   (`loadIntegrationConfig`, `loadIntegration`, `updateIntegrationConfig`,
   `listIntegrations`) read `env.userId` exactly once each — the config layer is
   already multi-tenant-shaped. The cost sits elsewhere: **125 direct
   `env.userId` reads** across the package, excluding tests (measured 2026-08-04
   via `grep -rn "env\.userId" packages/mcp-server/src --include="*.ts" | grep -v
   -E "__tests__|\.test\.ts" | wc -l`; 128 if tests are included). The rule going
   forward is that this number must not grow.
3. **Per-user scoping graduates from discipline to enforcement before, not
   after, a second tenant exists.** See the open question below.

## Consequences

- **Good:** the integrations layer is the most multi-tenant-ready part of the
  system — per-user table, access behind four functions, and a working
  vault-pointer precedent. Config-printing tools cannot leak secrets by
  construction. A credential minted once serves every surface.
- **Cost / bad:** every secret exists in two places (local `.env`, Railway var);
  divergence is silent and has bitten twice (#355, #424). Refresh tokens are
  scope-bound: re-minting Google for Calendar scope *replaces* the Drive token,
  so scopes must be requested together. `KMS_USER_ID` remains a `required()`
  boot var, so the server cannot start without exactly one owner.
- **Open question (not decided here):** the service-role key bypasses RLS.
  Single-tenant that is fine — there is one owner. Multi-tenant it means every
  query is one missing `.eq("user_id", …)` from a cross-tenant leak with no
  database-level backstop. This is a security posture, not a refactor, and is
  the one item that does **not** retrofit cheaply. It must be decided before a
  second tenant exists, in its own ADR.
- **Follow-up:** `getCurrentUserId()` seam + a guard against new direct
  `env.userId` reads; the `getCredential(provider)` seam is best folded into
  #424, which is already making Notion credential resolution take a workspace
  parameter; #100 (centralised secrets manager) is the Option-C enabler.
- **No as-built change:** this ADR records a boundary already implemented
  (migration 046 onward) and sets forward policy; it does not alter components,
  boundaries, or flows, so `architecture.md` needs no update in this PR. #408
  tracks that `architecture.md` omits the mcp-server entirely — that backfill
  should describe this boundary when it lands.

## Links

- Related: [ADR-032](./ADR032_Native_First_Connector_Sourcing.md) (`routing` /
  `credential_ref` as the gateway-port model),
  [ADR-019](./ADR019_Capability_Hosting_And_Binding_Layer.md) /
  [ADR-031](./ADR031_Capability_Registry.md) (the remote, single-owner serving
  surface)
- Issues: #478 (the activation that raised it), #424 (Notion credential
  routing — the natural home for the `getCredential` seam), #100 (secrets
  manager), #408 (`architecture.md` backfill)
