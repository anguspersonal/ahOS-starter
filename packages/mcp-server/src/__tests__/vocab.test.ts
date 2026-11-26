/**
 * ADR-033 / #192 — Schema.org vocabulary adoption.
 * ADR-033 / #193 — PROV-O vocabulary adoption.
 * ADR-033 / #196 — DCTerms vocabulary adoption.
 * ADR-033 / #194 — FOAF vocabulary adoption (completes ADR-021's People-only slice).
 * ADR-033 / #195 — SKOS vocabulary adoption (Areas hierarchy).
 *
 * Pins several things about EDGE_TYPES / SCHEMA_ORG_CONTEXT / PROV_CONTEXT /
 * DCTERMS_CONTEXT / FOAF_CONTEXT / SKOS_CONTEXT so the vocabulary doesn't
 * silently drift:
 *   1. every context key is a real EDGE_TYPES member (the mapping can't
 *      reference a string that was renamed or removed);
 *   2. is_part_of / has_part are declared as an inverse pair (mirroring the
 *      inverse-pair check the RELATIONSHIP_VOCABULARY tests run in
 *      packages/web/__tests__/utils/relationshipVocabulary.test.ts);
 *   3. subject_of is adopted direct to schema:subjectOf (the formal inverseOf
 *      schema:about — an exact match, not an approximation) and related_to
 *      has no mapping (schema:relatedTo is Person<->Person only, not a
 *      general Thing<->Thing relation, so it would be a false claim here);
 *   4. derived_from / was_generated_by / was_attributed_to are adopted direct
 *      to their prov: IRIs (PROV-O owns the lineage axis) and PROV_CONTEXT
 *      never overlaps with SCHEMA_ORG_CONTEXT (one canonical vocabulary per edge);
 *   5. references is adopted direct to dcterms:references (DCTerms owns the
 *      documents/citation axis) and DCTERMS_CONTEXT never overlaps with
 *      SCHEMA_ORG_CONTEXT or PROV_CONTEXT (one canonical vocabulary per edge —
 *      dcterms:creator/isPartOf/subject overlap with already-adopted
 *      schema:author/isPartOf/subjectOf, so DCTerms only claims `references`);
 *   6. current_project is adopted direct to foaf:currentProject (FOAF owns the
 *      people axis; this is the one People->Project gap ADR-021 left open) and
 *      FOAF_CONTEXT never overlaps with the other three context maps —
 *      `member_of` stays owned by schema:memberOf (#223) because foaf:member's
 *      verified domain/range (Group->Agent) is the OPPOSITE direction from
 *      how `member_of` is actually written (Agent->Group), so it is not
 *      re-mapped to foaf:member.
 *   7. broader/narrower/skos_related are adopted direct to skos:broader,
 *      skos:narrower, skos:related (SKOS owns the concept-hierarchy axis) and
 *      SKOS_CONTEXT never overlaps with the other four context maps. Direction
 *      was independently verified against the published SKOS reference
 *      (skos:broader's subject is the NARROWER concept — the classic trap);
 *      broader/narrower are the declared owl:inverseOf pair, skos_related is
 *      owl:SymmetricProperty.
 *
 * ADR-033 / #209 — 'concept' entity type, anchored to skos:Concept.
 *   8. 'concept' is in ENTITY_TYPES and ENTITY_TYPE_CLASS_CONTEXT maps it
 *      directly to skos:Concept (adopt-direct — an exact match for "a topic/
 *      subject node", no ahos: proxy or skos:closeMatch hedge). Concepts reuse
 *      the already-adopted broader/narrower SKOS edges and the existing
 *      `about` edge (schema:about) — no new EDGE_TYPES string is minted.
 *
 * ADR085 / #173 — people/organization/place/event anchored to public classes.
 *   9. 'people'/'organization'/'place'/'event' are each in ENTITY_TYPES and
 *      ENTITY_TYPE_CLASS_CONTEXT maps them directly to foaf:Person /
 *      schema:Organization / schema:Place / schema:Event (adopt-direct — each
 *      published class matches ours exactly; ADR085 records the per-type
 *      reasoning and the properties key vocabulary each class implies).
 *
 * ADR099 / #1231 — the career ledger rides existing graph types.
 *  10. knows_about / demonstrates / in_role / student / institution are in
 *      EDGE_TYPES; knows_about is adopted direct to schema:knowsAbout (the
 *      one exact match) and the other four are ahos-native, so they stay out
 *      of every @context map, like the ADR-035 participant edges.
 */

