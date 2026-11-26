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

describe("gmail_modify migration (#1533)", () => {
	it("serves gmail_modify from the registry with dev's exact contract and removes it from legacy baseline", async () => {
		const manifest = JSON.parse(
			readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"),
		);
		expect(manifest.actions.gmail_modify?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(serverRegistry().get("gmail_modify")).toBeDefined();
		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("gmail_modify");

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();
		const tool = tools.find((t) => t.name === "gmail_modify")!;
		expect(tool?.description).toBe(
			"Add or remove labels on a Gmail message or thread, mark it read/unread, and archive it or return it to the inbox. Cannot delete: there is no delete tool. Sending is a separate two-step path, gmail_draft then gmail_send_draft.",
		);
		expect(tool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		const props = (tool.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
		expect(Object.keys(props).sort()).toEqual([
			"account",
			"add_labels",
			"archive",
			"domain",
			"mark_read",
			"message_id",
			"message_ids",
			"remove_labels",
			"thread_id",
			"thread_ids",
		]);
		expect(props.message_id?.description).toBe(
			"Message id to modify. Pass message_id / message_ids or thread_id / thread_ids (do not mix message and thread targets).",
		);
		expect(props.thread_id?.description).toBe(
			"Thread id to modify \u2014 applies the change to every message in it.",
		);
		expect(props.archive?.description).toBe(
			"true archives (removes INBOX); false moves back to the inbox (adds INBOX). Archiving never deletes \u2014 there is no delete tool.",
		);
	});

	it("executes gmail_modify through MCP for message and thread targets with byte-for-byte text parity", async () => {
		vi.stubEnv("GOOGLE_CLIENT_ID", "cid-test");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret-test");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_PERSONAL", "rt-personal-val");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_WORK", "rt-work-val");

		const seenCalls: { url: URL; method: string; body: unknown }[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(String(input));
				if (url.href === "https://oauth2.googleapis.com/token") {
					return new Response(JSON.stringify({ access_token: "at-test" }), { status: 200 });
				}
				seenCalls.push({
					url,
					method: init?.method ?? "GET",
					body: init?.body ? JSON.parse(String(init.body)) : undefined,
				});
				if (url.pathname.endsWith("/threads/t1/modify")) {
					return new Response(
						JSON.stringify({ id: "t1", messages: [{ id: "m1", threadId: "t1", labelIds: [] }] }),
						{ status: 200 },
					);
				}
				return new Response(JSON.stringify({ id: "m1", labelIds: ["Label_1"] }), { status: 200 });
			}),
		);

		const { client } = await connectClient();
		const msgOut = await client.callTool({
			name: "gmail_modify",
			arguments: { message_id: "m1", add_labels: ["Label_1"], mark_read: true },
		});
		const threadOut = await client.callTool({
			name: "gmail_modify",
			arguments: { thread_id: "t1", archive: true, domain: "work" },
		});
		await client.close();

		expect(msgOut.isError).toBeFalsy();
		expect(seenCalls[0]?.url.pathname).toBe("/gmail/v1/users/me/messages/m1/modify");
		expect(seenCalls[0]?.body).toEqual({ addLabelIds: ["Label_1"], removeLabelIds: ["UNREAD"] });
		expect(((msgOut.content as any)[0] as any).text).toBe(
			[
				"Modified message m1 in the 'personal' mailbox.",
				"Added: Label_1",
				"Removed: UNREAD",
				"Labels now: Label_1",
			].join("\n"),
		);

		expect(threadOut.isError).toBeFalsy();
		expect(seenCalls[1]?.url.pathname).toBe("/gmail/v1/users/me/threads/t1/modify");
		expect(seenCalls[1]?.body).toEqual({ addLabelIds: [], removeLabelIds: ["INBOX"] });
		expect(((threadOut.content as any)[0] as any).text).toBe(
			[
				"Modified thread t1 in the 'work' mailbox.",
				"Removed: INBOX",
				"Labels now: (none)",
			].join("\n"),
		);
	});
});
