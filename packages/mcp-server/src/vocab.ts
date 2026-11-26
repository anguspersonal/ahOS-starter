/**
 * Controlled vocabularies for the knowledge graph.
 *
 * These live in the application layer (not as rigid DB CHECK constraints) so the
 * ontology can evolve with a one-line edit and no migration. A hard-coded DB enum
 * that drifted from the code is exactly what broke entity-edge writes before
 * migration 049 (the worker wrote a relationship_type the CHECK rejected).
 *
 * Exception: entities.entity_type is STILL guarded by a DB CHECK (project,
 * area, resource, people + 'event' + 'organization' + 'signal' + 'place' +
 * 'concept' + 'capability' + 'domain' + 'arrangement' + 'term' + 'decision'), so
 * ENTITY_TYPES below must stay in sync with that constraint.
 */
import { z } from "zod";
import type { LifecycleStage } from "@ahkms/shared";
import {
	BACKDATABLE_CONTENT_SUBTYPES,
	type ConnectionDomainInput,
	connectionDomain,
	DAILY_EMAIL_FLOW_CONTENT_SUBTYPE,
	DAILY_LOG_CONTENT_SUBTYPE,
	DAILY_LOG_LINK_KIND,
	DISCOVERED_STAGE,
	EDGE_TYPES,
	EVENT_REQUEST_CONTENT_SUBTYPE,
	EVIDENCE_AGGREGATED,
	EVIDENCE_AGGREGATED_UNATTENDED,
	EVIDENCE_CLOSING_KINDS,
	type EvidenceClosingKind,
	MEETING_NOTE_CONTENT_SUBTYPE,
	REFLECTION_CONTENT_SUBTYPE,
	REFLECTION_LINK_KIND,
	SCAFFOLD_CONTENT_SUBTYPE,
	STATE_DOC_LINK_KIND,
	SYNTHESIZED,
	SYNTHESIZED_UNATTENDED,
	SYNTHESIS_MARKER_KINDS,
	type SynthesisMarkerKind,
	SYSTEM_PRODUCED_CONTENT_SUBTYPES,
	TASK_CREATE_RECEIPT_SUBTYPE,
	TASK_REQUEST_CONTENT_SUBTYPE,
	WEEKLY_KPI_SCORECARD_CONTENT_SUBTYPE,
} from "@ahkms/core";
export {
	BACKDATABLE_CONTENT_SUBTYPES,
	type ConnectionDomainInput,
	connectionDomain,
	DAILY_EMAIL_FLOW_CONTENT_SUBTYPE,
	DAILY_LOG_CONTENT_SUBTYPE,
	DAILY_LOG_LINK_KIND,
	DISCOVERED_STAGE,
	EDGE_TYPES,
	EVENT_REQUEST_CONTENT_SUBTYPE,
	EVIDENCE_AGGREGATED,
	EVIDENCE_AGGREGATED_UNATTENDED,
	EVIDENCE_CLOSING_KINDS,
	type EvidenceClosingKind,
	MEETING_NOTE_CONTENT_SUBTYPE,
	REFLECTION_CONTENT_SUBTYPE,
	REFLECTION_LINK_KIND,
	SCAFFOLD_CONTENT_SUBTYPE,
	STATE_DOC_LINK_KIND,
	SYNTHESIZED,
	SYNTHESIZED_UNATTENDED,
	SYNTHESIS_MARKER_KINDS,
	type SynthesisMarkerKind,
	SYSTEM_PRODUCED_CONTENT_SUBTYPES,
	TASK_CREATE_RECEIPT_SUBTYPE,
	TASK_REQUEST_CONTENT_SUBTYPE,
	WEEKLY_KPI_SCORECARD_CONTENT_SUBTYPE,
};

/**
 * entities.entity_type -- must match the DB CHECK (project, area, resource,
 * people + 'event' + 'organization' + 'signal' + 'place' + 'concept' + 'capability' +
 * 'domain' + 'arrangement' + 'term' + 'decision', migrations 054, 063, 065, 067,
 * 074, 075, 079, 110, 146).
 *
 * organization: companies/institutions that the graph relates people and work to
 *   (the employed_by / member_of / vendor_for / client_of edges presuppose them).
 * signal: a derived, uncertain inference projected from an artifact (e.g. a
 *   tentative scheduling read), carrying confidence in properties.
 * place: a location (city, address, venue, region, country) mentioned in a
 *   capture (issue #188). One type, not one per granularity -- the subtype
 *   lives in properties.place_type, open-vocab per the ADR-021 ethos.
 *   Containment (address -> city -> country) and person -> place edges are
 *   entity_relationships rows (locatedIn / livesAt / basedNear), not columns.
 * concept: a topic/subject node (issue #209, supersedes PR #200), anchored to
 *   the W3C SKOS class skos:Concept -- see ENTITY_TYPE_CLASS_CONTEXT below.
 *   Concepts reuse the SKOS broader/narrower hierarchy edges already adopted
 *   for the Areas tree (#195/#232) and the existing `about` edge for
 *   artifact/entity -> concept links -- no new edge type is introduced.
 * domain: a sphere of life/work used to partition the ego graph (#62,
 *   ADR-019), anchored to the ontology's ahos:Domain class (ahOS-seed.ttl).
 *   The scope axis the binding layer resolves against: a `(scope, name)`
 *   binding is scoped to a domain row (personal/work). Seeded, not
 *   graph-derived; ordinary CRUD applies (no lifecycle-protection flag).
 * capability: a skill/agent/command registry entry (#63, ADR-031). Typed
 *   fields live in properties (kind/surface/storage_location/...), validated
 *   by the capability_register tool, projected by the `capabilities` view
 *   (migration 056). Added to this CHECK by migration 074/075 -- migration
 *   056 shipped the view before the CHECK recognized the type, which is why
 *   every capability-row insert failed until 074.
 * arrangement: a reified n-ary / repeated fact (ADR-035, #327) -- one generic
 *   node type for facts too rich for a binary edge: employment (role + dates),
 *   residency (several residents + place), a supply chain. Participants attach
 *   as per-role edges OUT of the arrangement (employer/employee/resident/
 *   at_place/supplier/customer/of_utility -- see EDGE_TYPES); the arrangement
 *   KIND is open-vocab in properties.kind (employment | residency | supply |
 *   ...), so new kinds need no migration. Time lives on valid_from/valid_to
 *   (migration 068). Graph-only (no dedicated view). Added to the CHECK by
 *   migration 079; unblocks the ahOS-seed.ttl ingestion (#326).
 * term: an acronym or piece of internal shorthand -- PSR, P0, "ship it", "the
 *   migration" (#1023, ADR-092). title = the short form; properties.expansion =
 *   the long form; properties.context = the disambiguator ("Work finance").
 *   A term is a row the owner's words refer to, not an ontology class: the
 *   ontology's own grounding rows (migration 081, ADR-037) stay 'concept' with
 *   properties.type = 'ahos_concept_term', and the two never meet. Added to the
 *   CHECK by migration 110.
 * decision: an executive or architectural decision node in the knowledge graph
 *   (#2003, ADR-038 §6). Graph-only (no dedicated view). Added to the CHECK by
 *   migration 146.
 *
 * 'memory', 'secure', 'archive' were dropped in migration 067 (#172): zero
 * rows in prod, and 'archive' duplicated the existing `archived` boolean
 * column. The dedicated public.memories/public.secure/public.archive Postgres
 * views and the MemoryEntity/SecureEntity/ArchiveEntity shapes in
 * `@ahkms/shared` still exist but are now unused -- retiring those is a
 * separate follow-up, out of scope for #172.
 *
 * Mirrored in `GraphEntityType` in `@ahkms/shared` (`shared` has no dependency
 * on this package, so that list is kept in sync by hand, not imported).
 */
