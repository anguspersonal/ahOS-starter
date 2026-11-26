import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
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

describe("drive_read_file migration (#1590)", () => {
	it("serves drive_read_file from the registry with dev's exact contract and deletes tools/drive/read.ts", async () => {
		const manifest = JSON.parse(readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"));
		expect(manifest.actions.drive_read_file?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(serverRegistry().get("drive_read_file")).toBeDefined();

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("drive_read_file");
		expect(existsSync(resolve(repoRoot, "packages/mcp-server/src/tools/drive/read.ts"))).toBe(false);

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();

		const tool = tools.find((t) => t.name === "drive_read_file")!;
		expect(tool?.description).toBe(
			"Read a Drive file's content inline as text. Google Docs and Sheets are read as Markdown with every tab (use `sheets_read` to list tabs or read one range of a large Sheet); binary files should use ingest_drive instead.",
		);
		expect(tool.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		const props = (tool.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(props).sort()).toEqual(["account", "domain", "file_id", "max_chars"]);
		expect(tool.inputSchema.required).toEqual(["file_id"]);
		expect(props.file_id).toMatchObject({
			type: "string",
			minLength: 1,
			description: "Drive file id to read.",
		});
		expect(props.max_chars).toMatchObject({
			type: "integer",
			minimum: 100,
			maximum: 200000,
			description: "Truncate returned text to this many characters (default 50000).",
		});
	});

	it("executes drive_read_file through MCP across 2-tab Docs, 2-sheet Spreadsheets, Slides/PDF refusals, and max_chars truncation", async () => {
		vi.stubEnv("GOOGLE_CLIENT_ID", "cid-test");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret-test");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_PERSONAL", "rt-personal-val");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_WORK", "rt-work-val");

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
				if (url.href === "https://oauth2.googleapis.com/token") {
					return new Response(JSON.stringify({ access_token: "at-tok", expires_in: 3600 }), { status: 200 });
				}
				if (url.pathname === "/drive/v3/files/doc-1") {
					return new Response(
						JSON.stringify({
							id: "doc-1",
							name: "Board Memo",
							mimeType: "application/vnd.google-apps.document",
						}),
						{ status: 200 },
					);
				}
				if (url.hostname === "docs.googleapis.com") {
					return new Response(
						JSON.stringify({
							documentId: "doc-1",
							title: "Board Memo",
							tabs: [
								{
									tabProperties: { tabId: "t1", title: "Summary" },
									documentTab: {
										body: { content: [{ paragraph: { elements: [{ textRun: { content: "Summary line\n" } }] } }] },
									},
								},
								{
									tabProperties: { tabId: "t2", title: "Appendix" },
									documentTab: {
										body: { content: [{ paragraph: { elements: [{ textRun: { content: "Appendix line\n" } }] } }] },
									},
								},
							],
						}),
						{ status: 200 },
					);
				}
				if (url.pathname === "/drive/v3/files/sheet-1") {
					return new Response(
						JSON.stringify({
							id: "sheet-1",
							name: "Budget",
							mimeType: "application/vnd.google-apps.spreadsheet",
						}),
						{ status: 200 },
					);
				}
				if (url.hostname === "sheets.googleapis.com" && url.pathname.endsWith("/values:batchGet")) {
					return new Response(
						JSON.stringify({
							spreadsheetId: "sheet-1",
							valueRanges: [
								{ range: "'Q1'!A1:B1", values: [["Dept", "Spend"]] },
								{ range: "'Q2'!A1:B1", values: [["Dept", "Forecast"]] },
							],
						}),
						{ status: 200 },
					);
				}
				if (url.hostname === "sheets.googleapis.com") {
					return new Response(
						JSON.stringify({
							spreadsheetId: "sheet-1",
							properties: { title: "Budget" },
							sheets: [
								{ properties: { sheetId: 0, title: "Q1", index: 0, hidden: false, sheetType: "GRID" } },
								{ properties: { sheetId: 1, title: "Q2", index: 1, hidden: false, sheetType: "GRID" } },
							],
						}),
						{ status: 200 },
					);
				}
				if (url.pathname === "/drive/v3/files/slides-1") {
					return new Response(
						JSON.stringify({
							id: "slides-1",
							name: "Roadmap Deck",
							mimeType: "application/vnd.google-apps.presentation",
						}),
						{ status: 200 },
					);
				}
				if (url.pathname === "/drive/v3/files/pdf-1") {
					return new Response(
						JSON.stringify({
							id: "pdf-1",
							name: "Invoice.pdf",
							mimeType: "application/pdf",
						}),
						{ status: 200 },
					);
				}
				if (url.pathname === "/drive/v3/files/txt-1" && url.searchParams.get("alt") === "media") {
					return new Response("x".repeat(250), { status: 200 });
				}
				if (url.pathname === "/drive/v3/files/txt-1") {
					return new Response(
						JSON.stringify({
							id: "txt-1",
							name: "Long.txt",
							mimeType: "text/plain",
						}),
						{ status: 200 },
					);
				}
				throw new Error(`Unexpected URL: ${url.toString()}`);
			}),
		);

		const { client } = await connectClient();
		const docRes = await client.callTool({ name: "drive_read_file", arguments: { file_id: "doc-1" } });
		const sheetRes = await client.callTool({
			name: "drive_read_file",
			arguments: { file_id: "sheet-1", domain: "work" },
		});
		const slidesRes = await client.callTool({ name: "drive_read_file", arguments: { file_id: "slides-1" } });
		const pdfRes = await client.callTool({ name: "drive_read_file", arguments: { file_id: "pdf-1" } });
		const truncRes = await client.callTool({
			name: "drive_read_file",
			arguments: { file_id: "txt-1", max_chars: 100 },
		});
		await client.close();

		expect(((docRes.content as any)[0] as any).text).toBe(
			"Board Memo (application/vnd.google-apps.document):\n\n## Summary\n\nSummary line\n\n## Appendix\n\nAppendix line",
		);
		expect(((sheetRes.content as any)[0] as any).text).toBe(
			"Budget (application/vnd.google-apps.spreadsheet):\n\n## Q1\n\n```csv\nDept,Spend\n```\n\n## Q2\n\n```csv\nDept,Forecast\n```",
		);
		expect(((slidesRes.content as any)[0] as any).text).toBe(
			`"Roadmap Deck" is a Google-native type (application/vnd.google-apps.presentation) that can't be exported as text. Use ingest_drive instead.`,
		);
		expect(((pdfRes.content as any)[0] as any).text).toBe(
			`"Invoice.pdf" is binary (application/pdf) and can't be read as text. Use ingest_drive to bring it into the knowledge store, then artifact_extract_text.`,
		);
		expect(((truncRes.content as any)[0] as any).text).toBe(
			`Long.txt (text/plain):\n\n${"x".repeat(100)}\n\n… [truncated at 100 chars of 250]`,
		);
	});
});