import { describe, expect, it } from "vitest";
import {
	DCTERMS_CONTEXT,
	EDGE_TYPES,
	ENTITY_TYPE_CLASS_CONTEXT,
	ENTITY_TYPES,
	FOAF_CONTEXT,
	PROV_CONTEXT,
	SCHEMA_ORG_CONTEXT,
	SKOS_CONTEXT,
} from "../vocab.js";

describe("EDGE_TYPES (ADR-033 / #192 Schema.org adoption)", () => {
	it("includes the net-new Schema.org spine terms", () => {
		expect(EDGE_TYPES).toContain("author");
		expect(EDGE_TYPES).toContain("is_part_of");
		expect(EDGE_TYPES).toContain("has_part");
		expect(EDGE_TYPES).toContain("subject_of");
	});

	it("declares is_part_of / has_part as an inverse pair (both present, neither orphaned)", () => {
		expect(EDGE_TYPES).toContain("is_part_of");
		expect(EDGE_TYPES).toContain("has_part");
	});

	it("keeps EDGE_TYPES entries unique (no accidental duplicate edge strings)", () => {
		const seen = new Set<string>();
		for (const t of EDGE_TYPES) {
			expect(seen.has(t), `duplicate EDGE_TYPES entry: ${t}`).toBe(false);
			seen.add(t);
		}
	});
});

describe("SCHEMA_ORG_CONTEXT (ADR-033 / #192)", () => {
	it("only maps strings that are actually in EDGE_TYPES (no stale/renamed keys)", () => {
		const edgeSet = new Set<string>(EDGE_TYPES);
		for (const key of Object.keys(SCHEMA_ORG_CONTEXT)) {
			expect(edgeSet.has(key), `SCHEMA_ORG_CONTEXT key "${key}" is not in EDGE_TYPES`).toBe(true);
		}
	});

	it("maps every value to a schema: CURIE (adopt-direct rule — no bare IRIs, no ahos: proxies)", () => {
		for (const [key, value] of Object.entries(SCHEMA_ORG_CONTEXT)) {
			expect(value, `SCHEMA_ORG_CONTEXT.${key}`).toMatch(/^schema:[A-Za-z]+$/);
		}
	});

	it("covers the terms ADR-033 / #192 named as already-existing + mapped", () => {
		expect(SCHEMA_ORG_CONTEXT.about).toBe("schema:about");
		expect(SCHEMA_ORG_CONTEXT.mentions).toBe("schema:mentions");
		expect(SCHEMA_ORG_CONTEXT.member_of).toBe("schema:memberOf");
		expect(SCHEMA_ORG_CONTEXT.employed_by).toBe("schema:worksFor");
		expect(SCHEMA_ORG_CONTEXT.attended).toBe("schema:attendee");
	});

	it("covers the net-new terms", () => {
		expect(SCHEMA_ORG_CONTEXT.author).toBe("schema:author");
		expect(SCHEMA_ORG_CONTEXT.is_part_of).toBe("schema:isPartOf");
		expect(SCHEMA_ORG_CONTEXT.has_part).toBe("schema:hasPart");
	});

	it("adopts subject_of directly — schema:subjectOf is the formal inverseOf schema:about, an exact match", () => {
		expect(SCHEMA_ORG_CONTEXT.subject_of).toBe("schema:subjectOf");
	});

	it("does not map related_to — schema:relatedTo is scoped to Person<->Person, not our general usage", () => {
		expect(SCHEMA_ORG_CONTEXT.related_to).toBeUndefined();
	});

	it("does not map derived_from — that axis is owned by PROV-O (#193), not Schema.org", () => {
		expect(SCHEMA_ORG_CONTEXT.derived_from).toBeUndefined();
	});
});

