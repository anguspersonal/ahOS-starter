import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { LIST_LABELS_FIELDS } from "@ahkms/core";
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

describe("gmail_labels migration (#1525)", () => {
	it("serves gmail_labels from the registry with dev's exact contract and removes it from legacy baseline", async () => {
		const manifest = JSON.parse(
			readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"),
		);
		expect(manifest.actions.gmail_labels?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(serverRegistry().get("gmail_labels")).toBeDefined();
		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("gmail_labels");

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();
		const tool = tools.find((t) => t.name === "gmail_labels")!;
		expect(tool?.description).toBe(
			"List a mailbox's Gmail labels with their ids, or idempotently create one by name (action='ensure'). Label ids, not names, are what gmail_modify takes.",
		);
		expect(tool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		const props = (tool.inputSchema.properties ?? {}) as Record<
			string,
			{
				type?: string;
				enum?: string[];
				description?: string;
			}
		>;
		expect(Object.keys(props).sort()).toEqual(["account", "action", "domain", "name"]);
		expect(tool.inputSchema.required).toEqual(["action"]);
		expect(props.action).toMatchObject({
			type: "string",
			enum: ["list", "ensure"],
			description:
				"'list' returns every label with its id. 'ensure' creates `name` if missing and returns it either way (idempotent, safe to re-run).",
		});
		expect(props.name).toMatchObject({
			type: "string",
			description: "Label name, required for action='ensure'. e.g. 'meeting_note'.",
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

	it("executes gmail_labels list and ensure through MCP with byte-for-byte text parity and fields mask", async () => {
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
				if (method === "POST" && url.pathname.endsWith("/labels")) {
					const body = JSON.parse(String(init?.body ?? "{}"));
					return new Response(
						JSON.stringify({ id: "Label_10", name: body.name, type: "user" }),
						{ status: 200 },
					);
				}
				return new Response(
					JSON.stringify({
						labels: [
							{ id: "INBOX", name: "INBOX", type: "system" },
							{ id: "Label_9", name: "Meeting_Note", type: "user" },
						],
					}),
					{ status: 200 },
				);
			}),
		);

		const { client } = await connectClient();
		const listOut = await client.callTool({
			name: "gmail_labels",
			arguments: { action: "list" },
		});
		const existingOut = await client.callTool({
			name: "gmail_labels",
			arguments: { action: "ensure", name: "meeting_note", domain: "work" },
		});
		const createdOut = await client.callTool({
			name: "gmail_labels",
			arguments: { action: "ensure", name: "new_label", account: "work" },
		});
		await client.close();

		expect(listOut.isError).toBeFalsy();
		expect(seenCalls[0]?.url.searchParams.get("fields")).toBe(LIST_LABELS_FIELDS);
		expect(((listOut.content as any)[0] as any).text).toBe(
			[
				"2 label(s) in the 'personal' mailbox:",
				"• [INBOX] INBOX (system)",
				"• [Label_9] Meeting_Note",
			].join("\n"),
		);

		expect(existingOut.isError).toBeFalsy();
		expect(((existingOut.content as any)[0] as any).text).toBe(
			"Already existed: label 'Meeting_Note' (id Label_9) in the 'work' mailbox.",
		);

		expect(createdOut.isError).toBeFalsy();
		expect(((createdOut.content as any)[0] as any).text).toBe(
			"Created: label 'new_label' (id Label_10) in the 'work' mailbox.",
		);
	});
});
