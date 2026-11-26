# ADR-086: PostHog writes travel on a second key, and history-restating edits must be acknowledged

- **Status:** Accepted
- **Accepted-on-dev:** 2026-09-14
- **Created:** 2026-09-09
- **Deciders:** Angus (solo maintainer)
- **Tags:** architecture, connectors, permissions, analytics
- **Builds on:** [ADR-045](./ADR045_Integration_Credential_Boundary_And_Multi_Tenancy_Seams.md) (seam 1: one place resolves a provider's secret),
  [ADR-060](./ADR060_Many_Connections_Per_Provider_And_Semantics_Attach_To_The_Connection.md) (the connection is the unit of semantics, and every result names it),
  [ADR-079](./ADR079_Per_Class_Handling_Is_A_Capability_And_Write_Out_Is_Earned.md) (write-out is earned rather than configured)

## Context and problem

`packages/mcp-server/src/posthog/client.ts` shipped with an explicit property in its own
header: **read-only by construction**. There was no write helper, and the personal API
key was scoped `project:read` plus query read, so the boundary was enforced at the token
as well as at the tool surface. The comment named the reason it was possible at all:
Gmail could not do this, because Google has no drafts-but-never-send scope, and PostHog
can.

On 2026-09-09 that property became the bottleneck. A device-farm cohort in project 110015
needed four edits over one morning. Each one required the maintainer to click through the
PostHog UI while the agent held the diagnosis, and two of the four went in wrong:

- The cohort matched `US` **or** `zh-Hans` where it meant `US` **and** `zh-Hans`, because
  the two conditions were separate criteria under `Match any` rather than two filters
  inside one criterion. That deleted the entire United States install base from every
  house-filtered metric, and had been doing so for weeks before anyone looked.

- The criterion keyed on `Application Installed`, an event the target devices never fire.
  The traffic it existed to exclude was untouched while real users were removed.

The cost was not the clicking. It was that a change nobody could diff landed silently and
restated history: one save moved 3 September's recorded auth failures from 11 to 1.

## Decision drivers

- Cohort and project-filter edits are applied at **query time to all history**, so saving
  one rewrites every past number rather than changing what happens next
- ADR-060 makes the connection the unit of semantics, and every result carries its stamp;
  a change stamped with one connection must not have been made to another
- The read path's token-level guarantee is worth more than the convenience that would
  destroy it
- A guard that fires after the write has landed is not a guard

## Considered options

**A. Keep it read-only.** Rejected: the maintainer is the bottleneck for a change the
agent can specify precisely, and hand-transcription is exactly where two of four edits
went wrong.

**B. Narrow per-resource tools** (`posthog_cohort_update` and friends). Recommended at the
time and not chosen. It models each resource, which reads safer, but a half-modelled
passthrough gives the impression of a safety net that only covers the endpoints somebody
remembered to model.

**C. General write passthrough.** **Chosen**, by the maintainer, over the recommendation
above. It is the widest surface and it discards the read path's guarantee by
construction, so the compensating controls have to be real rather than advisory.

**D. Widen the existing key's scopes.** Rejected as the credential design. It is the
simplest change and it removes the only guard that survives a bug in this codebase.

## Decision

**Writes exist, on a second credential, behind two independent switches, and the two
classes of irreversible change must be acknowledged explicitly.**

1. **A separate write credential.** `POSTHOG_API_KEY_<SLUG>_WRITE`, resolved through
   ADR-045's seam via `getCredential(ref, { write: true })`. Reads keep travelling on the
   read key, so no bug in the guards can turn a read into a write, and the write key's own
   scopes stay the last line of defence. There is deliberately **no fallback** to the read
   key: a write attempted with a read-scoped key fails at PostHog as a 403 about scopes,
   which reads as "the API changed" rather than "the write key was never minted".

2. **Per-connection opt-in.** `write_policy` on the connection config, with the same
   three-state shape as `filter_policy`: `allowed`, `forbidden`, and absent. **Absent
   refuses.** Undeclared is not the same as permitted, for the same reason ADR-060 says
   undeclared is not the same as clean.

3. **A project-scope check.** A path naming `/api/projects/<id>/` must name the
   connection's own project. A passthrough that accepts an arbitrary path can otherwise
   leave the connection it claims to be acting as, and the stamp is the thing this whole
   surface is built on.

4. **Acknowledgement for irreversible classes.** `acknowledge_destructive` for `DELETE`,
   and `acknowledge_retroactive` for cohort and project-filter paths. The second is the
   one that earns its place: those edits restate history, and the refusal message carries
   the 11-to-1 measurement rather than a general warning, because a caveat that does not
   name a number does not survive being quoted.

5. **A before-image on retroactive writes**, read on the read credential, best-effort. It
   puts what was overwritten in the transcript at the moment of the change. Non-fatal,
   because failing to show the old value is not a reason to refuse a write the caller
   explicitly acknowledged.

**Not decided here:** whether the write key exists at all in any given deployment. Leaving
it unset is the safe default and keeps every read working.

## Consequences

- **Good:** a cohort fix is now a diffable call with a before-image, rather than four UI
  clicks nobody can review. The failure that motivated this ADR would have been visible in
  the transcript the first time.
- **Good:** the read surface keeps its original property, in full, and can still be
  described as read-only by construction.
- **Cost:** the passthrough does not validate request bodies, by design. A malformed body
  reaches PostHog and fails there. That is the accepted price of option C, and it is the
  reason option B was recommended.
- **Cost:** two switches means two ways to be confused about why a write refused. Both
  error messages name the exact variable or config field that would satisfy them.
- **Watch:** if the passthrough is used mainly for two or three endpoints in practice,
  that is evidence for option B after all, and this decision should be revisited rather
  than defended.
