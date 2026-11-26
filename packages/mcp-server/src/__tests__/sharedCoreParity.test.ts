import { describe, expect, it } from "vitest";
import {
	ARTIFACT_SURFACES as CORE_SURFACES,
	type DeriveArtifactTitleInput,
	deriveArtifactTitle as coreDeriveArtifactTitle,
	deriveTitleFromFilename as coreDeriveTitleFromFilename,
	deriveTitleFromText as coreDeriveTitleFromText,
	EDGE_TYPES as CORE_EDGE_TYPES,
	ENTITY_PROPERTY_VALIDATORS as CORE_ENTITY_PROPERTY_VALIDATORS,
	type EntityMergeRecord as CoreEntityMergeRecord,
	inverseOf as coreInverseOf,
	isKnownRelationshipType as coreIsKnownRelationshipType,
	type MergePropertiesResult as CoreMergePropertiesResult,
	mergeEntityProperties as coreMergeEntityProperties,
	normalizeRelationshipType as coreNormalizeRelationshipType,
	RELATIONSHIP_VOCABULARY as CORE_RELATIONSHIP_VOCABULARY,
	slugify as coreSlugify,
	vocabNoteSynonymsForType as coreVocabNoteSynonymsForType,
} from "@ahkms/core";
import {
	ARTIFACT_SURFACES as SHARED_SURFACES,
	deriveArtifactTitle as sharedDeriveArtifactTitle,
	deriveTitleFromFilename as sharedDeriveTitleFromFilename,
	deriveTitleFromText as sharedDeriveTitleFromText,
	ENTITY_PROPERTY_VALIDATORS as SHARED_ENTITY_PROPERTY_VALIDATORS,
	type EntityMergeRecord as SharedEntityMergeRecord,
	inverseOf as sharedInverseOf,
	isKnownRelationshipType as sharedIsKnownRelationshipType,
	type MergePropertiesResult as SharedMergePropertiesResult,
	mergeEntityProperties as sharedMergeEntityProperties,
	normalizeRelationshipType as sharedNormalizeRelationshipType,
	RELATIONSHIP_VOCABULARY as SHARED_RELATIONSHIP_VOCABULARY,
	vocabNoteSynonymsForType as sharedVocabNoteSynonymsForType,
} from "@ahkms/shared";
import { slugify as mcpSlugify } from "../kms/artifacts.js";
import { EDGE_TYPES as MCP_EDGE_TYPES } from "../vocab.js";

const TITLE_INPUTS: Array<{ label: string; input: DeriveArtifactTitleInput; slugExpected: string }> = [
	{ label: "empty object", input: {}, slugExpected: "note" },
	{ label: "null fields", input: { explicitTitle: null, text: null, filename: null }, slugExpected: "note" },
	{ label: "whitespace-only text", input: { text: "   \n\t  \r\n " }, slugExpected: "note" },
	{ label: "CRLF text with blank leading lines", input: { text: "\r\n  \r\nFirst CRLF line\r\nSecond line" }, slugExpected: "first-crlf-line" },
	{ label: "300-character first line", input: { text: `${"x".repeat(300)}\nsecond` }, slugExpected: "x".repeat(60) },
	{ label: "custom maxLength 25", input: { text: "abcdefghijklmnopqrstuvwxyz0123456789", maxLength: 25 }, slugExpected: "abcdefghijklmnopqrstuvwxy" },
	{ label: "filename only with extension", input: { filename: "meeting-notes-2026.md" }, slugExpected: "meeting-notes-2026" },
	{ label: "filename with multiple dots", input: { filename: "archive.v1.2.tar.gz" }, slugExpected: "archive-v1-2-tar" },
	{ label: "dotfile with no basename", input: { filename: ".gitignore" }, slugExpected: "note" },
	{ label: "explicit title with surrounding whitespace", input: { explicitTitle: "  Quarterly Review!  ", text: "Body", filename: "f.txt" }, slugExpected: "quarterly-review" },
	{ label: "whitespace-only explicit title falls back to text", input: { explicitTitle: "   ", text: "Fallback Line" }, slugExpected: "fallback-line" },
	{ label: "symbols-only explicit title", input: { explicitTitle: "---***???" }, slugExpected: "note" },
	{ label: "mixed unicode and punctuation", input: { explicitTitle: "Hello, World! — 2026 #1" }, slugExpected: "hello-world-2026-1" },
];

describe("@ahkms/core vs @ahkms/shared artifact helper parity (issue #1608)", () => {
	it("keeps ARTIFACT_SURFACES deep-equal between @ahkms/core and @ahkms/shared", () => {
		expect(CORE_SURFACES).toEqual(SHARED_SURFACES);
	});

	it.each(TITLE_INPUTS)("returns identical deriveArtifactTitle and slugify results for $label", ({ input, slugExpected }) => {
		const coreTitle = coreDeriveArtifactTitle(input);
		const sharedTitle = sharedDeriveArtifactTitle(input);
		expect(coreTitle).toBe(sharedTitle);
		expect(coreDeriveTitleFromText(input.text, input.maxLength)).toBe(
			sharedDeriveTitleFromText(input.text, input.maxLength),
		);
		expect(coreDeriveTitleFromFilename(input.filename)).toBe(
			sharedDeriveTitleFromFilename(input.filename),
		);

		const rawForSlug = coreTitle ?? "";
		expect(coreSlugify(rawForSlug)).toBe(slugExpected);
		expect(mcpSlugify(rawForSlug)).toBe(coreSlugify(rawForSlug));
	});
});

