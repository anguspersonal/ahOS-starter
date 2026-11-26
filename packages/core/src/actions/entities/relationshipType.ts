import { EDGE_TYPES, type EdgeType } from "../../domain/vocab.js";

export { EDGE_TYPES, type EdgeType };

/**
 * Relationship vocabulary for the interpersonal knowledge graph (ADR-021, #1482).
 *
 * Isomorphic copy of the relationship vocabulary and normalisation helpers from
 * `@ahkms/shared` so `@ahkms/core` does not depend on `@ahkms/shared` (verified by
 * `scripts/check-core-isomorphic.js` and pinned by `sharedCoreParity.test.ts`).
 */
export type KnownRelationshipType =
	| "parentOf"
	| "childOf"
	| "grandparentOf"
	| "grandchildOf"
	| "ancestorOf"
	| "descendantOf"
	| "siblingOf"
	| "spouseOf"
	| "lifePartnerOf"
	| "engagedTo"
	| "romanticPartnerOf"
	| "friendOf"
	| "closeFriendOf"
	| "acquaintanceOf"
	| "neighborOf"
	| "livesWith"
	| "hasMet"
	| "knowsOf"
	| "knowsInPassing"
	| "knowsByReputation"
	| "wouldLikeToKnow"
	| "lostContactWith"
	| "colleagueOf"
	| "worksWith"
	| "collaboratesWith"
	| "employedBy"
	| "employerOf"
	| "mentorOf"
	| "apprenticeTo"
	| "influencedBy"
	| "enemyOf"
	| "antagonistOf"
	| "ambivalentOf"
	| "knows"
	| "member"
	| "currentProject"
	| "pastProject"
	| "made"
	| "livesAt"
	| "basedNear"
	| "locatedIn"
	| "broader"
	| "narrower"
	| "co_occurs_with"
	| "other";

export type RelationshipType = KnownRelationshipType | (string & {});

export type RelationshipCategory =
	| "family"
	| "romantic"
	| "social"
	| "professional"
	| "negative"
	| "foaf"
	| "place"
	| "hierarchy"
	| "system"
	| "other";

export interface RelationshipVocabularyEntry {
	curie: string | null;
	label: string;
	category: RelationshipCategory;
	symmetric?: boolean;
	inverseOf?: KnownRelationshipType;
	subPropertyOf?: string;
}

const KNOWS = "foaf:knows";