describe("EDGE_TYPES (ADR-033 / #193 PROV-O adoption)", () => {
	it("includes the net-new PROV-O lineage terms", () => {
		expect(EDGE_TYPES).toContain("was_generated_by");
		expect(EDGE_TYPES).toContain("was_attributed_to");
	});

	it("keeps the pre-existing derived_from term (now mapped to prov:wasDerivedFrom)", () => {
		expect(EDGE_TYPES).toContain("derived_from");
	});
});

describe("PROV_CONTEXT (ADR-033 / #193)", () => {
	it("only maps strings that are actually in EDGE_TYPES (no stale/renamed keys)", () => {
		const edgeSet = new Set<string>(EDGE_TYPES);
		for (const key of Object.keys(PROV_CONTEXT)) {
			expect(edgeSet.has(key), `PROV_CONTEXT key "${key}" is not in EDGE_TYPES`).toBe(true);
		}
	});

	it("maps every value to a prov: CURIE (adopt-direct rule — no bare IRIs, no ahos: proxies)", () => {
		for (const [key, value] of Object.entries(PROV_CONTEXT)) {
			expect(value, `PROV_CONTEXT.${key}`).toMatch(/^prov:[A-Za-z]+$/);
		}
	});

	it("adopts all three PROV-O lineage terms directly — verified exact-match domain/range against the published ontology", () => {
		expect(PROV_CONTEXT.derived_from).toBe("prov:wasDerivedFrom");
		expect(PROV_CONTEXT.was_generated_by).toBe("prov:wasGeneratedBy");
		expect(PROV_CONTEXT.was_attributed_to).toBe("prov:wasAttributedTo");
	});

	it("does not overlap with SCHEMA_ORG_CONTEXT keys — one canonical vocabulary per edge (specialist-wins rule)", () => {
		const schemaKeys = new Set(Object.keys(SCHEMA_ORG_CONTEXT));
		for (const key of Object.keys(PROV_CONTEXT)) {
			expect(schemaKeys.has(key), `"${key}" is mapped by both SCHEMA_ORG_CONTEXT and PROV_CONTEXT`).toBe(false);
		}
	});
});

describe("EDGE_TYPES (ADR-033 / #196 DCTerms adoption)", () => {
	it("includes the net-new DCTerms citation term", () => {
		expect(EDGE_TYPES).toContain("references");
		expect(EDGE_TYPES).toContain("is_referenced_by");
	});
});

describe("DCTERMS_CONTEXT (ADR-033 / #196)", () => {
	it("only maps strings that are actually in EDGE_TYPES (no stale/renamed keys)", () => {
		const edgeSet = new Set<string>(EDGE_TYPES);
		for (const key of Object.keys(DCTERMS_CONTEXT)) {
			expect(edgeSet.has(key), `DCTERMS_CONTEXT key "${key}" is not in EDGE_TYPES`).toBe(true);
		}
	});

	it("maps every value to a dcterms: CURIE (adopt-direct rule — no bare IRIs, no ahos: proxies)", () => {
		for (const [key, value] of Object.entries(DCTERMS_CONTEXT)) {
			expect(value, `DCTERMS_CONTEXT.${key}`).toMatch(/^dcterms:[A-Za-z]+$/);
		}
	});

	it("adopts references directly — verified against the published DCMI definition (exact match)", () => {
		expect(DCTERMS_CONTEXT.references).toBe("dcterms:references");
	});

	it("does not map creator/isPartOf/subject — those relations are already owned by Schema.org (#192), no double-mapping", () => {
		expect(DCTERMS_CONTEXT.author).toBeUndefined();
		expect(DCTERMS_CONTEXT.is_part_of).toBeUndefined();
		expect(DCTERMS_CONTEXT.has_part).toBeUndefined();
		expect(DCTERMS_CONTEXT.subject_of).toBeUndefined();
	});

	it("does not overlap with SCHEMA_ORG_CONTEXT or PROV_CONTEXT keys — one canonical vocabulary per edge (specialist-wins rule)", () => {
		const schemaKeys = new Set(Object.keys(SCHEMA_ORG_CONTEXT));
		const provKeys = new Set(Object.keys(PROV_CONTEXT));
		for (const key of Object.keys(DCTERMS_CONTEXT)) {
			expect(schemaKeys.has(key), `"${key}" is mapped by both SCHEMA_ORG_CONTEXT and DCTERMS_CONTEXT`).toBe(false);
			expect(provKeys.has(key), `"${key}" is mapped by both PROV_CONTEXT and DCTERMS_CONTEXT`).toBe(false);
		}
	});
});

