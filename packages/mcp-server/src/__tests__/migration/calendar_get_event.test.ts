import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { EVENT_FIELDS } from "@ahkms/core";
import { createServer } from "../../server.js";
import { serverRegistry } from "../../actions/serverRegistry.js";
import { readLegacyBaseline } from "../legacyBaseline.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
afterEach(() => {
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

describe("calendar_get_event migration (#1582)", () => {
	it("serves calendar_get_event from the registry with dev's exact contract and removes it from legacy baseline", async () => {
		const manifest = JSON.parse(readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"));
		expect(manifest.actions.calendar_get_event?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(serverRegistry().get("calendar_get_event")).toBeDefined();
		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("calendar_get_event");

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();
		const tool = tools.find((t) => t.name === "calendar_get_event")!;
		expect(tool?.description).toBe(
			"Read one Google Calendar event in full: attendees and their individual response statuses, your own response, organiser, location, description, recurrence and link. `domain` is required here (unlike calendar_list_events) because an event id belongs to exactly one calendar, and asking the wrong domain returns a 404 that reads like a deleted event.",
		);
		expect(tool.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		const props = (tool.inputSchema.properties ?? {}) as Record<
			string,
			{ type?: string; enum?: string[]; minLength?: number; description?: string }
		>;
		expect(Object.keys(props).sort()).toEqual(["account", "calendar_id", "domain", "event_id"]);
		expect(tool.inputSchema.required).toEqual(["event_id"]);
		expect(props.domain).toMatchObject({
			type: "string",
			enum: ["work", "angus"],
			description:
				"Which domain to act in: 'work' (the Work company workspace and account) or 'angus' (the personal one).",
		});
		expect(props.account).toMatchObject({
			type: "string",
			enum: ["personal", "work"],
			description: "Deprecated, use `domain`. Which account owns the event: personal | work.",
		});
		expect(props.calendar_id?.description).toBe("Calendar id, default 'primary'.");
		expect(props.event_id).toMatchObject({
			type: "string",
			minLength: 1,
			description: "Event id, from calendar_list_events.",
		});
	});

	it("executes calendar_get_event through MCP with byte-for-byte text parity and EVENT_FIELDS mask", async () => {
		vi.stubEnv("GOOGLE_CLIENT_ID", "cid-test");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret-test");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_WORK", "rt-work-val");

		let eventUrl: URL | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = new URL(String(input));
				if (url.href === "https://oauth2.googleapis.com/token") {
					return new Response(JSON.stringify({ access_token: "at-work" }), { status: 200 });
				}
				eventUrl = url;
				return new Response(
					JSON.stringify({
						id: "e1",
						summary: "Standup",
						start: { dateTime: "2026-09-07T09:30:00Z" },
						end: { dateTime: "2026-09-07T09:45:00Z" },
						location: "Zoom",
						organizer: { email: "them@example.com" },
						attendees: [
							{ email: "them@example.com", responseStatus: "accepted" },
							{ email: "me@example.com", responseStatus: "tentative", self: true },
						],
					}),
					{ status: 200 },
				);
			}),
		);

		const { client } = await connectClient();
		const out = await client.callTool({
			name: "calendar_get_event",
			arguments: { account: "work", event_id: "e1" },
		});
		await client.close();

		expect(out.isError).toBeFalsy();
		expect(eventUrl?.searchParams.get("fields")).toBe(EVENT_FIELDS);
		expect(((out.content as any)[0] as any).text).toBe(
			[
				"Standup [work]",
				"When: 2026-09-07T09:30:00Z to 2026-09-07T09:45:00Z",
				"Where: Zoom",
				"Status: confirmed, your response: tentative",
				"Organiser: them@example.com",
				"Attendees:",
				"  - them@example.com: accepted",
				"  - me@example.com (you): tentative",
			].join("\n"),
		);
	});

	it("round-trips the ETag over MCP: the text of calendar_get_event carries a value calendar_update_event sends as If-Match (#2293)", async () => {
		vi.stubEnv("GOOGLE_CLIENT_ID", "cid-test");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret-test");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_WORK", "rt-work-val");

		const etag = '"3181161784712000"';
		const event = {
			id: "e1",
			etag,
			summary: "Standup",
			start: { dateTime: "2026-09-07T09:30:00Z" },
			end: { dateTime: "2026-09-07T09:45:00Z" },
		};
		let ifMatch: string | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(String(input));
				if (url.href === "https://oauth2.googleapis.com/token") {
					return new Response(JSON.stringify({ access_token: "at-work" }), { status: 200 });
				}
				if (init?.method === "PATCH") {
					ifMatch = (init.headers as Record<string, string>)["If-Match"];
					return new Response(JSON.stringify({ ...event, summary: "Renamed" }), { status: 200 });
				}
				return new Response(JSON.stringify(event), { status: 200 });
			}),
		);

		const { client } = await connectClient();
		const read = await client.callTool({
			name: "calendar_get_event",
			arguments: { domain: "work", event_id: "e1" },
		});
		expect(read.isError).toBeFalsy();
		const text = ((read.content as any)[0] as any).text as string;
		const seen = text.match(/^ETag: (.+)$/m)?.[1];
		expect(seen).toBe(etag);

		const write = await client.callTool({
			name: "calendar_update_event",
			arguments: { domain: "work", event_id: "e1", summary: "Renamed", etag: seen },
		});
		await client.close();

		expect(write.isError).toBeFalsy();
		expect(ifMatch).toBe(etag);
	});
});
