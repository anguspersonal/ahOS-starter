import { describe, expect, it } from "vitest";
import {
	assertValidWindow,
	EDGE_TYPES,
	isKnownRelationshipType,
	isPlainObject,
	mergeMetadataPatch,
	nextNotesValue,
	normalizeRelationshipConfidence,
	normalizeRelationshipType,
	RELATIONSHIP_VOCABULARY,
	resolveRelationshipType,
	sameInstant,
	temporalCollision,
	VOCAB_SUMMARY,
	vocabNoteSynonymsForType,
} from "./relationshipType.js";

describe("resolveRelationshipType (ADR-021 soft validation)", () => {
	it("passes canonical vocabulary terms through unchanged", () => {
		expect(resolveRelationshipType("parentOf")).toEqual({ type: "parentOf" });
		expect(resolveRelationshipType("lifePartnerOf")).toEqual({ type: "lifePartnerOf" });
		expect(resolveRelationshipType("colleagueOf")).toEqual({ type: "colleagueOf" });
	});

	it("passes legacy EDGE_TYPES through unchanged (no silent retyping)", () => {
		expect(resolveRelationshipType("partner_of")).toEqual({ type: "partner_of" });
		expect(resolveRelationshipType("works_with")).toEqual({ type: "works_with" });
		expect(resolveRelationshipType("co_occurs_with")).toEqual({ type: "co_occurs_with" });
	});

	it("normalises synonyms to canonical terms", () => {
		expect(resolveRelationshipType("mother").type).toBe("parentOf");
		expect(resolveRelationshipType("Partner").type).toBe("lifePartnerOf");
		expect(resolveRelationshipType("colleague").type).toBe("colleagueOf");
	});

	it("falls back to 'other' preserving the raw phrase in the note", () => {
		const r = resolveRelationshipType("owes a pint to");
		expect(r.type).toBe("other");
		expect(r.vocabNote).toBeTruthy();
		expect(r.vocabNote).toContain("owes a pint to");
	});

	it("trims surrounding whitespace before resolving", () => {
		expect(resolveRelationshipType("  parentOf  ")).toEqual({ type: "parentOf" });
	});

	it("passes place-edge vocabulary terms through unchanged", () => {
		expect(resolveRelationshipType("livesAt")).toEqual({ type: "livesAt" });
		expect(resolveRelationshipType("basedNear")).toEqual({ type: "basedNear" });
		expect(resolveRelationshipType("locatedIn")).toEqual({ type: "locatedIn" });
	});

	it("normalises 'lives at' to livesAt", () => {
		expect(resolveRelationshipType("lives at").type).toBe("livesAt");
		expect(resolveRelationshipType("Lives At").type).toBe("livesAt");
	});

	it("passes foaf-core canonical terms (knows, member, currentProject) through unchanged via RELATIONSHIP_VOCABULARY", () => {
		expect(resolveRelationshipType("knows")).toEqual({ type: "knows" });
		expect(resolveRelationshipType("member")).toEqual({ type: "member" });
		expect(resolveRelationshipType("currentProject")).toEqual({ type: "currentProject" });
	});

	it("passes the net-new EDGE_TYPES term current_project through unchanged (foaf:currentProject, People -> Project)", () => {
		expect(resolveRelationshipType("current_project")).toEqual({ type: "current_project" });
	});

	it("passes the career-ledger edge strings through unchanged instead of storing 'other'", () => {
		for (const edge of ["knows_about", "demonstrates", "in_role", "student", "institution"]) {
			expect(resolveRelationshipType(edge)).toEqual({ type: edge });
		}
	});

	it("keeps the student synonym for phrases: only the exact participant-edge string is shadowed", () => {
		expect(resolveRelationshipType("student of").type).toBe("apprenticeTo");
	});

	it("passes ADR-120 job-application participant edge strings through unchanged", () => {
		for (const edge of ["applicant", "applied_to", "applied_via", "recruiter", "hiring_contact"]) {
			expect(resolveRelationshipType(edge)).toEqual({ type: edge });
		}
	});
});

