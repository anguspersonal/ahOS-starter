import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEX_TOOLS, dexSearchContactsInput } from "@ahkms/core";
import { createServer } from "../server.js";
import { env } from "../env.js";

// #1063: the forty-odd first-class `dex_*` tools collapse behind `dex_list_tools` /
// `dex_call_tool`. What must not change is everything a caller could do before:
// the same tools, the same schemas, the same results. These tests hold the
// passthrough to that.

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function mockFetchJson(result: unknown) {
	const fetchMock = vi.fn(async () => ({
		ok: true,
		status: 200,
		statusText: "OK",
		headers: new Headers({ "content-type": "application/json" }),
		json: async () => ({
			jsonrpc: "2.0",
			id: "1",
			result,
		}),
	}));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

/**
 * The names `server.ts` registered as first-class tools before #1063, frozen here
 * on purpose. This is the contract the passthrough inherits, so it is written down
 * once rather than derived from the catalog it is checking.
 */
const PREVIOUSLY_REGISTERED = [
	"dex_search_contacts",
	"dex_list_contacts",
	"dex_get_contact",
	"dex_create_contact",
	"dex_update_contact",
	"dex_delete_contacts",
	"dex_merge_contacts",
	"dex_list_note_types",
	"dex_create_note",
	"dex_get_note",
	"dex_update_note",
	"dex_delete_note",
	"dex_list_notes",
	"dex_create_reminder",
	"dex_get_reminder",
	"dex_list_reminders",
	"dex_update_reminder",
	"dex_delete_reminder",
	"dex_list_tags",
	"dex_get_tag",
	"dex_create_tag",
	"dex_update_tag",
	"dex_delete_tag",
	"dex_add_tags_to_contacts",
	"dex_remove_tags_from_contacts",
	"dex_list_groups",
	"dex_get_group",
	"dex_create_group",
	"dex_update_group",
	"dex_delete_group",
	"dex_list_group_contacts",
	"dex_add_contacts_to_group",
	"dex_remove_contacts_from_group",
	"dex_list_custom_fields",
	"dex_create_custom_field",
	"dex_update_custom_field",
	"dex_delete_custom_field",
	"dex_set_custom_field_values",
];

type Listed = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations: Record<string, unknown>;
};

type ToolResult = { content: unknown; isError?: boolean };

async function connect(server: McpServer): Promise<Client> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

function text(result: ToolResult): string {
	return (result.content as { type: string; text: string }[])[0]?.text ?? "";
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
	const client = await connect(createServer());
	try {
		return (await client.callTool({ name, arguments: args })) as ToolResult;
	} finally {
		await client.close();
	}
}

async function listDexTools(): Promise<Listed[]> {
	const result = await call("dex_list_tools", {});
	expect(result.isError, text(result)).toBeFalsy();
	return JSON.parse(text(result)) as Listed[];
}

const SEARCH_RESULT = {
	content: [
		{
			type: "text" as const,
			text: JSON.stringify({ contacts: [{ id: "c_1", first_name: "Ada", last_name: "Lovelace" }] }),
		},
	],
};

