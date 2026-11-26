# ADR081: A connector migrates into ahKMS when one connection cannot serve two accounts

- **Status:** Accepted (superseded in part by [ADR-106](./ADR106_GitHub_Actions_Migrate_Into_ahKMS_Under_Ledger_And_Approval_Gate.md) — the GitHub row and its reasoning)
- **Created:** 2026-09-08
- **Accepted-on-dev:** 2026-09-08
- **Deciders:** Angus

## Context and problem

Over 2026-09-07 and 08 the claude.ai connector list was audited and cut. Gmail,
Google Calendar, Notion, PostHog, GitHub Integration and Booking.com were
disconnected; ahkms, Supabase, Supabase-Work, Vercel, Claude in Chrome and
Filesystem were kept.

Each disconnection was decided on its own merits, which worked and did not
scale: the next candidate arrived (GitHub, then Supabase and Vercel) with no
rule to apply, and the reasoning had to be rebuilt each time. Halfway through,
"GitHub should go through ahKMS too" was proposed on the strength of the
consolidation alone, and reversed on inspection. A rule that only exists as a
sequence of individual calls will produce a wrong one eventually, and the
expensive direction of that error is building a client ahKMS did not need.

The forcing constraint is narrower than "consolidate", and naming it is the
point of this ADR.

## Decision drivers

- **Two domains, always.** Every workflow runs against a personal identity and a
  Work one (ADR-051 §11 makes the same split structural in the ritual). A
  capability that can only reach one of them is half a capability.
- **A first-party connector authenticates as one account.** One Gmail
  connection is one mailbox. There is no `account` parameter to pass.
- **Maintenance is not free.** A vendor's own MCP server tracks a vendor's own
  API. Reimplementing one means owning that tracking permanently.
- **ahKMS is a knowledge store.** Its reason to hold a credential is that the
  surface behind it produces atoms (ADR-046 §3's role ladder is about inputs,
  not operations).
- **Reachable from anywhere cuts both ways.** The point of ahKMS is that it works
  from a phone. Not every operation should.

## Considered options

### Option A: migrate every connector into ahKMS

- **Pros:** one credential surface, one auth story, everything reachable
  everywhere; connector list goes to one row.
- **Cons:** ahKMS acquires and must maintain clients for GitHub, Supabase and
  Vercel, none of which produce a single atom. Each tracks an API that changes
  without asking. It also puts `apply_migration` and `deploy_to_vercel` on a
  phone, and this repo already holds a standing rule that migrations are never
  applied from a session and `execute_sql` is for DML and reads, never DDL.
  A rebuilt Supabase client would recreate exactly the surface that rule guards,
  inside the system that is meant to be the safe-from-anywhere one.

### Option B: keep every connector, ahKMS holds only its own store

- **Pros:** nothing to build or maintain.
- **Cons:** fails the constraint that actually forced the question. One Gmail
  connector reaches one mailbox, so the Work account is simply unreachable,
  and no amount of connector configuration fixes it.

### Option C: migrate on the multi-account test, keep on the maintenance test

- **Pros:** answers the case that forced it, and answers the next three without
  re-deriving anything.
- **Cons:** a rule with an edge, since "one connection per account" is a property
  of the connector rather than of the service, and it can change under us.

## Decision

We chose **Option C**.

**A surface migrates into ahKMS when one connector connection cannot serve both
domains. It stays a connector when one connection covers everything, and the
maintenance cost of reimplementing it is real.**

| Surface | One connection covers both domains? | Outcome |
| --- | --- | --- |
| Gmail | No, one connection is one mailbox | **Migrated** (`gmail_*`, `account` required on writes) |
| Google Calendar | No, one connection is one calendar account | **Migrated** (`calendar_*`, both accounts in one read) |
| Google Drive | No | **Migrated** (`drive_*`) |
| Notion | No, two workspaces with disjoint page access | **Migrated** (`notion_work` / `notion_personal`) |
| GitHub | **Yes**, one account already spans personal and Work repos | **Connector** |
| Supabase, Vercel | Effectively yes: these are per-project MCP servers, so two projects are two connections and that already works | **Connector** |

Google is the clearest case and the reason the rule reads this way. A Google
refresh token is per ACCOUNT, not per service (ADR-045, and the scope-bundling
trap in it), so one token covers Drive, Calendar and Gmail for whichever account
consented. Two accounts therefore means two tokens and an `account` discriminator
at the tool boundary, which is a thing a client can express and a connector
cannot.

GitHub fails the test for a reason that is easy to miss: **it is one source for
both domains.** The same login sees `anguspersonal/*` and the Work repos.
Nothing is unreachable, so the constraint that forced the Google migration is
simply absent, and what remains is the maintenance argument, which points the
other way.

**Two independent tests agree on every row**, which is the main reason to trust
the line:

1. **Multi-account:** does one connection leave a domain unreachable?
2. **Does it produce atoms?** Gmail, Calendar, Drive, Notion and Slack feed the
   knowledge store. GitHub operations, Supabase and Vercel do not; they operate a
   service.

Where the two disagree in future, **the multi-account test wins**, because
unreachable is a capability gap and awkward is a preference.

### The exception this rule does not cover, and why it is not one

`github_ingest` (#1010) and `slack_ingest` (#1011) live in ahKMS while GitHub
and Slack operations do not. That is not an inconsistency: an ingest is not a
client. It reads one narrow slice, writes it to the store as artifacts, and can
never act on the source. It qualifies on the second test (it produces atoms) and
is unaffected by the first.

The credential split makes this concrete and enforced. `github` resolves
`GITHUB_TOKEN_INGEST`, a read-only classic token, with **no fallback** to
`GITHUB_TOKEN`, the fine-grained write-capable token the connector uses (#1021).
The nightly sweep therefore cannot write to GitHub even if a future edit tried to
make it; the token it holds is incapable of it.

## Consequences

- **Good:** the next connector answers itself. Both Google accounts are reachable
  for mail, calendar and files for the first time, from every surface.
- **Good:** ahKMS does not acquire three clients it would then have to track
  vendor API changes for, and DDL stays off the phone.
- **Cost / bad:** the connector list does not go to one row, so "which tool do I
  reach for" still has two answers. That is the price of the rule and is
  accepted.
- **Cost / bad:** the rule keys on a property of the connector, not of the
  service. If first-party connectors gain multi-account support, Gmail and
  Calendar would no longer qualify on test 1, though they would still qualify on
  test 2, and migrating back would be a regression, so this is a reason to
  re-read the ADR rather than to reverse it.
- **Follow-up:** Google Calendar is migrated on the read side only.
  `calendar_list_events`, `calendar_get_event` and `create_event` exist;
  `update_event`, `delete_event` and `respond_to_event` do not. The connector is
  now off, so **there is presently no way to move, cancel or RSVP to an event
  from any surface.** Migrating a surface obliges us to cover it, and this one is
  not yet covered.
- **Follow-up:** the same rule applied to skills is a separate and unfinished
  question (#1027): the claude.ai skill store has the same travels-nowhere
  property that forced this decision for connectors.

## Links

- Related: [ADR-045](./ADR045_Integration_Credential_Boundary_And_Multi_Tenancy_Seams.md): the
  credential seam, and why a Google token is per account rather than per service
- Related: [ADR-046](./ADR046_Per_Source_Ingestion_Policy.md): the role ladder, which is
  about inputs to the store and so underwrites the second test
- Related: [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md): one log per domain, the
  same personal/Work split made structural in the ritual