export const ENTITY_TYPES = [
	"project",
	"area",
	"resource",
	"people",
	"event",
	"organization",
	"signal",
	"place",
	"concept",
	"capability",
	"domain",
	"arrangement",
	"term",
	"decision",
] as const;
export const entityType = z.enum(ENTITY_TYPES);
export type EntityType = (typeof ENTITY_TYPES)[number];

/**
 * entity_relationships.relationship_type -- OPEN vocabulary (DB CHECK dropped in
 * migration 049). The first five are the original allowed set, kept so existing
 * worker writes still validate; the rest are knowledge-graph edge types. Add new
 * ones here freely -- no migration required.
 *
 * NOTE (ADR-021): people↔people edges have a canonical vocabulary in
 * @ahkms/shared (RELATIONSHIP_VOCABULARY + normalizeRelationshipType). This list
 * is the LEGACY/system set — entity_relate accepts both: shared-vocab terms
 * and synonyms are normalised there; these legacy terms pass through unchanged.
 *
 * NOTE (ADR-033 / #192): Schema.org is the spine / default vocabulary layer —
 * reach for it first, and defer to a specialist vocab only when that vocab's
 * axis is the point (lineage → PROV-O #193, people → FOAF #194, hierarchy →
 * SKOS #195, citation → DCTerms #196). Per the adopt-direct rule, the Postgres
 * string here stays snake_case; the schema.org IRI each string maps to is
 * named in the comment and mirrored in SCHEMA_ORG_CONTEXT below (no `ahos:`
 * proxy is minted for an exact match).
 *
 * NOTE (ADR-033 / #193): PROV-O owns the lineage axis — "where did this come
 * from?" (derivation, generation, attribution). All three terms below are
 * adopt-direct: verified against the published ontology
 * (https://www.w3.org/ns/prov-o#), each term's rdfs:domain/rdfs:range matches
 * our usage exactly, so no `ahos:` proxy or `skos:closeMatch` hedge is needed:
 *   - wasDerivedFrom: domain/range prov:Entity/prov:Entity — artifact -> source artifact.
 *   - wasGeneratedBy: domain/range prov:Entity/prov:Activity — artifact -> the
 *     workflow step run that produced it.
 *   - wasAttributedTo: domain/range prov:Entity/prov:Agent — artifact -> the
 *     responsible person/agent (ADR-026's captured_by).
 *
 * NOTE (ADR-033 / #196): DCTerms owns the documents/citation axis — verified
 * each term's real DCMI definition (dublincore.org/specifications/dublin-core/dcmi-terms/)
 * rather than trusting #196's own table, per the precedent #192/#193 set:
 *   - references: "a related resource that is referenced, cited, or otherwise
 *     pointed to by the described resource" (formal inverse: isReferencedBy).
 *     Our usage — artifact/Resource entity -> artifact/Resource entity
 *     citation — matches exactly. Adopt direct as a net-new edge string.
 *   - creator: "an entity responsible for making the resource"
 *     (dcam:rangeIncludes dcterms:Agent; owl:equivalentProperty foaf:maker).
 *     Overlaps with the already-adopted `author` -> schema:author (#192).
 *     Per specialist-wins + "one canonical term per relation", `author` stays
 *     canonical here — NOT double-mapped to dcterms:creator too. dcterms:creator
 *     is adopted directly, but only at the TTL level, replacing the broader
 *     ahos:createdBy property (any ahos:Entity, not just Resources/artifacts);
 *     see ahOntology.ttl. No second EDGE_TYPES string is minted for it.
 *   - isPartOf: formal inverse hasPart. Exact overlap with the already-adopted
 *     is_part_of/has_part -> schema:isPartOf/schema:hasPart (#192). Deferred to
 *     Schema.org per specialist-wins; NOT re-mapped here (containment isn't
 *     citation's axis specifically — Schema.org's general "part of" already
 *     covers it, and one canonical term per relation forbids a second mapping).
 *   - subject: "a topic of the resource". Exact overlap with subject_of, which
 *     #192's round-1 review already adopted direct as schema:subjectOf (the
 *     formal inverseOf schema:about) — upgraded from the originally-planned
 *     ahos:subjectOf + skos:closeMatch bridge to a direct exact match, so
 *     there is no ahos:subjectOf node left for #196's table to bridge against.
 *     dcterms:subject is therefore NOT mapped to any EDGE_TYPES string here;
 *     schema:subjectOf remains sole canonical owner (specialist-wins: the
 *     Schema.org mapping is now the more specific/exact of the two, since it's
 *     a formally-declared inverse rather than an approximate topic relation).
 *
 * NOTE (ADR-033 / #194): FOAF owns the people axis. `current_project` is the
 * one genuine gap ADR-021 left open (ADR-021 was explicitly People-only and
 * deferred non-interpersonal edges): a People -> Project edge, verified
 * against the published spec (http://xmlns.com/foaf/spec/) —
 * rdfs:domain foaf:Person, rdfs:range foaf:Thing, "a current project this
 * person works on" — an exact match for our People -> `project`-typed entity
 * usage, so adopt-direct with no `ahos:` proxy. `knows` and `member` are
 * NOT re-listed here: they're People<->People/Group edges already owned by
 * `@ahkms/shared`'s RELATIONSHIP_VOCABULARY (`knows`, `member`,
 * `currentProject`, `pastProject`, `made` — curied `foaf:*` since ADR-021/PR
 * #184) and validated end-to-end through entity_relate's
 * isKnownRelationshipType check; EDGE_TYPES only takes the net-new
 * People -> Project edge because "Project" isn't a RELATIONSHIP_VOCABULARY
 * concern (that vocabulary is scoped to person <-> person/group ties). The
 * two vocab tables are complementary, not duplicative: shared's `currentProject`
 * (camelCase, People<->People-graph consumer) and this file's `current_project`
 * (snake_case, general entity_relate/entity_relationships consumer) name the
 * same FOAF property for two different write surfaces, per the storage-split
 * rule (ADR-033 point 5) — both resolve to `foaf:currentProject`.
 *
 * `member_of` DIRECTION (resolved explicitly, specialist-wins): `foaf:member`
 * verified against the spec has rdfs:domain foaf:Group, rdfs:range foaf:Agent
 * — i.e. it points Group -> Agent ("this group has this member"), the
 * OPPOSITE direction from the already-shipped `member_of` -> schema:memberOf
 * (#223), which is rdfs:domain schema:Person|Organization, rdfs:range
 * schema:Organization — Agent -> Group ("this person/org is a member of that
 * org"), matching how `member_of` is actually written (person -> org). Since
 * `member_of`'s direction is the Agent->Group direction, it cannot be
 * re-mapped to `foaf:member` (that would silently reverse the edge's
 * meaning) — schema:memberOf stays its sole canonical mapping (one canonical
 * term per relation), unchanged by this issue. `foaf:member`'s own
 * Group->Agent direction has no EDGE_TYPES string of its own: nothing in the
 * codebase currently writes a group-out-to-member edge (`entity_relate`
 * always writes person -> org, matching `member_of`/`employed_by`'s
 * direction), so no net-new string is minted for a direction we don't
 * produce — if a group-owns-members write path is added later, it should
 * mint its own edge string (e.g. `has_member`) mapped to `foaf:member`
 * rather than overloading `member_of`. (Historical note: `RELATIONSHIP_VOCABULARY.member`
 * in `@ahkms/shared` was once flagged as a latent mislabel — label vs. curie direction.
 * That is resolved: its label is now "Has member" (Group->Agent), which agrees with the
 * `foaf:member` curie (Group->Agent), and nothing writes that edge. No mismatch remains;
 * the earlier follow-up was chasing a phantom, so it is dropped here.)
 *
 * NOTE (ADR-033 / #195): SKOS owns the concept-hierarchy axis — the Areas
 * tree. Verified against the published spec
 * (https://www.w3.org/TR/skos-reference/#semantic-relations) rather than
 * trusting #195's own table (the doctrine every #19x adoption in this file
 * follows). All three terms are sub-properties of skos:semanticRelation,
 * domain/range both skos:Concept:
 *   - broader: THE CLASSIC SKOS DIRECTION TRAP — `<A> skos:broader <B>` means
 *     B is broader than A (A is the subject/narrower concept; B is the
 *     object/broader concept the edge points TO). So for our Area tree, the
 *     edge is written CHILD -> PARENT: `child_area broader parent_area`
 *     (matches the existing `parent_area_id` mental model of "this area's
 *     parent is X" — the child holds the pointer). Exact match to
 *     skos:broader's own semantics; adopt direct.
 *   - narrower: formally `owl:inverseOf` broader (skos-reference S25) —
 *     `<C> skos:narrower <D>` means D is narrower than C, i.e. PARENT ->
 *     CHILD. Written as the reverse edge alongside `broader` so the
 *     hierarchy is traversable in both directions without a join-reversal
 *     query. Exact match; adopt direct.
 *   - skos_related: maps to skos:related, which is declared
 *     `owl:SymmetricProperty` (skos-reference S23) — `<A> skos:related <B>`
 *     entails `<B> skos:related <A>`. Stored as a single directional string
 *     per the is_part_of/has_part precedent (no automatic inverse-row
 *     insertion at write time; symmetry is a reader-side fact, same as
 *     engaged_to/married_to/partner_of above). Named `skos_related` rather
 *     than `related` to avoid clashing with the pre-existing `related_to`
 *     string (which maps to schema:relatedTo, a different, Person-scoped
 *     relation) — see the storage-split note in ADR-DRAFT-2026-07-05.
 */