describe("vocabNoteSynonymsForType (#501 QA round 2)", () => {
	it("returns an empty set for a type whose synonyms never carry a note", () => {
		expect(vocabNoteSynonymsForType("parentOf")).toEqual(new Set());
		expect(vocabNoteSynonymsForType("friendOf")).toEqual(new Set());
	});

	it("returns exactly the romantic-subtype synonyms for romanticPartnerOf, excluding the bare 'romantic partner'", () => {
		const notes = vocabNoteSynonymsForType("romanticPartnerOf");
		expect(notes).toEqual(new Set(["girlfriend", "boyfriend", "situationship", "going steady"]));
		expect(notes.has("romantic partner")).toBe(false);
		expect(notes.has("fiance")).toBe(false);
	});

	it("returns an empty set for a type with no synonym mapping at all", () => {
		expect(vocabNoteSynonymsForType("other")).toEqual(new Set());
		expect(vocabNoteSynonymsForType("livesAt")).toEqual(new Set());
	});
});

describe("VOCAB_SUMMARY and pure relationship helpers", () => {
	it("builds VOCAB_SUMMARY from RELATIONSHIP_VOCABULARY categories", () => {
		expect(VOCAB_SUMMARY).toContain("family: parentOf");
		expect(VOCAB_SUMMARY).toContain("hierarchy: broader, narrower");
		expect(isKnownRelationshipType("parentOf")).toBe(true);
		expect(isKnownRelationshipType("not_a_term")).toBe(false);
		expect(normalizeRelationshipType("girlfriend")).toEqual({
			type: "romanticPartnerOf",
			notes: "girlfriend",
		});
		expect(EDGE_TYPES).toContain("belongs_to");
		expect(RELATIONSHIP_VOCABULARY.parentOf.inverseOf).toBe("childOf");
	});

	it("normalises confidence values to the 0.0-1.0 scale", () => {
		expect(normalizeRelationshipConfidence(null)).toBeNull();
		expect(normalizeRelationshipConfidence(undefined)).toBeNull();
		expect(normalizeRelationshipConfidence(0.85)).toBe(0.85);
		expect(normalizeRelationshipConfidence(85)).toBe(0.85);
	});

	it("evaluates window equality, collision, and validity", () => {
		expect(sameInstant(null, null)).toBe(true);
		expect(sameInstant("2026-01-01T00:00:00Z", "2026-01-01T00:00:00.000+00:00")).toBe(true);
		expect(
			temporalCollision(
				{ valid_from: "2025-01-01T00:00:00Z", valid_to: null },
				"2026-01-01T00:00:00Z",
				null,
			),
		).toBe(true);
		expect(
			temporalCollision(
				{ valid_from: "2025-01-01T00:00:00Z", valid_to: null },
				"2025-01-01T00:00:00.000Z",
				null,
			),
		).toBe(false);
		expect(() =>
			assertValidWindow("2026-05-01T00:00:00Z", "2026-01-01T00:00:00Z"),
		).toThrow(/Invalid validity window/);
	});

	it("merges metadata patches and preserves notes and vocab notes", () => {
		expect(isPlainObject({ a: 1 })).toBe(true);
		expect(isPlainObject([1, 2])).toBe(false);
		expect(isPlainObject(null)).toBe(false);
		expect(
			mergeMetadataPatch({ keep: "yes", drop: "old" }, { drop: null, added: 1, __proto__: "safe" }),
		).toEqual({ keep: "yes", added: 1, __proto__: "safe" });
		expect(
			nextNotesValue("met at uni | girlfriend", undefined, "romanticPartnerOf", undefined),
		).toBe("met at uni | girlfriend");
		expect(
			nextNotesValue("met at uni | owes a pint", undefined, "other", "owes a pint"),
		).toBe("met at uni | owes a pint");
	});
});