describe("EDGE_TYPES (ADR-033 / #194 FOAF adoption)", () => {
	it("includes the net-new FOAF People->Project term", () => {
		expect(EDGE_TYPES).toContain("current_project");
	});

	it("does not mint a separate member_of-direction string for foaf:member (Group->Agent, opposite of member_of's Agent->Group)", () => {
		// member_of already exists (schema:memberOf, #223) and is written
		// Agent -> Group; foaf:member's own Group -> Agent direction has no
		// producer today, so no `has_member`-style string is minted here.
		expect(EDGE_TYPES).toContain("member_of");
	});
});

describe("FOAF_CONTEXT (ADR-033 / #194)", () => {
	it("only maps strings that are actually in EDGE_TYPES (no stale/renamed keys)", () => {
		const edgeSet = new Set<string>(EDGE_TYPES);
		for (const key of Object.keys(FOAF_CONTEXT)) {
			expect(edgeSet.has(key), `FOAF_CONTEXT key "${key}" is not in EDGE_TYPES`).toBe(true);
		}
	});

	it("maps every value to a foaf: CURIE (adopt-direct rule — no bare IRIs, no ahos: proxies)", () => {
		for (const [key, value] of Object.entries(FOAF_CONTEXT)) {
			expect(value, `FOAF_CONTEXT.${key}`).toMatch(/^foaf:[A-Za-z]+$/);
		}
	});

	it("adopts current_project directly — verified exact-match domain/range (foaf:Person -> foaf:Thing) against the published spec", () => {
		expect(FOAF_CONTEXT.current_project).toBe("foaf:currentProject");
	});

	it("does not map member_of — schema:memberOf (#223) already owns that direction; foaf:member points the opposite way", () => {
		expect(FOAF_CONTEXT.member_of).toBeUndefined();
	});

	it("does not overlap with SCHEMA_ORG_CONTEXT, PROV_CONTEXT, or DCTERMS_CONTEXT keys — one canonical vocabulary per edge (specialist-wins rule)", () => {
		const schemaKeys = new Set(Object.keys(SCHEMA_ORG_CONTEXT));
		const provKeys = new Set(Object.keys(PROV_CONTEXT));
		const dctermsKeys = new Set(Object.keys(DCTERMS_CONTEXT));
		for (const key of Object.keys(FOAF_CONTEXT)) {
			expect(schemaKeys.has(key), `"${key}" is mapped by both SCHEMA_ORG_CONTEXT and FOAF_CONTEXT`).toBe(false);
			expect(provKeys.has(key), `"${key}" is mapped by both PROV_CONTEXT and FOAF_CONTEXT`).toBe(false);
			expect(dctermsKeys.has(key), `"${key}" is mapped by both DCTERMS_CONTEXT and FOAF_CONTEXT`).toBe(false);
		}
	});
});

describe("EDGE_TYPES (ADR-033 / #195 SKOS adoption)", () => {
	it("includes the net-new SKOS concept-hierarchy terms", () => {
		expect(EDGE_TYPES).toContain("broader");
		expect(EDGE_TYPES).toContain("narrower");
		expect(EDGE_TYPES).toContain("skos_related");
	});

	it("declares broader / narrower as an inverse pair (both present, neither orphaned)", () => {
		expect(EDGE_TYPES).toContain("broader");
		expect(EDGE_TYPES).toContain("narrower");
	});

	it("names the associative term skos_related, not related, to avoid clashing with related_to", () => {
		expect(EDGE_TYPES).toContain("skos_related");
		expect(EDGE_TYPES).not.toContain("related");
	});
});

