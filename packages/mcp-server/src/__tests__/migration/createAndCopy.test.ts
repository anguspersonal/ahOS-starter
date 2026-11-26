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

describe("drive_create_folder and drive_copy migration (#1591)", () => {
	it("serves drive_create_folder and drive_copy from the registry with dev's exact contract and removes them from legacy baseline", async () => {
		const manifest = JSON.parse(readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"));
		for (const id of ["drive_create_folder", "drive_copy"]) {
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
		expect(baseline).not.toContain("drive_create_folder");
		expect(baseline).not.toContain("drive_copy");

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();

		const createFolderTool = tools.find((t) => t.name === "drive_create_folder")!;
		expect(createFolderTool?.description).toBe(
			"Create a new folder in Google Drive, optionally inside a parent folder.",
		);
		expect(createFolderTool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
		const createFolderProps = (createFolderTool.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(createFolderProps).sort()).toEqual(["account", "domain", "name", "parent_id"]);
		expect(createFolderTool.inputSchema.required).toEqual(["name"]);
		expect(createFolderProps.name).toMatchObject({
			type: "string",
			minLength: 1,
			description: "Name for the new folder.",
		});
		expect(createFolderProps.parent_id).toMatchObject({
			type: "string",
			description: "Parent folder id (default: My Drive root).",
		});
		expect(createFolderProps.account).toMatchObject({
			type: "string",
			enum: ["personal", "work"],
			description:
				"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
		});
		expect(createFolderProps.domain).toMatchObject({
			type: "string",
			enum: ["work", "angus"],
			description:
				"Which domain to act in: 'work' (the Work company workspace and account) or 'angus' (the personal one).",
		});

		const copyTool = tools.find((t) => t.name === "drive_copy")!;
		expect(copyTool?.description).toBe(
			"Make a copy of a Google Drive file, optionally renamed and/or placed in another folder.",
		);
		expect(copyTool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
		const copyProps = (copyTool.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(copyProps).sort()).toEqual(["account", "domain", "file_id", "name", "parent_id"]);
		expect(copyTool.inputSchema.required).toEqual(["file_id"]);
		expect(copyProps.file_id).toMatchObject({
			type: "string",
			minLength: 1,
			description: "File id to copy (folders cannot be copied).",
		});
		expect(copyProps.name).toMatchObject({
			type: "string",
			description: "Name for the copy (default: 'Copy of …').",
		});
		expect(copyProps.parent_id).toMatchObject({
			type: "string",
			description: "Destination folder id (default: same as source).",
		});
	});

	it("executes drive_create_folder and drive_copy through MCP with byte-for-byte text parity, supportsAllDrives=true, and FILE_FIELDS mask", async () => {
		vi.stubEnv("GOOGLE_CLIENT_ID", "cid-test");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret-test");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_PERSONAL", "rt-personal-val");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_WORK", "rt-work-val");

		const postCalls: Array<{ url: URL; body: string }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(String(input));
				if (url.href === "https://oauth2.googleapis.com/token") {
					return new Response(JSON.stringify({ access_token: "at-tok" }), { status: 200 });
				}
				const body = String(init?.body ?? "");
				postCalls.push({ url, body });
				const parsed = JSON.parse(body);
				if (url.pathname.endsWith("/copy")) {
					return new Response(
						JSON.stringify({
							id: "copy-77",
							name: parsed.name ?? "Copy of Spec.md",
							mimeType: "text/markdown",
							size: "256",
							modifiedTime: "2026-10-12T09:00:00Z",
							owners: [{ emailAddress: "owner@example.com" }],
						}),
						{ status: 200 },
					);
				}
				return new Response(
					JSON.stringify({
						id: "folder-55",
						name: parsed.name,
						mimeType: "application/vnd.google-apps.folder",
						modifiedTime: "2026-10-12T08:00:00Z",
						owners: [{ emailAddress: "owner@example.com" }],
					}),
					{ status: 200 },
				);
			}),
		);

		const { client } = await connectClient();
		const folderOut = await client.callTool({
			name: "drive_create_folder",
			arguments: { name: "Archive", parent_id: "root-9" },
		});
		const copyOut = await client.callTool({
			name: "drive_copy",
			arguments: { file_id: "f-42", name: "Spec Backup.md", parent_id: "folder-55", domain: "work" },
		});
		await client.close();

		expect([folderOut.isError, copyOut.isError]).toEqual([undefined, undefined]);
		expect(
			postCalls.map((c) => [
				c.url.pathname,
				c.url.searchParams.get("supportsAllDrives"),
				c.url.searchParams.get("fields"),
				c.body,
			]),
		).toEqual([
			[
				"/drive/v3/files",
				"true",
				FILE_FIELDS,
				JSON.stringify({
					name: "Archive",
					mimeType: "application/vnd.google-apps.folder",
					parents: ["root-9"],
				}),
			],
			[
				"/drive/v3/files/f-42/copy",
				"true",
				FILE_FIELDS,
				JSON.stringify({
					name: "Spec Backup.md",
					parents: ["folder-55"],
				}),
			],
		]);
		expect(((folderOut.content as any)[0] as any).text).toBe(
			"Created folder:\n• [folder-55] Archive (application/vnd.google-apps.folder, modified 2026-10-12T08:00:00Z, owner owner@example.com)",
		);
		expect(((copyOut.content as any)[0] as any).text).toBe(
			"Copied to:\n• [copy-77] Spec Backup.md (text/markdown, 256 bytes, modified 2026-10-12T09:00:00Z, owner owner@example.com)",
		);
	});
});
