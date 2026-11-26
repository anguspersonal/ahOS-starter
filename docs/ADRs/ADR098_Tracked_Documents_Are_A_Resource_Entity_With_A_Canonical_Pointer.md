# ADR098: A tracked document is a `resource` entity with a canonical pointer

- **Status:** Accepted
- **Created:** 2026-09-29
- **Accepted-on-dev:** 2026-10-02
- **Deciders:** Angus Hally

## Context and problem

The owner thinks of some documents as one thing across all of their copies: "my CV" is a
single document to him, whatever surface it sits on. ahOS has no way to say that. The
2026-09-29 audit behind #1238 found the CV as at least 24 Drive copies of one file, several
more Drive and OneDrive copies of other versions, a Notion page and a captured text atom whose
only claim to being the master is the string "(master copy)" in its title. That atom is
already stale against two amendment atoms that correct it, and it is linked to nothing.

Nothing in the schema carries document identity or a golden copy. `artifacts.version` and
`previous_version_id` exist and have no writer in `packages/`. `lifecycle_stage` has no
`superseded` value, and `ahOntology.ttl` says no terminal stage is defined. The `supersedes`
edge runs entity to entity only, because `entity_relationships` has foreign keys to
`entities`. `artifact_entity_links.link_type` is CHECKed to `primary | mentioned | related`.
`knowledge_search` cannot find the copies either: its entity arm buries every artifact for a
short query (#1213).

[ADR-069](./ADR069_One_Item_Is_One_Atom_A_Second_Source_Is_A_Second_Atom.md) has already
settled half of this. Each copy stays its own atom, and multiplicity is an entity-level fact:
N artifacts link to one entity. What is missing is the entity, the rule for which copy is
golden, how "get my X" resolves, and how superseded copies are retired without losing
anything. The tools and skills in this batch implement against the answer: `document_resolve`
(#1230), `document_duplicates` (#1217), the `golden-doc` skill (#1233, #1235) and the `cv`
skill (#1234).

## Decision drivers

- **Additive.** Vision principle 8 and [ADR-016](./ADR016_Discover_And_Index_Axis.md): reach
  for properties and tags before machinery. No migration if one can be avoided.
- **Never merge artifact rows** ([ADR-069](./ADR069_One_Item_Is_One_Atom_A_Second_Source_Is_A_Second_Atom.md)
  §1-2). A copy is evidence that the file exists on that surface.
- **Reversible** ([ADR-034](./ADR034_Lifecycle_Semantics.md)): soft-archive with a reason,
  default-excluded from reads, restored by update. Hard delete stays opt-in.
- **Standard vocabulary** ([ADR-033](./ADR033_External_Vocabulary_Adoption.md),
  [ADR-041](./ADR041_Public_Vocabularies_As_LLM_Scaffolding.md)): DCTerms owns the documents
  axis, and `dcterms:isVersionOf` is the exact relation between a copy and the document.
- **Provenance and a human gate** (`docs/guides/GRAPH_MAINTENANCE_CONTRACT.md` §1 and §3B):
  no write without an artifact behind it, and anything that rewrites identity across many
  rows is proposed, never done autonomously.
- **Gate actions on the source surface** ([ADR-028](./ADR028_Surface_Registry_And_Reference_Artifacts.md)
  §8): discovery and linking may be automated; moving a file in Drive may not.
- **Ambiguity is surfaced, not guessed** (R3): "get my CV" with nothing tracked must say so.

## Considered options

### Option A: a documents table, or a `canonical` column on `artifacts`

- **Pros:** one query answers "which copy is golden"; a foreign key can protect the pointer.
- **Cons:** a migration and a second home for identity that the entity graph already provides.
  It has no aliases, no embeddings and no search arm, all of which `entities` already has
  (migration 110, [ADR-092](./ADR092_Terms_Aliases_And_A_Hot_Tier_In_The_Handshake.md)). A
  column on `artifacts` puts a per-document fact on every copy and needs a rule to keep exactly
  one of them true.

### Option B: a `superseded` lifecycle stage, with `previous_version_id` as the chain

- **Pros:** uses columns that already exist; "superseded" becomes queryable by stage.
- **Cons:** the stage needs a CHECK migration, and it would overload a pipeline field
  (`discovered`, `extracted` and so on describe processing, not standing). `previous_version_id`
  alone has no identity node: nowhere for aliases, a document kind or the canonical choice. It
  also models the wrong thing. 24 byte-identical copies are not a revision chain, and nothing
  writes the column today. Soft-archive with a reason already expresses "retired, kept, not
  shown by default".

### Option C: an `artifact_relationships` table (copy to copy lineage)

- **Pros:** real edges between artifacts (`isVersionOf`, `replaces`), traversable.
- **Cons:** a migration, a second graph, and the answer to a different question.
  [ADR-DRAFT-artifact-provenance-links](./ADR-DRAFT-artifact-provenance-links.md) keeps
  artifact-to-artifact lineage in `processing_metadata` until a lineage consumer materialises,
  and names this table as the escape hatch. A document resolver is a consumer of **identity**
  (which copies are one document), not of lineage (which copy was made from which), and
  identity already rides the entity graph under ADR-069 §2. So the escape hatch is not
  triggered, and the draft is neither bent nor superseded here.

### Option D: `artifact_external_links` rows with provider `internal`

- **Pros:** no migration; kinds are open vocabulary (migration 047).
- **Cons:** that table is the cross-store lineage and synthesis-marker ledger. Using it for
  "this copy is a version of that copy" spreads one document's identity over pairwise rows
  with no node to hang aliases or the canonical choice on, and puts identity facts beside
  consumption markers that several readers treat as a ledger.

### Option E: one `resource` entity per tracked document, canonical pointer in its properties (chosen)

- **Pros:** no migration; reuses `entities` (aliases, search, embeddings, provenance links)
  and the link multiplicity ADR-069 already relies on; reversible end to end.
- **Cons:** the canonical pointer is a property, so no foreign key protects it; the `golden`
  tag duplicates the property and can drift from it. Both are handled below.

## Decision

We chose **Option E**.

### 1. Identity: one `resource` entity per tracked document

`entity_type = 'resource'`, a title such as `CV — Angus Hally`, and `aliases` such as
`["CV", "curriculum vitae", "resume", "résumé", "Angus Hally CV"]`. Everything else lives in
`properties` (JSONB, no migration):

```jsonc
{
  "tracked": true,
  "doc_kind": "cv",                     // free text: cv, cv_master, passport_scan, ...
  "canonical_artifact_id": "<uuid>",    // the golden copy
  "canonical_url": "<https link>",
  "canonical_set_at": "<ISO timestamp>",
  "canonical_set_by": "owner" | "golden-doc",
  "renditions": [ { "format": "docx", "artifact_id": "<uuid>", "url": "<link>" } ],
  "output_folder_id": "<drive folder id>",   // optional: where new versions are written
  "last_reviewed_through": "YYYY-MM-DD"      // optional: sweep watermark (the cv sweep)
}
```

`tracked: true` is what makes a `resource` a tracked document; readers select on
`properties @> {"tracked": true}`. Renditions (a PDF exported from the golden Doc, say) are a
list on the entity, not an edge, for the reason given under Option C.

### 2. Every copy links `primary`, and here `primary` means `dcterms:isVersionOf`

Every known copy or version of the document links to the entity through
`artifact_entity_links` with `link_type = 'primary'`. For an entity with `tracked: true`,
that link reads as `dcterms:isVersionOf` (the copy is a version of the abstract document).
No link type is added: `primary` already means "the atom is chiefly about this entity", and
ADR-069 §2 already expresses one entity with N atoms this way. `mentioned` and `related`
links to a tracked document are not versions (a render citing achievements links `related`
to them, not the reverse). The mapping is recorded here rather than in `DCTERMS_CONTEXT`,
which maps edge strings, not link types. If a JSON-LD export of links is ever built, this
section is its mapping.

### 3. Tags: `doc:<kind>` on every copy, `golden` on exactly one

Through `artifact_update`, every copy carries `doc:<kind>` and the canonical copy also
carries `golden`. There is exactly one `golden` per tracked document: moving the canonical
removes the tag from the previous copy in the same step. The entity property is
authoritative and the tags are a search convenience (the `tags` filter on
`knowledge_search`, #1213); when they disagree, the property wins and the tags are repaired.
`golden` alone is also the graph-maintenance contract's tag for golden examples (§3D, #178),
so a tracked document's golden copy is always identified by `golden` **and** `doc:<kind>`
together, never by `golden` alone.

The tags will drift, and mostly not by hand. When discovery sees a pointer's content change,
it rewrites the row's `tags` to what the connector supplied (`discover.ts`, the changed-path
update), and the Drive cadence supplies none. A Google Doc's content hash is its modified
time, so every edit to the golden copy strips `doc:<kind>` and `golden` on the next discover
run: the copy the owner edits is exactly the one that loses them. Until discovery merges tags
instead of replacing them (a follow-up), the `golden-doc` skill checks the canonical copy's
tags in `get` and `sweep` and re-applies them from `canonical_artifact_id`, and nothing
treats a missing tag as evidence against the pointer.

Discovered twins of the canonical file and each rendition (pointers created by automated
Drive discovery for the same underlying Drive files) share the Drive file ID. `golden-doc track`
and `set-canonical` locate these discovered twins and tag them `doc:<kind>` as well (#1246).
This ensures that downstream consumers (such as `cv sweep`, ADR-099 §3) can structurally exclude
both tracked copies and their discovered twins by tag, link, and Drive file ID, preventing
unintended self-evidence loops.

### 4. Superseded copies are soft-archived only on approval

A superseded copy is archived through `artifact_delete` (soft, the default) with
`archived_reason = 'superseded:<canonical artifact id>'`, and only after the owner approves.
It stays linked, point lookups still find it, and `artifact_update { archived: false }`
restores it. Moving files in Drive is a separate step with its own explicit approval: into
an Archive folder the owner chooses, with `drive_move`, and never `drive_trash` or
`drive_delete`. Marking the canonical copy is the default outcome; physical tidying is
optional (vision principle 1, coherence rather than consolidation).

### 5. Every consolidation leaves an op record, so it can be undone

Each consolidation writes one capture atom tagged `golden-doc` and `consolidation` whose body
is JSON:

```json
{"op_id": "<uuid>", "entity_id": "<uuid>", "canonical_id": "<uuid>",
 "archived_ids": ["<uuid>"],
 "drive_moves": [{"file_id": "<id>", "account": "personal", "from_parents": ["<id>"],
                  "to_parent": "<id>"}]}
```

Undo reads it back: restore every archived pointer and move every file back to its recorded
parents, as the recorded `account`. Copies can sit in either Google account (`gdrive` is
`personal`, `gdrive_work` is `work`), and the Drive tools fall back to the personal
account when none is named, so every Drive call in a consolidation names the file's account,
an Archive folder is chosen per account, and a file is only ever moved within its own
account. A rendition of the canonical copy (listed in `renditions`) is the canonical in
another format, not a superseded version, and is never archived with the others. This mirrors the entity-merge `_merge` record and `entity_unmerge`
(`docs/guides/ENTITY_MERGE.md`). The op record is itself the provenance for the
consolidation's writes (contract §1).

### 6. "Get my X" resolves through the entity, and never guesses

Find the tracked document by title, alias or `doc_kind`, then return the canonical pointer and
the other versions. If nothing is tracked, say so and offer to track one. A best-guess file
presented as "your CV" is exactly the silent guess R3 forbids.

### 7. What this does not decide

- A `superseded` lifecycle stage, an `artifact_relationships` table, and a writer for
  `previous_version_id` are deferred until tags, `archived_reason` and the entity prove
  insufficient. Each needs a migration and a new ADR; the table would supersede
  ADR-DRAFT-artifact-provenance-links rather than bend it.
- Where machine-generated proposals are approved now that the web review queue is gone
  (#1218). Consolidation here is proposed and approved in chat.
- Why the same files multiply across Drive and OneDrive (#1219).

## Consequences

- **Good:**
  - Zero migrations. Any tool that reads `entities` can read a tracked document, and the
    aliases make "CV", "resume" and "curriculum vitae" resolve to the same row.
  - Copies stay atoms (ADR-069), so each one keeps its own provenance, surface and history.
  - Every step is reversible: archive by soft-delete with a reason, undo from the op record.
- **Cost / bad:**
  - The canonical pointer has no foreign key. A hard-deleted canonical leaves a dangling id;
    hard delete is opt-in, and `document_resolve` reports a missing canonical as missing.
  - The tags drift from the property, routinely: discovery resets a changed pointer's tags,
    so every edit to a Google Doc strips `doc:<kind>` and `golden` from it (§3), and the
    owner can edit tags by hand. The resolver trusts the property and reports a second
    `golden` tag it finds; the skill checks and repairs the canonical copy's tags. A
    `knowledge_search` on `doc:<kind>` misses an edited copy until it is repaired.
  - `entity_update` replaces `properties` wholesale and `artifact_update` replaces `tags`
    wholesale, so every writer must read, merge and write. That needs a read that shows the
    whole object: `entity_get` prints `properties` (added alongside this ADR; before it no
    read tool did, and a merge was a merge over nothing). The skills refuse to write
    `properties` they could not read.
  - `primary` carries a meaning that depends on the entity it points at. It is only
    `dcterms:isVersionOf` for a tracked `resource`.
- **Follow-up:** #1230 (`document_resolve`), #1217 (`document_duplicates`), #1233 and #1235
  (`golden-doc`), #1213 (search filters), #1218 (approval surface), #1219 (the sync loop);
  and an issue to be filed for discovery's changed path to merge tags rather than replace
  them (keeping `doc:*` and `golden`), with a test in `discover.test.ts`.

## Current-state sync (ADR-039 §2)

`docs/architecture/architecture.md` "Capability status" records tracked documents in the same
PR.

## Links

- Related: [ADR-069](./ADR069_One_Item_Is_One_Atom_A_Second_Source_Is_A_Second_Atom.md)
  (one item is one atom; multiplicity at the entity)
- Related: [ADR-034](./ADR034_Lifecycle_Semantics.md) (reversible lifecycle)
- Related: [ADR-DRAFT-artifact-provenance-links](./ADR-DRAFT-artifact-provenance-links.md)
  (artifact lineage stays metadata; not triggered here)
- Related: [ADR-028](./ADR028_Surface_Registry_And_Reference_Artifacts.md) (registry over a
  federation; §8 gates actions on the source surface)
- Related: [ADR-091](./ADR091_Per_Connector_L3_Map_Versus_Store_Policy.md) (Drive is store
  under 25 MB)
- Sibling: [ADR-099](./ADR099_The_Career_Ledger_Rides_Existing_Graph_Types.md) (the career
  ledger the CV is rendered from)
- Guide: `docs/guides/GRAPH_MAINTENANCE_CONTRACT.md`, `docs/guides/ENTITY_MERGE.md`
- Issues: #1238, #1216, #1230, #1217, #1233, #1235, #1213, #1218, #1219
