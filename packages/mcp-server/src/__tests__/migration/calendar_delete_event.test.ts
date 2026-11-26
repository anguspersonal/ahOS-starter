import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	EVENT_FIELDS,
	setActionApprovalStore,
	type ActionApprovalLifecycleStore,
	type ApprovalRequest,
} from "@ahkms/core";
import { executeApproved } from "@ahkms/core/actions";

vi.mock("../../google/oauth.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../google/oauth.js")>();
	const { getCredential } = await import("../../credentials.js");
	const { GOOGLE_ACCOUNT_PROVIDER, DEFAULT_GOOGLE_ACCOUNT } = await import(
		"../../google/accounts.js"
	);
	return {
		...actual,
		getGoogleAccessToken: vi.fn(
			async (account: "personal" | "work" = DEFAULT_GOOGLE_ACCOUNT) => {
				const rt = await getCredential(GOOGLE_ACCOUNT_PROVIDER[account]);
				return `at-${rt}`;
			},
		),
	};
});

import { createServer } from "../../server.js";
import { serverRegistry } from "../../actions/serverRegistry.js";
import { inboxActionResolver } from "../../actions/approvals.js";
import { LEGACY_GATES } from "../../actions/legacyGates.js";
import { resetOwnerAddressesForTests } from "../../google/gmail.js";
import { readLegacyBaseline } from "../legacyBaseline.js";

const require = createRequire(import.meta.url);
const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000000";

