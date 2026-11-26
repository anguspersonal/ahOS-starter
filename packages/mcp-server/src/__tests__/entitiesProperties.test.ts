/**
 * entity_get prints the row's full `properties`, and entity_query does on
 * request (`include_properties: true`) — #1234 / #1236.
 *
 * `entity_update` replaces `properties` wholesale, so every writer has to read
 * the current object and write the merged whole. Before this change neither
 * read tool printed `properties`, so a "merge" was a merge over nothing: the
 * unattended cv sweep advancing `last_reviewed_through` would have wiped
 * `tracked`, `canonical_*` and `output_folder_id` from the tracked CV.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { entitiesUpdateInput } from "@ahkms/core";
import { supabase } from "../supabase.js";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";

const entitiesGetHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("entity_get")!).handler(args);
const entitiesQueryHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("entity_query")!).handler(args);

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

const TRACKED_PROPERTIES = {
	tracked: true,
	doc_kind: "cv",
	canonical_artifact_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	output_folder_id: "folder-1",
	last_reviewed_through: "2026-08-31",
	renditions: [{ format: "pdf", artifact_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", url: "https://example.test/cv.pdf" }],
};

const row = (id: string, properties: Record<string, unknown>) => ({
	id,
	entity_type: "resource",
	title: `Row ${id}`,
	description: null,
	archived: false,
	archived_at: null,
	properties,
	tags: [],
	source_url: null,
	user_id: "u1",
	team_id: null,
	created_at: null,
	updated_at: null,
	domain_override: null,
});

/** One builder for every table: the list select resolves on `.limit()`, point reads on `.maybeSingle()`. */
function stubAllTables(rows: unknown[], single: unknown) {
	const b: any = {
		select: () => b,
		eq: () => b,
		is: () => b,
		in: () => b,
		order: () => b,
		limit: async () => ({ data: rows, error: null }),
		maybeSingle: async () => ({ data: single, error: null }),
		then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
	};
	(supabase as any).from = vi.fn(() => b);
}

function propertiesLine(text: string, afterId: string): string | undefined {
	const lines = text.split("\n");
	const at = lines.findIndex((line) => line.includes(`[${afterId}]`));
	return at >= 0 ? lines[at + 1] : undefined;
}

describe("entity_get prints the whole properties object", () => {
	it("puts the properties JSON on the line under the row, every key intact", async () => {
		stubAllTables([], row("e1", TRACKED_PROPERTIES));

		const res = await entitiesGetHandler({ id: "e1" } as any);
		const line = propertiesLine(res.content[0].text, "e1");

		expect(line).toBeDefined();
		expect(line!.trim().startsWith("properties: ")).toBe(true);
		expect(JSON.parse(line!.trim().slice("properties: ".length))).toEqual(TRACKED_PROPERTIES);
	});

	it("prints an empty object rather than omitting the line when properties is null", async () => {
		stubAllTables([], { ...row("e2", {}), properties: null });

		const res = await entitiesGetHandler({ id: "e2" } as any);

		expect(propertiesLine(res.content[0].text, "e2")?.trim()).toBe("properties: {}");
	});
});

describe("entity_query include_properties", () => {
	it("keeps one line per row by default", async () => {
		stubAllTables([row("q1", { concept_scheme: "competency" })], null);

		const res = await entitiesQueryHandler({});

		expect(res.content[0].text).not.toContain("properties:");
	});

	it("prints each row's properties under it when asked", async () => {
		stubAllTables([row("q1", { concept_scheme: "competency" }), row("q2", { kind: "achievement" })], null);

		const res = await entitiesQueryHandler({ include_properties: true });
		const text = res.content[0].text;

		expect(propertiesLine(text, "q1")?.trim()).toBe('properties: {"concept_scheme":"competency"}');
		expect(propertiesLine(text, "q2")?.trim()).toBe('properties: {"kind":"achievement"}');
	});

	it("is a read option only: the bulk update filter does not carry it", () => {
		const filterShape = z.object(entitiesUpdateInput).shape.filter.unwrap().shape;
		expect(Object.keys(filterShape)).toContain("entity_type");
		expect(Object.keys(filterShape)).not.toContain("include_properties");
	});
});
