import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { LIST_MESSAGES_FIELDS, MESSAGE_FIELDS } from "@ahkms/core";
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

describe("gmail_search migration (#1504)", () => {
	it("serves gmail_search from the registry with dev's exact contract and removes it from legacy baseline", async () => {
		const manifest = JSON.parse(
			readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"),
		);
		expect(manifest.actions.gmail_search?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(serverRegistry().get("gmail_search")).toBeDefined();
		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("gmail_search");

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();
		const tool = tools.find((t) => t.name === "gmail_search")!;
		expect(tool?.description).toBe(
			"Search a Gmail mailbox with Gmail's own query syntax (from:, subject:, newer_than:, label:, is:unread). Returns matching messages with ids, subjects, senders and read/archived state. Use domain='work' for the work.example.com mailbox.",
		);
		expect(tool.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		const props = (tool.inputSchema.properties ?? {}) as Record<
			string,
			{
				type?: string;
				enum?: string[];
				minLength?: number;
				minimum?: number;
				maximum?: number;
				description?: string;
			}
		>;
		expect(Object.keys(props).sort()).toEqual(["account", "cursor", "domain", "max_results", "query"]);
		expect(tool.inputSchema.required).toEqual(["query"]);
		expect(props.query).toMatchObject({
			type: "string",
			minLength: 1,
			description:
				'Gmail search query, in Gmail\'s own syntax — e.g. `from:noreply@example.com subject:"Notes:" newer_than:7d`. Supports from:, to:, subject:, label:, has:, newer_than:, older_than:, is:unread, and OR / -negation.',
		});
		expect(props.max_results).toMatchObject({
			type: "integer",
			minimum: 1,
			maximum: 50,
			description: "Max messages to return (default 10).",
		});
		expect(props.cursor).toMatchObject({
			type: "string",
			minLength: 1,
		});
		expect(props.account).toMatchObject({
			type: "string",
			enum: ["personal", "work"],
			description:
				"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
		});
		expect(props.domain).toMatchObject({
			type: "string",
			enum: ["work", "angus"],
			description:
				"Which domain to act in: 'work' (the Work company workspace and account) or 'angus' (the personal one).",
		});
	});

	it("executes gmail_search through MCP with byte-for-byte text parity and fields masks", async () => {
		vi.stubEnv("GOOGLE_CLIENT_ID", "cid-test");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret-test");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_PERSONAL", "rt-personal-val");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_WORK", "rt-work-val");

		const seenUrls: URL[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = new URL(String(input));
				if (url.href === "https://oauth2.googleapis.com/token") {
					return new Response(JSON.stringify({ access_token: "at-test" }), { status: 200 });
				}
				seenUrls.push(url);
				if (url.pathname.endsWith("/messages")) {
					if (url.searchParams.get("q") === "from:empty") {
						return new Response(JSON.stringify({}), { status: 200 });
					}
					return new Response(
						JSON.stringify({ messages: [{ id: "m1" }, { id: "m2" }] }),
						{ status: 200 },
					);
				}
				if (url.pathname.endsWith("/messages/m1")) {
					return new Response(
						JSON.stringify({
							id: "m1",
							threadId: "t1",
							labelIds: ["UNREAD", "INBOX"],
							payload: {
								headers: [
									{ name: "From", value: "Alice <alice@example.com>" },
									{ name: "Subject", value: "Notes: Q3 Review" },
									{ name: "Date", value: "Mon, 7 Sep 2026 09:00:00 +0000" },
								],
							},
						}),
						{ status: 200 },
					);
				}
				return new Response(
					JSON.stringify({
						id: "m2",
						threadId: "t2",
						labelIds: [],
						payload: {
							headers: [
								{ name: "From", value: "Bob <bob@example.com>" },
								{ name: "Date", value: "Sun, 6 Sep 2026 18:30:00 +0000" },
							],
						},
					}),
					{ status: 200 },
				);
			}),
		);

		const { client } = await connectClient();
		const out = await client.callTool({
			name: "gmail_search",
			arguments: { query: "newer_than:7d" },
		});
		const emptyOut = await client.callTool({
			name: "gmail_search",
			arguments: { domain: "work", query: "from:empty" },
		});
		await client.close();

		expect(out.isError).toBeFalsy();
		expect(seenUrls[0]?.searchParams.get("fields")).toBe(LIST_MESSAGES_FIELDS);
		expect(seenUrls[1]?.searchParams.get("fields")).toBe(MESSAGE_FIELDS);
		expect(((out.content as any)[0] as any).text).toBe(
			[
				"2 message(s) in the 'personal' mailbox:",
				"• [m1 | thread: t1] Notes: Q3 Review — Alice <alice@example.com> (Mon, 7 Sep 2026 09:00:00 +0000, unread, inbox)",
				"• [m2 | thread: t2] (no subject) — Bob <bob@example.com> (Sun, 6 Sep 2026 18:30:00 +0000, read, archived)",
				"",
				"Read one in full with gmail_read (message_id or thread_id).",
			].join("\n"),
		);

		expect(emptyOut.isError).toBeFalsy();
		expect(((emptyOut.content as any)[0] as any).text).toBe(
			"No messages in the 'work' mailbox for query: from:empty",
		);
	});
});
