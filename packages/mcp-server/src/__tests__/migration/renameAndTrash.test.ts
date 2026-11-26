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

describe("drive_rename and drive_trash migration (#1481)", () => {
	it("serves drive_rename and drive_trash from the registry with dev's exact contract and removes them from legacy baseline", async () => {
		const manifest = JSON.parse(readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"));
		for (const id of ["drive_rename", "drive_trash"]) {
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
		expect(baseline).not.toContain("drive_rename");
		expect(baseline).not.toContain("drive_trash");

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();

		const renameTool = tools.find((t) => t.name === "drive_rename")!;
		expect(renameTool?.description).toBe("Rename a Google Drive file or folder.");
		expect(renameTool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		const renameProps = (renameTool.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(renameProps).sort()).toEqual(["account", "domain", "file_id", "name"]);
		expect(renameTool.inputSchema.required).toEqual(["file_id", "name"]);
		expect(renameProps.file_id).toMatchObject({
			type: "string",
			minLength: 1,
			description: "File or folder id to rename.",
		});
		expect(renameProps.name).toMatchObject({
			type: "string",
			minLength: 1,
			description: "New name.",
		});
		expect(renameProps.account).toMatchObject({
			type: "string",
			enum: ["personal", "work"],
			description:
				"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
		});
		expect(renameProps.domain).toMatchObject({
			type: "string",
			enum: ["work", "angus"],
			description:
				"Which domain to act in: 'work' (the Work company workspace and account) or 'angus' (the personal one).",
		});

		const trashTool = tools.find((t) => t.name === "drive_trash")!;
		expect(trashTool?.description).toBe(
			"Move a Google Drive file/folder to Trash (reversible). Set restore=true to bring it back.",
		);
		expect(trashTool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		const trashProps = (trashTool.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(trashProps).sort()).toEqual(["account", "domain", "file_id", "restore"]);
		expect(trashTool.inputSchema.required).toEqual(["file_id"]);
		expect(trashProps.file_id).toMatchObject({
			type: "string",
			minLength: 1,
			description: "File or folder id to move to Trash.",
		});
		expect(trashProps.restore).toMatchObject({
			type: "boolean",
			description: "Set true to restore a trashed item instead of trashing it.",
		});
	});

	it("executes drive_rename and drive_trash through MCP with byte-for-byte text parity, supportsAllDrives=true, and FILE_FIELDS mask", async () => {
		vi.stubEnv("GOOGLE_CLIENT_ID", "cid-test");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret-test");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_PERSONAL", "rt-personal-val");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_WORK", "rt-work-val");

		const patchCalls: Array<{ url: URL; body: string }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(String(input));
				if (url.href === "https://oauth2.googleapis.com/token") {
					return new Response(JSON.stringify({ access_token: "at-tok" }), { status: 200 });
				}
				const body = String(init?.body ?? "");
				patchCalls.push({ url, body });
				const parsed = JSON.parse(body);
				return new Response(
					JSON.stringify({
						id: "f-42",
						name: parsed.name ?? "Notes.md",
						mimeType: "text/markdown",
						size: "512",
						modifiedTime: "2026-10-12T08:00:00Z",
						trashed: parsed.trashed ?? false,
						owners: [{ emailAddress: "owner@example.com" }],
					}),
					{ status: 200 },
				);
			}),
		);

		const { client } = await connectClient();
		const renameOut = await client.callTool({
			name: "drive_rename",
			arguments: { file_id: "f-42", name: "Renamed Notes.md" },
		});
		const trashOut = await client.callTool({
			name: "drive_trash",
			arguments: { file_id: "f-42", domain: "work" },
		});
		const restoreOut = await client.callTool({
			name: "drive_trash",
			arguments: { file_id: "f-42", restore: true },
		});
		await client.close();

		expect([renameOut.isError, trashOut.isError, restoreOut.isError]).toEqual([
			undefined,
			undefined,
			undefined,
		]);
		expect(patchCalls.map((c) => [c.url.searchParams.get("supportsAllDrives"), c.url.searchParams.get("fields"), c.body])).toEqual([
			["true", FILE_FIELDS, JSON.stringify({ name: "Renamed Notes.md" })],
			["true", FILE_FIELDS, JSON.stringify({ trashed: true })],
			["true", FILE_FIELDS, JSON.stringify({ trashed: false })],
		]);
		expect(((renameOut.content as any)[0] as any).text).toBe(
			"Renamed:\n• [f-42] Renamed Notes.md (text/markdown, 512 bytes, modified 2026-10-12T08:00:00Z, owner owner@example.com)",
		);
		expect(((trashOut.content as any)[0] as any).text).toBe(
			"Trashed:\n• [f-42] Notes.md (text/markdown, 512 bytes, modified 2026-10-12T08:00:00Z, TRASHED, owner owner@example.com)",
		);
		expect(((restoreOut.content as any)[0] as any).text).toBe(
			"Restored:\n• [f-42] Notes.md (text/markdown, 512 bytes, modified 2026-10-12T08:00:00Z, owner owner@example.com)",
		);
	});
});