// EDGE_TYPES is defined in @ahkms/core (src/domain/vocab.ts) and re-exported above.


/**
 * JSON-LD `@context` fragment (ADR-033 / #192): maps each adopt-direct
 * EDGE_TYPES string to its canonical external IRI. This is the machine-
 * readable mirror of the per-term comments above `EDGE_TYPES` — anything
 * serialising an edge as JSON-LD should spread this in under `@context`.
 *
 * Deliberately excludes edges with no exact schema.org counterpart
 * (`related_to` — schema.org's only "relatedTo" is Person<->Person, not a
 * general Thing<->Thing relation, so it stays an ahkms-only term with no
 * `@context` mapping) and edges owned by a specialist vocabulary (the
 * lineage axis — `derived_from`, `was_generated_by`, `was_attributed_to` —
 * belongs to PROV-O per the specialist-wins rule; see PROV_CONTEXT below;
 * the citation axis — `references` — belongs to DCTerms per #196; see
 * DCTERMS_CONTEXT below).
 */
export const SCHEMA_ORG_CONTEXT: Partial<Record<(typeof EDGE_TYPES)[number], string>> = {
	mentions: "schema:mentions",
	member_of: "schema:memberOf",
	employed_by: "schema:worksFor",
	about: "schema:about",
	attended: "schema:attendee",
	author: "schema:author",
	is_part_of: "schema:isPartOf",
	has_part: "schema:hasPart",
	subject_of: "schema:subjectOf",
	// ADR099: schema:knowsAbout's domain (Person | Organization) and range (Thing |
	// Text | URL) match self -> competency concept exactly, so adopt-direct.
	knows_about: "schema:knowsAbout",
};

/**
 * JSON-LD `@context` fragment (ADR-033 / #193): maps each adopt-direct PROV-O
 * EDGE_TYPES string to its canonical `prov:` IRI. Mirrors SCHEMA_ORG_CONTEXT's
 * shape/purpose but kept as its own export — PROV-O is a distinct vocabulary
 * with its own prefix, and per-vocabulary context fragments are what "which
 * standards does ahOS align to, and for what?" (ADR-033) is meant to make
 * legible: one export per adopted vocabulary, not a single merged bag that
 * hides which term came from where. Anything serialising an edge as JSON-LD
 * should spread all adopted-vocabulary `@context` fragments together.
 */