export const RELATIONSHIP_VOCABULARY: Record<KnownRelationshipType, RelationshipVocabularyEntry> = {
	// Family
	parentOf: { curie: "rel:parentOf", label: "Parent of", category: "family", inverseOf: "childOf", subPropertyOf: KNOWS },
	childOf: { curie: "rel:childOf", label: "Child of", category: "family", inverseOf: "parentOf", subPropertyOf: KNOWS },
	grandparentOf: { curie: "rel:grandparentOf", label: "Grandparent of", category: "family", inverseOf: "grandchildOf", subPropertyOf: KNOWS },
	grandchildOf: { curie: "rel:grandchildOf", label: "Grandchild of", category: "family", inverseOf: "grandparentOf", subPropertyOf: KNOWS },
	ancestorOf: { curie: "rel:ancestorOf", label: "Ancestor of", category: "family", inverseOf: "descendantOf", subPropertyOf: KNOWS },
	descendantOf: { curie: "rel:descendantOf", label: "Descendant of", category: "family", inverseOf: "ancestorOf", subPropertyOf: KNOWS },
	siblingOf: { curie: "rel:siblingOf", label: "Sibling of", category: "family", symmetric: true, subPropertyOf: KNOWS },
	spouseOf: { curie: "rel:spouseOf", label: "Spouse of", category: "family", symmetric: true, subPropertyOf: KNOWS },
	lifePartnerOf: { curie: "rel:lifePartnerOf", label: "Life partner of", category: "family", symmetric: true, subPropertyOf: KNOWS },
	engagedTo: { curie: "rel:engagedTo", label: "Engaged to", category: "family", symmetric: true, subPropertyOf: KNOWS },

	// Romantic
	romanticPartnerOf: { curie: "ahos:romanticPartnerOf", label: "Romantic partner of", category: "romantic", symmetric: true, subPropertyOf: KNOWS },

	// Social
	friendOf: { curie: "rel:friendOf", label: "Friend of", category: "social", symmetric: true, subPropertyOf: KNOWS },
	closeFriendOf: { curie: "rel:closeFriendOf", label: "Close friend of", category: "social", symmetric: true, subPropertyOf: KNOWS },
	acquaintanceOf: { curie: "rel:acquaintanceOf", label: "Acquaintance of", category: "social", symmetric: true, subPropertyOf: KNOWS },
	neighborOf: { curie: "rel:neighborOf", label: "Neighbour of", category: "social", symmetric: true, subPropertyOf: KNOWS },
	livesWith: { curie: "rel:livesWith", label: "Lives with", category: "social", symmetric: true, subPropertyOf: KNOWS },
	hasMet: { curie: "rel:hasMet", label: "Has met", category: "social", symmetric: true, subPropertyOf: KNOWS },
	knowsOf: { curie: "rel:knowsOf", label: "Knows of", category: "social", subPropertyOf: KNOWS },
	knowsInPassing: { curie: "rel:knowsInPassing", label: "Knows in passing", category: "social", subPropertyOf: KNOWS },
	knowsByReputation: { curie: "rel:knowsByReputation", label: "Knows by reputation", category: "social", subPropertyOf: KNOWS },
	wouldLikeToKnow: { curie: "rel:wouldLikeToKnow", label: "Would like to know", category: "social", subPropertyOf: KNOWS },
	lostContactWith: { curie: "rel:lostContactWith", label: "Lost contact with", category: "social", symmetric: true, subPropertyOf: KNOWS },

	// Professional
	colleagueOf: { curie: "rel:colleagueOf", label: "Colleague of", category: "professional", symmetric: true, subPropertyOf: KNOWS },
	worksWith: { curie: "rel:worksWith", label: "Works with", category: "professional", symmetric: true, subPropertyOf: KNOWS },
	collaboratesWith: { curie: "rel:collaboratesWith", label: "Collaborates with", category: "professional", symmetric: true, subPropertyOf: KNOWS },
	employedBy: { curie: "rel:employedBy", label: "Employed by", category: "professional", inverseOf: "employerOf", subPropertyOf: KNOWS },
	employerOf: { curie: "rel:employerOf", label: "Employer of", category: "professional", inverseOf: "employedBy", subPropertyOf: KNOWS },
	mentorOf: { curie: "rel:mentorOf", label: "Mentor of", category: "professional", inverseOf: "apprenticeTo", subPropertyOf: KNOWS },
	apprenticeTo: { curie: "rel:apprenticeTo", label: "Apprentice to", category: "professional", inverseOf: "mentorOf", subPropertyOf: KNOWS },
	influencedBy: { curie: "rel:influencedBy", label: "Influenced by", category: "professional", subPropertyOf: KNOWS },

	// Negative / ambivalent
	enemyOf: { curie: "rel:enemyOf", label: "Enemy of", category: "negative", symmetric: true, subPropertyOf: KNOWS },
	antagonistOf: { curie: "rel:antagonistOf", label: "Antagonist of", category: "negative", subPropertyOf: KNOWS },
	ambivalentOf: { curie: "rel:ambivalentOf", label: "Ambivalent of", category: "negative", subPropertyOf: KNOWS },

	// FOAF core
	knows: { curie: "foaf:knows", label: "Knows", category: "foaf", symmetric: true },
	member: { curie: "foaf:member", label: "Has member", category: "foaf" },
	currentProject: { curie: "foaf:currentProject", label: "Current project", category: "foaf" },
	pastProject: { curie: "foaf:pastProject", label: "Past project", category: "foaf" },
	made: { curie: "foaf:made", label: "Made", category: "foaf" },

	// Place edges (#188)
	livesAt: { curie: null, label: "Lives at", category: "place" },
	basedNear: { curie: "foaf:based_near", label: "Based near", category: "place" },
	locatedIn: { curie: null, label: "Located in", category: "place" },

	// SKOS concept-hierarchy edges (#195/#232)
	broader: { curie: "skos:broader", label: "Broader", category: "hierarchy", inverseOf: "narrower" },
	narrower: { curie: "skos:narrower", label: "Narrower", category: "hierarchy", inverseOf: "broader" },

	// System-generated
	co_occurs_with: { curie: null, label: "Co-occurs with", category: "system", symmetric: true },

	// Fallback
	other: { curie: null, label: "Related to", category: "other" },
};

/** Type guard: is `t` one of the canonical vocabulary terms? */
export function isKnownRelationshipType(t: string): t is KnownRelationshipType {
	return Object.prototype.hasOwnProperty.call(RELATIONSHIP_VOCABULARY, t);
}

