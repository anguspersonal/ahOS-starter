import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
	AdapterUnavailableError,
	buildRegistry,
	executeAction,
} from "@ahkms/core/actions";
import { toMcpTool } from "../actions/adapters/mcp.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import { createServer } from "../server.js";
import { readLegacyBaseline } from "./legacyBaseline.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function connectClient(registry = serverRegistry()) {
	const server = createServer([], [], registry);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return { client, server };
}

describe("docs_comments core action (#1530)", () => {
	it("1. Contract parity: MCP lists docs_comments with exact schema properties, required list, description, and annotations", async () => {
		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();

		const tool = tools.find((t) => t.name === "docs_comments")!;
		expect(tool).toBeDefined();
		expect(tool.description).toBe(
			"List comments and replies, or create a comment anchored to quoted text on a Google Doc. Full notes: docs/guides/tools/docs_comments.md",
		);
		expect(tool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
		const props = (tool.inputSchema.properties ?? {}) as Record<
			string,
			{ type?: string; enum?: string[] }
		>;
		expect(Object.keys(props).sort()).toEqual([
			"account",
			"action",
			"comment_id",
			"content",
			"cursor",
			"document_id",
			"domain",
			"include_resolved",
			"page_size",
			"quoted_text",
		]);
		expect([...(tool.inputSchema.required ?? [])].sort()).toEqual([
			"action",
			"document_id",
			"domain",
		]);
		expect(props.document_id.type).toBe("string");
		expect(props.domain.type).toBe("string");
		expect(props.account.type).toBe("string");
		expect(props.action.type).toBe("string");
		expect(props.action.enum).toEqual(["list", "create", "reply"]);
		expect(props.content.type).toBe("string");
		expect(props.quoted_text.type).toBe("string");
		expect(props.comment_id.type).toBe("string");
		expect(props.include_resolved.type).toBe("boolean");
		expect(props.page_size.type).toBe("integer");
		expect(props.cursor.type).toBe("string");
	});

	it("2. Exposure: docs_comments is in packages/core/action-manifest.json with default exposure", () => {
		const manifest = JSON.parse(
			readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"),
		);
		expect(manifest.actions.docs_comments?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
	});

	it("3. Registration path: docs_comments is in buildRegistry({}) and absent from legacy-tools-baseline.txt; unwired adapter throws AdapterUnavailableError", async () => {
		const unwired = buildRegistry({});
		expect(unwired.list().map((a) => a.id)).toContain("docs_comments");

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("docs_comments");

		await expect(
			executeAction(unwired.get("docs_comments")!, {
				document_id: "doc-1",
				domain: "angus",
				action: "list",
			}),
		).rejects.toThrow(AdapterUnavailableError);
	});

	it("4. action keeps enum list | create | reply and reply without comment_id is refused with the legacy message", async () => {
		const reg = buildRegistry({
			drive: {
				listComments: vi.fn(),
				createComment: vi.fn(),
				createReply: vi.fn(),
			} as any,
		});
		const handler = toMcpTool(reg.get("docs_comments")!).handler;
		await expect(
			handler({
				document_id: "doc-123",
				domain: "angus",
				action: "reply",
				content: "Replying",
			}),
		).rejects.toThrow(
			"comment_id is required when action='reply'. Pass the ID of the comment to reply to.",
		);
	});
});
