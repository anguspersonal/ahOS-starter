import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { supabase } from "../supabase.js";
import { createServer } from "../server.js";
import { HOT_TIER_MAX_LINES, loadHotTier, renderHotTier, type HotTierRow } from "../hotTier.js";

// #1023 (ADR-092): the hot tier is a generated section of the MCP handshake
// instructions — the always-loaded decoder ring that turns shorthand in a
// one-line request into the graph's canonical names without a tool call.

const origFrom = supabase.from;

afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

const row = (over: Partial<HotTierRow> & Pick<HotTierRow, "entity_type" | "title">): HotTierRow => ({
	id: `id-${over.title}`,
	description: null,
	properties: {},
	aliases: [],
	...over,
});

/** The acceptance-test fixture from the issue: agency, term, and a person. */
const logicrays = row({
	entity_type: "organization",
	title: "LogicRays Technologies",
	aliases: ["logicrays", "LR"],
	description: "Dev agency building the Work app\nsecond line never rendered",
});
const psr = row({
	entity_type: "term",
	title: "PSR",
	properties: { expansion: "Pipeline Status Report", context: "Work finance" },
});
const todd = row({
	entity_type: "people",
	title: "Todd Martinez",
	aliases: ["todd"],
	properties: { role: "Finance lead", organization: "Work" },
});

describe("renderHotTier", () => {
	it("renders nothing when there are no hot rows", () => {
		const out = renderHotTier([]);
		expect(out.text).toBe("");
		expect(out.omitted).toBe(0);
	});

	it("renders a people table and a terms table as name | aliases | gloss", () => {
		const { text } = renderHotTier([logicrays, psr, todd]);
		expect(text).toContain("| Name | Aliases | Gloss |");
		expect(text).toContain("| Todd Martinez | todd | Finance lead, Work |");
		expect(text).toContain("| PSR | — | Pipeline Status Report (Work finance) |");
		// A hot non-term entity is decoded from the same table, its kind leading the
		// gloss so "logicrays" resolves to the agency, not a guess.
		expect(text).toContain("| LogicRays Technologies | logicrays, LR | organization: Dev agency building the Work app |");
		expect(text).not.toContain("second line never rendered");
		// People come first, in their own table.
		expect(text.indexOf("Todd Martinez")).toBeLessThan(text.indexOf("PSR"));
	});

	it("tells the reader how to go one hop deeper with a single call", () => {
		const { text } = renderHotTier([logicrays]);
		expect(text).toContain("entity_neighbourhood");
		expect(text).toContain("title_contains");
	});

	it("escapes pipes and newlines so a cell can never break the table", () => {
		const { text } = renderHotTier([
			row({ entity_type: "term", title: "A|B", properties: { expansion: "x | y" } }),
		]);
		expect(text).toContain("| A\\|B | — | x \\| y |");
	});

	it("falls back to the description, then to the kind, when a term has no expansion", () => {
		const { text } = renderHotTier([
			row({ entity_type: "term", title: "P0", description: "Drop everything priority" }),
			row({ entity_type: "term", title: "ship it" }),
		]);
		expect(text).toContain("| P0 | — | Drop everything priority |");
		expect(text).toContain("| ship it | — | term |");
	});

	it("never exceeds the hard cap of 100 lines, and says how many rows it dropped", () => {
		const many = [
			...Array.from({ length: 80 }, (_, i) => row({ entity_type: "people", title: `Person ${i}` })),
			...Array.from({ length: 80 }, (_, i) => row({ entity_type: "term", title: `T${i}` })),
		];
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		const out = renderHotTier(many);
		expect(HOT_TIER_MAX_LINES).toBe(100);
		expect(out.text.split("\n").length).toBeLessThanOrEqual(100);
		expect(out.lines).toBe(out.text.split("\n").length);
		expect(out.omitted).toBeGreaterThan(0);
		expect(out.text).toContain(`${out.omitted} more hot rows omitted`);
		// Neither table is starved by the other when both overflow.
		expect(out.text).toContain("Person 0");
		expect(out.text).toContain("T0");
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("hot tier truncated"));
	});
});

/** Query-builder stub that resolves at `.limit()` with the given result. */
function stubEntities(result: { data: unknown; error: unknown }) {
	const calls: { table?: string; cols?: string; eqs: [string, unknown][] } = { eqs: [] };
	const b: any = {
		select: (cols: string) => {
			calls.cols = cols;
			return b;
		},
		eq: (col: string, val: unknown) => {
			calls.eqs.push([col, val]);
			return b;
		},
		order: () => b,
		limit: () => Promise.resolve(result),
	};
	(supabase as any).from = vi.fn((table: string) => {
		calls.table = table;
		return b;
	});
	return calls;
}

describe("loadHotTier", () => {
	it("reads the owner's live hot rows from entities", async () => {
		const calls = stubEntities({ data: [todd], error: null });
		const rows = await loadHotTier();
		expect(rows).toEqual([todd]);
		expect(calls.table).toBe("entities");
		expect(calls.cols).toContain("aliases");
		expect(calls.eqs).toContainEqual(["hot", true]);
		expect(calls.eqs).toContainEqual(["archived", false]);
	});

	it("degrades to no tier when the column is not there yet (migration 110 unpushed)", async () => {
		stubEntities({ data: null, error: { code: "42703", message: "column entities.hot does not exist" } });
		expect(await loadHotTier()).toEqual([]);
	});

	it("degrades to no tier when the client throws outright", async () => {
		(supabase as any).from = vi.fn(() => {
			throw new Error("network down");
		});
		expect(await loadHotTier()).toEqual([]);
	});
});

async function handshakeInstructions(server: ReturnType<typeof createServer>) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test-client", version: "0.0.0" });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	const instructions = client.getInstructions();
	await client.close();
	await server.close();
	return instructions;
}

describe("createServer — hot tier in the handshake", () => {
	it("places the hot tier before the tone rules (#2346)", async () => {
		const instructions = await handshakeInstructions(createServer(["Plain British English"], [logicrays, todd]));
		expect(instructions).toContain("Hot tier");
		expect(instructions).toContain("| LogicRays Technologies | logicrays, LR |");
		expect(instructions!.indexOf("Hot tier")).toBeLessThan(instructions!.indexOf("Plain British English"));
		expect(instructions).toContain("capability_get");
	});

	it("adds no section when nothing is hot", async () => {
		const instructions = await handshakeInstructions(createServer([], []));
		expect(instructions).not.toContain("Hot tier");
	});
});