export const PROV_CONTEXT: Partial<Record<(typeof EDGE_TYPES)[number], string>> = {
	derived_from: "prov:wasDerivedFrom",
	was_generated_by: "prov:wasGeneratedBy",
	was_attributed_to: "prov:wasAttributedTo",
};

/**
 * JSON-LD `@context` fragment (ADR-033 / #196): maps each adopt-direct
 * DCTerms EDGE_TYPES string to its canonical `dcterms:` IRI. Mirrors
 * SCHEMA_ORG_CONTEXT / PROV_CONTEXT's shape/purpose but kept as its own
 * export — DCTerms is a distinct vocabulary with its own prefix, and
 * per-vocabulary context fragments keep "which standard owns this term"
 * visible from the export name.
 *
 * Deliberately only carries `references` — DCTerms overlaps with two
 * already-adopted relations (`isPartOf` with schema:isPartOf/#192,
 * `subject` with schema:subjectOf/#192, `creator` with schema:author/#192),
 * and per the specialist-wins + one-canonical-term-per-relation rule those
 * stay owned by their existing mappings rather than being double-mapped
 * here. See the EDGE_TYPES comment block above for the per-term reasoning.
 */
export const DCTERMS_CONTEXT: Partial<Record<(typeof EDGE_TYPES)[number], string>> = {
	references: "dcterms:references",
	is_referenced_by: "dcterms:isReferencedBy",
};

/**
 * JSON-LD `@context` fragment (ADR-033 / #194): maps each adopt-direct FOAF
 * EDGE_TYPES string to its canonical `foaf:` IRI. Mirrors SCHEMA_ORG_CONTEXT /
 * PROV_CONTEXT / DCTERMS_CONTEXT's shape/purpose but kept as its own export —
 * FOAF is a distinct vocabulary with its own prefix, and per-vocabulary
 * context fragments keep "which standard owns this term" visible from the
 * export name.
 *
 * Deliberately only carries `current_project` — the People<->People/Group
 * FOAF terms (`knows`, `member`, `pastProject`, `made`) are owned by
 * `@ahkms/shared`'s RELATIONSHIP_VOCABULARY (ADR-021), which is where
 * People<->People/Group edges live per the routing rule; EDGE_TYPES only
 * carries the net-new People->Project edge FOAF also covers. See the
 * EDGE_TYPES comment block above for the full `member_of` direction
 * resolution (schema:memberOf vs. foaf:member point opposite ways).
 */
export const FOAF_CONTEXT: Partial<Record<(typeof EDGE_TYPES)[number], string>> = {
	current_project: "foaf:currentProject",
};

/**
 * JSON-LD `@context` fragment (ADR-033 / #195): maps each adopt-direct SKOS
 * EDGE_TYPES string to its canonical `skos:` IRI. Mirrors SCHEMA_ORG_CONTEXT /
 * PROV_CONTEXT / DCTERMS_CONTEXT / FOAF_CONTEXT's shape/purpose but kept as
 * its own export — SKOS is a distinct vocabulary with its own prefix, and
 * per-vocabulary context fragments keep "which standard owns this term"
 * visible from the export name.
 *
 * SKOS is doubly used in this codebase: as *data* here (the Areas hierarchy
 * edges) and as the cross-vocabulary *mapping predicate* (`skos:closeMatch`)
 * every other adoption in `ahOntology.ttl` uses to bridge approximate
 * `ahos:` terms — see the ADR-DRAFT-2026-07-05 doc. This context fragment
 * only concerns the data-edge usage.
 */
export const SKOS_CONTEXT: Partial<Record<(typeof EDGE_TYPES)[number], string>> = {
	broader: "skos:broader",
	narrower: "skos:narrower",
	skos_related: "skos:related",
};

/**
 * JSON-LD `@context` fragment (ADR-033 / #209): maps each ENTITY_TYPES value
 * that is directly anchored to an external RDF class to its canonical IRI.
 * There is no precedent table for this in vocab.ts before now -- `event`/
 * `organization`/`place` were added to ENTITY_TYPES without a class mapping
 * (ADR-025, #188) -- but `concept` explicitly IS a named external class
 * (skos:Concept), not just a graph-only node type, so it gets one, mirroring
 * SCHEMA_ORG_CONTEXT / PROV_CONTEXT / DCTERMS_CONTEXT / FOAF_CONTEXT /
 * SKOS_CONTEXT's per-vocabulary-fragment shape.
 *
 * concept -> skos:Concept is adopt-direct per ADR-033: "a topic/subject node"
 * is an exact match for skos:Concept's published definition (the generic
 * "unit of thought" class SKOS itself introduces), so no `ahos:` proxy or
 * `skos:closeMatch` hedge is needed. Concepts reuse the already-adopted
 * `broader`/`narrower` SKOS hierarchy edges (SKOS_CONTEXT above, #195/#232)
 * and the existing `about` edge (SCHEMA_ORG_CONTEXT, schema:about) for
 * artifact/entity -> concept links -- no new edge type is minted here.
 *
 * people/organization/place/event (ADR085, #173): the other four entity
 * types that had NO class mapping before this -- `event`/`organization`/
 * `place` were added to the CHECK with no anchor (ADR-025, #188) and
 * `people` never got one either -- are anchored here too, all adopt-direct
 * per ADR-033 (each published class definition matches ours exactly; see
 * ADR085 for the per-type reasoning). ADR085 also documents the properties
 * KEY vocabulary each class implies (e.g. people.email -> schema:email,
 * organization.legal_name -> schema:legalName) -- not encoded here, since
 * `properties` stays unvalidated free-form JSONB (ADR-036 rejects columns;
 * ADR-041 §3 rejects hard validation). This is a documentation-only
 * extension of the existing mechanism above; it does not touch the
 * ADR-036 vocabulary-registry runtime (term-node rows, `graph_instance_of`,
 * `graph_export_rdf`, the CI vocab-diff gate) that #359 implements in parallel.
 */
export const ENTITY_TYPE_CLASS_CONTEXT: Partial<Record<(typeof ENTITY_TYPES)[number], string>> = {
	concept: "skos:Concept",
	people: "foaf:Person",
	organization: "schema:Organization",
	place: "schema:Place",
	event: "schema:Event",
};

/** artifact_entity_links.link_type -- provenance edge strength. */
export const LINK_TYPES = ["primary", "mentioned", "related"] as const;
export const linkType = z.enum(LINK_TYPES);
export type LinkType = (typeof LINK_TYPES)[number];

