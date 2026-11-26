import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MESSAGE_FIELDS, THREAD_FIELDS } from "@ahkms/core";
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

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64url");

describe("gmail_read migration (#1515)", () => {
	it("serves gmail_read from the registry with dev's exact contract and removes it from legacy baseline", async () => {
		const manifest = JSON.parse(
			readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"),
		);
		expect(manifest.actions.gmail_read?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(serverRegistry().get("gmail_read")).toBeDefined();
		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("gmail_read");

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();
		const tool = tools.find((t) => t.name === "gmail_read")!;
		expect(tool?.description).toBe(
			"Read one Gmail message, or a whole thread, in full — headers, decoded body text and attachment list. Prefers the plain-text part and keeps link hrefs, so document URLs in transactional mail survive.",
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
				minimum?: number;
				maximum?: number;
				description?: string;
			}
		>;
		expect(Object.keys(props).sort()).toEqual([
			"account",
			"domain",
			"max_chars",
			"max_messages",
			"message_id",
			"thread_id",
		]);
		expect(tool.inputSchema.required ?? []).toEqual([]);
		expect(props.message_id).toMatchObject({
			type: "string",
			description: "Message id to read in full. Exactly one of message_id / thread_id.",
		});
		expect(props.thread_id).toMatchObject({
			type: "string",
			description:
				"Thread id to read in full — returns every message in the thread, oldest first.",
		});
		expect(props.max_chars).toMatchObject({
			type: "integer",
			minimum: 100,
			maximum: 200_000,
			description: "Truncate each message body to this many characters (default 20000).",
		});
		expect(props.max_messages).toMatchObject({
			type: "integer",
			minimum: 1,
			maximum: 200,
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

	it("executes gmail_read through MCP for message_id and thread_id with byte-for-byte text parity and fields masks", async () => {
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
				if (url.pathname.endsWith("/messages/m1")) {
					return new Response(
						JSON.stringify({
							id: "m1",
							threadId: "t1",
							labelIds: ["UNREAD", "INBOX"],
							payload: {
								mimeType: "multipart/mixed",
								headers: [
									{ name: "From", value: "Alice <alice@example.com>" },
									{ name: "To", value: "owner@example.com" },
									{ name: "Date", value: "Mon, 7 Sep 2026 09:00:00 +0000" },
									{ name: "Subject", value: "Notes: Q3 Review" },
								],
								parts: [
									{
										mimeType: "text/plain",
										body: { data: b64("Hello from m1") },
									},
									{
										filename: "notes.pdf",
										mimeType: "application/pdf",
										body: { size: 1234, attachmentId: "att-1" },
									},
								],
							},
						}),
						{ status: 200 },
					);
				}
				if (url.pathname.endsWith("/threads/t1")) {
					return new Response(
						JSON.stringify({
							messages: [
								{
									id: "m1",
									threadId: "t1",
									labelIds: ["INBOX"],
									payload: {
										mimeType: "text/plain",
										headers: [
											{ name: "From", value: "Alice <alice@example.com>" },
											{ name: "To", value: "work@example.com" },
											{ name: "Date", value: "Mon, 7 Sep 2026 09:00:00 +0000" },
											{ name: "Subject", value: "Thread subject" },
										],
										body: { data: b64("First message") },
									},
								},
								{
									id: "m2",
									threadId: "t1",
									labelIds: [],
									payload: {
										mimeType: "text/plain",
										headers: [
											{ name: "From", value: "Bob <bob@example.com>" },
											{ name: "To", value: "Alice <alice@example.com>" },
											{ name: "Date", value: "Mon, 7 Sep 2026 09:15:00 +0000" },
											{ name: "Subject", value: "Re: Thread subject" },
										],
										body: { data: b64("Second message") },
									},
								},
							],
						}),
						{ status: 200 },
					);
				}
				return new Response(JSON.stringify({}), { status: 404 });
			}),
		);

		const { client } = await connectClient();
		const msgOut = await client.callTool({
			name: "gmail_read",
			arguments: { message_id: "m1" },
		});
		const threadOut = await client.callTool({
			name: "gmail_read",
			arguments: { thread_id: "t1", domain: "work" },
		});
		await client.close();

		expect(msgOut.isError).toBeFalsy();
		expect(seenUrls[0]?.searchParams.get("fields")).toBe(MESSAGE_FIELDS);
		expect(((msgOut.content as any)[0] as any).text).toBe(
			[
				"id: m1  thread: t1",
				"From: Alice <alice@example.com>",
				"To: owner@example.com",
				"Date: Mon, 7 Sep 2026 09:00:00 +0000",
				"Subject: Notes: Q3 Review",
				"Labels: UNREAD, INBOX",
				"Attachments: notes.pdf (application/pdf, 1234B, id: att-1)",
				"",
				"Hello from m1",
			].join("\n"),
		);

		expect(threadOut.isError).toBeFalsy();
		expect(seenUrls[1]?.searchParams.get("fields")).toBe(THREAD_FIELDS);
		expect(((threadOut.content as any)[0] as any).text).toBe(
			[
				"id: m1  thread: t1",
				"From: Alice <alice@example.com>",
				"To: work@example.com",
				"Date: Mon, 7 Sep 2026 09:00:00 +0000",
				"Subject: Thread subject",
				"Labels: INBOX",
				"",
				"First message",
				"",
				"---",
				"",
				"id: m2  thread: t1",
				"From: Bob <bob@example.com>",
				"To: Alice <alice@example.com>",
				"Date: Mon, 7 Sep 2026 09:15:00 +0000",
				"Subject: Re: Thread subject",
				"Labels: (none)",
				"",
				"Second message",
			].join("\n"),
		);
	});
});
