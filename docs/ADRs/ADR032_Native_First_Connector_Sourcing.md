# ADR-032: Native-first connector sourcing behind the gateway; the binding disqualifier is zero-third-party-egress

- **Status:** Accepted
- **Date:** 2026-06-29
- **Accepted-on-dev:** 2026-06-29
- **Deciders:** Angus (solo maintainer)
- **Tags:** architecture, connectors, correspondence, sourcing, composio, egress, routing
- **Supersedes:** the Composio free-tier name-drop in
  [ADR-017](./ADR017_Knowledge_Grounded_Correspondence_Edge.md) §4 (connectors as
  "thin adapters over a rented aggregator"). The ADR-017 *boundary* (connectors as a
  deletable edge behind send-tools) stands; only its default *sourcing* changes.

## Context

ADR-017 added a knowledge-grounded correspondence edge: a skill composing thin
**send-tools** (`post_linkedin`, `send_email`, …) over the knowledge core's MCP
retrieval contract. It deferred *how* the send-tools source their connectors,
sketching "rent via Composio free tier." This ADR settles that question per provider.

The governing principle is unchanged (`docs/design/design-principles.md`): **build your
opinions, rent your mechanics** — own the judgment, leverage the mechanics, buy
portability last. The brief: official provider SDKs first; an aggregator only where it
demonstrably earns its keep; whatever is rented sits behind our own tool-interface as
**one swappable upstream**, never sprayed through core. Constraints: single-user (we hold
our own tokens), ~$0–5/month budget, and *avoid third-party egress of tokens/traffic
unless it clearly pays*. The native exemplar and cost yardstick is
`packages/mcp-server/src/google/drive.ts`: one minted refresh token in env, the SDK
refreshes transparently, ~5KB behind one tool, zero third-party egress, $0.

A coverage matrix was built across 8 providers — Gmail, Google Calendar, Notion, Slack,
LinkedIn (post), X/Twitter (post), Instagram (post + DM), WhatsApp (message) — comparing
three sourcing options ((i) native SDK/REST behind our tool, (ii) a community/official MCP
server, (iii) an aggregator such as Composio/Ayrshare/Unipile) across seven dimensions
(action coverage, single-user auth, edge-case handling, egress, cost, maintenance/churn,
gateway fit), checked against live mid-2026 docs. It was then put through three adversarial
passes. Full research: `docs/research/social-connectors-feasibility.md` plus the matrix
appendix below.

## Decision

**Native-first for the entire current 8-provider surface, sourced per provider via a
routing registry (`user_integrations`), with an aggregator (Composio) as a documented
per-provider fallback unlocked only by a regime change.** Hybrid by design: native for the
stable, private, or high-value core; an aggregator for the churny / low-sensitivity long
tail (30+ connectors anticipated — Firebase, Supabase substrate excepted, see below).

This is a "best call for now, in full knowledge it may change" decision. The whole point of
the routing registry is that changing any provider's sourcing is a one-row update, not a
rewrite.

### The binding reason (corrected by the adversarial passes)

The **sole in-regime disqualifier of an aggregator is zero-third-party-egress of tokens +
payloads** — *not* single-user, and *not* API stability. Two corrections the skeptics forced:

1. **Single-user nulls only the aggregator's *vault* value** (multi-tenant token custody).
   Its *mechanics* value (wire-format churn-shielding, auth-refresh, app-review absorption)
   is genuinely real and survives single-user — but loses anyway, on egress. So
   "single-user collapses the aggregator's value" was overstated, redundant rhetoric on top
   of the one argument (egress) that actually settles every cell.
2. **API stability + static/long-lived tokens** (provider properties) — not single-user —
   are what make native win for Gmail/Calendar/Notion/Slack.