/**
 * Source-trust tiers, ordered highest → lowest (index 0 = most trustworthy).
 * Small + stable set, so this IS enforced (enum / DB CHECK on trust_override).
 *
 * Trust is a JUDGEMENT, derived at read time from the capture's `surface` via the
 * user's surface→trust map, NOT stamped at capture time (capture is dumb). The
 * only stored trust is an optional per-artifact override. See ADR-026.
 */
export const TRUST_TIERS = ["perfect", "high", "medium", "low", "unverified"] as const;
export const trustTier = z.enum(TRUST_TIERS);
export type TrustTier = (typeof TRUST_TIERS)[number];

/**
 * Synthesis role ladder (ADR-046 §3) -- an ordered ladder of usage PERMISSIONS
 * for how EOD synthesis may use an artifact. Orthogonal to TRUST_TIERS above:
 * trust says how much to believe an item; role says how synthesis may use it.
 * Each tier includes everything below it (index 0 = most permissive):
 *   - narrative: quote/bundle into the day's story, plus everything below.
 *   - evidence:  consult to corroborate/reconcile, never narrate alone, +below.
 *   - metrics:   see only aggregates; individual items stay invisible.
 *   - excluded:  nothing; synthesis never touches it (the parking tier).
 * Small + stable set (like TRUST_TIERS), so this IS enforced (zod enum) even
 * though, like TRUST_TIERS, it is never a DB CHECK -- role is derived at read,
 * never stored on the artifact row (ADR-018: capture/ingest is dumb, interpret
 * at read). Storage is a `surface -> role` map in
 * user_preferences.capture_preferences, sibling to surface_trust_map -- see
 * captureConfig.ts's `surface_role_map` / `default_role` / `resolveSynthesisRole`.
 */
export const SYNTHESIS_ROLES = ["narrative", "evidence", "metrics", "excluded"] as const;
export const synthesisRole = z.enum(SYNTHESIS_ROLES);
export type SynthesisRole = (typeof SYNTHESIS_ROLES)[number];

/**
 * Capture-time urgency dial -- a USER-SUPPLIED signal (the May-12 `-throw` / default /
 * `-file` affordance, ported per docs/design/capture-skill-consolidation.md §b). Small
 * + stable set, so this IS enforced (enum / DB CHECK on artifacts.urgency, migration 072).
 *
 * Capture only WRITES the value faithfully; it never acts on it. The level is read at
 * enrich / synthesis time (#52) to decide how much to do — consistent with ADR-018
 * (capture dumb, synthesis smart). See migration 072 and issue #297.
 */
export const URGENCY_LEVELS = ["throw", "default", "file"] as const;
export const urgencyLevel = z.enum(URGENCY_LEVELS);
export type UrgencyLevel = (typeof URGENCY_LEVELS)[number];

/**
 * Capture surfaces -- the specific app / agent / ingest path a capture came
 * through (finer than source_channel). OPEN vocab: this list is suggestions, not
 * enforcement (every new integration adds one), so `surface` is stored as a free
 * string. Add entries here for discoverability; no migration needed. See ADR-026.
 */
/**
 * The surface a Gmail BODY ingest stamps (ADR-046 §4 rows 1.5/1.6): mail pulled from a
 * mailbox as evidence of the day, as opposed to the `act_receipt` that `gmail_send_draft`
 * writes when ahOS itself sends. No tool writes it yet; sessions have captured sent mail
 * under it by hand (2026-10-13). Named so the role floor can key on it (#1767).
 */
export const GMAIL_INGEST_SURFACE = "gmail_ingest";

export const SURFACES = [
	"claude_code",
	"claude_chat",
	"claude_mobile",
	"web_app",
	"mobile_app",
	GMAIL_INGEST_SURFACE,
	"slack",
	"browser_extension",
	"drive_import",
	"api",
	// A RITUAL-OUTPUT surface: the dos-hl EOD ritual writing its own Daily Log entry
	// back into the store as an artifact twin (#562, ADR-050 §7). It is listed here
	// because ADR-051 §9 -- "the ritual's own output is never the ritual's input" --
	// is specified to be enforced through the `surface -> role` map (a ritual output
	// resolving to the ADR-046 §3 `excluded` tier), and that map is keyed on exactly
	// this string. The gate is NOT built yet (no search path gates on role;
	// knowledge_search's `rank_by_role`, #911, reads it for order only); exclusion is carried today by
	// DAILY_LOG_CONTENT_SUBTYPE below. Stamping the surface now is what lets the gate
	// be built later WITHOUT a backfill over twins written in the meantime.
	"dos_hl",
	// The same surface for the unified `dos` ritual (ADR-054 §7), which replaces dos-hl,
	// dos-personal and dos-infra with one nightly session over both domains. `dos_hl` is
	// kept for the twins it already stamped; nothing new should write it. Both resolve to
	// the same `excluded` tier once the surface -> role gate is built.
	"dos",
	// SYSTEM-STAMPED surfaces (#584): no caller supplies these, a writer invents
	// them, so their canonical definitions live in @ahkms/shared's
	// ARTIFACT_SURFACES — the worker stamps some of them too and the two packages
	// must not drift. They are listed here as well because this is the list a
	// human reads when deciding what to put in `surface_role_map`, and a value
	// that resolves in production but is absent from the vocabulary is exactly
	// how a surface becomes un-configurable in practice. `artifactSurface.test.ts`
	// pins the two lists together.
	"act_receipt",
	"derived",
	// Ingest of the owner's own GitHub activity (#1010). Seeded to role `evidence`
	// by ADR-046 §3, which is a statement about this exact key: GitHub corroborates
	// a day, it never narrates one alone.
	"github",
	// Ingest of the owner's own Slack messages (#1011). Two surfaces, because DMs
	// carry other people's confidences and are the one class most likely to need a
	// rule of their own; pooling them with channels would make that rule
	// inexpressible without re-ingesting. `slack` was already in this list as an
	// aspiration before anything wrote it; `slack_dm` is new.
	"slack_dm",
	// Ingest of WhatsApp messages via the linked companion device (`whatsapp_ingest`).
	// Split into `whatsapp` (group chats) and `whatsapp_dm` (1:1 and self-chats) for
	// the same ADR-046 §3 reason as `slack` / `slack_dm`.
	"whatsapp",
	"whatsapp_dm",
	// Weekly KPI scorecard snapshots written by `weekly_kpi_snapshot` (ADR-046 §3 role `metrics`).
	"kpi_snapshot",
	// HISTORICAL surfaces, minted by migration 091's backfill and by nothing else.
	// No writer in this repo produces them and none ever should, so they are
	// deliberately absent from ARTIFACT_SURFACES — but they exist in the store,
	// and this list is what a human reads when deciding what to put in
	// `surface_role_map`. Leaving them off would reproduce the #584 defect in its
	// subtler form: a row that HAS a key nobody can discover is barely better than
	// one with no key at all, and 091's whole promise for these rows is that the
	// owner "can map them to `excluded` in one line".
	//
	//   n8n_upload         14 rows from an EXTERNAL n8n workflow that wrote
	//                      straight through PostgREST (newest 2025-11-18). Named
	//                      rather than pooled because it is a different writer
	//                      with a different trust story — and because it is the
	//                      second, un-guardable precondition on the NOT NULL
	//                      constraint (#736).
	//   legacy_unrecorded   4 rows from 2025 with no channel, no source and no
	//                      subtype. There is no writer left to attribute them to;
	//                      inventing a plausible one would be a lie. Deliberately
	//                      narrow and time-bounded — never a bucket for new rows.
	"n8n_upload",
	"legacy_unrecorded",
] as const;
export type Surface = (typeof SURFACES)[number];