/** The inverse of an edge type. Symmetric and unknown/other types return themselves. */
export function inverseOf(t: RelationshipType): RelationshipType {
	const entry = RELATIONSHIP_VOCABULARY[t as KnownRelationshipType];
	if (!entry) return t;
	if (entry.symmetric) return t;
	return entry.inverseOf ?? t;
}

const RELATION_SYNONYMS: Record<string, KnownRelationshipType> = {
	"close friend": "closeFriendOf",
	"best friend": "closeFriendOf",
	bestie: "closeFriendOf",
	friend: "friendOf",
	buddy: "friendOf",
	mate: "friendOf",
	pal: "friendOf",
	acquaintance: "acquaintanceOf",
	"co-worker": "colleagueOf",
	coworker: "colleagueOf",
	colleague: "colleagueOf",
	workmate: "colleagueOf",
	collaborator: "collaboratesWith",
	mentor: "mentorOf",
	mentee: "apprenticeTo",
	apprentice: "apprenticeTo",
	protege: "apprenticeTo",
	student: "apprenticeTo",
	manager: "employerOf",
	supervisor: "employerOf",
	employer: "employerOf",
	boss: "employerOf",
	employee: "employedBy",
	subordinate: "employedBy",
	grandmother: "grandparentOf",
	grandfather: "grandparentOf",
	grandparent: "grandparentOf",
	grandson: "grandchildOf",
	granddaughter: "grandchildOf",
	grandchild: "grandchildOf",
	mother: "parentOf",
	father: "parentOf",
	parent: "parentOf",
	mom: "parentOf",
	mum: "parentOf",
	dad: "parentOf",
	daughter: "childOf",
	son: "childOf",
	child: "childOf",
	brother: "siblingOf",
	sister: "siblingOf",
	sibling: "siblingOf",
	husband: "spouseOf",
	wife: "spouseOf",
	spouse: "spouseOf",
	partner: "lifePartnerOf",
	fiance: "engagedTo",
	fiancee: "engagedTo",
	girlfriend: "romanticPartnerOf",
	boyfriend: "romanticPartnerOf",
	situationship: "romanticPartnerOf",
	"going steady": "romanticPartnerOf",
	"romantic partner": "romanticPartnerOf",
	neighbour: "neighborOf",
	neighbor: "neighborOf",
	"lives at": "livesAt",
};

const RELATION_SYNONYM_KEYS = Object.keys(RELATION_SYNONYMS).sort((a, b) => b.length - a.length);

function synonymCarriesVocabNote(type: KnownRelationshipType, key: string): boolean {
	return type === "romanticPartnerOf" && key !== "romantic partner";
}

/**
 * Normalise a free-text relation value to a canonical relationship type (ADR-021).
 */
export function normalizeRelationshipType(raw: string | null | undefined): {
	type: RelationshipType;
	notes?: string;
} {
	if (!raw || !raw.trim()) return { type: "other" };
	const text = raw.trim();

	if (isKnownRelationshipType(text)) return { type: text };

	const lower = text.toLowerCase();
	for (const key of RELATION_SYNONYM_KEYS) {
		if (lower === key || lower.includes(key)) {
			const type = RELATION_SYNONYMS[key];
			if (synonymCarriesVocabNote(type, key)) {
				return { type, notes: key };
			}
			return { type };
		}
	}

	return { type: "other", notes: text };
}

/**
 * The bounded set of raw synonym phrases that resolve to `type` AND carry a
 * vocab note under `normalizeRelationshipType`'s rules (#501 QA round 2).
 */
export function vocabNoteSynonymsForType(type: string): ReadonlySet<string> {
	const notes = new Set<string>();
	for (const [key, mappedType] of Object.entries(RELATION_SYNONYMS)) {
		if (mappedType !== type) continue;
		if (!synonymCarriesVocabNote(mappedType, key)) continue;
		notes.add(key);
	}
	return notes;
}

// Compact summary of the canonical ADR-021 vocabulary, grouped by category and
// derived at load time so tool descriptions cannot drift from validation rules.
const vocabByCategory: Record<string, string[]> = {};
for (const [term, entry] of Object.entries(RELATIONSHIP_VOCABULARY)) {
	(vocabByCategory[entry.category] ??= []).push(term);
}
export const VOCAB_SUMMARY = Object.entries(vocabByCategory)
	.map(([category, terms]) => `${category}: ${terms.join(", ")}`)
	.join("; ");

