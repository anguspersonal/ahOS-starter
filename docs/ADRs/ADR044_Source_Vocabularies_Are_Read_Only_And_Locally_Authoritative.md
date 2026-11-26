# ADR044: Source vocabularies are read-only and locally authoritative — normalisation belongs to the consumer

- **Status:** Accepted
- **Created:** 2026-08-02
- **Accepted-on-dev:** 2026-08-02
- **Deciders:** Angus (solo maintainer)
- **Tags:** architecture, ontology, connectors, taxonomy
- **Builds on:** [ADR-023](./ADR023_Sibling_Read_Side_Consumers_For_Personal_And_Infra.md) (§6 taxonomies are consumer-local), [ADR-032](./ADR032_Native_First_Connector_Sourcing.md), [ADR-033](./ADR033_External_Vocabulary_Adoption.md)

## Context and problem

ahOS reads from task systems it does not own. Those systems carry their own priority
vocabularies, status taxonomies, and domain lists — and several of them are **shared team
workspaces** whose naming is a collective artefact, not a personal preference.

The force requiring a decision surfaced concretely in #471. That issue proposes consolidating
the Work Tasks DB `Priority` select — which carries `High`/`Medium`/`Low` **and** `P0`–`P4`
simultaneously — onto `P0`–`P4` alone, migrating existing rows. Its stated rationale is that
doing so would "make the `Normalised Priority` formula's mapping table trivial."

That rationale inverts the dependency. It proposes mutating a **source** system so that a
**consumer's** mapping gets simpler. Two things are wrong with it:

1. **Mapping heterogeneous vocabularies is the feature, not an obstacle to it.** If ahOS is to
   hold one prioritised view across any task database a user has, heterogeneous vocabularies
   are the normal case, not a defect to be cleaned up at each source. A source that needs no
   mapping is not a better source; it is one that happened to be easy.
2. **The blast radius is other people's.** Work is a shared workspace. Re-labelling its
   `Priority` vocabulary to serve one user's normalisation reaches into a team's surface and
   rewrites metadata the team relies on. A user-scoped consumer must not impose its taxonomy
   on a shared producer.

An agent came within one confirmation of executing that migration during an AFK session
(2026-08-02), which is what prompted writing the principle down rather than leaving it as
instinct.

## Decision drivers

- **Legibility at the source beats uniformity for the consumer.** A priority label has one
  job: be readable at a glance by the person triaging. `High`/`Medium`/`Low` needs no
  training; `P0`–`P4` requires a decoder page — and one has already had to be written. If a
  scale needs documentation to be read, the documentation is evidence the scale failed, not a
  remedy for it.
- **Shared surfaces have non-consenting stakeholders.** Changes to a team workspace's
  taxonomy are paid for by every teammate, repeatedly, and they did not ask for it.
- **Consistency with [ADR-023](./ADR023_Sibling_Read_Side_Consumers_For_Personal_And_Infra.md) §6.** "Taxonomies are consumer-local … Work priorities are not
  reused for personal or infra synthesis by default." This ADR is the producer-side mirror of
  that already-accepted rule.
- **Reversibility.** Mapping is a pure function that can be corrected in one place at any
  time. A migration of live rows in a third-party system is not meaningfully reversible —
  the prior values are gone.
- **Blast radius asymmetry.** Getting a mapping wrong yields a mis-sorted list. Getting a
  migration wrong corrupts a team's task metadata irrecoverably.

## Considered options

### Option A — Normalise at the source: migrate each source onto a canonical vocabulary

- **Pros:** the consumer's mapping table becomes trivial; one vocabulary to reason about;
  no per-source mapping to maintain.
- **Cons:** mutates systems ahOS does not own; imposes a personal taxonomy on shared team
  surfaces; irreversible; does not scale — every newly connected source demands a migration
  before it is usable; and the migration is precisely the class of bulk external write that
  should never be autonomous.

### Option B — Normalise at the consumer: sources stay untouched, ahOS maps inbound

- **Pros:** no writes to systems ahOS does not own; each surface keeps the vocabulary its
  users chose; new sources are connectable immediately by adding a mapping; mapping errors
  are cheap and correctable; mirrors ADR-023 §6.
- **Cons:** ahOS must maintain a mapping per source vocabulary; ambiguous or unmapped values
  need an explicit fallback; a mapping is another thing that can silently drift from its
  source's option list.

## Decision

We chose **Option B**.

**ahOS treats every source vocabulary as read-only and authoritative for that surface.**

Concretely:

1. **No ahOS component writes to a source system's vocabulary or taxonomy** — not its select
   options, not the values on existing records. Normalisation is a read-time projection, never
   a write-back.

   This binds **ahOS and its agents**, not the humans who own the source. A workspace owner
   remains free to change their own vocabulary for their own reasons — what this ADR forbids
   is ahOS making that change *on their behalf, to suit its own normalisation*. The test is
   whose interest the edit serves: an owner reordering options because the sort order is wrong
   for their team is in bounds; ahOS rewriting values so its mapping table shrinks is not.
   Where an owner-directed change to a shared surface is warranted, it is raised as a
   `needs-angus` issue and performed by a human, not automated (worked example: #485).
2. **The source's vocabulary is authoritative for that surface.** Where a source is a shared
   workspace, its naming persists as the team defined it. A user-scoped consumer defaults to
   not overriding shared-workspace naming.
3. **Normalisation is the consumer's job and lives in the consumer.** A normalised score is
   derived for ahOS's own ranking; it does not license editing the source value it was
   derived from.
4. **Unmapped values fail visibly, not silently.** An unrecognised source value must surface
   as unmapped rather than defaulting into a tier where it disappears from ranked views.

### Scope note — a related question this ADR does NOT settle

The premise that *"ahOS keeps a map of a user's tasks across any task database they have, in
a single prioritised list"* is an **assumption, not a recorded decision**. No ADR establishes
it. [ADR-023](./ADR023_Sibling_Read_Side_Consumers_For_Personal_And_Infra.md) arguably points
away from it: sibling read-side consumers with consumer-local taxonomies and separate
canonical surfaces is a different shape from one unified cross-source list.

This ADR is deliberately narrower and holds either way — a source vocabulary should be
read-only whether ahOS aggregates across sources or keeps them siblings. The aggregation
question needs its own ADR and belongs in
[ADR-020](./ADR020_Open_Contradictions_To_Resolve.md)'s register until settled.

## Consequences

- **Good:** ahOS can connect a new task source without negotiating a migration first. Shared
  team surfaces are protected from user-scoped taxonomy changes by rule rather than by
  vigilance. Mapping errors stay cheap.
- **Good:** gives agents an unambiguous stop sign. "Consolidate the source vocabulary" is now
  a recognisably out-of-bounds proposal rather than a plausible cleanup.
- **Cost / bad:** ahOS carries a mapping per source vocabulary, and each can drift when a
  source adds a select option. Sources keep whatever internal inconsistency they have —
  including a `Priority` select carrying two vocabularies at once — and ahOS must tolerate it.
- **Cost / bad:** deliberately declines a real simplification. Consolidating would genuinely
  make the mapping trivial; this ADR says that benefit does not justify the cost of writing to
  a shared source.
- **Follow-up:** #471 was closed `wontfix` under this ADR (2026-08-02). Its migration half is
  out of bounds here, and independently had no functional benefit: `Normalised Priority` is a
  *formula*, computed on read, so there was never anything to backfill — and
  [ADR-040](./ADR040_State_Doc_Write_Through_Projection.md) §3's formula already handles both
  vocabularies. Its "document the mapping" half was already satisfied by that same section.
- **Follow-up:** the AFK protocol's hard rails (`.claude/skills/afk/SKILL.md` §7) cover
  destructive *database* operations but are silent on bulk writes to external systems. Add
  external-system record mutation as a human gate.
- **Follow-up:** the live sort defect this investigation surfaced — the Work Tasks DB
  "All Tasks" view sorts by `Priority` ascending, and because Notion orders a select by option
  order (`High, Medium, Low, P0…P4`), a `P0` sorts below every `Low` — is fixable **within**
  this ADR by reordering select options or sorting on `Normalised Priority` per ADR-040 §2.
  Neither touches a row value. Tracked as #485, as an owner-directed Notion-UI action per
  clause 1 — deliberately not automated, because the only programmatic route
  (`ALTER COLUMN … SET`) may drop and recreate options and so could clear every row's value.

## Links

- Related: [ADR-023](./ADR023_Sibling_Read_Side_Consumers_For_Personal_And_Infra.md) §6 (taxonomies are consumer-local — the consumer-side mirror of this rule)
- Related: [ADR-033](./ADR033_External_Vocabulary_Adoption.md), [ADR-041](./ADR041_Public_Vocabularies_As_LLM_Scaffolding.md) (external vocabulary adoption)
- Related: [ADR-040](./ADR040_State_Doc_Write_Through_Projection.md) §3 (the `Normalised Priority` formula)
- Prompted by: #471