describe("SKOS_CONTEXT (ADR-033 / #195)", () => {
	it("only maps strings that are actually in EDGE_TYPES (no stale/renamed keys)", () => {
		const edgeSet = new Set<string>(EDGE_TYPES);
		for (const key of Object.keys(SKOS_CONTEXT)) {
			expect(edgeSet.has(key), `SKOS_CONTEXT key "${key}" is not in EDGE_TYPES`).toBe(true);
		}
	});

	it("maps every value to a skos: CURIE (adopt-direct rule — no bare IRIs, no ahos: proxies)", () => {
		for (const [key, value] of Object.entries(SKOS_CONTEXT)) {
			expect(value, `SKOS_CONTEXT.${key}`).toMatch(/^skos:[A-Za-z]+$/);
		}
	});

	it("adopts all three SKOS hierarchy terms directly — verified exact-match domain/range against the published SKOS reference", () => {
		expect(SKOS_CONTEXT.broader).toBe("skos:broader");
		expect(SKOS_CONTEXT.narrower).toBe("skos:narrower");
		expect(SKOS_CONTEXT.skos_related).toBe("skos:related");
	});

	it("does not overlap with SCHEMA_ORG_CONTEXT, PROV_CONTEXT, DCTERMS_CONTEXT, or FOAF_CONTEXT keys — one canonical vocabulary per edge (specialist-wins rule)", () => {
		const schemaKeys = new Set(Object.keys(SCHEMA_ORG_CONTEXT));
		const provKeys = new Set(Object.keys(PROV_CONTEXT));
		const dctermsKeys = new Set(Object.keys(DCTERMS_CONTEXT));
		const foafKeys = new Set(Object.keys(FOAF_CONTEXT));
		for (const key of Object.keys(SKOS_CONTEXT)) {
			expect(schemaKeys.has(key), `"${key}" is mapped by both SCHEMA_ORG_CONTEXT and SKOS_CONTEXT`).toBe(false);
			expect(provKeys.has(key), `"${key}" is mapped by both PROV_CONTEXT and SKOS_CONTEXT`).toBe(false);
			expect(dctermsKeys.has(key), `"${key}" is mapped by both DCTERMS_CONTEXT and SKOS_CONTEXT`).toBe(false);
			expect(foafKeys.has(key), `"${key}" is mapped by both FOAF_CONTEXT and SKOS_CONTEXT`).toBe(false);
		}
	});
});

describe("ENTITY_TYPES (ADR-033 / #209 'concept' entity type)", () => {
	it("includes 'concept' alongside the pre-existing PARAMPS + event/organization/signal/place set", () => {
		expect(ENTITY_TYPES).toContain("concept");
		expect(ENTITY_TYPES).toContain("place");
		expect(ENTITY_TYPES).toContain("event");
	});

	it("keeps ENTITY_TYPES entries unique (no accidental duplicate entity-type strings)", () => {
		const seen = new Set<string>();
		for (const t of ENTITY_TYPES) {
			expect(seen.has(t), `duplicate ENTITY_TYPES entry: ${t}`).toBe(false);
			seen.add(t);
		}
	});
});

describe("ENTITY_TYPE_CLASS_CONTEXT (ADR-033 / #209)", () => {
	it("only maps values that are actually in ENTITY_TYPES (no stale/renamed keys)", () => {
		const entityTypeSet = new Set<string>(ENTITY_TYPES);
		for (const key of Object.keys(ENTITY_TYPE_CLASS_CONTEXT)) {
			expect(entityTypeSet.has(key), `ENTITY_TYPE_CLASS_CONTEXT key "${key}" is not in ENTITY_TYPES`).toBe(true);
		}
	});

	it("adopts concept directly to skos:Concept — an exact match, no ahos: proxy or skos:closeMatch hedge", () => {
		expect(ENTITY_TYPE_CLASS_CONTEXT.concept).toBe("skos:Concept");
	});

	it("adopts people/organization/place/event directly to their public classes (ADR085, #173)", () => {
		expect(ENTITY_TYPE_CLASS_CONTEXT.people).toBe("foaf:Person");
		expect(ENTITY_TYPE_CLASS_CONTEXT.organization).toBe("schema:Organization");
		expect(ENTITY_TYPE_CLASS_CONTEXT.place).toBe("schema:Place");
		expect(ENTITY_TYPE_CLASS_CONTEXT.event).toBe("schema:Event");
	});

	it("maps every value to a CURIE (adopt-direct rule — no bare IRIs, no ahos: proxies)", () => {
		for (const [key, value] of Object.entries(ENTITY_TYPE_CLASS_CONTEXT)) {
			expect(value, `ENTITY_TYPE_CLASS_CONTEXT.${key}`).toMatch(/^[a-z]+:[A-Za-z]+$/);
		}
	});
});

