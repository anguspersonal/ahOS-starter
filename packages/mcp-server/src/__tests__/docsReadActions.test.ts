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

const repoRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../",
);

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function connectClient(registry = serverRegistry()) {
	const server = createServer([], [], registry);
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	const client = new Client(
		{ name: "test", version: "0" },
		{ capabilities: {} },
	);
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	]);
	return { client, server };
}

describe("docs_get and docs_find_text core actions (#1523)", () => {
	it("1. Contract parity: MCP lists docs_get and docs_find_text with exact schema properties, required list, descriptions, and annotations", async () => {
		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();

		const docsGet = tools.find((t) => t.name === "docs_get")!;
		expect(docsGet).toBeDefined();
		expect(docsGet.description).toBe(
			"Read a Google Doc's structural outline and tabs via the Google Docs API. Returns revisionId (required for concurrency lock on edits) and element start/end indexes. Full notes: docs/guides/tools/docs_get.md",
		);
		expect(docsGet.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		const getProps = (docsGet.inputSchema.properties ?? {}) as Record<
			string,
			{ type?: string; enum?: string[] }
		>;
		expect(Object.keys(getProps).sort()).toEqual([
			"account",
			"document_id",
			"domain",
			"field_mask",
			"include_suggestions",
			"max_chars",
			"tab_id",
		]);
		expect([...(docsGet.inputSchema.required ?? [])].sort()).toEqual([
			"document_id",
			"domain",
		]);
		expect(getProps.document_id.type).toBe("string");
		expect(getProps.domain.type).toBe("string");
		expect(getProps.account.type).toBe("string");
		expect(getProps.tab_id.type).toBe("string");
		expect(getProps.field_mask.type).toBe("string");
		expect(getProps.include_suggestions.type).toBe("boolean");
		expect(getProps.max_chars.type).toBe("integer");

		const docsFindText = tools.find((t) => t.name === "docs_find_text")!;
		expect(docsFindText).toBeDefined();
		expect(docsFindText.description).toBe(
			"Find the exact UTF-16 start and end indexes of text matches across tabs and paragraphs in a Google Doc. Full notes: docs/guides/tools/docs_find_text.md",
		);
		expect(docsFindText.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		const findProps = (docsFindText.inputSchema.properties ?? {}) as Record<
			string,
			{ type?: string; enum?: string[] }
		>;
		expect(Object.keys(findProps).sort()).toEqual([
			"account",
			"document_id",
			"domain",
			"match_case",
			"tab_id",
			"text",
		]);
		expect([...(docsFindText.inputSchema.required ?? [])].sort()).toEqual([
			"document_id",
			"domain",
			"text",
		]);
		expect(findProps.document_id.type).toBe("string");
		expect(findProps.domain.type).toBe("string");
		expect(findProps.account.type).toBe("string");
		expect(findProps.text.type).toBe("string");
		expect(findProps.match_case.type).toBe("boolean");
		expect(findProps.tab_id.type).toBe("string");
	});

	it("2. Exposure: both actions are in packages/core/action-manifest.json with default exposure", () => {
		const manifest = JSON.parse(
			readFileSync(
				resolve(repoRoot, "packages/core/action-manifest.json"),
				"utf-8",
			),
		);
		for (const id of ["docs_get", "docs_find_text"]) {
			expect(manifest.actions[id]?.expose).toEqual({
				mcp: true,
				http: true,
				ui_agent: true,
				worker: true,
				cli: false,
				a2a: false,
			});
		}
	});

	it("3. Registration path: both are in buildRegistry({}) and absent from legacy-tools-baseline.txt; unwired adapter throws AdapterUnavailableError", async () => {
		const unwired = buildRegistry({});
		const ids = unwired.list().map((a) => a.id);
		expect(ids).toContain("docs_get");
		expect(ids).toContain("docs_find_text");

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("docs_get");
		expect(baseline).not.toContain("docs_find_text");

		await expect(
			executeAction(unwired.get("docs_get")!, {
				document_id: "doc-1",
				domain: "angus",
			}),
		).rejects.toThrow(AdapterUnavailableError);
		await expect(
			executeAction(unwired.get("docs_find_text")!, {
				document_id: "doc-1",
				domain: "angus",
				text: "hello",
			}),
		).rejects.toThrow(AdapterUnavailableError);
	});

	it("4. docs_get with an unknown tab_id throws Tab '<id>' not found in document '<title>'. Available tabs: ...", async () => {
		const reg = buildRegistry({
			docs: {
				getDocument: vi.fn().mockResolvedValue({
					documentId: "doc-123",
					title: "Tabbed Doc",
					revisionId: "rev-1",
					tabs: [
						{ tabProperties: { tabId: "t.1", title: "Summary" } },
						{ tabProperties: { tabId: "t.2", title: "Details" } },
					],
				}),
			},
		});

		const handler = toMcpTool(reg.get("docs_get")!).handler;
		await expect(
			handler({
				document_id: "doc-123",
				domain: "work",
				tab_id: "non-existent-tab",
			}),
		).rejects.toThrow(
			/Tab 'non-existent-tab' not found in document 'Tabbed Doc'\. Available tabs: 't\.1' \(Summary\), 't\.2' \(Details\)\./,
		);
	});

	it("5. Neither action names a domain implicitly: missing domain and account is refused with requireGoogleAccount's message", async () => {
		const reg = buildRegistry({
			docs: {
				getDocument: vi.fn(),
			},
		});

		const expectedMsg =
			"`domain` is required to send — 'work' (the work.example.com Workspace account) or 'angus' (the personal one). There is no default: sending as the wrong identity cannot be taken back.";

		await expect(
			toMcpTool(reg.get("docs_get")!).handler({ document_id: "doc-123" }),
		).rejects.toThrow(expectedMsg);

		await expect(
			toMcpTool(reg.get("docs_find_text")!).handler({
				document_id: "doc-123",
				text: "query",
			}),
		).rejects.toThrow(expectedMsg);
	});
});
