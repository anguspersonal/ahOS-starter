import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { LIST_FIELDS } from "@ahkms/core";
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

describe("drive_list and drive_search migration (#1588)", () => {
	it("serves drive_list and drive_search from the registry with dev's exact contract and removes them from legacy baseline", async () => {
		const manifest = JSON.parse(readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"));
		for (const id of ["drive_list", "drive_search"]) {
			expect(manifest.actions[id]?.expose).toEqual({
				mcp: true,
				http: true,
				ui_agent: true,
				worker: true,
				cli: false,
				a2a: false,
			});
			expect(serverRegistry().get(id)).toBeDefined();
		}

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("drive_list");
		expect(baseline).not.toContain("drive_search");

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();

		const listTool = tools.find((t) => t.name === "drive_list")!;
		expect(listTool?.description).toBe(
			"List Google Drive files, optionally within a folder (use folder_id 'root' for My Drive top level).",
		);
		expect(listTool.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		const listProps = (listTool.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(listProps).sort()).toEqual([
			"account",
			"cursor",
			"domain",
			"folder_id",
			"include_trashed",
			"order_by",
			"page_size",
			"q",
		]);
		expect(listTool.inputSchema.required ?? []).toEqual([]);
		expect(listProps.folder_id).toMatchObject({
			type: "string",
			description:
				"Optional folder id to list children of. Use 'root' for My Drive top level. Omit to list across all of Drive.",
		});
		expect(listProps.q).toMatchObject({
			type: "string",
			description:
				"Optional raw Drive query (files.list q syntax), e.g. \"name = 'X.docx'\" or \"mimeType = 'application/pdf'\". ANDed with folder_id and, unless include_trashed, trashed = false.",
		});
		expect(listProps.cursor).toMatchObject({
			type: "string",
			description:
				"Opaque cursor from a previous call's 'More files exist' line. Pass it with the same other arguments; omit for the first page.",
		});
		expect(listProps.include_trashed).toMatchObject({
			type: "boolean",
			description: "Include trashed files (default false).",
		});
		expect(listProps.page_size).toMatchObject({
			type: "integer",
			minimum: 1,
			maximum: 100,
			description: "Max files to return (default 25).",
		});
		expect(listProps.order_by).toMatchObject({
			type: "string",
			description:
				"Drive orderBy expression, e.g. 'modifiedTime desc' (default), 'name', 'folder,name'.",
		});
		expect(listProps.account).toMatchObject({
			type: "string",
			enum: ["personal", "work"],
			description:
				"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
		});
		expect(listProps.domain).toMatchObject({
			type: "string",
			enum: ["work", "angus"],
			description:
				"Which domain to act in: 'work' (the Work company workspace and account) or 'angus' (the personal one).",
		});

		const searchTool = tools.find((t) => t.name === "drive_search")!;
		expect(searchTool?.description).toBe(
			"Search Google Drive by file name and full-text content, optionally filtered by MIME type.",
		);
		expect(searchTool.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		const searchProps = (searchTool.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(searchProps).sort()).toEqual([
			"account",
			"cursor",
			"domain",
			"include_trashed",
			"mime_type",
			"page_size",
			"query",
		]);
		expect(searchTool.inputSchema.required).toEqual(["query"]);
		expect(searchProps.query).toMatchObject({
			type: "string",
			minLength: 1,
			description:
				"Text to find in file name and full-text content. Matched with Drive's fullText/name contains operators.",
		});
		expect(searchProps.cursor).toMatchObject({
			type: "string",
			description:
				"Opaque cursor from a previous call's 'More files exist' line. Pass it with the same other arguments; omit for the first page.",
		});
		expect(searchProps.mime_type).toMatchObject({
			type: "string",
			description:
				"Optional exact mimeType filter, e.g. 'application/pdf' or 'application/vnd.google-apps.folder'.",
		});
		expect(searchProps.include_trashed).toMatchObject({
			type: "boolean",
			description: "Include trashed files (default false).",
		});
		expect(searchProps.page_size).toMatchObject({
			type: "integer",
			minimum: 1,
			maximum: 100,
			description: "Max files to return (default 25).",
		});
	});

	it("executes drive_list and drive_search through MCP with byte-for-byte text parity, supportsAllDrives=true, includeItemsFromAllDrives=true, and LIST_FIELDS, incompleteSearch mask", async () => {
		vi.stubEnv("GOOGLE_CLIENT_ID", "cid-test");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret-test");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_PERSONAL", "rt-personal-val");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_WORK", "rt-work-val");

		const getCalls: URL[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = new URL(String(input));
				if (url.href === "https://oauth2.googleapis.com/token") {
					return new Response(JSON.stringify({ access_token: "at-tok" }), { status: 200 });
				}
				getCalls.push(url);
				const isSearch = (url.searchParams.get("q") ?? "").includes("fullText contains");
				return new Response(
					JSON.stringify({
						files: [
							{
								id: isSearch ? "f-search" : "f-list",
								name: isSearch ? "Report.pdf" : "Notes.md",
								mimeType: isSearch ? "application/pdf" : "text/markdown",
								size: "512",
								modifiedTime: "2026-10-12T08:00:00Z",
								owners: [{ emailAddress: "owner@example.com" }],
							},
						],
						nextPageToken: isSearch ? "tok-search-2" : "tok-list-2",
						...(isSearch ? { incompleteSearch: true } : {}),
					}),
					{ status: 200 },
				);
			}),
		);

		const { client } = await connectClient();
		const listOut = await client.callTool({
			name: "drive_list",
			arguments: { folder_id: "root", q: "name != 'Skip'", cursor: "tok-list-1" },
		});
		const searchOut = await client.callTool({
			name: "drive_search",
			arguments: { query: "report", mime_type: "application/pdf", cursor: "tok-search-1", domain: "work" },
		});
		await client.close();

		expect([listOut.isError, searchOut.isError]).toEqual([undefined, undefined]);
		expect(
			getCalls.map((u) => [
				u.searchParams.get("supportsAllDrives"),
				u.searchParams.get("includeItemsFromAllDrives"),
				u.searchParams.get("fields"),
				u.searchParams.get("pageToken"),
				u.searchParams.get("q"),
			]),
		).toEqual([
			[
				"true",
				"true",
				LIST_FIELDS,
				"tok-list-1",
				"(name != 'Skip') and 'root' in parents and trashed = false",
			],
			[
				"true",
				"true",
				LIST_FIELDS,
				"tok-search-1",
				"(fullText contains 'report' or name contains 'report') and mimeType = 'application/pdf' and trashed = false",
			],
		]);

		expect(((listOut.content as any)[0] as any).text).toBe(
			[
				"1 file(s):",
				"• [f-list] Notes.md (text/markdown, 512 bytes, modified 2026-10-12T08:00:00Z, owner owner@example.com)",
				"More files exist. Call drive_list again with the same arguments plus cursor 'tok-list-2' for the next page; do not treat this list as complete.",
			].join("\n"),
		);
		expect(((searchOut.content as any)[0] as any).text).toBe(
			[
				"1 file(s):",
				"• [f-search] Report.pdf (application/pdf, 512 bytes, modified 2026-10-12T08:00:00Z, owner owner@example.com)",
				"More files exist. Call drive_search again with the same arguments plus cursor 'tok-search-2' for the next page; do not treat this list as complete.",
				"Drive searched only part of the corpus; results may be missing.",
			].join("\n"),
		);
	});
});
