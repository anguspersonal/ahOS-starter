/**
 * ADR-021 soft validation in entity_relate.
 *
 * PR #184 shipped the RELATIONSHIP vocabulary in @ahkms/shared, but entity_relate
 * kept validating relationship_type against a hard z.enum of pre-FOAF terms — so
 * canonical terms like 'parentOf' were rejected at the tool boundary (live repro:
 * the interview agent fell back to 'related_to' for "Anne is Angus's mother").
 *
 * These tests pin the resolution rules:
 *   1. canonical ADR-021 terms pass through unchanged;
 *   2. legacy EDGE_TYPES pass through unchanged (the write path must never retype
 *      advertised terms — legacy migration belongs to the seed script);
 *   3. synonyms normalise to canonical terms;
 *   4. unknown phrases soft-fall-back to 'other' with the raw value preserved.
 */

import { describe, expect, it } from "vitest";
import { resolveRelationshipType as coreResolveRelationshipType } from "@ahkms/core";
import { resolveRelationshipType } from "@ahkms/core/actions";
import { vocabNoteSynonymsForType } from "@ahkms/shared";

describe("resolveRelationshipType (ADR-021 soft validation)", () => {
	it("passes canonical vocabulary terms through unchanged", () => {
		expect(resolveRelationshipType).toBe(coreResolveRelationshipType);
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

	// Place edges (#188) — person -> place and place -> place containment.
	it("passes place-edge vocabulary terms through unchanged", () => {
		expect(resolveRelationshipType("livesAt")).toEqual({ type: "livesAt" });
		expect(resolveRelationshipType("basedNear")).toEqual({ type: "basedNear" });
		expect(resolveRelationshipType("locatedIn")).toEqual({ type: "locatedIn" });
	});

	it("normalises 'lives at' to livesAt", () => {
		expect(resolveRelationshipType("lives at").type).toBe("livesAt");
		expect(resolveRelationshipType("Lives At").type).toBe("livesAt");
	});

	// ADR-033 / #194 — FOAF completion. `knows` and `member` were already
	// defined in RELATIONSHIP_VOCABULARY (ADR-021, PR #184) but #194's AC asks
	// for end-to-end confirmation through entity_relate, not just that they're
	// declared. `current_project` is the net-new EDGE_TYPES string this issue adds.
	it("passes foaf-core canonical terms (knows, member, currentProject) through unchanged via RELATIONSHIP_VOCABULARY", () => {
		expect(resolveRelationshipType("knows")).toEqual({ type: "knows" });
		expect(resolveRelationshipType("member")).toEqual({ type: "member" });
		expect(resolveRelationshipType("currentProject")).toEqual({ type: "currentProject" });
	});

	it("passes the net-new EDGE_TYPES term current_project through unchanged (foaf:currentProject, People -> Project)", () => {
		expect(resolveRelationshipType("current_project")).toEqual({ type: "current_project" });
	});

	// ADR099 / #1231 — the career-ledger edges. Before they were in EDGE_TYPES, every
	// one of these writes landed as 'other' (or, for `student`, as the people-vocab
	// synonym apprenticeTo), so an education arrangement's participant edge and an
	// achievement's competency edge were indistinguishable from noise.
	it("passes the career-ledger edge strings through unchanged instead of storing 'other'", () => {
		for (const edge of ["knows_about", "demonstrates", "in_role", "student", "institution"]) {
			expect(resolveRelationshipType(edge)).toEqual({ type: edge });
		}
	});

	it("keeps the student synonym for phrases: only the exact participant-edge string is shadowed", () => {
		// Same trade employer/employee make: the bare EDGE_TYPES string is the
		// arrangement role, a free-text phrase still maps to the people vocabulary.
		expect(resolveRelationshipType("student of").type).toBe("apprenticeTo");
	});

	it("passes ADR-120 job-application participant edge strings through unchanged", () => {
		for (const edge of ["applicant", "applied_to", "applied_via", "recruiter", "hiring_contact"]) {
			expect(resolveRelationshipType(edge)).toEqual({ type: edge });
		}
	});
});

/**
 * #501 QA round 2 — https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/pull/772#pullrequestreview-5000511482
 *
 * `vocabNoteSynonymsForType` must return ONLY the synonym keys that actually
 * carry a vocab note under `normalizeRelationshipType`'s rules (currently the
 * romantic subtypes), not every synonym key that happens to map to `type`. A
 * round-1 version of the function got this backwards — it excluded just the
 * "romantic partner" key and returned every OTHER key mapping to `type`, so
 * `vocabNoteSynonymsForType('parentOf')` wrongly returned all 6 parentOf
 * synonyms (mother, father, parent, mom, mum, dad) as "note-carrying". Fixed
 * by deriving both functions from one shared predicate
 * (`synonymCarriesVocabNote`) instead of writing the exclusion rule twice.
 */
describe("vocabNoteSynonymsForType (#501 QA round 2)", () => {
	it("returns an empty set for a type whose synonyms never carry a note (the reviewer's repro)", () => {
		expect(vocabNoteSynonymsForType("parentOf")).toEqual(new Set());
		expect(vocabNoteSynonymsForType("friendOf")).toEqual(new Set());
	});

	it("returns exactly the romantic-subtype synonyms for romanticPartnerOf, excluding the bare 'romantic partner'", () => {
		// fiance/fiancee map to engagedTo, not romanticPartnerOf — only these
		// four synonyms resolve to romanticPartnerOf itself (per RELATION_SYNONYMS),
		// with "romantic partner" excluded since it has no distinct subtype.
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
