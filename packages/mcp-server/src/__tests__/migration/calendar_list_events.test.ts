import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { LIST_EVENTS_FIELDS } from "@ahkms/core";
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

describe("calendar_list_events migration (#1581)", () => {
	it("serves calendar_list_events from the registry with dev's exact contract and removes it from legacy baseline", async () => {
		const manifest = JSON.parse(readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"));
		expect(manifest.actions.calendar_list_events?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(serverRegistry().get("calendar_list_events")).toBeDefined();
		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("calendar_list_events");

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();
		const tool = tools.find((t) => t.name === "calendar_list_events")!;
		expect(tool?.description).toBe(
			"Read Google Calendar events in a time window, recurring series expanded into instances. Omit " +
				"`account` to read the personal and work calendars together, which is what 'what is on today' " +
				"usually wants; each event names its calendar. If one calendar fails the other still returns, " +
				"marked incomplete. Full notes: docs/guides/tools/calendar_list_events.md",
		);
		expect(tool.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		const props = (tool.inputSchema.properties ?? {}) as Record<
			string,
			{ type?: string; enum?: string[]; minimum?: number; maximum?: number; description?: string }
		>;
		expect(Object.keys(props).sort()).toEqual([
			"account",
			"calendar_id",
			"domain",
			"max_results",
			"query",
			"time_max",
			"time_min",
		]);
		expect(tool.inputSchema.required ?? []).toEqual([]);
		expect(props.account).toMatchObject({
			type: "string",
			enum: ["personal", "work"],
			description:
				'Deprecated, use `domain`. Which calendar to read: personal | work. OMIT BOTH to read both, which is the default and usually what you want: "what is on today" spans both calendars, and the commonest bug in this area is answering it from one. Every returned event names the account it came from.',
		});
		expect(props.domain).toMatchObject({
			type: "string",
			enum: ["work", "angus"],
			description:
				"Which domain to act in: 'work' (the Work company workspace and account) or 'angus' (the personal one).",
		});
		expect(props.calendar_id?.description).toBe(
			"Calendar id, default 'primary'. 'primary' resolves per-account to that account's own default calendar, so it means different calendars for personal and work, which is the intended behaviour.",
		);
		expect(props.time_min?.description).toBe(
			"RFC3339 lower bound, e.g. '2026-09-06T00:00:00Z'. Defaults to now.",
		);
		expect(props.time_max?.description).toBe(
			"RFC3339 upper bound. Defaults to seven days after time_min.",
		);
		expect(props.query?.description).toBe(
			"Free-text search over summary, description, location and attendees.",
		);
		expect(props.max_results).toMatchObject({
			type: "integer",
			minimum: 1,
			maximum: 100,
			description: "Max events PER ACCOUNT (default 25).",
		});
	});

	it("executes calendar_list_events through MCP across both calendars with LIST_EVENTS_FIELDS mask and byte-for-byte text parity", async () => {
		vi.stubEnv("GOOGLE_CLIENT_ID", "cid-test");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret-test");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_PERSONAL", "rt-personal-val");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_WORK", "rt-work-val");

		const eventUrls: URL[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(String(input));
				if (url.href === "https://oauth2.googleapis.com/token") {
					const body = String(init?.body ?? "");
					const token = body.includes("rt-work-val") ? "at-work" : "at-personal";
					return new Response(JSON.stringify({ access_token: token }), { status: 200 });
				}
				eventUrls.push(url);
				const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
				const items =
					auth === "Bearer at-personal"
						? [
								{
									id: "late",
									summary: "Late",
									start: { dateTime: "2026-09-07T17:00:00Z" },
									end: { dateTime: "2026-09-07T18:00:00Z" },
								},
							]
						: [
								{
									id: "early",
									summary: "Early",
									start: { dateTime: "2026-09-07T08:00:00Z" },
									end: { dateTime: "2026-09-07T09:00:00Z" },
									location: "Room 1",
								},
							];
				return new Response(JSON.stringify({ items }), { status: 200 });
			}),
		);

		const { client } = await connectClient();
		const out = await client.callTool({
			name: "calendar_list_events",
			arguments: {
				time_min: "2026-09-07T00:00:00.000Z",
				time_max: "2026-09-14T00:00:00.000Z",
			},
		});
		await client.close();

		expect(out.isError).toBeFalsy();
		expect(eventUrls).toHaveLength(2);
		for (const u of eventUrls) {
			expect(u.searchParams.get("fields")).toBe(LIST_EVENTS_FIELDS);
			expect(u.searchParams.get("singleEvents")).toBe("true");
			expect(u.searchParams.get("orderBy")).toBe("startTime");
			expect(u.searchParams.get("maxResults")).toBe("25");
		}
		expect(((out.content as any)[0] as any).text).toBe(
			[
				"2 event(s) in both calendars ('primary') from 2026-09-07T00:00:00.000Z to 2026-09-14T00:00:00.000Z:",
				"",
				"• [early] 2026-09-07T08:00:00Z to 2026-09-07T09:00:00Z — Early [work] (at Room 1)",
				"• [late] 2026-09-07T17:00:00Z to 2026-09-07T18:00:00Z — Late [personal]",
				"",
				"Both calendars read. Each event names its account in brackets.",
			].join("\n"),
		);
	});

	it("round-trips the ETag over MCP: the text of calendar_list_events carries a value calendar_update_event sends as If-Match (#2293)", async () => {
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
				return new Response(JSON.stringify({ items: [event] }), { status: 200 });
			}),
		);

		const { client } = await connectClient();
		const read = await client.callTool({
			name: "calendar_list_events",
			arguments: {
				domain: "work",
				time_min: "2026-09-07T00:00:00.000Z",
				time_max: "2026-09-14T00:00:00.000Z",
			},
		});
		expect(read.isError).toBeFalsy();
		const text = ((read.content as any)[0] as any).text as string;
		const seen = text.match(/^• \[e1\] .* etag=(\S+)$/m)?.[1];
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