describe("@ahkms/core vs @ahkms/shared relationship vocabulary parity (issue #1482)", () => {
	it("keeps RELATIONSHIP_VOCABULARY and EDGE_TYPES in sync across @ahkms/core, @ahkms/shared, and mcp-server", () => {
		expect(CORE_RELATIONSHIP_VOCABULARY).toEqual(SHARED_RELATIONSHIP_VOCABULARY);
		expect(CORE_EDGE_TYPES).toBe(MCP_EDGE_TYPES);
		for (const term of ["knows", "broader", "narrower", "co_occurs_with"] as const) {
			expect(CORE_EDGE_TYPES).toContain(term);
			expect(SHARED_RELATIONSHIP_VOCABULARY[term]).toBeDefined();
		}
	});

	it("returns identical relationship type resolution and synonym sets for all canonical terms, EDGE_TYPES, and free-text phrases", () => {
		const samples: Array<string | null | undefined> = [
			...Object.keys(SHARED_RELATIONSHIP_VOCABULARY),
			...CORE_EDGE_TYPES,
			"mother",
			"close friend",
			"best friend",
			"co-worker",
			"student of",
			"lives at",
			"Lives At",
			"girlfriend",
			"boyfriend",
			"situationship",
			"going steady",
			"romantic partner",
			"fiance",
			"fiancee",
			"neighbour",
			"owes a pint to",
			"  parentOf  ",
			"",
			"   ",
			null,
			undefined,
		];

		for (const sample of samples) {
			expect(coreNormalizeRelationshipType(sample)).toEqual(
				sharedNormalizeRelationshipType(sample),
			);
			if (typeof sample === "string") {
				expect(coreIsKnownRelationshipType(sample)).toBe(
					sharedIsKnownRelationshipType(sample),
				);
				expect(coreInverseOf(sample)).toBe(sharedInverseOf(sample));
				expect(coreVocabNoteSynonymsForType(sample)).toEqual(
					sharedVocabNoteSynonymsForType(sample),
				);
			}
		}
	});
});

const MERGE_PROPERTY_FIXTURES: Array<{
	label: string;
	winnerType: string;
	winnerProps: Record<string, unknown> | null | undefined;
	loserProps: Record<string, unknown> | null | undefined;
}> = [
	{ label: "both null", winnerType: "people", winnerProps: null, loserProps: null },
	{ label: "both undefined", winnerType: "people", winnerProps: undefined, loserProps: undefined },
	{ label: "conflict keeps winner value", winnerType: "people", winnerProps: { email: "w@example.com" }, loserProps: { email: "l@example.com", role: "CTO" } },
	{ label: "blank winner string overwritten", winnerType: "people", winnerProps: { email: "   ", phone: null }, loserProps: { email: "l@example.com", phone: "+44123" } },
	{ label: "non-scalars skipped", winnerType: "project", winnerProps: { status: "active" }, loserProps: { list: [1, 2], obj: { k: 1 }, priority_level: 3, done: false } },
	{ label: "system and underscore keys excluded", winnerType: "people", winnerProps: {}, loserProps: { aliases: ["a"], merged_into: "id", merged_at: "t", archived_reason: "r", _merge: {}, _priv: 1, homepage: "https://a.test" } },
	{ label: "people schema_invalid values", winnerType: "people", winnerProps: {}, loserProps: { email: "", role: "  ", phone: 123, organization: "Acme" } },
	{ label: "organization validators", winnerType: "organization", winnerProps: { url: "https://w.test" }, loserProps: { url: "https://l.test", legal_name: "Acme Ltd", address: "" } },
	{ label: "place and event validators", winnerType: "event", winnerProps: { date: "2026-10-11" }, loserProps: { location: "London", attendees: "   ", start_date: "09:00" } },
	{ label: "term validators", winnerType: "term", winnerProps: { expansion: "Action Registry" }, loserProps: { context: "ahOS", local_name: "", namespace: "ahos" } },
];

describe("@ahkms/core vs @ahkms/shared entity merge helper parity (issue #1663)", () => {
	it("keeps ENTITY_PROPERTY_VALIDATORS keys and validator outcomes aligned", () => {
		expect(Object.keys(CORE_ENTITY_PROPERTY_VALIDATORS)).toEqual(
			Object.keys(SHARED_ENTITY_PROPERTY_VALIDATORS),
		);
		const samples: unknown[] = ["ok", "", "   ", 0, 42, true, null, undefined, [], {}];
		for (const [entityType, sharedMap] of Object.entries(SHARED_ENTITY_PROPERTY_VALIDATORS)) {
			const coreMap = CORE_ENTITY_PROPERTY_VALIDATORS[entityType];
			expect(Object.keys(coreMap)).toEqual(Object.keys(sharedMap));
			for (const key of Object.keys(sharedMap)) {
				for (const s of samples) {
					expect(coreMap[key](s)).toBe(sharedMap[key](s));
				}
			}
		}

		const sampleRecord: CoreEntityMergeRecord = {
			op_id: "op-1",
			merged_at: "2026-10-11T00:00:00Z",
			winner_id: "w-1",
			moved_edge_ids: [],
			archived_edge_ids: [],
			aliases_added: [],
			properties_carried: [],
			links_moved: [],
			links_deleted: [],
		};
		const asShared: SharedEntityMergeRecord = sampleRecord;
		const backToCore: CoreEntityMergeRecord = asShared;
		expect(backToCore).toEqual(sampleRecord);
	});

	it.each(MERGE_PROPERTY_FIXTURES)("returns identical mergeEntityProperties results for $label", ({ winnerType, winnerProps, loserProps }) => {
		const coreRes: CoreMergePropertiesResult = coreMergeEntityProperties(winnerType, winnerProps, loserProps);
		const sharedRes: SharedMergePropertiesResult = sharedMergeEntityProperties(winnerType, winnerProps, loserProps);
		expect(coreRes).toEqual(sharedRes);
	});
});

