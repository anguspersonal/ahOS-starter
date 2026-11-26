# ADR085: People, organization, place and event anchor to public classes; a documented key vocabulary, not new columns

- **Status:** Accepted
- **Created:** 2026-09-12
- **Accepted-on-dev:** 2026-09-12
- **Deciders:** Angus Hally

## Context and problem

[#173](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/173)
("ontology gap 5") found `entities.properties` sparse and inconsistent: most
rows carry no structured attributes, and the ones that do use ad-hoc JSONB
keys with no agreed shape. The issue's own comment thread already worked
through the options and reached a decision (2026-08-30, owner-approved):

> Anchor `people`, `organization`, `place` and `event` to their public
> classes, joining `concept`, which is the only entity type currently mapped
> to one. Let the property keys follow from those classes rather than being
> invented. No columns, no migration.

That decision is **Option A** from the issue thread, chosen over dedicated
columns (Option B) and doing nothing (Option C). This ADR is that decision's
write-up, verified against the actual code (the issue-thread analysis flagged
that it could not reach the graph database from its session and so could not
check current data or usage), and its concrete landing point in `vocab.ts`.

**Why this is a gap at all, and why columns were already rejected.**
[ADR-036](./ADR036_IRI_Grounded_Vocabulary_Self_Describing_Graph.md) §1a
defines a **total** mapping from Turtle triples into this schema, normative
for seed ingestion and `export_rdf`: a literal-valued predicate lands in
`entities.properties`, keyed by the predicate (`schema:birthDate` →
`properties.birth_date`). ADR-036 considered — and rejected — dedicated
columns for exactly this case (its "sketch 3"), on two grounds that still
hold: the values exist for only a minority of rows on a table of thousands
(poor cohesion), and the vocabulary axis is open, so columns need a migration
per extension where JSONB needs none. A column for `email` is therefore not a
neutral optimisation; it is a deliberate hole in a mapping two other
mechanisms already rely on being total.

**What is actually anchored today.** Of the twelve `ENTITY_TYPES`
(`packages/mcp-server/src/vocab.ts`), only `concept` carries an external class
mapping — `ENTITY_TYPE_CLASS_CONTEXT.concept = "skos:Concept"`, added under
ADR-033/#209. `event`, `organization` and `place` were added to the CHECK
constraint (migrations 054/063) with no class mapping at all, and `people`
never got one either. Nothing tells a reader (or an extracting agent) that a
`people` row's `role` key means anything in particular — the type is not
anchored to any published vocabulary, so there is no external class for a key
set to fall out of. That is the gap #173 is actually pointing at for its
"vocabulary problem" half.

**What the code already does, independent of any schema.** Reading the
current tools past the issue's own two-months-old row counts, three of the
four entity types already have a de facto property-key convention that
predates this ADR:

- `packages/mcp-server/src/tools/people.ts` — the `people_*` MCP tool family
  is a convenience view over `entities` (`entity_type = 'people'`) with typed
  fields `role`, `organization`, `email`, `phone`, `relationship`,
  `last_contact`, each flattened into `properties` under that same key
  (`normalizeProperties`, `people.ts:177-185`) on every create/update/upsert.
- `packages/mcp-server/src/tools/meetingNotesIngest.ts` (`resolveEventEntity`,
  line ~124) writes `event` rows with `properties.date` and
  `properties.attendees`.
- `packages/mcp-server/src/tools/artifactEntitySync.ts` reads and scopes
  matching on `properties.place_type` for `place` rows (documented in
  `vocab.ts` as "open-vocab per the ADR-021 ethos" — a local discriminator,
  not an external predicate).
- `organization` has no established key convention yet: nothing in
  `packages/mcp-server/src` writes a structured `organization` property today.

So the "let the property keys follow from the class" instruction is not a
blank slate for `people`, `event`, and `place` — it is a check that what
already exists corresponds honestly to the anchored class (exact match,
approximate match, or deliberately local), plus naming the small remainder
that does not yet exist (mainly `organization`, which starts from nothing).

## Decision drivers

- **ADR-036 §1a's mapping contract is normative and total.** Every literal
  predicate needs a `properties` key; the two-hop lookup (runtime type →
  canonical class → external match) that ADR-036 §1 describes for the
  vocabulary registry applies equally to `ENTITY_TYPE_CLASS_CONTEXT`, which is
  the same mechanism already in production for `concept`.
- **Adopt-direct when exact, mint-and-map when approximate**
  ([ADR-033](./ADR033_External_Vocabulary_Adoption.md)). A type anchors
  directly to a public class only where the class's published definition
  matches ours; where a property's meaning is only close to a public
  predicate's, the key stays local and the correspondence is recorded as an
  annotation, not asserted as identity.
- **Public vocabularies are free inference from model weights**
  ([ADR-041](./ADR041_Public_Vocabularies_As_LLM_Scaffolding.md) §1) — the
  main consumer of this graph is an LLM that already knows `foaf:Person` and
  `schema:Organization`; a documented key vocabulary pays for itself
  immediately, before any extraction pipeline exists to populate it.
- **Don't invent what already exists.** Renaming `people.ts`'s established
  `role`/`organization`/`email`/`phone` keys to match a predicate's local name
  exactly (e.g. `phone` → `telephone`) would touch production data and every
  reader of it for a cosmetic gain; ADR-036's flattening convention
  (`schema:birthDate` → `birth_date`) is a naming *convention for new keys*,
  not a mandate to rename keys already in use.
- **Backfill is a capture problem, not a schema problem** (the issue's own
  diagnosis, restated because it is decision-relevant): an empty `properties`
  column is exactly as empty as an absent JSON key. Nothing in this ADR
  writes data; it gives a future extraction step (out of scope here) a
  vocabulary to write into.
- **No premature validation.** [ADR-041](./ADR041_Public_Vocabularies_As_LLM_Scaffolding.md)
  §3 rejects hard consistency checking (rejecting writes) as contradicting
  ADR-021's soft-validation stance and this system's messy-input-is-normal
  posture; it leaves soft, surfaced-not-blocking checks as a real option,
  naming #173 as a candidate. This ADR does not add either — it is scoped to
  naming the vocabulary, not enforcing it.

## Considered options

### Option A — anchor the four types to public classes; document (don't invent) the key vocabulary; no columns (chosen)

Complete `ENTITY_TYPE_CLASS_CONTEXT` for `people` (`foaf:Person`),
`organization` (`schema:Organization`), `place` (`schema:Place`), and `event`
(`schema:Event`) — the same mechanism, and the same file, that already anchors
`concept`. Property keys are documented per type, reconciled against what the
code already writes.

- **Pros:** finishes a decision (ADR-033/041) that was made and then only
  half-applied — `concept` was anchored and the other four types were not;
  zero migration, zero new validation surface; directly satisfies the
  "public vocabularies over invented ones" constraint the owner raised on the
  issue; every future type inherits the rule instead of relitigating it;
  keeps `export_rdf`'s eventual class mapping honest, since `concept` already
  proves the pattern.
- **Cons:** does nothing about sparsity by itself — extraction has to start
  writing these keys, which is separate work; does not stop a future caller
  writing a junk key, since nothing validates `properties` shape.

### Option B — dedicated columns per type (e.g. `people.email`)

- **Pros:** real constraints (`NOT NULL`, uniqueness, indexes, foreign keys);
  cheap filtering on attributes actually queried.
- **Cons:** contradicts [ADR-036](./ADR036_IRI_Grounded_Vocabulary_Self_Describing_Graph.md)'s
  explicit rejection of this exact shape (its "sketch 3"), in both directions
  — needs an ADR either way per
  [ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md)'s sibling rule that a
  decision reversal needs one. On today's evidence it buys little: a column
  earns its place when a predicate is present and queried on most rows of
  that type; #173 says the opposite — these attributes are absent almost
  everywhere. Adding columns to fix sparsity treats a capture problem as a
  schema problem.

### Option C — do nothing until a query demands it

- **Pros:** zero cost; an honest trigger condition.
- **Cons:** the ad-hoc-key half of the problem (the half this ADR actually
  fixes) keeps compounding with every new `organization`/`place`/`event` row
  written, and gets more expensive to unwind the longer it goes undocumented.

## Decision

Adopt **Option A**, exactly as approved on the issue.

### 1. Extend `ENTITY_TYPE_CLASS_CONTEXT` in `packages/mcp-server/src/vocab.ts`

Add four entries alongside the existing `concept: "skos:Concept"`, each
adopt-direct (ADR-033) because the class's published definition matches ours
exactly, mirroring `concept`'s own treatment:

| `entity_type` | Anchor class | Why exact (not approximate) |
| --- | --- | --- |
| `people` | `foaf:Person` | FOAF's `Person` is "a person" with no narrower scope than ours; `people` already carries the plural label purely as a naming quirk (ADR-036's own worked example: `ahos:angus a foaf:Person` → `'people'`). |
| `organization` | `schema:Organization` | Schema.org's `Organization` — "an organization such as a school, NGO, corporation, club, etc." — is exactly the `vocab.ts` comment's own definition ("companies/institutions that the graph relates people and work to"). |
| `place` | `schema:Place` | Schema.org's `Place` — "entities that have a somewhat fixed, physical extension" — matches the `vocab.ts` comment verbatim in intent ("a location (city, address, venue, region, country)"). |
| `event` | `schema:Event` | Schema.org's `Event` — "an event happening at a certain time and location" — matches existing usage (`meetingNotesIngest.ts` creates `event` rows with a title, a date, and attendees). |