/**
 * `artifacts.content_subtype` is OPEN vocab (see capture.ts — user-supplied flags like
 * 'transcript' | 'note' | 'task' | …, never enforced). This one value is the exception:
 * it is SYSTEM-generated, never user-supplied. `task_create` stamps it on the artifact it
 * auto-captures from the message that requested an artifact-less task (issue #413 — "every
 * task traceable back to the thought that produced it"). It is the "distinct provenance"
 * marker: `knowledge_search` excludes rows carrying it by default (opt in with
 * `include_task_requests`) so one-line task requests ("add task: buy milk") don't crowd
 * search results. Single-sourced here so the writer (task_create) and the reader
 * (knowledge_search) can never drift on the string. Deliberately NOT 'task' — that value
 * has downstream meaning (feeds SOD/EOD state-doc scoping, ADR-013); a task *request* must
 * not be mistaken for an actionable task atom.
 */
// TASK_REQUEST_CONTENT_SUBTYPE is defined in @ahkms/core (src/domain/vocab.ts) and re-exported above.

/**
 * Sibling of TASK_REQUEST_CONTENT_SUBTYPE for the Event/Calendar Act facet (issue #126,
 * ADR-038 §6): `event_create` stamps this on the provenance artifact it auto-captures
 * from the message that requested an artifact-less calendar event, mirroring
 * `task_create`'s `task_request` marker exactly (same "distinct provenance, excluded
 * from knowledge_search by default" treatment — see `knowledge_search`'s
 * `include_event_requests`). Also system-generated, never user-supplied.
 */
// EVENT_REQUEST_CONTENT_SUBTYPE is defined in @ahkms/core (src/domain/vocab.ts) and re-exported above.

/**
 * The third SYSTEM-generated `content_subtype` (#562, ADR-050 §7): the ahKMS twin of a
 * Daily Log entry the EOD ritual wrote to Notion. A Daily Log entry is an immutable
 * record of a day, so it is knowledge and belongs where `knowledge_search` can reach it
 * -- "what did I decide on 12 August" is otherwise unanswerable from the memory side.
 *
 * It carries the SAME treatment as its two siblings above -- excluded from
 * `knowledge_search` by default, opt back in with `include_daily_logs` -- and that one
 * mechanism is the whole of ADR-051 §9 as built: **the ritual's own output must never
 * come back as an input.** Without it, tomorrow's day-window read consumes today's log
 * and the ritual synthesises its own synthesis.
 *
 * Deliberately NOT `'derived'`: the worker already writes that value on artifacts it
 * derives from others, and it is not excluded from search -- reusing it would make one
 * string mean two things and silently widen the exclusion to rows nobody meant to hide.
 *
 * Deliberately not carrying "was this day confirmed?" either. That is DERIVED from the
 * marker set (which `artifact_external_links` kinds point at the twin's Notion page),
 * never stored: promotion is INSERT-only and no marker-mutation path exists anywhere in
 * the codebase, so a stored flag would go stale on the first promotion and could never
 * be cleared. See `dos_synthesis_coverage`, whose per-kind id lists answer it.
 */
// DAILY_LOG_CONTENT_SUBTYPE is defined in @ahkms/core (src/domain/vocab.ts) and re-exported above.

/**
 * The fourth SYSTEM-generated `content_subtype` (#994, ADR-051 §9): output a Cowork
 * scheduled task captures back into the store as the ritual's own INPUT for a later
 * ritual -- e.g. `friday-reflection-prep`'s "Weekly Reflection" scaffold, the input
 * `dos-reflect` reads and archives or consumes. It is ritual output, not material for
 * `dos`'s day-window read, exactly the same shape as its three siblings above.
 *
 * Before this existed, #991 caught the one instance it broke (a scaffold surfacing as
 * the day's only unconsumed atom) with a text match in the `dos` skill body: an atom
 * whose text opens with a fixed banner, or that carries the tags `routine` + `weekly`
 * + `reflection`. That rule lived in prose, not structure -- a generator that changed
 * its banner, or a second scheduled task with no banner at all, was routed like any
 * other atom until someone noticed. This subtype is the structural fix ADR-051 §9
 * calls for: excluded from `knowledge_search` by default, opt back in with
 * `include_scaffolds`, same mechanism as `daily_log`.
 *
 * Stamping it is an owner action in the Cowork scheduled task itself (the same class
 * of follow-up as #988) -- out of scope here; this declares the vocabulary value and
 * wires its default-excluded treatment so the task has something to stamp.
 */
// SCAFFOLD_CONTENT_SUBTYPE, DAILY_LOG_LINK_KIND, STATE_DOC_LINK_KIND, BACKDATABLE_CONTENT_SUBTYPES,
// MEETING_NOTE_CONTENT_SUBTYPE, and SYSTEM_PRODUCED_CONTENT_SUBTYPES are defined in @ahkms/core
// (src/domain/vocab.ts) and re-exported above.

