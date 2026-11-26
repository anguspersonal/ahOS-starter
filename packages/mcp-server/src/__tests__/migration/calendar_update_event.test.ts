import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
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

describe("calendar_update_event migration (#1583)", () => {
	it("serves calendar_update_event from the registry with dev's exact contract and removes it from legacy baseline", async () => {
		const manifest = JSON.parse(readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"));
		expect(manifest.actions.calendar_update_event?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(serverRegistry().get("calendar_update_event")).toBeDefined();
		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("calendar_update_event");

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();
		const tool = tools.find((t) => t.name === "calendar_update_event")!;
		expect(tool?.description).toBe(
			"Change a Google Calendar event's title, description, location, start or end. Only the fields you pass are touched. It CANNOT change who is invited: Calendar treats the attendee list as one whole value, so a partial write would silently uninvite everyone omitted. Full notes: docs/guides/tools/calendar_update_event.md",
		);
		expect(tool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		const props = (tool.inputSchema.properties ?? {}) as Record<
			string,
			{ type?: string; enum?: string[]; minLength?: number; description?: string }
		>;
		expect(Object.keys(props).sort()).toEqual([
			"account",
			"calendar_id",
			"description",
			"domain",
			"end",
			"etag",
			"event_id",
			"location",
			"notify_attendees",
			"start",
			"summary",
		]);
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
			description:
				"Event id, from calendar_list_events. For a recurring series, that id is ONE OCCURRENCE (calendar_list_events expands series into instances), so updating it changes that occurrence alone and leaves the rest of the series untouched.",
		});
		expect(props.summary?.description).toBe("New title. Omit to leave unchanged.");
		expect(props.description?.description).toBe("New description. Omit to leave unchanged.");
		expect(props.location?.description).toBe("New location. Omit to leave unchanged.");
		expect(props.start?.description).toBe(
			"New start: a full ISO datetime for a timed event, or 'YYYY-MM-DD' for an all-day one. Pass `end` too when moving an event, or it keeps its old end and the duration changes.",
		);
		expect(props.end?.description).toBe("New end, same format as `start`.");
		expect(props.notify_attendees).toMatchObject({
			type: "string",
			enum: ["all", "externalOnly", "none"],
			description:
				"Who Google emails about the change. Default 'all', which is deliberate: an unwanted notification is noise, but moving or cancelling a meeting other people hold in their own calendars without telling them is a mess the owner has to clean up by hand. Use 'none' only for an event nobody else is on, or a correction made seconds after the original.",
		});
	});

	it("executes calendar_update_event through MCP with byte-for-byte text parity and partial PATCH body", async () => {
		vi.stubEnv("GOOGLE_CLIENT_ID", "cid-test");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret-test");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_WORK", "rt-work-val");

		let patchUrl: URL | undefined;
		let patchMethod: string | undefined;
		let patchBody: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(String(input));
				if (url.href === "https://oauth2.googleapis.com/token") {
					return new Response(JSON.stringify({ access_token: "at-work" }), { status: 200 });
				}
				patchUrl = url;
				patchMethod = init?.method;
				patchBody = init?.body ? JSON.parse(String(init.body)) : undefined;
				return new Response(
					JSON.stringify({
						id: "e1",
						summary: "Moved Standup",
						start: { dateTime: "2026-09-07T11:00:00Z" },
						end: { dateTime: "2026-09-07T11:15:00Z" },
						location: "Zoom",
						recurringEventId: "series_1",
						attendees: [
							{ email: "them@example.com", responseStatus: "accepted" },
							{ email: "me@example.com", responseStatus: "accepted", self: true },
						],
					}),
					{ status: 200 },
				);
			}),
		);

		const { client } = await connectClient();
		const out = await client.callTool({
			name: "calendar_update_event",
			arguments: {
				account: "work",
				event_id: "e1",
				summary: "Moved Standup",
				start: "2026-09-07T11:00:00Z",
				end: "2026-09-07T11:15:00Z",
			},
		});
		await client.close();

		expect(out.isError).toBeFalsy();
		expect(patchMethod).toBe("PATCH");
		expect(patchUrl?.searchParams.get("sendUpdates")).toBe("all");
		expect(patchBody).toEqual({
			summary: "Moved Standup",
			start: { dateTime: "2026-09-07T11:00:00Z" },
			end: { dateTime: "2026-09-07T11:15:00Z" },
		});
		expect(patchBody).not.toHaveProperty("attendees");
		expect(((out.content as any)[0] as any).text).toBe(
			[
				"Updated summary, start, end on 'Moved Standup' [work].",
				"• [e1] 2026-09-07T11:00:00Z to 2026-09-07T11:15:00Z — Moved Standup [work] (at Zoom, 2 attendees)",
				"2 attendees, notified: all.",
				"NOTE: this changed ONE occurrence of recurring series series_1, not the whole series.",
			].join("\n"),
		);
	});
});