afterEach(() => {
	setActionApprovalStore(undefined);
	resetOwnerAddressesForTests();
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

describe("calendar_delete_event migration (#1585)", () => {
	it("preserves dev's exact MCP listTools() contract (description, annotations, inputSchema)", async () => {
		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();

		const tool = tools.find((t) => t.name === "calendar_delete_event")!;
		expect(tool?.description).toBe(
			"Cancel a Google Calendar event. Irreversible. `account` is required. Reads the event first so " +
				"bad ids fail safely and the reply names what was cancelled; attendees are emailed by default. " +
				"Parks for the owner's approval when the event has guests other than the owner. Full notes: " +
				"docs/guides/tools/calendar_delete_event.md",
		);
		expect(tool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		});
		const props = (tool.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(props).sort()).toEqual([
			"account",
			"calendar_id",
			"domain",
			"etag",
			"event_id",
			"notify_attendees",
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
				"Event id, from calendar_list_events. For a recurring series this is ONE OCCURRENCE and only that occurrence is deleted; to cancel a whole series, delete the id shown as its recurring series id.",
		});
		expect(props.notify_attendees).toMatchObject({
			type: "string",
			enum: ["all", "externalOnly", "none"],
			description:
				"Who Google emails about the change. Default 'all', which is deliberate: an unwanted notification is noise, but moving or cancelling a meeting other people hold in their own calendars without telling them is a mess the owner has to clean up by hand. Use 'none' only for an event nobody else is on, or a correction made seconds after the original.",
		});
	});

	it("serves calendar_delete_event from the registry and removes it from legacy baseline and LEGACY_GATES", () => {
		const manifest = require("@ahkms/core/action-manifest.json");
		expect(manifest.actions.calendar_delete_event?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(serverRegistry().get("calendar_delete_event")).toBeDefined();
		expect(typeof serverRegistry().get("calendar_delete_event")?.needsApproval).toBe("function");
		expect("calendar_delete_event" in LEGACY_GATES).toBe(false);

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("calendar_delete_event");
	});

	it("deletes owner-only events with EVENT_FIELDS read mask and byte-for-byte text parity, and parks external guests until approved", async () => {
		vi.stubEnv("GOOGLE_CLIENT_ID", "cid-test");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret-test");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_PERSONAL", "rt-personal-val");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_WORK", "rt-work-val");

		const parked: ApprovalRequest[] = [];
		const lifecycleStore: ActionApprovalLifecycleStore = {
			park: vi.fn(async (req: ApprovalRequest) => {
				parked.push(req);
				return { decisionId: `dec-${parked.length}` };
			}),
			claim: vi.fn(async (decisionId: string) => {
				const req = parked[Number(decisionId.replace("dec-", "")) - 1];
				return req
					? {
							decisionId,
							actionId: req.actionId,
							input: req.input,
							inputSha256: req.inputSha256,
							caller: req.caller,
							userId: req.userId ?? DEFAULT_USER_ID,
						}
					: null;
			}),
			finish: vi.fn(async () => {}),
			reject: vi.fn(async () => true),
		};
		setActionApprovalStore(lifecycleStore);

		const seenCalls: { url: URL; method: string }[] = [];
		let deleteStatus = 204;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(String(input));
				if (url.href === "https://oauth2.googleapis.com/token") {
					const rt = new URLSearchParams(String(init?.body ?? "")).get("refresh_token");
					return new Response(JSON.stringify({ access_token: `at-${rt}` }), { status: 200 });
				}
				const method = init?.method ?? "GET";
				const auth = new Headers(init?.headers).get("Authorization") ?? "";
				seenCalls.push({ url, method });
				if (url.pathname.endsWith("/profile")) {
					const emailAddress = auth.includes("rt-work-val")
						? "owner@work.example.com"
						: "owner@example.com";
					return new Response(JSON.stringify({ emailAddress, messagesTotal: 10 }), { status: 200 });
				}
				if (method === "DELETE") {
					return new Response(null, { status: deleteStatus });
				}
				if (url.pathname.endsWith("/events/e-ext")) {
					return new Response(
						JSON.stringify({
							id: "e-ext",
							summary: "Client sync",
							start: { dateTime: "2026-09-07T09:30:00Z" },
							end: { dateTime: "2026-09-07T09:45:00Z" },
							attendees: [
								{ email: "owner@example.com", responseStatus: "accepted", self: true },
								{ email: "guest@example.com", responseStatus: "accepted", self: false },
							],
						}),
						{ status: 200 },
					);
				}
				return new Response(
					JSON.stringify({
						id: "e1",
						summary: "Standup",
						start: { dateTime: "2026-09-07T09:30:00Z" },
						end: { dateTime: "2026-09-07T09:45:00Z" },
						recurringEventId: "series_1",
						attendees: [
							{ email: "owner@work.example.com", responseStatus: "accepted", self: true },
							{ email: "owner@example.com", responseStatus: "accepted", self: false },
						],
					}),
					{ status: 200 },
				);
			}),
		);

		const { client } = await connectClient();
		const selfOut = await client.callTool({
			name: "calendar_delete_event",
			arguments: { account: "work", event_id: "e1" },
		});
		expect(selfOut.isError).toBeFalsy();
		expect(parked).toHaveLength(0);
		expect(
			seenCalls.some(
				(c) =>
					c.method === "GET" &&
					c.url.pathname === "/calendar/v3/calendars/primary/events/e1" &&
					c.url.searchParams.get("fields") === EVENT_FIELDS,
			),
		).toBe(true);
		expect(
			seenCalls.some(
				(c) =>
					c.method === "DELETE" &&
					c.url.pathname === "/calendar/v3/calendars/primary/events/e1" &&
					c.url.searchParams.get("sendUpdates") === "all",
			),
		).toBe(true);
		expect(((selfOut.content as any)[0] as any).text).toBe(
			[
				"Deleted 'Standup' [work], which was 2026-09-07T09:30:00Z to 2026-09-07T09:45:00Z.",
				"2 attendees, notified: all.",
				"NOTE: this deleted ONE occurrence of recurring series series_1. The rest of the series still exists; delete 'series_1' to cancel all of it.",
			].join("\n"),
		);

		deleteStatus = 410;
		const goneOut = await client.callTool({
			name: "calendar_delete_event",
			arguments: { account: "work", event_id: "e1" },
		});
		expect(((goneOut.content as any)[0] as any).text).toBe(
			"'Standup' was already deleted; nothing to do.",
		);

		deleteStatus = 204;
		seenCalls.length = 0;
		const extOut = await client.callTool({
			name: "calendar_delete_event",
			arguments: { account: "personal", event_id: "e-ext" },
		});
		await client.close();

		expect(extOut.isError).toBeUndefined();
		expect(JSON.parse(((extOut.content as any)[0] as any).text.split("\n")[0])).toEqual({
			status: "pending_approval",
			decision_id: "dec-1",
			action_id: "calendar_delete_event",
		});
		expect(seenCalls.some((c) => c.method === "DELETE")).toBe(false);

		const approved = await executeApproved("dec-1", {
			store: lifecycleStore,
			resolve: inboxActionResolver,
			approvedBy: { userId: DEFAULT_USER_ID, via: "web_inbox" },
		});
		expect(approved.status).toBe("executed");
		expect(seenCalls.some((c) => c.method === "DELETE")).toBe(true);
	});
});