/**
 * Which `processing_metadata.discovery` timestamp is ORIGINATION, per connector (#571 (a),
 * ADR-088; ADR-046 §4's per-source policy table).
 *
 * There is no single right answer across sources, which is why this is a table and not a
 * constant. Drive's discover cadence is incremental on `modifiedTime`, so the rows that
 * arrive are precisely the recently-touched ones — keying on modified time would put a
 * 2016 contract re-saved last week back into last week's window, which is the bug. Its
 * `createdTime` is the honest answer: the contract is from 2016. Notion is the opposite
 * case: a page is a living document, and one edited today holds content from today, so
 * `last_edited_time` is its origination and `created_time` would file a heavily-revised
 * 2024 page under 2024 forever.
 *
 * A connector ABSENT from this map is not a defect and needs no entry to be safe: its
 * rows keep `originated_at` NULL, `artifacts.effective_at` falls back to `captured_at`,
 * and the day window behaves exactly as it did before ADR-088. Adding a source is
 * therefore additive and never retroactive — the opposite of a default that guesses.
 *
 * Both values are deterministic field-copies of the source API's own response, so this
 * stays on the provenance side of ADR-046 §2's envelope test and never becomes the
 * write-time judgement ADR-018 forbids.
 *
 * Deliberately NOT in `captureConfig.ts` beside `DISCOVER_ROLE_SEED`, despite both
 * implementing a row of the same ADR-046 §4 table: everything in that module is a FLOOR
 * under the owner's stored `capture_preferences`, i.e. configurable. Which timestamp a
 * source serves as origination is a fact about the source's API, not a preference, and
 * putting it there would advertise a dial that must not exist — an owner who could point
 * origination at a different field could silently refile years of atoms.
 *
 * Gmail attachments (#1210) take the message date, which the sweep serves as
 * `source_created_at`: a delivered message never changes, so an attachment originates
 * when it was sent or received, not when the sweep first saw it.
 */
export { ORIGINATION_FIELD_BY_CONNECTOR, originationFor } from "@ahkms/core";

/**
 * The connector each Google account's Gmail attachment sweep writes pointers under
 * (#1210), so `source_channel` is `discovered_<connector>`.
 *
 * Same shape as Drive's DRIVE_CONNECTOR_BY_ACCOUNT, and for the same reason: the account
 * is carried in the connector name, which is the one value that already reaches both the
 * write side (source_channel, surface) and every reader. The personal account takes the
 * bare spelling, Work the suffix.
 *
 * Deliberately NOT `gmail`. `ingest_discover` advertises 'gmail' as an example connector,
 * so an agent may already have written message-level pointers under `discovered_gmail`,
 * keyed by message id. One pointer per ATTACHMENT is a different kind of row with a
 * different key (`<message_id>:<part_id>`); sharing the channel would mix the two in
 * every reader that filters on it.
 *
 * These are DB values once a sweep has run: re-discovery matches on source_channel, so a
 * rename would orphan every pointer already written. Add an account; never rename one.
 */
export const GMAIL_ATTACHMENT_CONNECTOR_BY_ACCOUNT: Readonly<
	Record<"personal" | "work", string>
> = Object.freeze({
	personal: "gmail_attachment",
	work: "gmail_attachment_work",
});

/**
 * The `content_subtype` the `close` skill stamps on the one session-summary atom every
 * `/close` writes (#565): the session's own account of what it set out to do, achieved,
 * decided and left open, at role narrative, so a coding day can be narrated at all. ADR-046
 * §3 puts GitHub at role evidence, which corroborates but never narrates alone; without
 * this atom the largest block of a coding day cannot appear in the Daily Log.
 *
 * Deliberately NOT given the exclusion treatment of its three system-generated siblings
 * above: it is an INPUT to the day, not ritual output, so the day-window read must
 * return it and the Daily Log consumes it like any other atom (#562 nests, it does not
 * compete). Not backdatable either (a close after midnight files under the day it ran;
 * #571 is the place a general originated_at would be decided). The structured fields the
 * #565 decision asked for travel as tags (`repo:`, `branch:`, `domain:`, `pr:`, `issue:`),
 * because tags are the one filterable list an artifact carries today. Declared here so
 * a reader that ever wants to filter on it has one string to import, not a guess.
 */
export const SESSION_SUMMARY_CONTENT_SUBTYPE = "session_summary";

/**
 * The two `content_subtype` values `ingest_github` stamps (#1010).
 *
 * Split by kind rather than pooled under one "github" value because the read end wants
 * them apart: a merged pull request is a thing that happened, an open issue is a thing
 * that has not. `knowledge_search` filters on this column, so pooling would make "what
 * did I ship" and "what is still open" the same query.
 *
 * Neither is excluded from search by default. They are INPUTS to a day, like
 * SESSION_SUMMARY_CONTENT_SUBTYPE above and unlike the `task_request` / `event_request`
 * provenance pair. Volume is governed at the SURFACE layer instead, where ADR-046 §3
 * already puts GitHub at role `evidence` and `surface_role_map` can demote it further.
 * Excluding by content_subtype would hide the rows from search entirely, which is a
 * blunter instrument than the one the architecture already provides.
 */
export const GITHUB_ISSUE_CONTENT_SUBTYPE = "github_issue";
export const GITHUB_PULL_REQUEST_CONTENT_SUBTYPE = "github_pull_request";

/**
 * The `content_subtype` `ingest_slack` stamps on a captured Slack message (#1011).
 *
 * ONE value across channels and DMs, unlike the GitHub pair above, because the
 * distinction that matters here is WHERE it was said, not what kind of thing it is, and
 * where-it-was-said is already carried by the surface (`slack` vs `slack_dm`) where the
 * role ladder can act on it. Splitting the subtype too would encode the same fact twice
 * and let the two disagree.
 */
export const SLACK_MESSAGE_CONTENT_SUBTYPE = "slack_message";

/**
 * The `content_subtype` `whatsapp_ingest` stamps on a captured WhatsApp message.
 * Mirrors `SLACK_MESSAGE_CONTENT_SUBTYPE`: one subtype across groups and DMs while
 * the surface (`whatsapp` vs `whatsapp_dm`) carries the role-governance boundary.
 */
export const WHATSAPP_MESSAGE_CONTENT_SUBTYPE = "whatsapp_message";

/**
 * The `content_subtype` stamped on the artifact `gmail_send_draft` writes after a send
 * lands (#1006): what went out, to whom, from which account, and the thread it joined.
 *
 * Gmail's Sent folder already holds the message, so this is not storage. It is reach:
 * `dos` reads the day from ahKMS, and before this a sent email was the one kind of
 * deliberate act that left no trace the ritual could see. "What did I commit to on
 * Tuesday" is usually answered by an email nobody captured. Its ROLE under ADR-046 §4
 * rows 1.5/1.6 is `evidence` with trust high, confirmed by the owner on 2026-10-14
 * (#1767, ADR-108 §4): the receipt corroborates the day, the session summary or capture
 * narrates it. The `act_receipt` surface joins the role floor in #1771 (together with
 * applying the robot exclusion to every tier); until then it resolves to `default_role`.
 * (An earlier version of this comment read ADR-046 §3 as placing sent mail above
 * evidence; it does not.)
 *
 * Treated like SESSION_SUMMARY_CONTENT_SUBTYPE above, not like its `task_request` /
 * `event_request` cousins: those are provenance for a thing created elsewhere and are
 * excluded from `knowledge_search` by default, whereas a sent email is a first-class
 * INPUT to the day and must come back in the day-window read. Not backdatable: the day it
 * was sent is the day it was sent.
 */