Native is therefore chosen for **lowest total cost + full control — explicitly not "low
maintenance."** It accepts ~1–2 forced wire-format version migrations/year concentrated in
the Meta + LinkedIn cluster (LinkedIn ~annual `NONEXISTENT_VERSION` sunset; Meta ~quarterly
versions with ~2-year hard-fail sunset; Notion's pending 2025-09-03 data-sources break). A
pinned version header is a **deferral with a hard-fail deadline, not insulation.**

### The native custody ledger (the hidden-lock-in correction)

Native is not "free." Building native converts a *disposable* software dependency (a ~150-LOC
adapter you can delete in minutes) into a **non-portable identity/custody dependency** you
cannot: a Google Cloud project, a Meta app + Business Verification, an X paid dev app, a
LinkedIn app with approved products, a Slack app, a Notion integration — plus N self-custodied
long-lived secrets. Native still wins because that lock-in is to a provider you must deal with
anyway; an aggregator is an *added* middleman on top of that same relationship, plus egress.
Native minimizes **net** lock-in for a single-user private system.

### "One swappable port" — real but bounded

The MCP send-tool contract (`post_linkedin(text, …)`) is the only fully stable layer. On a
native↔aggregator swap, the tool signature is unchanged but **auth substrate, dev-account
custody, and payload mapping are redone.** The port is real, but the swap is bounded-cost, not
free. The egress rule is driven by **credential** egress, not payload sensitivity — a public
post is world-visible anyway, but its posting *token* is abusable, so the rule applies
uniformly on principle.

## The routing registry (`user_integrations`)

`user_integrations` (migration 046) is extended (migration 060) into the routing + health
registry:

- `routing` — `native | composio | mcp | own_substrate`. Which upstream a send/read tool
  dispatches to behind our gateway port. **`own_substrate`** (Supabase, PostHog, Firebase) =
  our own backends: direct, our creds, **never** an aggregator. These are not third-party
  connectors and must not be routed through Composio.
- `status` — `connected | needs_reauth | disconnected | error`, distinct from the `enabled`
  feature flag. This is where LinkedIn/Instagram 60-day re-consent reminders fire from
  (with `expires_at`).
- `credential_ref` — a **pointer, not a secret**: the env var name (native) or the Composio
  connected-account id (composio). Secrets stay in env (native) or Composio's vault.

A send-tool resolves its upstream at call time (`loadIntegration(provider)` → switch on
`routing`). Flipping a provider from `composio` to `native` (or back) is a one-row `UPDATE`.

## First pilot: LinkedIn via Composio

LinkedIn (member post) is deliberately the **first `composio`-routed connector**:

- Native LinkedIn is the worst onboarding in the set (60-day interactive browser re-consent
  on a headless gateway; no programmatic refresh without MDP-partner status).
- A LinkedIn post is public → only the *token* egresses (weak egress concern), so it is the
  defensible place to rent.
- It exercises the brand-new `routing='composio'` path end-to-end (the native path is already
  proven by `drive.ts`/`notion.ts`).

Implementation: `post_linkedin` tool → `loadIntegration('linkedin')` → `composio.ts`
(`executeComposioTool('LINKEDIN_CREATE_LINKED_IN_POST', …)`). Composio's token is in its vault;
`credential_ref` holds the connected-account id.

> **The rented-churn risk, confirmed live (2026-06-29).** On the first real post, Composio's
> pre-baked `LINKEDIN_CREATE_LINKED_IN_POST` action returned `426 NONEXISTENT_VERSION` — it
> pins a deprecated `LinkedIn-Version` (`20241101`), not overridable on the action call
> ([ComposioHQ/composio#3113](https://github.com/ComposioHQ/composio/issues/3113)). This is
> exactly the "rented churn from an opaquer vendor with no version pinning" risk ADR-032
> names — empirical validation of native-first.
>
> **Resolution: proxy-execute, not full native (yet).** Rather than stand up our own LinkedIn
> OAuth app, `post_linkedin` now uses Composio's **proxy execute** (`POST .../api/v3.1/tools/
> execute/proxy`) to send *our own* request to LinkedIn's current `/rest/posts` with a
> `LinkedIn-Version` header **we** control (`config.linkedin_version`, default `202602`).
> Composio still injects auth (token custody), but the request shape and API version are ours —
> "rent the auth, own the request." When LinkedIn next sunsets the version, bump that one config
> value (a `NONEXISTENT_VERSION` error is the signal); no code change. The pre-baked action path
> is abandoned for LinkedIn. Full native (`routing='native'`) remains the documented escape hatch
> if we later want Composio out of the LinkedIn path entirely.

Manual setup remaining (one-time): set `COMPOSIO_API_KEY` (the `ak_…` Platform key), authorize
LinkedIn in Composio, store the connected-account id in `credential_ref` + the Composio `user_id`
in `config.composio_user_id` (set `status='connected'`). The author URN is auto-resolved and cached
on first post. **Proxy execute must be enabled on the Composio key.**

## Per-provider recommendation

All 8 → **native**. Confidence **high**: Gmail, Calendar, Notion, Slack, X, WhatsApp.
**Medium** (named flip-candidates): **LinkedIn**, **Instagram**. The MCP-server option is
never chosen — redundant (in-process native is thinner than MCP-in-MCP behind our own gateway)
or worse (archived / sunset / single-maintainer / fragile session). Note: the *first build* is
LinkedIn-on-Composio as the pilot above — its native recommendation is the eventual target the
routing flip enables, not a contradiction.

## Break-even — when an aggregator beats native

Within the current regime (single-user + zero-egress + $0–5/mo): break-even on breadth or
churn velocity **alone is effectively never** — egress disqualifies regardless of provider
count, and aggregators absorb only *cheap* wire-format churn while *expensive* churn
(Meta verification/template approval, LinkedIn's 60-day re-consent, BYO dev-account custody)
stays with us. The threshold is set by which **constraint relaxes**:

- **Per-provider flip:** native access becomes impossible without a Tech-Provider intermediary
  or weeks-long App Review the aggregator absorbs as the integrating party (the
  Ayrshare-for-IG-posting shape), *and* that payload's egress is acceptable.
- **Wholesale flip:** the zero-egress principle is relaxed (a self-hostable aggregator, or a
  vendor with an acceptable data-processing posture). Even then renting wins only at roughly
  ≥15–20 high-churn providers (aggregate >~1 hand-patch/month) *and* staying under Composio's
  20k-call/mo free tier — the next tier is $29/mo, ~6× the $5 budget. At the anticipated 30+
  connectors, the long-tail-on-Composio economics hold **provided** their actions are
  low-sensitivity (egress acceptable) and volume stays in the free tier.

## What would change this

1. **ahOS goes multi-tenant** → the aggregator's vault value becomes real; per-user native
   re-consent (esp. LinkedIn's headless interactive flow) favours renting at breadth.
2. **Zero-egress is relaxed** (self-hostable aggregator / acceptable data posture) → removes
   the across-the-board disqualifier; the specific trigger to revisit **LinkedIn**.
3. **A provider revokes cheap native access** — Meta narrows own-account Standard Access
   (flips **Instagram**), or LinkedIn locks all posting behind MDP-partner refresh (flips
   **LinkedIn**).

## Consequences

### Positive
- One recorded default prevents re-litigating the aggregator question on every new connector.
- The routing registry makes the core/tail line *data*, not architecture: start fast on
  Composio, harden to native later, one row at a time.
- Honest cost accounting (custody ledger, bounded swappability) — no "$0, full control" myth.
- Consistent with ADR-017's deletable edge and ADR-029 (this repo is a thin tooling layer; an
  aggregator's agentic features add nothing).

### Negative
- Native accepts ~1–2 forced wire-format migrations/year in the Meta+LinkedIn cluster, plus
  LinkedIn's 60-day re-consent chore.
- The aggregator path adds a vendor dependency for the long tail (catalog/slug churn, free-tier
  policy risk, token egress) — accepted only for low-sensitivity providers behind the port.

### Neutral
- Own substrate (Supabase/PostHog/Firebase) is explicitly out of the aggregator path; `routing`
  records it as `own_substrate`.
- LinkedIn DM remains out of scope (ADR-017): no compliant cheap route.

## Alternatives considered

- **Aggregator-first for everything (ADR-017's name-drop, taken literally):** rejected — token
  + payload egress for the whole private knowledge surface, for mechanics that are free or
  cheap natively at single-user volume.
- **MCP-server-per-provider:** rejected portfolio-wide — redundant MCP-in-MCP behind our own
  gateway, or worse (archived/sunset/single-maintainer).
- **Native-only, no aggregator ever:** rejected at the projected 30+ breadth — the long tail of
  low-sensitivity, churny providers is exactly where renting earns its keep once egress is
  acceptable.

## References

- ADR-017 (correspondence edge / boundary): `docs/ADRs/ADR017_Knowledge_Grounded_Correspondence_Edge.md`
- ADR-029 (thin tooling layer, no agent framework): `docs/ADRs/ADR029_No_LangChain_LangSmith_Or_Agent_SDK.md`
- Design principles (build vs rent): `docs/design/design-principles.md`
- Connector feasibility & cost: `docs/research/social-connectors-feasibility.md`
- Native exemplar: `packages/mcp-server/src/google/drive.ts`
- Composio LinkedIn version caveat: https://github.com/ComposioHQ/composio/issues/3113

## Appendix — coverage matrix (condensed, native = PICK for all 8)

| Provider | Native (PICK) | MCP server | Aggregator | Conf |
|---|---|---|---|---|
| Gmail | reuse existing Google refresh token + scope; $0; no egress | official connector is draft-only (can't send); GongRzhe archived | Composio works but vaults token + egresses content | high |
| Google Calendar | same Google token + calendar scope; stable since 2014 | nspady adds 2nd OAuth app + a process | vault moot single-user; egress | high |
| Notion | already shipped (`notion.ts`); static token never expires | hosted needs interactive OAuth + drops block-edit; OSS sunset | managed-refresh moot for static token; egress | high |
| Slack | `@slack/web-api`, static xoxb never expires; backoff+pagination | official archived; korotovsky = MCP-in-MCP + fragile xoxc/xoxd | vault custody + payload egress for nothing native lacks | high |
| LinkedIn (post) | `POST /rest/posts`; 60-day interactive re-consent; ~annual sunset | community single-maintainer; same gate + supply-chain risk | Composio (egresses) viable; Unipile/Ayrshare bust budget | med |
| X / Twitter (post) | twitter-api-v2; rotating refresh → writable store; $0 conn | community thin, weaker refresh | churn-shield real but BYO X keys everywhere + egress | high |
| Instagram (post+DM) | own-account Standard Access (publish + in-window DM), no review; 60-day refresh cron | community thin (23–24 tools for 2 actions) | Ayrshare absorbs review but post-only; Composio/Unipile egress | med |
| WhatsApp (message) | Cloud API one POST, static System User token never expires | personal web-bridge = wrong/ToS-violating channel | doesn't absorb biz-verify + template gate; egresses | high |
