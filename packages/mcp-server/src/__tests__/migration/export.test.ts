import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { FILE_FIELDS } from "@ahkms/core";
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

describe("drive_export migration (#1592)", () => {
	it("serves drive_export from the registry with dev's exact contract and removes it from legacy baseline", async () => {
		const manifest = JSON.parse(readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"));
		expect(manifest.actions.drive_export?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(serverRegistry().get("drive_export")).toBeDefined();

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("drive_export");

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();

		const tool = tools.find((t) => t.name === "drive_export")!;
		expect(tool?.description).toBe(
			"Export a Google Doc to PDF or DOCX and save it as a new file beside the source (or in " +
				"parent_id), returning its link. The source Doc is only read; each call creates another " +
				"file. Google Docs only, and Drive refuses exports over 10 MB. A tabbed Doc exports its " +
				"default tab only (the reply warns). Full notes: " +
				"docs/guides/tools/drive_export.md",
		);
		expect(tool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
		const props = (tool.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(props).sort()).toEqual(["account", "domain", "file_id", "format", "name", "parent_id"]);
		expect(tool.inputSchema.required).toEqual(["file_id", "format"]);
		expect(props.file_id).toMatchObject({
			type: "string",
			minLength: 1,
			description: "Google Doc id to export. Other file types are refused.",
		});
		expect(props.format).toMatchObject({
			type: "string",
			enum: ["pdf", "docx"],
			description: "Export format: 'pdf' or 'docx'.",
		});
		expect(props.name).toMatchObject({
			type: "string",
			minLength: 1,
			description:
				"Name for the exported file (default: the Doc's name). .pdf or .docx is appended when the name lacks it.",
		});
		expect(props.parent_id).toMatchObject({
			type: "string",
			description: "Destination folder id (default: the source Doc's own folder, so the export sits beside it).",
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

	it("executes drive_export through MCP with byte-for-byte text parity and fields masks", async () => {
		vi.stubEnv("GOOGLE_CLIENT_ID", "cid-test");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret-test");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_PERSONAL", "rt-personal-val");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_WORK", "rt-work-val");

		const calls: Array<{ url: URL; method: string }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(String(input));
				if (url.href === "https://oauth2.googleapis.com/token") {
					return new Response(JSON.stringify({ access_token: "at-tok" }), { status: 200 });
				}
				calls.push({ url, method: init?.method ?? "GET" });
				if (url.hostname === "docs.googleapis.com") {
					return new Response(
						JSON.stringify({
							tabs: [{ tabProperties: { tabId: "t1" } }, { tabProperties: { tabId: "t2" } }],
						}),
						{ status: 200 },
					);
				}
				if (url.pathname.endsWith("/export")) {
					return new Response(new TextEncoder().encode("pdf-bytes"), { status: 200 });
				}
				if (url.pathname === "/upload/drive/v3/files") {
					return new Response(
						JSON.stringify({
							id: "export-1",
							name: "Angus Hally CV.pdf",
							mimeType: "application/pdf",
							size: "9",
							parents: ["folder-cv"],
							webViewLink: "https://drive.google.com/file/d/export-1/view",
						}),
						{ status: 200 },
					);
				}
				return new Response(
					JSON.stringify({
						id: "doc-1",
						name: "Angus Hally CV",
						mimeType: "application/vnd.google-apps.document",
						parents: ["folder-cv"],
						webViewLink: "https://docs.google.com/document/d/doc-1/edit",
					}),
					{ status: 200 },
				);
			}),
		);

		const { client } = await connectClient();
		const out = await client.callTool({
			name: "drive_export",
			arguments: { file_id: "doc-1", format: "pdf" },
		});
		await client.close();

		expect(out.isError).toBeUndefined();
		expect(calls[0]?.url.pathname).toBe("/drive/v3/files/doc-1");
		expect(calls[0]?.url.searchParams.get("fields")).toBe("id, name, mimeType, parents, webViewLink");
		expect(calls[1]?.url.hostname).toBe("docs.googleapis.com");
		expect(calls[1]?.url.searchParams.get("fields")).toBeTruthy();
		expect(calls[2]?.url.pathname).toBe("/drive/v3/files/doc-1/export");
		expect(calls[2]?.url.searchParams.get("mimeType")).toBe("application/pdf");
		expect(calls[3]?.url.pathname).toBe("/upload/drive/v3/files");
		expect(calls[3]?.url.searchParams.get("fields")).toBe(FILE_FIELDS);
		expect(((out.content as any)[0] as any).text).toBe(
			'Exported "Angus Hally CV" to PDF (9 bytes) and saved it beside the source, in the same folder:\n' +
				"• [export-1] Angus Hally CV.pdf (application/pdf, 9 bytes)\n" +
				"Link: https://drive.google.com/file/d/export-1/view\n" +
				"Source Doc (unchanged): https://docs.google.com/document/d/doc-1/edit\n" +
				"Warning: only the default tab was exported. This Doc has 2 tabs, and Drive's export renders the default tab only; the other tab is not in this file.",
		);
	});
});
