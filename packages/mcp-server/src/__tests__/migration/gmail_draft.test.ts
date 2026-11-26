import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { DRAFT_FIELDS, MESSAGE_FIELDS } from "@ahkms/core";
import { createServer } from "../../server.js";
import { serverRegistry } from "../../actions/serverRegistry.js";
import { readLegacyBaseline } from "../legacyBaseline.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const b64url = (s: string) => Buffer.from(s, "utf-8").toString("base64url");

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

describe("gmail_draft migration (#1543)", () => {
	it("serves gmail_draft from the registry with dev's exact contract and removes it from legacy baseline", async () => {
		const manifest = JSON.parse(
			readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"),
		);
		expect(manifest.actions.gmail_draft?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(serverRegistry().get("gmail_draft")).toBeDefined();
		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("gmail_draft");

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();
		const tool = tools.find((t) => t.name === "gmail_draft")!;
		expect(tool?.description).toBe(
			"Compose a draft in a Gmail mailbox, or update an existing one. Does NOT send: it leaves a real draft that can be read, edited in Gmail, sent by hand, or sent with gmail_send_draft. Pass `reply_to_message_id` to reply in-thread. Full notes: docs/guides/tools/gmail_draft.md",
		);
		expect(tool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
		const props = (tool.inputSchema.properties ?? {}) as Record<
			string,
			{
				type?: string;
				enum?: string[];
				minLength?: number;
				description?: string;
			}
		>;
		expect(Object.keys(props).sort()).toEqual([
			"account",
			"bcc",
			"body",
			"cc",
			"domain",
			"draft_id",
			"reply_to_message_id",
			"subject",
			"to",
		]);
		expect(tool.inputSchema.required).toEqual(["body"]);
		expect(props.account).toMatchObject({
			type: "string",
			enum: ["personal", "work"],
			description:
				"Deprecated, use `domain` ('work' | 'angus'). Which Google account to send AS: personal | work.",
		});
		expect(props.domain).toMatchObject({
			type: "string",
			enum: ["work", "angus"],
			description:
				"Which domain to act in: 'work' (the Work company workspace and account) or 'angus' (the personal one).",
		});
		expect(props.body).toMatchObject({
			type: "string",
			minLength: 1,
			description: "Plain-text body. Sent as UTF-8; no HTML.",
		});
	});

	it("executes gmail_draft through MCP with byte-for-byte text parity and fields masks", async () => {
		vi.stubEnv("GOOGLE_CLIENT_ID", "cid-test");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret-test");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_PERSONAL", "rt-personal-val");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_WORK", "rt-work-val");

		const seenCalls: { url: URL; method: string }[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(String(input));
				if (url.href === "https://oauth2.googleapis.com/token") {
					return new Response(JSON.stringify({ access_token: "at-test" }), { status: 200 });
				}
				const method = init?.method ?? "GET";
				seenCalls.push({ url, method });
				if (url.pathname.endsWith("/messages/m1")) {
					return new Response(
						JSON.stringify({
							id: "m1",
							threadId: "t1",
							payload: {
								headers: [
									{ name: "Message-ID", value: "<orig@mail>" },
									{ name: "Subject", value: "Budget" },
									{ name: "From", value: "her@example.com" },
								],
							},
						}),
						{ status: 200 },
					);
				}
				if (url.pathname.endsWith("/drafts") && method === "POST") {
					return new Response(
						JSON.stringify({ id: "d1", message: { id: "m9", threadId: "t1" } }),
						{ status: 200 },
					);
				}
				return new Response(
					JSON.stringify({
						id: "d1",
						message: {
							id: "m9",
							threadId: "t1",
							payload: {
								mimeType: "text/plain",
								headers: [
									{ name: "To", value: "her@example.com" },
									{ name: "Subject", value: "Re: Budget" },
								],
								body: { data: b64url("sure") },
							},
						},
					}),
					{ status: 200 },
				);
			}),
		);

		const { client } = await connectClient();
		const out = await client.callTool({
			name: "gmail_draft",
			arguments: {
				account: "work",
				body: "sure",
				reply_to_message_id: "m1",
			},
		});
		await client.close();

		expect(out.isError).toBeFalsy();
		expect(seenCalls.some((c) => c.url.pathname.endsWith("/drafts/send"))).toBe(false);
		expect(seenCalls[0]?.url.searchParams.get("fields")).toBe(MESSAGE_FIELDS);
		expect(seenCalls[2]?.url.searchParams.get("fields")).toBe(DRAFT_FIELDS);
		expect(((out.content as any)[0] as any).text).toBe(
			[
				"Created draft d1 in the 'work' mailbox. Nothing has been sent.",
				"",
				"To: her@example.com",
				"Subject: Re: Budget",
				"Thread: t1 (reply)",
				"",
				"sure",
				"",
				"Recipient defaulted to the original sender: her@example.com",
				"",
				"Send it with gmail_send_draft({ account: 'work', draft_id: 'd1' }), or open it in Gmail and send it by hand.",
			].join("\n"),
		);
	});
});
