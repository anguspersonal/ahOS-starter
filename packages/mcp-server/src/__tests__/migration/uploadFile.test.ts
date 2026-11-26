import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { FILE_FIELDS, GOOGLE_DOC_MIME_TYPE } from "@ahkms/core";
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

describe("drive_upload_file migration (#1471)", () => {
	it("serves drive_upload_file from the registry with dev's exact contract and removes it from legacy baseline", async () => {
		const manifest = JSON.parse(
			readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"),
		);
		expect(manifest.actions.drive_upload_file?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(serverRegistry().get("drive_upload_file")).toBeDefined();

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("drive_upload_file");

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();

		const uploadTool = tools.find((t) => t.name === "drive_upload_file")!;
		expect(uploadTool?.description).toBe(
			"Upload a new file to Google Drive from inline text content or a local file path. Set " +
				"convert_to 'google_doc' to turn an HTML, Markdown, plain-text or .docx upload into an " +
				"editable Google Doc; drive_export then renders it to PDF or DOCX.",
		);
		expect(uploadTool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
		const props = (uploadTool.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(props).sort()).toEqual([
			"account",
			"content",
			"convert_to",
			"domain",
			"local_path",
			"mime_type",
			"name",
			"parent_id",
		]);
		expect(uploadTool.inputSchema.required).toEqual(["name"]);
		expect(props.name).toMatchObject({
			type: "string",
			minLength: 1,
			description: "Name for the file in Drive.",
		});
		expect(props.content).toMatchObject({
			type: "string",
			description: "Inline text content to upload. Provide this OR local_path.",
		});
		expect(props.local_path).toMatchObject({
			type: "string",
			description:
				"Absolute path to a local file to upload. Provide this OR content. Takes precedence over content.",
		});
		expect(props.mime_type).toMatchObject({
			type: "string",
			description: "MIME type of the upload (default text/plain for inline content).",
		});
		expect(props.parent_id).toMatchObject({
			type: "string",
			description: "Destination folder id (default: My Drive root).",
		});
		expect(props.convert_to).toMatchObject({
			type: "string",
			enum: ["google_doc"],
			description:
				"Set 'google_doc' to convert an HTML, Markdown, plain-text or .docx upload into an editable Google Doc (the source type comes from mime_type, else the file extension, else an inline body that starts like HTML). Omit to store the bytes as-is.",
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

	it("executes drive_upload_file through MCP for inline content and local_path with byte-for-byte text parity", async () => {
		vi.stubEnv("GOOGLE_CLIENT_ID", "cid-test");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret-test");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_PERSONAL", "rt-personal-val");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_WORK", "rt-work-val");

		const tmpDir = await mkdtemp(join(tmpdir(), "drive-upload-mcp-"));
		const localPath = join(tmpDir, "spec.md");
		await writeFile(localPath, "# Spec\n", "utf-8");

		const uploadCalls: Array<{ url: URL; contentType: string | null; bodyText: string }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(String(input));
				if (url.href === "https://oauth2.googleapis.com/token") {
					return new Response(JSON.stringify({ access_token: "at-tok" }), { status: 200 });
				}
				const rawBody = init?.body;
				const bodyBytes =
					rawBody instanceof Uint8Array
						? rawBody
						: new TextEncoder().encode(String(rawBody ?? ""));
				const bodyText = new TextDecoder().decode(bodyBytes);
				uploadCalls.push({
					url,
					contentType: new Headers(init?.headers).get("Content-Type"),
					bodyText,
				});
				const isConverted = bodyText.includes(GOOGLE_DOC_MIME_TYPE);
				return new Response(
					JSON.stringify({
						id: isConverted ? "doc-99" : "file-88",
						name: isConverted ? "spec" : "notes.txt",
						mimeType: isConverted ? GOOGLE_DOC_MIME_TYPE : "text/plain",
						size: isConverted ? "7" : "5",
						modifiedTime: "2026-10-12T08:00:00Z",
						webViewLink: "https://docs.google.com/document/d/doc-99/edit",
						owners: [{ emailAddress: "owner@example.com" }],
					}),
					{ status: 200 },
				);
			}),
		);

		try {
			const { client } = await connectClient();
			const inlineOut = await client.callTool({
				name: "drive_upload_file",
				arguments: { name: "notes.txt", content: "hello", parent_id: "folder-1" },
			});
			const localConvertedOut = await client.callTool({
				name: "drive_upload_file",
				arguments: {
					name: "spec.md",
					local_path: localPath,
					convert_to: "google_doc",
					domain: "work",
				},
			});
			await client.close();

			expect([inlineOut.isError, localConvertedOut.isError]).toEqual([
				undefined,
				undefined,
			]);
			expect(uploadCalls).toHaveLength(2);
			expect([
				uploadCalls[0].url.pathname,
				uploadCalls[0].url.searchParams.get("uploadType"),
				uploadCalls[0].url.searchParams.get("supportsAllDrives"),
				uploadCalls[0].url.searchParams.get("fields"),
			]).toEqual(["/upload/drive/v3/files", "multipart", "true", FILE_FIELDS]);
			expect(uploadCalls[0].bodyText).toContain(
				JSON.stringify({ name: "notes.txt", parents: ["folder-1"] }),
			);
			expect(uploadCalls[1].bodyText).toContain(
				JSON.stringify({ name: "spec", mimeType: GOOGLE_DOC_MIME_TYPE }),
			);
			expect(uploadCalls[1].bodyText).toContain("Content-Type: text/markdown");
			expect(uploadCalls[1].bodyText).toContain("# Spec\n");

			expect(((inlineOut.content as any)[0] as any).text).toBe(
				"Uploaded 5 bytes:\n• [file-88] notes.txt (text/plain, 5 bytes, modified 2026-10-12T08:00:00Z, owner owner@example.com)",
			);
			expect(((localConvertedOut.content as any)[0] as any).text).toBe(
				"Uploaded 7 bytes (text/markdown) and converted them to a Google Doc:\n• [doc-99] spec (application/vnd.google-apps.document, 7 bytes, modified 2026-10-12T08:00:00Z, owner owner@example.com)\nLink: https://docs.google.com/document/d/doc-99/edit",
			);
		} finally {
			await rm(tmpDir, { recursive: true, force: true });
		}
	});
});
