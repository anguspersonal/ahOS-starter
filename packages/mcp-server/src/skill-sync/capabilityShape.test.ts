import { describe, expect, it } from "vitest";
import { capabilityKinds, isSkillCapability, normalizeDeclaredSurface } from "./capabilityShape.js";

describe("capabilityKinds", () => {
	it("reads migration 114's array and a legacy string the same way", () => {
		expect(capabilityKinds({ kind: ["skill", "agent"] })).toEqual(["skill", "agent"]);
		expect(capabilityKinds({ kind: "skill" })).toEqual(["skill"]);
	});

	it("returns no kinds for a missing or malformed value", () => {
		expect(capabilityKinds({})).toEqual([]);
		expect(capabilityKinds(null)).toEqual([]);
		expect(capabilityKinds({ kind: 42 })).toEqual([]);
	});
});

describe("isSkillCapability", () => {
	it("is true for a skill alone or in a twin, from kinds or the joined label", () => {
		expect(isSkillCapability({ kind: "skill+agent", kinds: ["skill", "agent"] })).toBe(true);
		expect(isSkillCapability({ kind: "skill" })).toBe(true);
		expect(isSkillCapability({ kind: "agent", kinds: ["agent"] })).toBe(false);
		expect(isSkillCapability({ kind: "?" , kinds: [] })).toBe(false);
	});
});

describe("normalizeDeclaredSurface", () => {
	it("mirrors migration 114: cowork -> claude-synced, chat and cowork -> clients", () => {
		expect(normalizeDeclaredSurface(["claude-code", "cowork", "chat"])).toEqual({
			surface: ["claude-code", "claude-synced"],
			clients: ["chat", "cowork"],
		});
	});

	it("leaves a runtime-only list untouched", () => {
		expect(normalizeDeclaredSurface(["claude-code"])).toEqual({ surface: ["claude-code"], clients: [] });
	});

	it("falls back to claude-synced when only chat was declared", () => {
		expect(normalizeDeclaredSurface(["chat"])).toEqual({ surface: ["claude-synced"], clients: ["chat"] });
	});
});
