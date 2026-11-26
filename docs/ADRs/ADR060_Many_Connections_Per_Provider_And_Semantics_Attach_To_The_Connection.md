# ADR-060: A provider can have many connections, and metric semantics attach to the connection

- **Status:** Accepted
- **Created:** 2026-08-24
- **Accepted-on-dev:** 2026-08-24
- **Deciders:** Angus (solo maintainer)
- **Builds on:** [ADR-030](./ADR030_Skill_Config_In_DB_Not_Reference_Files.md),
  [ADR-032](./ADR032_Native_First_Connector_Sourcing.md),
  [ADR-045](./ADR045_Integration_Credential_Boundary_And_Multi_Tenancy_Seams.md)

## Context and problem

ADR-032 classified PostHog as `own_substrate`: direct, our credentials, never an
aggregator. ADR-045 put every provider secret behind `getCredential(provider)`.
Both were written assuming **one connection per provider**, and for the providers
they covered that assumption held.

PostHog breaks it. The realistic set is four or more PostHog projects that have
nothing to do with each other: Work's product analytics, the ahkms platform's
own telemetry, a personal app, and a family member's portfolio site. They may sit
in **separate PostHog accounts** (separate logins, separate keys) and in
**separate regions** (`us.posthog.com` / `eu.posthog.com` / self-hosted). The list
changes for reasons that have nothing to do with this codebase.

The tempting precedent is the Google work that landed immediately before this
(`google/accounts.ts`): a `GoogleAccount = "personal" | "work"` union in code,
one `CREDENTIALS` entry per account, an `account` parameter on every tool. That
pattern is **honest for Google and wrong for PostHog**. Adding a Google account
requires an OAuth consent ceremony with a human in a browser, so it can never be
pure config, and a two-value enum records a real constraint. Adding a PostHog
project is typing an integer. If that needs a pull request and a Railway deploy,
the design has encoded the wrong thing.