/**
 * Issue #170 (decision 2026-07-17) — PARA primary/secondary containment.
 * `belongs_to` is the single-parent PRIMARY containment edge (roll-ups and
 * counting traverse it exclusively); `associated_with` is the zero-or-more
 * SECONDARY, non-counted containment edge. A distinct edge type was chosen
 * over a metadata.role flag so type-filtered roll-up queries stay correct by
 * construction and entity_relate's replace-metadata-on-update semantics
 * can't silently flip an edge between primary and secondary.
 */
describe("EDGE_TYPES (issue #170 PARA primary/secondary containment)", () => {
	it("includes both containment kinds: primary belongs_to and secondary associated_with", () => {
		expect(EDGE_TYPES).toContain("belongs_to");
		expect(EDGE_TYPES).toContain("associated_with");
	});

	it("keeps associated_with out of every external-vocab @context map — ahkms-only, like related_to (no exact schema/prov/foaf/skos/dcterms match)", () => {
		const mapped = new Set<string>([
			...Object.keys(SCHEMA_ORG_CONTEXT),
			...Object.keys(PROV_CONTEXT),
			...Object.keys(DCTERMS_CONTEXT),
			...Object.keys(FOAF_CONTEXT),
			...Object.keys(SKOS_CONTEXT),
		]);
		expect(mapped.has("associated_with")).toBe(false);
		expect(mapped.has("belongs_to")).toBe(false);
	});
});

/**
 * ADR-035 / #327 — relationship reification.
 * The `arrangement` entity type + its per-role participant edges are the slice
 * (1+2) that unblocks the ahOS-seed.ttl ingestion (#326). `entity_promote_edge`
 * and the collision-at-2 guard are a separate PR under #327.
 */
describe("ENTITY_TYPES / EDGE_TYPES (ADR-035 / #327 arrangement reification)", () => {
	const PARTICIPANT_EDGES = [
		"employer",
		"employee",
		"resident",
		"at_place",
		"supplier",
		"customer",
		"of_utility",
	];

	it("includes 'arrangement' as a graph entity type (must match the migration 079 CHECK)", () => {
		expect(ENTITY_TYPES).toContain("arrangement");
	});

	// #1023 / ADR-092: acronyms and internal shorthand (PSR, P0, "the migration")
	// live in entities as their own kind, reusing search, embeddings, provenance
	// links and entity_neighbourhood. Must match the migration 110 CHECK.
	it("includes 'term' as a graph entity type (must match the migration 110 CHECK)", () => {
		expect(ENTITY_TYPES).toContain("term");
	});

	// #2003: decision entities must match the migration 146 CHECK.
	it("includes 'decision' as a graph entity type (must match the migration 146 CHECK)", () => {
		expect(ENTITY_TYPES).toContain("decision");
	});

	it("seeds the per-role participant edge vocabulary (ADR-035 §5)", () => {
		for (const role of PARTICIPANT_EDGES) {
			expect(EDGE_TYPES, `EDGE_TYPES should contain participant edge "${role}"`).toContain(role);
		}
	});

	it("keeps participant edges out of the external-vocab @context maps — they're ahos-native (ADR-035 mints them; no exact schema/prov/foaf/skos/dcterms match)", () => {
		const mapped = new Set<string>([
			...Object.keys(SCHEMA_ORG_CONTEXT),
			...Object.keys(PROV_CONTEXT),
			...Object.keys(DCTERMS_CONTEXT),
			...Object.keys(FOAF_CONTEXT),
			...Object.keys(SKOS_CONTEXT),
		]);
		for (const role of PARTICIPANT_EDGES) {
			expect(mapped.has(role), `participant edge "${role}" should not be in any @context map`).toBe(false);
		}
	});
});