/**
 * Resolve a raw relationship_type to what gets stored (ADR-021 soft validation).
 * Canonical vocabulary terms and EDGE_TYPES entries pass through unchanged.
 * Anything else is normalised or stored as 'other' with the raw phrase preserved.
 */
export function resolveRelationshipType(raw: string): {
	type: string;
	vocabNote?: string;
} {
	const t = raw.trim();
	if (isKnownRelationshipType(t)) return { type: t };
	if ((EDGE_TYPES as readonly string[]).includes(t)) return { type: t };
	const { type, notes } = normalizeRelationshipType(t);
	return { type, vocabNote: notes };
}

/**
 * Normalize an edge confidence score to the canonical 0.0-1.0 scale (#1979).
 * Legacy callers passing 1 < value <= 100 are automatically divided by 100.
 */
export function normalizeRelationshipConfidence(
	value: number | null | undefined,
): number | null {
	if (value === null || value === undefined) return null;
	if (value > 1) return Number((value / 100).toFixed(4));
	return Number(value.toFixed(4));
}

/** Same instant, tolerant of formatting (DB timestamptz vs. caller ISO); both null = same. */
export function sameInstant(a: string | null, b: string | null): boolean {
	if (a === null && b === null) return true;
	if (a === null || b === null) return false;
	return new Date(a).getTime() === new Date(b).getTime();
}

/**
 * ADR-035 collision-at-2: a write collides with an existing edge when BOTH carry
 * a temporal window and those windows differ.
 */
export function temporalCollision(
	existing: { valid_from: string | null; valid_to: string | null },
	nextFrom: string | null,
	nextTo: string | null,
): boolean {
	const existingHasWindow =
		existing.valid_from !== null || existing.valid_to !== null;
	const nextHasWindow = nextFrom !== null || nextTo !== null;
	if (!existingHasWindow || !nextHasWindow) return false;
	return !(
		sameInstant(existing.valid_from, nextFrom) &&
		sameInstant(existing.valid_to, nextTo)
	);
}

/**
 * Data-integrity backstop for the window about to be persisted: reject an
 * inverted window (valid_from after valid_to) outright (#464).
 */
export function assertValidWindow(from: string | null, to: string | null): void {
	if (from === null || to === null) return;
	if (new Date(from).getTime() > new Date(to).getTime()) {
		throw new Error(
			`Invalid validity window: valid_from (${from}) is after valid_to (${to}). ` +
				"Supply both bounds together when correcting one of them, or use clear_window to erase the window instead.",
		);
	}
}

/**
 * True for a plain JSON object (not null, not an array, not a bare scalar).
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * RFC 7386 JSON Merge Patch, applied one level deep (#501 / ADR-035 amendment).
 */
export function mergeMetadataPatch(
	target: Record<string, unknown>,
	patch: Record<string, unknown>,
): Record<string, unknown> {
	const result = { ...target };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) {
			delete result[key];
		} else {
			Object.defineProperty(result, key, {
				value,
				writable: true,
				enumerable: true,
				configurable: true,
			});
		}
	}
	return result;
}

/**
 * Compute the `notes` value for a re-assertion (#501):
 *  1. The caller's free-text prose is preserve-on-omit.
 *  2. A recognised ADR-021 vocab note is never caller-erasable.
 */
export function nextNotesValue(
	storedNotes: string | null,
	calledNotes: string | undefined,
	type: string,
	currentVocabNote: string | undefined,
): string | null {
	const knownVocabNotes = vocabNoteSynonymsForType(type);
	const storedSegments = storedNotes ? storedNotes.split(" | ") : [];

	const proseSegments: string[] = [];
	const carriedVocabNotes: string[] = [];
	for (const segment of storedSegments) {
		if (segment === currentVocabNote) continue;
		if (knownVocabNotes.has(segment)) carriedVocabNotes.push(segment);
		else proseSegments.push(segment);
	}

	const prose = calledNotes !== undefined ? calledNotes : proseSegments.join(" | ");
	const vocabNotes = currentVocabNote !== undefined ? [currentVocabNote] : carriedVocabNotes;

	return [prose, ...vocabNotes].filter(Boolean).join(" | ") || null;
}

/**
 * PARA containment (issue #170): entity types whose outgoing `belongs_to` edge
 * is a PRIMARY containment pointer and therefore single-parent.
 */
export const PRIMARY_CONTAINMENT_SOURCE_TYPES: ReadonlySet<string> = new Set([
	"project",
	"resource",
]);
