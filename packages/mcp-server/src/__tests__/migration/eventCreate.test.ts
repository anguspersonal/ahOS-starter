import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../../server.js";
import { serverRegistry } from "../../actions/serverRegistry.js";
import { supabase } from "../../supabase.js";
import { readLegacyBaseline } from "../legacyBaseline.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const origFrom = supabase.from;

afterEach(() => {
	(supabase as any).from = origFrom;
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function connectClient() {
	const server = createServer();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return { client, server };
}

describe("event_create migration (#1612)", () => {
	it("serves event_create from the registry with dev's exact contract and removes it from legacy baseline", async () => {
		const manifest = JSON.parse(
			readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"),
		);
		expect(manifest.actions.event_create?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(serverRegistry().get("event_create")).toBeDefined();
		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("event_create");

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();
		const tool = tools.find((t) => t.name === "event_create")!;
		expect(tool?.description).toBe(
			"Create a Google Calendar event. `title` is required. `start` is a full ISO datetime for a timed " +
				"event or a bare YYYY-MM-DD for an all-day one; `end` is optional and defaults to one hour later, " +
				"or the next day for all-day. Full notes: docs/guides/tools/event_create.md",
		);
		expect(tool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
		const props = (tool.inputSchema.properties ?? {}) as Record<
			string,
			{ type?: string; enum?: string[]; minLength?: number; description?: string }
		>;
		expect(Object.keys(props).sort()).toEqual([
			"account",
			"artifact_id",
			"attendees",
			"dedup_key",
			"description",
			"domain",
			"end",
			"location",
			"single_event",
			"source_text",
			"start",
			"title",
		]);
		expect(tool.inputSchema.required).toEqual(["title", "start"]);
		expect(props.title).toMatchObject({
			type: "string",
			minLength: 1,
			description: "The event title (Calendar's 'summary' field).",
		});
		expect(props.domain).toMatchObject({
			type: "string",
			enum: ["work", "angus"],
		});
		expect(props.account).toMatchObject({
			type: "string",
			enum: ["personal", "work"],
		});
	});

	it("executes event_create through MCP with byte-for-byte text parity", async () => {
		vi.stubEnv("GOOGLE_CLIENT_ID", "cid-test");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret-test");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_PERSONAL", "rt-personal-val");

		(supabase as any).from = vi.fn((table: string) => {
			if (table === "user_integrations") {
				const b: any = {
					select: () => b,
					eq: () => b,
					maybeSingle: () =>
						Promise.resolve({
							data: { config: { calendar_id: "primary" }, enabled: true },
							error: null,
						}),
				};
				return b;
			}
			if (table === "artifact_external_links") {
				return {
					upsert: () => Promise.resolve({ error: null }),
				};
			}
			throw new Error(`Unexpected table: ${table}`);
		});

		let postUrl: URL | undefined;
		let postBody: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(String(input));
				if (url.href === "https://oauth2.googleapis.com/token") {
					return new Response(JSON.stringify({ access_token: "at-personal" }), { status: 200 });
				}
				postUrl = url;
				postBody = init?.body ? JSON.parse(String(init.body)) : undefined;
				return new Response(
					JSON.stringify({
						id: "evt_1",
						htmlLink: "https://calendar.google.com/event?eid=evt_1",
					}),
					{ status: 200 },
				);
			}),
		);

		const { client } = await connectClient();
		const out = await client.callTool({
			name: "event_create",
			arguments: {
				title: "Team sync",
				start: "2026-07-10T14:00:00Z",
				artifact_id: "11111111-1111-4111-8111-111111111111",
			},
		});
		await client.close();

		expect(out.isError).toBeFalsy();
		expect(postUrl?.pathname).toBe("/calendar/v3/calendars/primary/events");
		expect(postBody).toMatchObject({
			summary: "Team sync",
			start: { dateTime: "2026-07-10T14:00:00Z" },
			end: { dateTime: "2026-07-10T15:00:00.000Z" },
		});
		const expectedText =
			"Created Calendar event: Team sync\n" +
			"Event: https://calendar.google.com/event?eid=evt_1\n" +
			"Linked to artifact 11111111-1111-4111-8111-111111111111";
		expect(((out.content as any)[0] as any).text).toBe(expectedText);
	});
});