/**
 * ADR099 / #1231 — the career ledger: roles, education and achievements are
 * `arrangement` nodes and competencies are `concept` rows, so the only net-new
 * vocabulary is these five edge strings. Before them, entity_relate stored every
 * one of these writes as 'other' (see relationshipType.test.ts).
 */
describe("EDGE_TYPES (ADR099 / #1231 career-ledger edges)", () => {
	const CAREER_LEDGER_EDGES = ["knows_about", "demonstrates", "in_role", "student", "institution"];

	it("includes all five career-ledger edge strings", () => {
		for (const edge of CAREER_LEDGER_EDGES) {
			expect(EDGE_TYPES, `EDGE_TYPES should contain career-ledger edge "${edge}"`).toContain(edge);
		}
	});

	it("adopts knows_about directly to schema:knowsAbout — Person -> Thing is an exact match", () => {
		expect(SCHEMA_ORG_CONTEXT.knows_about).toBe("schema:knowsAbout");
	});

	it("keeps demonstrates / in_role / student / institution out of every @context map — ahos-native, no exact external term", () => {
		const mapped = new Set<string>([
			...Object.keys(SCHEMA_ORG_CONTEXT),
			...Object.keys(PROV_CONTEXT),
			...Object.keys(DCTERMS_CONTEXT),
			...Object.keys(FOAF_CONTEXT),
			...Object.keys(SKOS_CONTEXT),
		]);
		for (const edge of ["demonstrates", "in_role", "student", "institution"]) {
			expect(mapped.has(edge), `career-ledger edge "${edge}" should not be in any @context map`).toBe(false);
		}
	});

	it("reuses was_attributed_to for achievement -> person rather than minting achieved_by", () => {
		expect(EDGE_TYPES).toContain("was_attributed_to");
		expect(EDGE_TYPES).not.toContain("achieved_by");
		expect(PROV_CONTEXT.was_attributed_to).toBe("prov:wasAttributedTo");
	});

	it("never calls a competency a skill — ahos:Skill already means a Claude capability", () => {
		for (const edge of EDGE_TYPES) {
			expect(edge, `edge "${edge}" reuses the reserved word 'skill'`).not.toMatch(/skill/);
		}
	});
});

/**
 * ADR-120 / #2439 — job applications ride arrangements (`kind: 'job_application'`).
 * Five ahos:-native participant edges keep job-application queries isolated from
 * ADR-099's career-ledger employer/employee edges and stay out of external @context maps.
 */
describe("EDGE_TYPES (ADR120 / #2439 job-application edges)", () => {
	const JOB_APPLICATION_EDGES = [
		"applicant",
		"applied_to",
		"applied_via",
		"recruiter",
		"hiring_contact",
	];

	it("includes all five job-application participant edge strings", () => {
		for (const edge of JOB_APPLICATION_EDGES) {
			expect(EDGE_TYPES, `EDGE_TYPES should contain job-application edge "${edge}"`).toContain(edge);
		}
	});

	it("keeps all five job-application edges out of every external @context map (ahos-native per ADR-033)", () => {
		const mapped = new Set<string>([
			...Object.keys(SCHEMA_ORG_CONTEXT),
			...Object.keys(PROV_CONTEXT),
			...Object.keys(DCTERMS_CONTEXT),
			...Object.keys(FOAF_CONTEXT),
			...Object.keys(SKOS_CONTEXT),
		]);
		for (const edge of JOB_APPLICATION_EDGES) {
			expect(mapped.has(edge), `job-application edge "${edge}" should not be in any @context map`).toBe(false);
		}
	});
});
