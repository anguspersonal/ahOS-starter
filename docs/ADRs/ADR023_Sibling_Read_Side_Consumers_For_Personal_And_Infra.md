# ADR-023: Sibling read-side consumers for personal and infra workspaces

**Status:** Superseded by [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md)
**Date:** 2026-06-20
**Accepted-on-dev:** 2026-06-20
**Deciders:** Angus (solo maintainer)
**Tags:** architecture, synthesis, skills, workspace, dos
**Builds on:** ADR-013 (capture primitive + memory/working-state split), ADR-018 (unified capture surface + synthesis-time interpretation, currently Proposed), ADR-022 (State Doc is a projection)

## Context

ADR-018 established the intended single capture substrate in ahkms and moved
interpretation to read time. That ADR is still `Proposed`; this ADR adopts the same
read-side interpretation model for the sibling-consumer decision, and should be
revisited if ADR-018 is materially revised before acceptance. The first live synthesis
consumer, `.claude/skills/dos-eod/`, is explicitly
Work-only: it infers workspace per atom, filters to `workspace=work`, and writes
to a Work Notion working-state surface.

That leaves a gap for atoms that are valid captures but are not Work work:

- **personal** atoms, which should land in a personal working-state surface, not the
  Work State Doc
- **infra** atoms, such as repo architecture and tooling work, which are often better
  consumed into repo-native artifacts like issues and ADRs rather than Notion

Issue #91 identified that gap. The question is whether to broaden `dos-eod` into a
single multi-workspace dispatcher or to add sibling consumers.

## Decision drivers

- **Keep the capture model stable.** Capture stays dumb; workspace/type/domain
  interpretation remains a synthesis concern.
- **Preserve strong skill contracts.** `dos-eod` already means "Work EOD synthesis."
  Broadening it would make invocation semantics fuzzy.
- **Match the destination to the work.** Personal work and infra work do not share the
  same canonical working-state surface.
- **Reuse the substrate and lineage model.** The same artifacts and `consumed_by_state`
  pattern should work across consumers.
- **Avoid taxonomy coupling.** Work domains and priorities should not leak into
  personal or infra consumers.

## Considered options

### Option A - Generalize `dos-eod` into a multi-workspace router

One skill infers workspace and then branches internally into Work, personal, or
infra write paths.

- **Pros:** one entry point; centralizes read-side logic.
- **Cons:** weakens the existing `dos-eod` contract; mixes unrelated taxonomies and
  destinations in one skill; makes the most mature consumer harder to reason about.

### Option B - Add sibling consumers for each workspace family (chosen)

Keep `dos-eod` scoped to Work. Add separate read-side consumers for personal and
infra work, each reading the same substrate but projecting into its own destination.

- **Pros:** preserves clear contracts; lets each consumer define its own taxonomy and
  projection rules; fits ADR-018's "many consumers, one substrate" model.
- **Cons:** more skill surfaces; some repeated orchestration shape across consumers.

### Option C - Stamp workspace at capture time

Classify atoms as Work / personal / infra when they are captured, then let one or
more consumers filter on stored tags.

- **Pros:** cheaper reads later; less repeated inference.
- **Cons:** violates ADR-018's capture-time boundary; forces routing policy into the
  producer path; creates drift and reclassification problems.

## Decision

We choose **Option B**.

### 1. `dos-eod` stays Work-only

The current skill remains the Work business operating-system consumer. It continues
to read ahkms artifacts, infer workspace/type/domain at read time, filter to
`workspace=work`, and project into the Work Notion surfaces.

### 2. Personal and infra become sibling consumers

Two additional consumer families are introduced:

- **`dos-personal`** for personal-life and personal-ops synthesis
- **`dos-infra`** for repo, architecture, tooling, and system-design synthesis

They are siblings of `dos-eod`, not branches inside it.

### 3. Workspace partition is explicit

For now the synthesis layer treats workspace as:

- `work`
- `personal`
- `infra`
- `other`

`other` remains uncaptured by any specific projection until a future consumer needs it.

### 4. Destinations differ by consumer

- **Work:** Work Notion working-state surfaces
- **Personal:** personal working-state surfaces, expected to be wired via the user's
  own Notion integration config
- **Infra:** repo-native artifacts, such as GitHub issues, ADRs, architecture notes, or
  issue comments, not a Notion DOS by default

This follows ADR-013's memory vs working-state split while acknowledging that infra
work's canonical surface may be the repo itself.

### 5. Lineage stays shared

All consumers continue to mark positive consumption via the lineage-link mechanism from
ADR-013 and ADR-018. The downstream `provider`, `kind`, and `external_id` differ by
consumer, but the substrate pattern does not.

### 6. Taxonomies are consumer-local

Workspace/type/domain inference remains read-side, but each consumer owns its own domain
list, priority scheme, and output conventions. Work priorities are not reused for
personal or infra synthesis by default.

## Consequences

### Positive

- Clear consumer boundaries and invocation semantics
- Shared substrate with no producer-side branching
- Repo-native handling for infra work instead of forcing it into Notion
- Freedom to evolve personal and infra taxonomies without destabilizing Work EOD

### Negative

- More skill surfaces to maintain
- Some orchestration logic is structurally similar across consumers
- Personal Notion wiring and infra sink conventions still need follow-up implementation

### Neutral

- This does not change capture semantics
- This does not change the existing Work `dos-eod` flow

## Links

- Related issue: #91
- Builds on: [ADR-013](./ADR013_Capture_Primitive_and_Memory_Working_State_Split.md),
  [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md),
  [ADR-022](./ADR022_State_Doc_Is_A_Projection_Not_An_Overflow_Sink.md)
