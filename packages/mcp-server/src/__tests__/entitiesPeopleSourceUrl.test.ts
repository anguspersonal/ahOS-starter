import { afterEach, describe, expect, it, vi } from "vitest";

import { supabase } from "../supabase.js";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";

const entitiesCreateHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("entity_create")!).handler(args);
const entitiesQueryHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("entity_query")!).handler(args);
const entitiesUpdateHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("entity_update")!).handler(args);
const peopleCreateHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("person_create")!).handler(args);
const peopleQueryHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("person_query")!).handler(args);
const peopleUpdateHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("person_update")!).handler(args);

const origFrom = supabase.from;

afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

/** Minimal query-builder stub returning `rows` (the view's contents) up to the cap. */
function stubTable(rows: unknown[]) {
	const b: any = {
		select: () => b,
		eq: () => b,
		in: () => b,
		order: () => b,
		limit: (n: number) => Promise.resolve({ data: rows.slice(0, n), error: null }),
		// ADR-084's resolver (entities_query wiring) also reads
		// `user_preferences.dos_config` once per call (QA round 1, Medium),
		// via `.maybeSingle()`.
		maybeSingle: () => Promise.resolve({ data: null, error: null }),
	};
	(supabase as any).from = vi.fn(() => b);
}

const entity = (id: string, title: string, source_url: string | null) => ({
	id,
	entity_type: "people",
	title,
	description: null,
	archived: false,
	archived_at: null,
	properties: {},
	tags: [],
	source_url,
	user_id: "u1",
	team_id: null,
	created_at: null,
	updated_at: null,
});

const person = (id: string, name: string, source_url: string | null) => ({
	id,
	name,
	bio: null,
	role: null,
	organization: null,
	email: null,
	phone: null,
	relationship: null,
	last_contact: null,
	tags: [],
	archived: false,
	archived_at: null,
	properties: {},
	source_url,
	user_id: "u1",
	team_id: null,
	created_at: null,
	updated_at: null,
});

describe("entity_query exposes source_url (#426)", () => {
	it("shows the source when set", async () => {
		stubTable([entity("e1", "Sam", "https://notion.so/sam")]);
		const res = await entitiesQueryHandler({});
		expect(res.content[0].text).toContain("source: https://notion.so/sam");
	});

	it("omits the source when null (native to the graph)", async () => {
		stubTable([entity("e2", "Robbie", null)]);
		const res = await entitiesQueryHandler({});
		expect(res.content[0].text).not.toContain("source:");
	});

	it("is queryable by source_url", async () => {
		stubTable([
			...Array.from({ length: 30 }, (_, i) => entity(`filler-${i}`, `Filler ${i}`, null)),
			entity("target", "Sam", "https://notion.so/needle"),
		]);
		const res = await entitiesQueryHandler({ query: "notion.so/needle" });
		expect(res.content[0].text).toContain("target");
	});
});

describe("person_query exposes source_url (#426)", () => {
	it("shows the source when set", async () => {
		stubTable([person("p1", "Sam", "https://notion.so/people/sam")]);
		const res = await peopleQueryHandler({});
		expect(res.content[0].text).toContain("source: https://notion.so/people/sam");
	});

	it("omits the source when null (native to the graph)", async () => {
		stubTable([person("p2", "Robbie", null)]);
		const res = await peopleQueryHandler({});
		expect(res.content[0].text).not.toContain("source:");
	});
});

/**
 * Capturing stub for insert/update paths: records the payload passed to `.insert()`
 * / `.update()` so tests can assert on what would actually be written, rather than
 * on the read-back row shape.
 */
function stubMutate() {
	const calls: { insert?: unknown; update?: unknown } = {};
	const b: any = {
		insert: (rows: unknown) => {
			calls.insert = rows;
			return b;
		},
		update: (updates: unknown) => {
			calls.update = updates;
			return b;
		},
		select: () => Promise.resolve({ data: [], error: null }),
		eq: () => b,
		in: () => b,
	};
	(supabase as any).from = vi.fn(() => b);
	return calls;
}

describe("entities create/update normalize source_url '' to null (#426 QA round 1)", () => {
	it("stores an empty-string source_url as null on create", async () => {
		const calls = stubMutate();
		await entitiesCreateHandler({ entities: [{ title: "Sam", source_url: "" }] } as any);
		expect((calls.insert as any[])[0].source_url).toBeNull();
	});

	it("clears source_url to null (not '') on update", async () => {
		const calls = stubMutate();
		await entitiesUpdateHandler({ ids: ["e1"], patch: { source_url: "" } } as any);
		expect((calls.update as any).source_url).toBeNull();
	});

	it("leaves a real source_url untouched", async () => {
		const calls = stubMutate();
		await entitiesCreateHandler({ entities: [{ title: "Sam", source_url: "https://notion.so/sam" }] } as any);
		expect((calls.insert as any[])[0].source_url).toBe("https://notion.so/sam");
	});
});

describe("people create/update normalize source_url '' to null (#426 QA round 1)", () => {
	it("stores an empty-string source_url as null on create", async () => {
		const calls = stubMutate();
		await peopleCreateHandler({ people: [{ name: "Sam", source_url: "" }] } as any);
		expect((calls.insert as any[])[0].source_url).toBeNull();
	});

	it("clears source_url to null (not '') on update", async () => {
		const calls = stubMutate();
		await peopleUpdateHandler({ ids: ["p1"], patch: { source_url: "" } } as any);
		expect((calls.update as any).source_url).toBeNull();
	});

	it("leaves a real source_url untouched", async () => {
		const calls = stubMutate();
		await peopleCreateHandler({ people: [{ name: "Sam", source_url: "https://notion.so/people/sam" }] } as any);
		expect((calls.insert as any[])[0].source_url).toBe("https://notion.so/people/sam");
	});
});
