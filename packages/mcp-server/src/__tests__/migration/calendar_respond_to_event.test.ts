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

describe("calendar_respond_to_event migration (#1584)", () => {
	it("serves calendar_respond_to_event from the registry with dev's exact contract and removes it from legacy baseline", async () => {
		const manifest = JSON.parse(readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"));
		expect(manifest.actions.calendar_respond_to_event?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(serverRegistry().get("calendar_respond_to_event")).toBeDefined();
		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("calendar_respond_to_event");

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();
		const tool = tools.find((t) => t.name === "calendar_respond_to_event")!;
		expect(tool?.description).toBe(
			"RSVP accepted, declined or tentative. `account` is required. Reads the attendee list and writes " +
				"it back with only your own entry changed, because Calendar treats that list as one value and a " +
				"partial write would remove everyone else. Fails loudly if you are not an attendee. Full notes: " +
				"docs/guides/tools/calendar_respond_to_event.md",
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
			"domain",
			"etag",
			"event_id",
			"notify_attendees",
			"response",
		]);
		expect(tool.inputSchema.required).toEqual(["event_id", "response"]);
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
		expect(props.response).toMatchObject({
			type: "string",
			enum: ["accepted", "declined", "tentative"],
			description: "Your RSVP. Replaces whatever your current response is.",
		});
		expect(props.notify_attendees).toMatchObject({
			type: "string",
			enum: ["all", "externalOnly", "none"],
			description:
				"Who Google emails about the change. Default 'all', which is deliberate: an unwanted notification is noise, but moving or cancelling a meeting other people hold in their own calendars without telling them is a mess the owner has to clean up by hand. Use 'none' only for an event nobody else is on, or a correction made seconds after the original.",
		});
	});

	it("executes calendar_respond_to_event through MCP with EVENT_FIELDS read mask, full attendee list write-back, and byte-for-byte text parity", async () => {
		vi.stubEnv("GOOGLE_CLIENT_ID", "cid-test");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret-test");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_WORK", "rt-work-val");

		const attendees = [
			{ email: "me@work.example.com", self: true, responseStatus: "needsAction" },
			{ email: "a@example.com", responseStatus: "accepted" },
			{ email: "b@example.com", responseStatus: "declined" },
		];
		let getUrl: URL | undefined;
		let patchUrl: URL | undefined;
		let patchBody: any;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(String(input));
				if (url.href === "https://oauth2.googleapis.com/token") {
					return new Response(JSON.stringify({ access_token: "at-work" }), { status: 200 });
				}
				const method = init?.method ?? "GET";
				if (method === "GET") {
					getUrl = url;
					return new Response(
						JSON.stringify({
							id: "e1",
							summary: "Standup",
							start: { dateTime: "2026-09-07T09:30:00Z" },
							end: { dateTime: "2026-09-07T09:45:00Z" },
							location: "Zoom",
							organizer: { email: "them@example.com" },
							attendees,
						}),
						{ status: 200 },
					);
				}
				patchUrl = url;
				patchBody = init?.body ? JSON.parse(String(init.body)) : undefined;
				return new Response(
					JSON.stringify({
						id: "e1",
						summary: "Standup",
						start: { dateTime: "2026-09-07T09:30:00Z" },
						end: { dateTime: "2026-09-07T09:45:00Z" },
						location: "Zoom",
						organizer: { email: "them@example.com" },
						attendees: attendees.map((a) =>
							a.self ? { ...a, responseStatus: "declined" } : a,
						),
					}),
					{ status: 200 },
				);
			}),
		);

		const { client } = await connectClient();
		const out = await client.callTool({
			name: "calendar_respond_to_event",
			arguments: { account: "work", event_id: "e1", response: "declined" },
		});
		await client.close();

		expect(out.isError).toBeFalsy();
		expect(getUrl?.searchParams.get("fields")).toBe(EVENT_FIELDS);
		expect(patchUrl?.searchParams.get("sendUpdates")).toBe("all");
		expect(patchBody?.attendees).toEqual([
			{ email: "me@work.example.com", self: true, responseStatus: "declined" },
			{ email: "a@example.com", responseStatus: "accepted" },
			{ email: "b@example.com", responseStatus: "declined" },
		]);
		expect(((out.content as any)[0] as any).text).toBe(
			[
				"RSVP set to 'declined' on 'Standup' [work].",
				"• [e1] 2026-09-07T09:30:00Z to 2026-09-07T09:45:00Z — Standup [work] (at Zoom, declined, 3 attendees)",
				"Organiser: them@example.com",
				"3 attendee(s) on the event, still all present.",
			].join("\n"),
		);
	});

	it("returns isError when caller is not on the event's attendee list", async () => {
		vi.stubEnv("GOOGLE_CLIENT_ID", "cid-test");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret-test");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN", "rt-personal-val");

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = new URL(String(input));
				if (url.href === "https://oauth2.googleapis.com/token") {
					return new Response(JSON.stringify({ access_token: "at-personal" }), { status: 200 });
				}
				return new Response(
					JSON.stringify({
						id: "e1",
						summary: "Standup",
						start: { dateTime: "2026-09-07T09:30:00Z" },
						end: { dateTime: "2026-09-07T09:45:00Z" },
						organizer: { email: "me@example.com" },
						attendees: [{ email: "someone@example.com", responseStatus: "needsAction" }],
					}),
					{ status: 200 },
				);
			}),
		);

		const { client } = await connectClient();
		const out = await client.callTool({
			name: "calendar_respond_to_event",
			arguments: { domain: "angus", event_id: "e1", response: "declined" },
		});
		await client.close();

		expect(out.isError).toBe(true);
		expect(((out.content as any)[0] as any).text).toMatch(/not on its attendee list/i);
	});
});