Separately, [#742](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/742)
records an unsettled test-account filter contract that has already produced a real
reporting error: install-to-paid reported as **7%** when the true figure is 1-2%.
`docs/analytics/metrics.yml` in `example-org/core` explains the mechanism in one line:
*"Raw HogQL queries BYPASS [filterTestAccounts] and must filter manually."*

These read as two unrelated problems. They are one problem. Everything that makes
a Work number trustworthy (the `filterTestAccounts` basis, the dev cohorts
`168929` / `168904` that live in PostHog project settings outside the repo, the
`is_test` event property, `$lib` platform scoping for a project shared by the app
and every web surface) is a fact about **project 110015**. None of it is a fact
about PostHog, and none of it is true of a portfolio site.

## Decision drivers

- Adding a connection must be **data, not a deploy**. The list changes for
  non-technical reasons.
- The Google enum must not be copied where the ceremony that justifies it is
  absent. Symmetry is not itself a reason.
- Secrets stay in env or a vault, **never** in `user_integrations` (ADR-045,
  migration 046's own header).
- The failure mode to design against is a **silently wrong number**. A wrong
  email is loud: a 403, or an empty result set. A wrong metric is plausible,
  well-formatted, and arrives with no signal at all. Every affordance here is
  chosen against that asymmetry.
- #742's contract must bind somewhere a per-routine prompt cannot bypass.
- Region and credential cannot be global. One key may cover several projects in
  one organisation while another account shares nothing with it.

## Considered options

### Option A - A `PostHogProject` union in code, mirroring `GoogleAccount`

- **Pros:** symmetric with the Google seam shipped last week; compile-time
  exhaustiveness; typed tool inputs via the existing `googleAccountInput`
  precedent.
- **Cons:** adding a project becomes a PR plus a deploy in exchange for an
  integer; `CredentialProvider` is a closed union with a `Record` over it, so four
  connections means four hardcoded `CREDENTIALS` entries; no per-connection
  enable/disable or connection health; and it copies a constraint (OAuth consent
  per account) that does not exist for PostHog.

### Option B - One `posthog` row whose `config` holds a `connections` map

- **Pros:** one row; no provider-naming question; no new rows to reason about.
- **Cons:** discards the per-row `credential_ref`, `enabled` and `status` columns
  that migration 060 added, which are exactly what four separate API keys need;
  and the map re-implements, inside JSON, three columns the table already has.

### Option C - One `user_integrations` row per connection (chosen)

`provider` becomes `<provider>:<slug>`, e.g. `posthog:work`, `posthog:ahkms`.

- **Pros:** **zero schema change**. Verified against migration 046: `provider` is
  `text NOT NULL` with `UNIQUE (user_id, provider)` and no check constraint or
  enum. Migration 060 already added per-row `credential_ref`, `routing` and
  `status`, so per-connection credentials, routing and health come free. Adding
  a connection is one row.
- **Cons:** "all connections for a provider" becomes a prefix query rather than a
  keyed lookup, so `loadIntegrationConfig(provider)` gains a sibling; and a
  free-text provider column now carries structure that nothing enforces, so the
  slug convention is a convention rather than a constraint.

## Decision

We chose **Option C**, with five parts.

### 1. The connection is the unit, and it lives in `user_integrations`

One row per connection, `provider = "<provider>:<slug>"`. PostHog is the first
provider to occupy more than one row; the mechanism is general, and RevenueCat
degenerates to a single row without being special-cased.

### 2. Three separable fields, not one

`host` (region, or a self-hosted origin), `credential_ref`, and the project id are
**separate**. Collapsing credential and project is the mistake that makes the
shared-organisation case unrepresentable: one key can legitimately reach several
projects, while a different account shares nothing.

### 3. `getCredential` accepts a ref string

`CredentialProvider` stays a closed union for the fixed providers. Connection
-scoped providers resolve through a ref, `posthog:work` to
`POSTHOG_API_KEY_WORK` by convention today. This is inside ADR-045's intent
rather than against it: the function is already `async` and already carries the
comment marking the `credential_ref` to vault insertion point. The vault swap
later is a body change, not a re-thread.

### 4. The semantics contract attaches to the connection

This is the half that resolves #742 rather than merely relocating it.

The metric semantics contract is a **per-connection attachment**, referenced by
the `posthog:work` row. The "where does `metrics.yml` live, given it is in
`example-org/core` and the tool is in ahkms" question dissolves: it is not a global
the tool consults, it is one connection's contract. And #742 gets smaller, because
that decision is **scoped to one connection, not to the tool**.

One rule falls out of this, and it matters:

> A connection with **no** contract declared must not read the same as one with an
> **empty** contract. Unknown is not clean.

An acting portfolio site legitimately has no test-account machinery, and says so.
A newly added Work-shaped project that nobody has written a contract for is a
different state entirely, and must be reported as unknown rather than rendered as
a clean number.

### 5. Three rules on the read surface

- **Never aggregate across connections.** Summing Work's house-filtered users
  with an unfiltered pageview count is a meaningless number. Fan-out returns a
  per-connection breakdown and no total.
- **Every result names its connection, project id and region.** This is the direct
  carry-over from the Gmail work: `getProfile` printing
  `owner@work.example.com` is the single line that proved the account was right,
  and its absence is what would have hidden a wrong one.
- **A configured default connection is fine**, provided the answer always says
  which one it used.

## Consequences

- **Good:** adding your brother's site is one row, no deploy. Per-connection
  enable, disable and health come from columns that already exist. #742 becomes a
  one-connection decision. The three read-surface rules make the 7%-class error
  visible at the point it would occur rather than downstream of it.
- **Good:** the same mechanism serves the other `own_substrate` providers
  (Supabase, Firebase) when they need it, without a second design.
- **Cost / bad:** a free-text `provider` column now carries meaning nothing
  enforces, so a typo'd slug is a missing connection rather than an error. A
  prefix-query sibling to `loadIntegrationConfig` has to exist. And naming every
  result with its connection is more verbose than the single-tenant output it
  replaces, which is the intended trade.
- **Deliberately not decided:** Google is **not** retrofitted into this. Its
  accounts need a consent ceremony each, so they will never be pure config, and
  the enum there records a real constraint. The convergence is noted, not chased.
- **Follow-up, unverified and to be checked against the live API before any code
  depends on it:** PostHog's project-enumeration endpoint (so connection rows are
  written from what a key actually reaches rather than hand-typed), whether
  personal API keys can be scoped per-project, and the HogQL cohort-filter syntax
  that the person-level leg of the Work contract would need. The rule that
  produced three wrong guesses at the Gemini sender applies here too: write the
  contract from observed reality, not from assumption.

## Links

- Related: [ADR-030](./ADR030_Skill_Config_In_DB_Not_Reference_Files.md),
  [ADR-032](./ADR032_Native_First_Connector_Sourcing.md),
  [ADR-045](./ADR045_Integration_Credential_Boundary_And_Multi_Tenancy_Seams.md)
- Binds: [#742](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/742)
  (test-account filter contract),
  [#647](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/647)
  (the `posthog_query` proxy this ADR reshapes)
- Evidence: `supabase/migrations/20260606130000_046_add_user_integrations.sql`
  (provider column shape),
  `supabase/migrations/20260629120000_060_extend_user_integrations_routing.sql`
  (`credential_ref` / `routing` / `status`),
  `packages/mcp-server/src/credentials.ts` (the seam),
  `docs/analytics/metrics.yml` in `example-org/core` (the Work contract's content)