No CHECK migration: `entity_type` values are unchanged; only the class
mapping — an application-layer JSON-LD context, per ADR-033 — is extended.
This is the same file and mechanism used for `concept` today, and is distinct
from the [ADR-036](./ADR036_IRI_Grounded_Vocabulary_Self_Describing_Graph.md)
vocabulary-registry runtime (term-node rows in `entities`, the derived
`graph_instance_of` view, the `entity_neighbourhood` opt-in flag,
`export_rdf`, the CI vocab-diff gate) that
[#359](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/359)
is implementing in parallel — this ADR does not touch that registry or its
implementation.

### 2. The property-key vocabulary per type

Keys already written by production code are **kept as-is** (no rename) and
annotated with the external predicate they correspond to; keys nothing writes
yet are **named**, not implemented — writing them is extraction/capture work,
explicitly out of scope (see Consequences).

**`people`** (`foaf:Person`)

| `properties` key | Status | Correspondence |
| --- | --- | --- |
| `email` | existing (`people.ts`) | exact — `schema:email` |
| `phone` | existing (`people.ts`) | exact — `schema:telephone` (key name predates ADR-036's flattening convention; kept, not renamed) |
| `role` | existing (`people.ts`) | close — `schema:jobTitle`. Our field also covers non-employment roles ("role or title"), so it stays a local key with a `closeMatch` annotation rather than an identity claim. |
| `organization` | existing (`people.ts`) | close — `schema:affiliation`. This is a denormalised free-text company name on the person row, not the `member_of` edge to an `organization` entity that `EDGE_TYPES` already supports (`schema:memberOf`). The two mechanisms already coexist; reconciling them is a separate, narrower question than this ADR and is not opened here. |
| `relationship`, `last_contact` | existing (`people.ts`) | local only — relationship-to-the-user and last-contact timestamp have no public-vocabulary equivalent worth adopting; they stay ahOS-local. |
| `homepage` | not yet written | exact — `foaf:homepage`, named for when a capture path starts writing it. |

**`organization`** (`schema:Organization`) — no existing convention; named
fresh, all exact matches:

| `properties` key | Correspondence |
| --- | --- |
| `legal_name` | `schema:legalName` |
| `url` | `schema:url` |
| `email` | `schema:email` |
| `telephone` | `schema:telephone` |
| `address` | `schema:address` |

**`place`** (`schema:Place`)

| `properties` key | Status | Correspondence |
| --- | --- | --- |
| `place_type` | existing (`artifactEntitySync.ts`) | local only, by design — `vocab.ts` already documents this as "open-vocab per the ADR-021 ethos"; it is a disambiguation discriminator (city vs. venue vs. …), not a public predicate. Unchanged. |
| `address` | not yet written | exact — `schema:address` |
| `geo` | not yet written | exact — `schema:geo` |

**`event`** (`schema:Event`)

| `properties` key | Status | Correspondence |
| --- | --- | --- |
| `date` | existing (`meetingNotesIngest.ts`) | local shorthand for a single-day event; kept as-is. |
| `attendees` | existing (`meetingNotesIngest.ts`) | denormalised cache of a literal list; the graph's actual attendance model is the `person —attended→ event` edge (`docs/architecture/architecture.md`). Reconciling the two is out of scope here, same caveat as `people.organization` above. |
| `start_date`, `end_date` | not yet written | exact — `schema:startDate` / `schema:endDate`, for the multi-day case `date` doesn't cover. |
| `location` | not yet written | exact — `schema:location` |

### 3. What this decision does not do

- **No new columns, no migration.** Per ADR-036, unchanged.
- **No validation of `properties` against a schema.** Every entity tool's
  `properties` field stays a free-form `z.record(z.string(), z.unknown())`
  (`entities.ts`, `people.ts`, `upsertEntity.ts`). Hard consistency checking
  is rejected by ADR-041 §3; soft, surfaced-not-blocking checks remain a real
  future option under the same section, and #173 stays the natural place to
  track that if it is ever picked up — this ADR does not implement it.
- **No backfill.** The issue's own analysis already separated this correctly:
  "an empty column is exactly as empty as an absent JSON key" — a capture
  problem, not something a vocabulary decision fixes. Populating the keys
  above is left to whatever extraction/capture work eventually targets these
  four types.
- **No change to the ADR-036/#359 vocabulary-registry runtime.** Term-node
  rows, `graph_instance_of`, the `entity_neighbourhood` flag, `export_rdf`,
  and the CI vocab-diff gate are #359's scope, in flight in parallel, and are
  untouched by this ADR.

## Consequences

- **Good:** four of the twelve entity types gain a real class anchor,
  finishing the half-applied ADR-033/041 adoption (`concept` was the only one
  anchored before this); the LLM extracting or reasoning over these types now
  has a real vocabulary to reach for instead of inventing one per capture;
  the small number of keys already written in production (`people.ts`,
  `meetingNotesIngest.ts`, `artifactEntitySync.ts`) are documented rather than
  silently ad hoc, with no rename and no migration risk to existing rows.
- **Cost / bad:** does not by itself raise the fraction of entities carrying
  structured properties — that half of #173's finding needs an extraction
  step this ADR does not build; two known local/external duplications
  (`people.organization` vs. the `member_of` edge; `event.attendees` vs. the
  `attended` edge) are named but not resolved here.
- **Follow-up (not opened by this ADR):** an extraction/capture pass that
  actually populates the keys above on new and existing rows; soft
  consistency checking on `properties` shape, if #173/#310's evidence ever
  justifies it (ADR-041 §3).

## Links

- Issue: [#173](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/173)
  (this ADR is its Option A, as approved in the issue's own comment thread,
  2026-08-30)
- Related, in flight in parallel, untouched by this ADR:
  [#359](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/359)
  (implements the ADR-036 vocabulary-registry runtime)
- Builds on: [ADR-033](./ADR033_External_Vocabulary_Adoption.md) (adopt-direct
  / mint-and-map), [ADR-036](./ADR036_IRI_Grounded_Vocabulary_Self_Describing_Graph.md)
  §1/§1a (the term-node/class-mapping mechanism and the total properties
  mapping contract; rejects columns), [ADR-037](./ADR037_IRI_Storage_Local_Name_And_Namespace_Binding.md)
  (IRI storage discipline, for the vocabulary-registry mechanism this ADR does
  not touch), [ADR-041](./ADR041_Public_Vocabularies_As_LLM_Scaffolding.md)
  (why public vocabularies pay off now; §3's inference-tier verdicts, which
  this ADR does not exercise)
- Runtime vocabulary: [`packages/mcp-server/src/vocab.ts`](../../packages/mcp-server/src/vocab.ts)
  (`ENTITY_TYPE_CLASS_CONTEXT`); the properties producers referenced above:
  [`packages/mcp-server/src/tools/people.ts`](../../packages/mcp-server/src/tools/people.ts),
  [`packages/mcp-server/src/tools/meetingNotesIngest.ts`](../../packages/mcp-server/src/tools/meetingNotesIngest.ts),
  [`packages/mcp-server/src/tools/artifactEntitySync.ts`](../../packages/mcp-server/src/tools/artifactEntitySync.ts)
