/**
 * embedEntityText (#551 / ADR-047 §1-§2) — the text an `entities` row is
 * embedded from. Must mirror migration 095's generated `search_vector` exactly
 * (title + description + properties.{role,organization,relationship}) so the
 * FTS and semantic arms of a future hybrid_search_entities (#552) agree on
 * what a row "is about" — the same invariant embedText already holds for
 * artifacts (migration 044 vs embeddings.ts).
 */

import { describe, expect, it } from "vitest";
import { embedEntityText } from "../embeddings.js";

describe("embedEntityText", () => {
	it("joins title, description, and the three scalar properties fields", () => {
		const text = embedEntityText({
			title: "Sam Altman",
			description: "Met at a conference.",
			properties: { role: "CEO", organization: "OpenAI", relationship: "acquaintance" },
		});
		expect(text).toBe("Sam Altman\n\nMet at a conference.\n\nCEO\n\nOpenAI\n\nacquaintance");
	});

	it("drops missing/falsy fields rather than embedding empty segments", () => {
		const text = embedEntityText({ title: "Sam", description: null, properties: null });
		expect(text).toBe("Sam");
	});

	it("ignores non-string properties.role/organization/relationship (e.g. accidental numbers/objects)", () => {
		const text = embedEntityText({
			title: "Weird Co",
			properties: { role: 42, organization: { name: "nested" }, relationship: null },
		});
		expect(text).toBe("Weird Co");
	});

	it("joins term expansion and context when present", () => {
		const text = embedEntityText({
			title: "PSR",
			properties: { expansion: "Pipeline Status Report", context: "Work finance" },
		});
		expect(text).toBe("PSR\n\nPipeline Status Report\n\nWork finance");
	});

	it("includes aliases from aliases column and legacy properties.aliases", () => {
		const fromCol = embedEntityText({
			title: "Alexander Smith",
			aliases: ["Alex", "todd"],
		});
		expect(fromCol).toBe("Alexander Smith\n\nAlex todd");

		const fromProps = embedEntityText({
			title: "Alexander Smith",
			properties: { aliases: ["todd"] },
		});
		expect(fromProps).toBe("Alexander Smith\n\ntodd");
	});

	it("ignores properties keys outside the tsvector composition (e.g. email, phone)", () => {
		// Mirrors migration 125: only role/organization/relationship/expansion/context
		// and aliases feed the generated column. Any other key must not leak into
		// the embed text — otherwise the embedding and search_vector would disagree
		// about what the row "is about".
		const text = embedEntityText({
			title: "Sam",
			properties: { email: "sam@example.com", phone: "+1234567890" },
		});
		expect(text).toBe("Sam");
	});

	it("returns empty string when there is nothing to embed", () => {
		expect(embedEntityText({})).toBe("");
		expect(embedEntityText({ title: null, description: null, properties: {} })).toBe("");
	});

	it("truncates to the same MAX_CHARS ceiling as embedText", () => {
		const text = embedEntityText({ title: "x".repeat(30_000) });
		expect(text.length).toBe(28_000);
	});
});