describe("dex_list_tools", () => {
	it("lists every Dex tool the server used to register, and nothing else", async () => {
		const names = (await listDexTools()).map((t) => t.name);
		expect([...names].sort()).toEqual([...PREVIOUSLY_REGISTERED].sort());
	});

	it("gives each one the JSON schema the SDK would have advertised for it", async () => {
		const reference = new McpServer({ name: "reference", version: "0" });
		for (const t of DEX_TOOLS) {
			reference.registerTool(t.name, { description: t.description, inputSchema: t.input }, async () => ({
				content: [],
			}));
		}
		const client = await connect(reference);
		const { tools } = await client.listTools();
		await client.close();
		const expected = new Map(tools.map((t) => [t.name, t.inputSchema]));

		const listed = await listDexTools();
		expect(listed.length).toBe(PREVIOUSLY_REGISTERED.length);
		for (const t of listed) {
			expect(t.description.trim(), `${t.name} description`).not.toBe("");
			expect(t.inputSchema, `${t.name} schema`).toEqual(expected.get(t.name));
		}
	});

	it("derives the schema from the zod input rather than a hand-written copy", async () => {
		const search = (await listDexTools()).find((t) => t.name === "dex_search_contacts");
		expect(search?.inputSchema).toMatchObject({
			type: "object",
			properties: { query: { type: "string" }, limit: { type: "number" } },
			required: ["query"],
		});
	});

	it("carries each tool's own annotations, so the destructive ones still say so", async () => {
		const listed = new Map((await listDexTools()).map((t) => [t.name, t.annotations]));
		for (const [name, a] of listed) {
			for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
				expect(typeof a[k], `${name}.${k}`).toBe("boolean");
			}
		}
		expect(listed.get("dex_delete_contacts")).toMatchObject({ destructiveHint: true, readOnlyHint: false });
		expect(listed.get("dex_merge_contacts")).toMatchObject({ destructiveHint: true, readOnlyHint: false });
		expect(listed.get("dex_search_contacts")).toMatchObject({ readOnlyHint: true, destructiveHint: false });
	});

	it("never calls Dex", async () => {
		const fetchMock = mockFetchJson(SEARCH_RESULT);
		await listDexTools();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("dex_call_tool", () => {
	it("refuses an unknown tool and names the valid ones", async () => {
		const fetchMock = mockFetchJson(SEARCH_RESULT);
		const result = await call("dex_call_tool", { tool: "dex_find_people", args: {} });

		expect(result.isError).toBe(true);
		expect(text(result)).toContain("dex_find_people");
		for (const name of PREVIOUSLY_REGISTERED) expect(text(result)).toContain(name);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("validates args locally, names the failing field, and sends nothing to Dex", async () => {
		const fetchMock = mockFetchJson(SEARCH_RESULT);
		const result = await call("dex_call_tool", {
			tool: "dex_search_contacts",
			args: { limit: "ten" },
		});

		expect(result.isError).toBe(true);
		expect(text(result)).toMatch(/\bquery\b/);
		expect(text(result)).toMatch(/\blimit\b/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("names a nested field by its full path", async () => {
		const fetchMock = mockFetchJson(SEARCH_RESULT);
		const result = await call("dex_call_tool", {
			tool: "dex_create_contact",
			args: { first_name: "Ada", emails: [{ label: "Work" }] },
		});

		expect(result.isError).toBe(true);
		expect(text(result)).toContain("emails.0.email");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("treats omitted args as empty, so a required field is still reported", async () => {
		const fetchMock = mockFetchJson(SEARCH_RESULT);
		const result = await call("dex_call_tool", { tool: "dex_delete_contacts" });

		expect(result.isError).toBe(true);
		expect(text(result)).toContain("contact_ids");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns exactly what the old first-class dex_search_contacts returned", async () => {
		vi.spyOn(env, "dexApiKey", "get").mockReturnValue("dex-test-key");
		const fetchMock = mockFetchJson(SEARCH_RESULT);
		const args = { query: "ada", limit: 5 };

		const old = new McpServer({ name: "pre-1063", version: "0" });
		old.registerTool(
			"dex_search_contacts",
			{
				description: "Search Dex contacts by name, email, company, or any keyword.",
				inputSchema: dexSearchContactsInput,
				annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
			},
			async () => SEARCH_RESULT,
		);
		const oldClient = await connect(old);
		const viaOld = await oldClient.callTool({ name: "dex_search_contacts", arguments: args });
		await oldClient.close();

		const viaPassthrough = await call("dex_call_tool", { tool: "dex_search_contacts", args });

		expect(viaPassthrough).toEqual(viaOld);
		expect(viaPassthrough.isError).toBeFalsy();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(JSON.parse(init.body as string).params).toEqual({ name: "dex_search_contacts", arguments: args });
	});

	it("drops undeclared keys before calling Dex, as the SDK did for the first-class tool", async () => {
		vi.spyOn(env, "dexApiKey", "get").mockReturnValue("dex-test-key");
		const fetchMock = mockFetchJson(SEARCH_RESULT);
		await call("dex_call_tool", { tool: "dex_search_contacts", args: { query: "ada", colour: "blue" } });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(JSON.parse(init.body as string).params).toEqual({
			name: "dex_search_contacts",
			arguments: { query: "ada" },
		});
	});
});

describe("the registered Dex surface", () => {
	async function surface() {
		const client = await connect(createServer());
		const { tools } = await client.listTools();
		await client.close();
		return tools;
	}

	it("registers the two passthrough tools and none of the collapsed ones", async () => {
		const dex = (await surface()).map((t) => t.name).filter((n) => n.startsWith("dex_"));
		expect(dex.sort()).toEqual(["dex_call_tool", "dex_list_tools"]);
	});

	it("marks dex_list_tools read-only and dex_call_tool as able to destroy", async () => {
		const byName = new Map((await surface()).map((t) => [t.name, t.annotations]));
		expect(byName.get("dex_list_tools")).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
		expect(byName.get("dex_call_tool")).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		});
	});
});
