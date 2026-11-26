# ADR099: The career ledger rides existing graph types

- **Status:** Accepted
- **Created:** 2026-09-29
- **Accepted-on-dev:** 2026-10-02
- **Deciders:** Angus Hally

## Context and problem

The owner wants one master record of his career (roles, education, achievements with their
evidence, competencies) that every CV is produced from, and that a monthly pass can extend
(#1238). Today the graph holds a fragment of it and gets that fragment partly wrong. The
2026-09-29 audit found four employment arrangements on the self entity, all sourced only from
the hand-written seed (`ahOS-seed.ttl`, ingested 2026-09-24, #1141). One matches the owner's
confirmed CV. Two between them put about three years at Accenture, where his 2026-09-11
amendment confirms one role of 21 months and says not to reintroduce the longer figure, and
the fourth calls him CEO of a company he is a director of. The seed dated roles to the year, so a
September departure was stored as 31 December and `entity_neighbourhood` with `as_of` answered
wrongly.

Most of the ledger is missing: two recent employers, two teaching roles, both degrees, every
achievement and every competency. The content exists, but only as a captured CV text atom and
two amendment atoms with no entity links. The vocabulary cannot express the rest either:
`EDGE_TYPES` has no edge for "knows about", "demonstrates", "happened in this role", student
or institution, and `entity_relate` stores an unknown type as `other`. The word "skill" is
taken: `ahos:Skill` is a Claude Code skill (`ahOntology.ttl`) and `capability` is its entity
type.

Two neighbouring questions press on the same design. A tailored CV (#1234) must never contain
a fact the ledger lacks, because a projection never stores what its source does not have
(`docs/vision.md`; [ADR-022](./ADR022_State_Doc_Is_A_Projection_Not_An_Overflow_Sink.md)).
And "revenue in month 1 against month 2" has to be quotable on a CV without a metrics store
([ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md) §1-3).

## Decision drivers

- **Additive, no new tables and no new entity types.** `entity_type` is guarded by a DB CHECK,
  so every new type is a migration plus an ADR; vision principle 8 and
  [ADR-016](./ADR016_Discover_And_Index_Axis.md) say properties and tags come first.
- **Reify by category, per-role edges out of the hub, provenance on the node**
  ([ADR-035](./ADR035_Relationship_Reification.md) §4, §5, §7).
- **Adopt a public term when it is exact, mint and note the nearest when it is not**
  ([ADR-033](./ADR033_External_Vocabulary_Adoption.md),
  [ADR-041](./ADR041_Public_Vocabularies_As_LLM_Scaffolding.md),
  [ADR-085](./ADR085_People_Organization_Place_And_Event_Anchor_To_Public_Classes.md)).
- **Metrics are derived, events are stamped** (ADR-052 §1-3, §7).
- **Valid time dates a fact** ([ADR-088](./ADR088_A_Day_Window_Reads_Valid_Time_Coverage_Reads_Transaction_Time.md)):
  a role is dated by when it happened, not when it was captured.
- **No provenance, no write; merges, retirements and low-confidence facts are human-gated**
  (`docs/guides/GRAPH_MAINTENANCE_CONTRACT.md` §1, §3B).
- **A projection is never read back as evidence**
  ([ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md) §9, as
  amended in part by [ADR-054](./ADR054_One_Dos_Config_Two_Domains_And_An_Open_Audience_Set.md)).

## Considered options

### Option A: career tables (`roles`, `achievements`, `skills`)

- **Pros:** typed columns, easy queries, easy validation.
- **Cons:** a second store for facts the entity graph already models, cut off from search,
  embeddings, provenance links and `entity_neighbourhood`. Every CV and every sweep would have
  to join two worlds. Nothing about a career needs a relational shape the graph cannot hold.

### Option B: new entity types (`achievement`, `skill` or `competency`, `role`, `credential`)

- **Pros:** each concept gets a name at the type level.
- **Cons:** one CHECK migration per type, each for a node ADR-035 already provides: an n-ary,
  dated fact with participants is exactly an `arrangement`. `skill` collides with
  `ahos:Skill`. A competency is a topic node, which is what `concept` (`skos:Concept`) is.

### Option C: binary edges only (`employed_by`, an `alumni_of` edge, achievements as edge metadata)

- **Pros:** fewest nodes.
- **Cons:** ADR-035 §4 reifies by category, and employment is already reified, so binary
  employment edges for the owner would make the category non-uniform. An achievement is
  n-ary (person, role, competencies, metric, window) and needs evidence links of its own,
  which only a node can carry (§7).

### Option D: store metric series (monthly snapshots, a metrics table or snapshot atoms)

- **Pros:** "month 1 against month 2" becomes a lookup.
- **Cons:** ADR-052 §1-2 rejects exactly this: store the event, derive the aggregate. A
  stored series is a second record that drifts from its source, and the audit found the
  current revenue sources untrustworthy for that metric in any case.

### Option E: arrangement kinds, `concept` competencies and five new edge strings (chosen)

- **Pros:** no migration (`relationship_type` has had no CHECK since migration 049, and
  `properties.kind` is open); every ledger fact is a graph node with its own evidence links;
  the CV is a read over the self-centred subgraph.
- **Cons:** the ledger's shape lives in a convention, not a schema, so nothing but the skills
  enforces it. Recorded below.

Two narrower choices inside E were also weighed. **Minting `achieved_by` for achievement to
person** was rejected: `was_attributed_to` (`prov:wasAttributedTo`) is already in the
vocabulary and is the exact relation. **An `alumni_of` binary edge for education** was
rejected for the same reason Option C was: a degree carries a credential, subject,
classification and dates, so it is an arrangement.

## Decision

We chose **Option E**. The master ledger is the self-centred subgraph, and nothing else stores
it: no table, no document, no snapshot. Every CV is a projection of it.

### 1. Roles

An `arrangement` with `properties.kind = 'employment'` (existing, ADR-035), with participant
edges `employer` to the organization and `employee` to the self entity (existing). Properties:
`role` (the title as held), `valid_from` and `valid_to` (ISO dates) with
`date_precision: 'month'`, `employment_type` (`full_time | part_time | contract | advisory |
directorship | internship | sabbatical`), `location`, `summary` (neutral and factual) and
`ledger_status` (`confirmed | proposed | rejected`, §5). A directorship is `kind: 'employment'` with
`employment_type: 'directorship'`, not a separate kind, so every role reads the same way.

### 2. Education

An `arrangement` with `kind: 'education'` and two new participant edges: `student` to the self
entity and `institution` to the organization. Properties: `credential`, `subject`,
`classification`, `valid_from`, `valid_to`, `date_precision`, `ledger_status`.

### 3. Achievements

An `arrangement` with `kind: 'achievement'`. Edges out of it: `was_attributed_to` to the self
entity (existing, adopt-direct), `in_role` to the employment or education arrangement it
happened in (new), `demonstrates` to one or more competency concepts (new), and optionally
`about` to an organization or project (existing). Properties: `statement` (a plain factual
sentence, not sales copy), `valid_from`, `valid_to`, `impact_tier` (1 high to 3 low),
`evidence_status` (`evidenced | self_reported`), `ledger_status`, and optionally `cv_bullet`
(owner-approved wording), `confidential: true`, and a `metric` block (see §6).

Evidence is an `artifact_entity_links` row with `link_type = 'primary'` from each evidence
atom to the achievement. No evidence link, no write. An atom whose `content_subtype` is
`cv_render` or `job_description` never counts as evidence: a render is the ledger's own
output, and a job description is someone else's requirement. No read tool shows
`content_subtype`, so the `cv` skill tells them apart by what it sets and the tools do show:
the tags `cv_render` and `job_description` (on `artifact_get`'s `Tags:` line, checked before
any atom is linked as evidence) and a title marker (`CV render` in every render's title and
Drive file name, so the untagged pointers Drive discovery later makes for the Doc and its
PDF are caught too; `: job description` ending a job description's title).

Drive-discovered twins of renders (which have no `CV render` in their title and no tags) and
copies of old CVs minted by duplication loops (#1219) slip past title and tag checks. Therefore,
evidence exclusion is structural (#1246): leave out any artifact that (1) is tagged `doc:<kind>`
for a tracked CV document (`cv`, `cv_master`), (2) is linked to a tracked document entity of
those kinds, or (3) shares a Drive file ID with such an artifact (canonical, rendition, or
linked version). In addition, `golden-doc track` and `set-canonical` tag the discovered twin
of every canonical and rendition file (matched by Drive file ID) with `doc:<kind>` so the tag
rule covers it. Title markers and `cv_render`/`job_description` tags are retained as fallback.

### 4. Competencies

A `concept` entity with `properties.concept_scheme = 'competency'`, a `group` (for example
`Product and delivery`, `Engineering`, `AI and data`, `Analytics and operations`,
`Leadership`) and an optional `esco_uri`, recorded as `skos:exactMatch` only when the match is
exact. They are called competencies, never skills. A self-declared competency is the new edge
`knows_about` from the self entity to the concept (`schema:knowsAbout`, adopt-direct). A
demonstrated competency is derived at read and never stored:
self ← `was_attributed_to` ← achievement → `demonstrates` → concept.

### 5. `ledger_status` and the human gate

`confirmed` means the owner has confirmed the fact; `proposed` means a machine found it. An
unattended run writes only `proposed`, and promotion happens in an attended session with the
owner. Retiring or correcting a confirmed fact is always put to the owner first, whatever the
edge count, because the facts are his own record of himself.

`rejected` means the owner turned a proposal down. A rejection is written in three steps:
`ledger_status: 'rejected'` first, then every edge of the node archived, then the node
archived. Each step is needed because archiving an entity does not archive its edges, and
`entity_neighbourhood` follows live edges to archived nodes: a node archived alone would still
be reached from the self, still read as `proposed`, and be offered again at every review. The
rejected node stays, archived, as the record that stops the monthly sweep proposing the same
fact again.

### 6. Metrics over time are derived or claimed, never stored as a series

A metric on a CV is one of two things. It is **derived at read** from its live source, or it
is an **owner-asserted claim** in an achievement's `metric` block:
`{name, value, unit, baseline, window_from, window_to, as_of, attribution: led | contributed |
team, source}`. The claim, with its `as_of` and `source`, is the stamped event ADR-052 §2 asks
for, which is what passes its §3 test. Month over month is a comparison made at read time
between claims or derived values. Only closed windows are quoted, and a metric with no live
source and no claim is shown as unavailable, structurally rather than by a caption (§7).

### 7. The vocabulary change

Five strings join `EDGE_TYPES` in `packages/mcp-server/src/vocab.ts`: `knows_about` (also
mapped in `SCHEMA_ORG_CONTEXT` to `schema:knowsAbout`), `demonstrates`, `in_role`, `student`
and `institution`. The last four are ahos-native, each commented with its nearest public term
and why it is not exact. No migration. `ahOntology.ttl` is unchanged because it does not
declare the existing `employer` and `employee` roles either; the new ones follow them. The
exact string `student` now resolves to the participant edge rather than the people-vocabulary
synonym `apprenticeTo`, the same trade `employer` and `employee` already make.

### 8. The seed is corrected at source, and the rows with the owner

`ahOS-seed.ttl` is corrected to the confirmed CV: one Accenture role, January 2019 to
September 2020 at month precision, and a directorship. The seed parser learns `xsd:gYearMonth`
for month precision and `ahos:employmentType`. The ingester never overwrites, so the runtime
rows are corrected, and the missing roles, education, achievements and competencies are seeded,
with the owner in the loop and primary provenance to the CV atoms (#1231). Until then the
ingester's drift report lists exactly those corrections.

### 9. The ledger read

```text
entity_neighbourhood({ entity_id: <self>, hops: 2,
  edge_types: ["employee", "student", "was_attributed_to", "knows_about",
               "employer", "institution", "in_role", "demonstrates"],
  node_properties: true })
```

The first hop reaches the owner's roles, education, achievements and declared competencies;
the second reaches the organizations, the role each achievement happened in, and the
competencies each one demonstrates. `node_properties: true` is part of the read: without it
only the starting entity carries `properties`, and nothing reached can be sorted. It was added
to `entity_neighbourhood` for this read, together with an `archived` flag on every reached
node. The read then drops every node that is archived or `rejected`, and the edges that touch
them (§5), tells arrangements apart by `properties.kind`, and keeps only those with their own
edge to the self. Evidence counts come from `link_query({ entity_id, link_type: 'primary',
limit: 100 })` on each achievement, reported as "100+" when the limit is reached, since
`link_query` does not say when it stops; renders link `related`, never `primary`, so they are
not among them.

## Consequences

- **Good:**
  - No migration and no new type. The ledger is searchable, embeddable and traversable with
    the tools that already exist, and each fact carries its own evidence.
  - Roles answer `as_of` questions correctly once they are dated to the month.
  - A CV can cite a ledger node id for every sentence, which is what lets a tailored CV be
    checked against its source.
- **Cost / bad:**
  - The shape is a convention. Nothing validates `properties` (ADR-036 and ADR-041 §3 reject
    hard validation), so a hand-written row can drift from it; the `cv` skill is the writer
    that keeps it.
  - `was_attributed_to` now has two readings (an artifact's responsible agent, and an
    achievement's owner). They are told apart by the source node's type.
  - Excluding renders and job descriptions from evidence is a rule in the skills today, keyed
    on tags and a title marker because `content_subtype` is not visible to any read tool.
    `knowledge_search` excludes `daily_log` and `scaffold` atoms by default in code, and the
    surface-to-role map orders reads but gates nothing yet, so a structural exclusion for
    these two subtypes is a follow-up. It matters because the monthly sweep's own draft
    render lands in the next month's read window, restating every ledger bullet.
  - A rejected fact takes three writes, not one (§5), because archiving an entity leaves its
    edges live.
- **Follow-up:** seed the ledger with the owner (#1231); the `cv` skill (#1234) and its
  monthly sweep (#1236); machine-authored atoms classed as narrative (#1222); revenue sources
  (#1223, #1224); and an issue to be filed for `knowledge_search` to exclude `cv_render` and
  `job_description` by default, with an opt-in flag, as it does `daily_log` and `scaffold`.

## Current-state sync (ADR-039 §2)

`docs/architecture/architecture.md` "Capability status" records the career ledger and the CV
capability in the same PR.

## Links

- Related: [ADR-035](./ADR035_Relationship_Reification.md) (arrangements, per-role edges,
  provenance on nodes)
- Related: [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md)
  (derived metrics; stamp the event)
- Related: [ADR-033](./ADR033_External_Vocabulary_Adoption.md) (adopt-direct when exact)
- Related: [ADR-DRAFT-concept-entity-type](./ADR-DRAFT-concept-entity-type.md) (`concept` as
  `skos:Concept`)
- Related: [ADR-024](./ADR024_Self_User_Entity.md) (the self entity is the endpoint for owner
  relationships)
- Sibling: [ADR-098](./ADR098_Tracked_Documents_Are_A_Resource_Entity_With_A_Canonical_Pointer.md)
  (the tracked CV the ledger is rendered into)
- Issues: #1238, #1231, #1234, #1236, #1222, #1223, #1224
