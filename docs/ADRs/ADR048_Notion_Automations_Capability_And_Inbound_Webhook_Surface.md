# ADR-048: Notion automations capability — inbound webhook surface + rule-type family

- **Status:** Accepted
- **Created:** 2026-08-05
- **Accepted-on-dev:** 2026-08-05
- **Deciders:** Angus (solo maintainer)
**Tags:** architecture, integrations, notion, webhooks, scheduler, act-layer
**Builds on:** ADR-023 (Notion as a system of record with sibling per-workspace consumers), ADR-040 (write-through projection — Act-layer hygiene on the system of record), ADR-045 (credential boundary: secrets in env, non-secret wiring in `user_integrations`)
**Resolves:** #546 (Completed-at stamping for the personal workspace)

---

## Context and problem

The personal Notion workspace has no native database automations — that feature
is plan-gated, and the personal workspace is on the free plan. The personal
Tasks DB's `Completed at` column exists but nothing stamps it, so "Done today"
queries silently return nothing (found by #526's tick-test). We need something
that reacts to a task being ticked Done and keeps the column truthful.

Two structural questions follow:

1. **How do changes in Notion reach ahOS?** Everything so far is outbound or
   polled — the system has **no inbound webhook surface**. Adding one changes the
   system's shape (a new unauthenticated-by-OAuth route on the mcp-server HTTP
   app), which per ADR-039 §2 requires an ADR plus a same-PR `architecture.md`
   sync.
2. **What is this capability, architecturally?** A one-off "stamp Completed-at"
   hack, or the seed of a "manage Notion" automations family?

This is Act-layer hygiene on the Notion system of record (ADR-023 / ADR-040
territory): zero contact with capture/artifacts/atoms, no interpretation-at-write
(ADR-018 untouched).

## Decision drivers

- Works on the **free personal workspace** (native automations are plan-gated;
  integration webhooks are not).
- Timestamp fidelity: `Completed at` should reflect **when the task was ticked**,
  not when a poller noticed.
- No new secrets outside env; no hardcoded ids/property names in source
  (ADR-045 posture).
- Loop safety: the automation's own writes must not re-trigger it indefinitely.
- Resilience: a missed event must not mean a permanently wrong column.
- The capability should grow (more rules) without growing the attack surface
  (more routes).

## Considered options

### Option A — Native Notion database automation

- **Pros:** Zero code, zero infra, runs inside Notion.
- **Cons:** **Unavailable** — plan-gated off the free personal workspace. This is
  the gap that created the issue.

### Option B — Polling only (scheduled sweep, no webhook)

- **Pros:** No new inbound surface; reuses the existing scheduler patterns
  (cadence + single-flight lock) wholesale.
- **Cons:** Loses timestamp fidelity — a daily poll can only stamp
  `last_edited_time` (or worse, poll time), not the moment the status changed;
  sub-day latency requires aggressive polling against a rate-limited API.

### Option C — Notion integration webhooks + reconciliation sweep (chosen)

- **Pros:** Integration webhooks are a **different feature** from native DB
  automations and are not plan-gated — they work for the free personal
  workspace. `page.properties_updated` events carry the change timestamp, so
  stamps are faithful. The sweep (Option B demoted from primary to net)
  converges anything the webhook missed.
- **Cons:** First inbound webhook surface — a new route that must authenticate
  deliveries itself (HMAC), plus a verification-token secret to manage.

### Option D — Third-party automation service (Zapier, Make, …)

- **Pros:** No code; UI-configured.
- **Cons:** A new external dependency and subscription; spreads the Notion token
  into another vendor's vault (against the ADR-045 posture of one env-resident
  secret per provider); rules live outside the repo, invisible to review and CI.

## Decision

We chose **Option C**, with two framing decisions beyond the mechanism:

1. **The inbound webhook surface joins the existing mcp-server HTTP app** as
   `POST /webhooks/notion`, mounted OUTSIDE the OAuth bearer gate (Notion cannot
   do an OAuth dance). Authenticity comes from Notion's `X-Notion-Signature`
   HMAC-SHA256 (keyed by the subscription's `verification_token`, held in env as
   `NOTION_WEBHOOK_VERIFICATION_TOKEN`), verified timing-safely; invalid ⇒ 401,
   no processing. Until the token is configured, the endpoint logs the handshake
   token (for the operator to complete verification) and acknowledges without
   processing. Deliveries are ACKed 200 immediately and processed async.
2. **This is the seed of an automations capability family, not a hack.** v0
   ships exactly one rule type, `completed_at_stamp`; the family grows **by
   adding rule types under the same surface** (`user_integrations`
   `notion_personal.automations.<rule>` config keys, the same webhook route, the
   same sweep cadence), never by widening an existing rule or adding routes.

Rule v0 (`completed_at_stamp`): config-driven (data source id, status property
name, done-value set, completed-at property name — non-secret pointers in
`user_integrations`, per ADR-045). On a status change: Done + empty → stamp with
the **event timestamp**; not-Done + set → **clear** (the column reflects current
state; a re-done task gets a fresh stamp). Both branches no-op when already
correct, which terminates the loop the automation's own PATCH would otherwise
start. A daily reconciliation sweep (existing scheduler cadence/lock patterns,
own env gate `KMS_NOTION_AUTOMATIONS_ENABLED` on top of
`KMS_SCHEDULER_ENABLED`) converges drift: Done + empty → stamp from
`last_edited_time` (best effort), not-Done + set → clear. Webhook = fast path,
sweep = correctness net.

## Consequences

- **Good:** `Completed at` becomes truthful on the free personal workspace, with
  faithful timestamps on the fast path. The webhook surface, signature
  verification, config shape, and sweep are reusable as-is by every future rule
  type — the family grows without new surface. Substrate safety holds: no
  capture/artifact/atom contact.
- **Cost / bad:** A new always-on inbound route to keep secure (HMAC + secret
  rotation via the Notion UI handshake). Sweep stamps are approximate
  (`last_edited_time`, the true completion moment is gone). A new scheduler
  cadence needed a small migration (lock row + `scheduler_runs` CHECK widening,
  the migration-076 pattern). The rule's page/query calls pin Notion API version
  `2025-09-03` (data sources) while older client calls stay on `2022-06-28` —
  two pins until a deliberate migration.
- **Follow-up:** Operator steps post-deploy (subscription creation, env var,
  `set_integration_config`, re-run #526's tick-test) — tracked on #546. Future
  rule types arrive as `automations.<rule>` keys plus a handler, one PR each.

## Links

- Related: [ADR-023](ADR023_Sibling_Read_Side_Consumers_For_Personal_And_Infra.md) ·
  [ADR-040](ADR040_State_Doc_Write_Through_Projection.md) ·
  [ADR-045](ADR045_Integration_Credential_Boundary_And_Multi_Tenancy_Seams.md) ·
  [ADR-039](ADR039_ADR_Immutability_Metadata_And_Guards.md) (§2 same-PR
  `architecture.md` sync — done in this PR)
- Issues: #546 (this capability) · #526 (the tick-test that found the gap) ·
  #525 (token hygiene pairing) · #414 (work-workspace Completed-at sibling)
- Notion docs: [Webhooks](https://developers.notion.com/reference/webhooks) ·
  [Event delivery](https://developers.notion.com/reference/webhooks-events-delivery)