export const EMAIL_SENT_CONTENT_SUBTYPE = "email_sent";

/**
 * Captured artifact content subtypes (#589, #590, #597).
 * Open vocabulary, classified at capture by tag routing — the same
 * `artifacts.content_subtype` convention TASK_REQUEST_CONTENT_SUBTYPE and
 * EVENT_REQUEST_CONTENT_SUBTYPE above are instances of (see capture.ts: user-supplied
 * flags, never enforced). Extracted and actioned downstream in `process_artifact`.
 */
export const VOUCHER_CONTENT_SUBTYPE = "voucher";
export const BILL_CONTENT_SUBTYPE = "bill";
export const BUSINESS_CARD_CONTENT_SUBTYPE = "business_card";

/**
 * `artifacts.lifecycle_stage` values written and read by the Discover & Index
 * pipeline (ADR-016) -- discover.ts, enrichNext.ts, and search.ts (issue #586).
 *
 * Before this, each of those three files carried its own hand-typed copy of
 * "discovered"/"extracted"/"failed" (search.ts's `UNENRICHED_STAGES`, discover.ts's
 * insert/update payloads, enrichNext.ts's selection queries and terminal-state
 * writes), and the *shared* `LifecycleStage` type in `@ahkms/shared` had already
 * drifted from them -- it listed `extracted`/`failed` but not `discovered` (round-1
 * QA review on #581, finding L1). Single-sourcing here is exactly the
 * TASK_REQUEST_CONTENT_SUBTYPE treatment above: the writer and every reader import
 * the same constant, so they can never drift on the string again.
 *
 * This is the Discover & Index SUBSET of the full artifact lifecycle, not the whole
 * of it -- `uploaded`/`analysed`/`complete`/... are the worker's capture pipeline
 * stages (packages/worker/src/workflows/steps/*.ts) and stay out of scope here; only
 * the three stages this pipeline actually writes belong in this file.
 *
 * The type below is a compile-time SUBSET check, not a bidirectional guard: it fails
 * `tsc` if a stage is ever added here that is not also in `@ahkms/shared`'s
 * `LifecycleStage` union, so this file's vocabulary can't silently outrun the shared
 * type again. The reverse is deliberately NOT enforced -- `LifecycleStage` also spans
 * the worker's capture-pipeline stages (`uploaded`/`analysed`/`complete`/...), which
 * have no business appearing in this Discover & Index subset. Note: `@ahkms/shared`
 * is a *built* dependency (`"@ahkms/shared": "*"` resolves to its `dist/`), so this
 * guard only sees a shared type change after `@ahkms/shared` is rebuilt -- run
 * `npx turbo run build --filter=@ahkms/shared` before `npx turbo run typecheck` when
 * editing `packages/shared/src/types/knowledge.ts`, and use `--force` on the
 * typecheck itself, since turbo's cache cannot see inside the built dependency.
 */
export const EXTRACTED_STAGE = "extracted";
export const FAILED_STAGE = "failed";

export const DISCOVER_INDEX_STAGES = [
	DISCOVERED_STAGE,
	EXTRACTED_STAGE,
	FAILED_STAGE,
] as const;
export type DiscoverIndexStage = (typeof DISCOVER_INDEX_STAGES)[number];

// Zero-runtime compile-time assertion (round-1 QA review on #774, L1): a type alias
// alone emits nothing to dist/, unlike the const-with-annotation form this replaces.
// `AssertTrue`'s `extends true` constraint is what actually forces the check to fire
// AT THIS DECLARATION -- deliberately branching to `false`, not `never`, on failure:
// `never` is TypeScript's bottom type, so it is structurally assignable to every
// constraint (`never extends true` holds), which would make a `? true : never` form
// compile cleanly regardless of whether the subset relation actually holds -- a type
// alias that always "passes" is a guard in name only.
type AssertTrue<T extends true> = T;
type _DiscoverIndexStagesAreSharedLifecycleStages = AssertTrue<
	DiscoverIndexStage extends LifecycleStage ? true : false
>;

/**
 * Discover & Index pointers that have nothing to narrate: registered by `ingest_discover`
 * but never enriched to a body (`discovered`), or enrichment attempted and errored
 * (`failed`, enrichNext.ts's `markFailed`) -- as opposed to `extracted`, which has
 * real content. `search.ts` excludes these from synthesis reads by default (#567,
 * round-1 QA finding M1) unless the caller opts in via `include_discovered`.
 *
 * Typed `ReadonlySet<string>` rather than `ReadonlySet<DiscoverIndexStage>` because
 * every call site checks membership of a plain `string | null` database column
 * value, not a value already known to be a `DiscoverIndexStage`.
 */
export const UNENRICHED_STAGES: ReadonlySet<string> = new Set([
	DISCOVERED_STAGE,
	FAILED_STAGE,
]);

/**
 * Artifact lifecycle stages that have content / bodies (as opposed to unenriched
 * pointers like 'discovered' or 'failed'). Used by search.ts to query PostgREST
 * with a positive `in` filter so Postgres can leverage stage indexes rather than
 * falling back to a full-table or wide-index scan on `not.in.(discovered,failed)` (#1726).
 */
export const ENRICHED_STAGES = [
	"uploaded",
	"upload_failed",
	"processing",
	"analysed",
	"analysis_failed",
	"needs_review",
	"entities_extracted",
	"actions_extracted",
	"artifacts_created",
	"complete",
	"blocked",
	"archived",
	"extracted",
	"contextualized",
	"actionable",
	"refined",
	"processed",
] as const;
export type EnrichedStage = (typeof ENRICHED_STAGES)[number];

// Compile-time assertion: no enriched stage may be an unenriched Discover & Index stage
type _NoEnrichedStageIsUnenriched = AssertTrue<
	EnrichedStage extends DiscoverIndexStage ? (EnrichedStage extends typeof EXTRACTED_STAGE ? true : false) : true
>;
