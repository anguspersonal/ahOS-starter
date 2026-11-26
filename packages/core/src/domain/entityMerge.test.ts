import { describe, expect, it } from "vitest";
import { ENTITY_PROPERTY_VALIDATORS, mergeEntityProperties } from "./entityMerge.js";

describe("mergeEntityProperties (#1663)", () => {
	it("carries non-conflicting scalars and keeps winner values on conflict", () => {
		const res = mergeEntityProperties(
			"people",
			{ email: "winner@example.com", empty_slot: "   " },
			{ email: "loser@example.com", role: "Engineer", empty_slot: "filled" },
		);

		expect(res).toEqual({
			mergedProperties: {
				email: "winner@example.com",
				empty_slot: "filled",
				role: "Engineer",
			},
			carriedKeys: ["role", "empty_slot"],
			skippedKeys: { email: "conflict_winner_preferred" },
		});
	});

	it("skips non-scalars and excludes system and underscore-prefixed keys", () => {
		const res = mergeEntityProperties(
			"project",
			{ priority_level: 2 },
			{
				aliases: ["old"],
				merged_into: "x",
				merged_at: "2026-01-01T00:00:00Z",
				archived_reason: "merged_duplicate",
				_merge: { op_id: "1" },
				_internal: "secret",
				nested: { a: 1 },
				list: ["a", "b"],
				active: true,
			},
		);

		expect(res).toEqual({
			mergedProperties: { priority_level: 2, active: true },
			carriedKeys: ["active"],
			skippedKeys: {
				nested: "non_scalar",
				list: "non_scalar",
			},
		});
	});

	it("marks failing ENTITY_PROPERTY_VALIDATORS entries as schema_invalid", () => {
		expect(ENTITY_PROPERTY_VALIDATORS.people.email("valid@example.com")).toBe(true);
		expect(ENTITY_PROPERTY_VALIDATORS.people.email("   ")).toBe(false);

		const res = mergeEntityProperties(
			"people",
			{},
			{ email: "   ", phone: 12345, homepage: "https://example.com" },
		);

		expect(res).toEqual({
			mergedProperties: { homepage: "https://example.com" },
			carriedKeys: ["homepage"],
			skippedKeys: {
				email: "schema_invalid",
				phone: "schema_invalid",
			},
		});
	});
});
