import { describe, expect, it, vi } from "vitest";

// ADR-084's resolver reads two things: `entities` (for domain_override + the
// primary `belongs_to` edge, via `entity_relationships`) and
// `user_preferences.dos_config` (for `domain_signals`, via loadDosConfig).
// Both are stubbed here rather than hit against a real Supabase project, in
// the same style as entitiesPeopleSourceUrl.test.ts and slackIngest.test.ts
// elsewhere in this package.

type EntityFixture = {
	id: string;
	title?: string | null;
	description?: string | null;
	tags?: string[] | null;
	properties?: Record<string, unknown> | null;
	domain_override?: string | null;
};

const store = vi.hoisted(() => ({
	entities: new Map<string, EntityFixture>(),
	// from_entity_id -> to_entity_id, one live primary `belongs_to` edge each.
	primaryParent: new Map<string, string>(),
}));

vi.mock("./supabase.js", () => {
	function entitiesBuilder() {
		let id: string | undefined;
		const b: any = {
			select: () => b,
			eq: (col: string, val: unknown) => {
				if (col === "id") id = val as string;
				return b;
			},
			maybeSingle: async () => {
				const row = id ? store.entities.get(id) : undefined;
				if (!row) return { data: null, error: null };
				return {
					data: {
						id: row.id,
						title: row.title ?? null,
						description: row.description ?? null,
						tags: row.tags ?? null,
						properties: row.properties ?? null,
						domain_override: row.domain_override ?? null,
					},
					error: null,
				};
			},
		};
		return b;
	}

	function relationshipsBuilder() {
		let fromId: string | undefined;
		const b: any = {
			select: () => b,
			eq: (col: string, val: unknown) => {
				if (col === "from_entity_id") fromId = val as string;
				return b;
			},
			limit: () => b,
			maybeSingle: async () => {
				const to = fromId ? store.primaryParent.get(fromId) : undefined;
				return { data: to ? { to_entity_id: to } : null, error: null };
			},
		};
		return b;
	}

	return {
		supabase: {
			from: (table: string) => (table === "entities" ? entitiesBuilder() : relationshipsBuilder()),
		},
	};
});

vi.mock("./identity.js", () => ({ getCurrentUserId: () => "user-1" }));

vi.mock("./dosConfig.js", () => ({
	loadDosConfig: async () => ({
		by_domain: {
			work: { domain_signals: ["Work", "Round"] },
			angus: { domain_signals: ["wedding", "Laura"] },
		},
		types: [],
		tone: [],
	}),
	domainConfig: (config: any, domain: string) => config.by_domain[domain] ?? null,
}));

import { matchesDomainSignals, resolveEntityDomain } from "./entityDomain.js";

function seed(...fixtures: EntityFixture[]) {
	store.entities.clear();
	store.primaryParent.clear();
	for (const f of fixtures) store.entities.set(f.id, f);
}

function belongsTo(fromId: string, toId: string) {
	store.primaryParent.set(fromId, toId);
}

describe("matchesDomainSignals", () => {
	it("is a case-insensitive substring test", () => {
		expect(matchesDomainSignals("the Work round closed", ["work"])).toBe(true);
		expect(matchesDomainSignals("nothing relevant here", ["work"])).toBe(false);
	});

	it("ignores blank signal entries", () => {
		expect(matchesDomainSignals("anything", [""])).toBe(false);
	});
});

describe("resolveEntityDomain (ADR-084 order)", () => {
	it("step 1: domain_override wins even when containment and signals would answer differently", async () => {
		seed({ id: "e1", title: "Work round update", domain_override: "angus" });

		const result = await resolveEntityDomain("e1");

		expect(result).toEqual({ domain: "angus", resolved_by: "override", path: ["e1"] });
	});

	it("step 2: inherits the resolved domain through a multi-level primary belongs_to chain", async () => {
		seed(
			{ id: "task", title: "Untitled task" },
			{ id: "project", title: "Untitled project" },
			{ id: "area", title: "Wedding planning", domain_override: "angus" },
		);
		belongsTo("task", "project");
		belongsTo("project", "area");

		const result = await resolveEntityDomain("task");

		expect(result.domain).toBe("angus");
		expect(result.resolved_by).toBe("parent");
		expect(result.path).toEqual(["task", "project", "area"]);
	});

	it("step 3: falls back to domain_signals on the entity's own text when there is no primary parent", async () => {
		seed({ id: "e2", title: "Coffee with Laura re wedding venue" });

		const result = await resolveEntityDomain("e2");

		expect(result).toEqual({ domain: "angus", resolved_by: "signals", path: ["e2"] });
	});

	it("step 3: also runs when the containment chain terminates without resolving", async () => {
		seed(
			{ id: "child", title: "wedding dress fitting" },
			{ id: "parent", title: "Untitled area" }, // no override, no parent, no signal match
		);
		belongsTo("child", "parent");

		const result = await resolveEntityDomain("child");

		// parent resolves to nothing, so `child` falls through to its OWN signals.
		expect(result).toEqual({ domain: "angus", resolved_by: "signals", path: ["child"] });
	});

	it("step 4: neither override, containment, nor signals reach — reported unresolved, not guessed", async () => {
		seed({ id: "e3", title: "Untitled thing" });

		const result = await resolveEntityDomain("e3");

		expect(result.domain).toBeNull();
		expect(result.resolved_by).toBe("unresolved");
	});

	it("cycle guard: a containment cycle resolves unresolved instead of looping forever", async () => {
		seed({ id: "a", title: "A" }, { id: "b", title: "B" });
		belongsTo("a", "b");
		belongsTo("b", "a");

		const result = await resolveEntityDomain("a");

		expect(result.domain).toBeNull();
		expect(result.resolved_by).toBe("unresolved");
	});

	it("an entity that no longer exists resolves unresolved rather than throwing", async () => {
		seed();

		const result = await resolveEntityDomain("missing");

		expect(result.domain).toBeNull();
		expect(result.resolved_by).toBe("unresolved");
	});

	it("depth cap: a belongs_to chain deeper than MAX_DEPTH resolves unresolved rather than walking to a distant ancestor's override or looping forever (QA round 1, High)", async () => {
		// A long, strictly ACYCLIC chain (distinct from the cycle-guard case
		// above) — chain-0 -> chain-1 -> ... -> chain-(N-1). N is comfortably
		// past MAX_DEPTH (50) so the walk must hit the depth cap before it could
		// ever reach the terminal ancestor's own answer.
		const N = 60;
		const fixtures: EntityFixture[] = [];
		for (let i = 0; i < N; i++) fixtures.push({ id: `chain-${i}`, title: `Untitled node ${i}` });
		// The terminal ancestor DOES carry an override that would resolve the
		// whole chain if the walk ever reached it — proving the cap is what
		// stops the walk, not that the chain happens to dead-end unresolved.
		fixtures[N - 1] = { id: `chain-${N - 1}`, title: "Root", domain_override: "work" };
		seed(...fixtures);
		for (let i = 0; i < N - 1; i++) belongsTo(`chain-${i}`, `chain-${i + 1}`);

		const result = await resolveEntityDomain("chain-0");

		// Reaching the root's override would answer { domain: "work", resolved_by: "parent" }.
		// Reporting unresolved instead proves the depth cap fired before the
		// walk got there (and that it terminates at all — no infinite walk).
		expect(result.domain).toBeNull();
		expect(result.resolved_by).toBe("unresolved");
		expect(Array.isArray(result.path)).toBe(true);
		expect(result.path.length).toBeGreaterThan(0);
	});
});
